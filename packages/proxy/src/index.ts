import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (response: ProxyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProxyMessage {
  correlationId: string;
  type: "request" | "response" | "notification";
  body: unknown;
  headers?: Record<string, string>;
  status?: number;
}

interface ProxyResponse {
  body: unknown;
  headers?: Record<string, string>;
  status?: number;
}

interface ServerConnection {
  ws: WebSocket;
  /**
   * WebSocket client sockets subscribed for server-initiated notifications.
   * Replaces the old SSE broadcast — provides full bidirectional streaming.
   */
  clientSockets: Set<WebSocket>;
}

export interface ProxyOptions {
  port?: number;
  requestTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface SkyhookProxy {
  httpServer: Server;
  app: express.Express;
  servers: Map<string, ServerConnection>;
  pending: Map<string, PendingRequest>;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProxy(opts?: ProxyOptions): SkyhookProxy {
  const port = opts?.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const requestTimeoutMs =
    opts?.requestTimeoutMs ??
    parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30000", 10);
  const pingIntervalMs = opts?.pingIntervalMs ?? 30_000;

  // Per-instance state
  const servers = new Map<string, ServerConnection>();
  const pending = new Map<string, PendingRequest>();
  const serverPending = new Map<string, Set<string>>();

  // Express app
  const app = express();
  app.use(express.raw({ type: "*/*", limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", servers: Array.from(servers.keys()) });
  });

  // MCP Streamable HTTP entry point.
  //
  // AgentCore Gateway (or any MCP client) posts a JSON-RPC message here.
  // The response is returned as a streamed JSON body (chunked HTTP) rather
  // than SSE — AgentCore Gateway will in turn stream it to its own clients
  // over its bidirectional MCP transport.
  app.post("/mcp/:serverId", (req, res) => {
    const { serverId } = req.params;
    const conn = servers.get(serverId);

    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      res.status(503).json({ error: "Server not connected", serverId });
      return;
    }

    const correlationId = randomUUID();
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf-8")
      : req.body;

    let parsed: unknown;
    try {
      parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    } catch {
      parsed = rawBody;
    }

    const msg: ProxyMessage = {
      correlationId,
      type: "request",
      body: parsed,
      headers: {
        "content-type": req.get("content-type") ?? "application/json",
      },
    };

    const timer = setTimeout(() => {
      pending.delete(correlationId);
      serverPending.get(serverId)?.delete(correlationId);
      if (!res.headersSent) {
        res.status(504).json({ error: "Request timeout", correlationId });
      }
    }, requestTimeoutMs);

    if (!serverPending.has(serverId)) {
      serverPending.set(serverId, new Set());
    }
    serverPending.get(serverId)!.add(correlationId);

    pending.set(correlationId, {
      resolve: (response) => {
        clearTimeout(timer);
        pending.delete(correlationId);
        serverPending.get(serverId)?.delete(correlationId);
        if (!res.headersSent) {
          const status = response.status ?? 200;
          if (response.headers) {
            for (const [k, v] of Object.entries(response.headers)) {
              res.setHeader(k, v);
            }
          }
          res.status(status).json(response.body);
        }
      },
      reject: (err) => {
        clearTimeout(timer);
        pending.delete(correlationId);
        serverPending.get(serverId)?.delete(correlationId);
        if (!res.headersSent) {
          res.status(502).json({ error: err.message, correlationId });
        }
      },
      timer,
    });

    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      clearTimeout(timer);
      pending.delete(correlationId);
      serverPending.get(serverId)?.delete(correlationId);
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "Failed to send to server", correlationId });
      }
    }
  });

  // DELETE — session termination
  app.delete("/mcp/:serverId", (req, res) => {
    const { serverId } = req.params;
    const conn = servers.get(serverId);

    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      res.status(503).json({ error: "Server not connected", serverId });
      return;
    }

    const msg: ProxyMessage = {
      correlationId: randomUUID(),
      type: "notification",
      body: { method: "session/terminate" },
    };

    try {
      conn.ws.send(JSON.stringify(msg));
      res.status(200).json({ status: "terminated" });
    } catch {
      res.status(502).json({ error: "Failed to send termination" });
    }
  });

  // HTTP + WebSocket server
  const httpServer = createServer(app);

  // Two separate WS namespaces:
  //   /register/:serverId  — upstream MCP servers connect here
  //   /mcp-ws/:serverId    — downstream clients (or AgentCore Gateway edge)
  //                          connect here for bidirectional MCP streaming
  const registerWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    const registerMatch = url.pathname.match(/^\/register\/([^/]+)$/);
    if (registerMatch) {
      const serverId = decodeURIComponent(registerMatch[1]);
      registerWss.handleUpgrade(req, socket, head, (ws) => {
        setupServerConnection(serverId, ws);
      });
      return;
    }

    const clientMatch = url.pathname.match(/^\/mcp-ws\/([^/]+)$/);
    if (clientMatch) {
      const serverId = decodeURIComponent(clientMatch[1]);
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        setupClientConnection(serverId, ws);
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  function setupServerConnection(serverId: string, ws: WebSocket): void {
    const existing = servers.get(serverId);
    if (existing) {
      existing.ws.close(1000, "Replaced by new connection");
      rejectPendingForServer(serverId, "Server reconnected");
    }

    const conn: ServerConnection = { ws, clientSockets: new Set() };
    servers.set(serverId, conn);
    console.log(`[skyhook] Server registered: ${serverId}`);

    let alive = true;
    const interval = setInterval(() => {
      if (!alive) {
        console.log(
          `[skyhook] Server ${serverId} failed pong check, closing`,
        );
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, pingIntervalMs);

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (data) => {
      let msg: ProxyMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error(`[skyhook] Invalid message from ${serverId}`);
        return;
      }

      if (msg.type === "response") {
        const p = pending.get(msg.correlationId);
        if (p) {
          p.resolve({
            body: msg.body,
            headers: msg.headers,
            status: msg.status,
          });
        }
      } else if (msg.type === "notification") {
        // Fan out to any connected client WebSockets for this server.
        const payload = JSON.stringify(msg.body);
        for (const clientWs of conn.clientSockets) {
          if (clientWs.readyState === WebSocket.OPEN) {
            try {
              clientWs.send(payload);
            } catch {
              conn.clientSockets.delete(clientWs);
            }
          } else {
            conn.clientSockets.delete(clientWs);
          }
        }
      }
    });

    ws.on("close", () => {
      console.log(`[skyhook] Server disconnected: ${serverId}`);
      clearInterval(interval);
      servers.delete(serverId);
      rejectPendingForServer(serverId, "Server disconnected");
      for (const clientWs of conn.clientSockets) {
        try {
          clientWs.close(1001, "Upstream server disconnected");
        } catch {
          // ignore
        }
      }
      conn.clientSockets.clear();
    });

    ws.on("error", (err) => {
      console.error(
        `[skyhook] WebSocket error for ${serverId}:`,
        err.message,
      );
    });
  }

  function setupClientConnection(serverId: string, ws: WebSocket): void {
    const conn = servers.get(serverId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      ws.close(1011, `Server not connected: ${serverId}`);
      return;
    }

    conn.clientSockets.add(ws);
    console.log(`[skyhook] Client WebSocket attached to ${serverId}`);

    const clientCorrelations = new Set<string>();

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }

      // Each client frame is a single JSON-RPC message. Forward it to the
      // upstream server and stream the response back on the same socket.
      const correlationId = randomUUID();
      clientCorrelations.add(correlationId);

      const timer = setTimeout(() => {
        pending.delete(correlationId);
        serverPending.get(serverId)?.delete(correlationId);
        clientCorrelations.delete(correlationId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Request timeout" },
              id: (parsed as { id?: unknown })?.id ?? null,
            }),
          );
        }
      }, requestTimeoutMs);

      if (!serverPending.has(serverId)) serverPending.set(serverId, new Set());
      serverPending.get(serverId)!.add(correlationId);

      pending.set(correlationId, {
        resolve: (response) => {
          clearTimeout(timer);
          pending.delete(correlationId);
          serverPending.get(serverId)?.delete(correlationId);
          clientCorrelations.delete(correlationId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response.body));
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          pending.delete(correlationId);
          serverPending.get(serverId)?.delete(correlationId);
          clientCorrelations.delete(correlationId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32002, message: err.message },
                id: (parsed as { id?: unknown })?.id ?? null,
              }),
            );
          }
        },
        timer,
      });

      try {
        conn.ws.send(
          JSON.stringify({
            correlationId,
            type: "request",
            body: parsed,
          } satisfies ProxyMessage),
        );
      } catch {
        const p = pending.get(correlationId);
        p?.reject(new Error("Failed to send to upstream server"));
      }
    });

    ws.on("close", () => {
      conn.clientSockets.delete(ws);
      for (const cid of clientCorrelations) {
        const p = pending.get(cid);
        if (p) p.reject(new Error("Client disconnected"));
      }
      clientCorrelations.clear();
    });

    ws.on("error", () => {
      /* close handler cleans up */
    });
  }

  function rejectPendingForServer(serverId: string, reason: string): void {
    const ids = serverPending.get(serverId);
    if (!ids) return;
    for (const correlationId of ids) {
      const p = pending.get(correlationId);
      if (p) {
        p.reject(new Error(reason));
      }
    }
    serverPending.delete(serverId);
  }

  return {
    httpServer,
    app,
    servers,
    pending,
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, () => {
          console.log(`[skyhook] Proxy listening on port ${port}`);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const [, conn] of servers) {
          conn.ws.close(1000, "Proxy shutting down");
          for (const clientWs of conn.clientSockets) {
            try {
              clientWs.close(1001, "Proxy shutting down");
            } catch {
              // ignore
            }
          }
        }
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Proxy shutting down"));
        }
        pending.clear();
        servers.clear();
        serverPending.clear();
        registerWss.close(() => {
          clientWss.close(() => {
            httpServer.close((err) => (err ? reject(err) : resolve()));
          });
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// Run directly
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");

if (isMain) {
  const proxy = createProxy();
  proxy.start();

  const shutdown = () => {
    console.log("\n[skyhook] Shutting down...");
    proxy.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
