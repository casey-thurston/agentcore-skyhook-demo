import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamChunk {
  body: unknown;
  final: boolean;
  status?: number;
  headers?: Record<string, string>;
}

interface PendingRequest {
  /** Called for each frame from the upstream server. final=true ends the exchange. */
  onChunk: (chunk: StreamChunk) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProxyMessage {
  correlationId: string;
  /**
   * - `request`: proxy → server (one per exchange)
   * - `response`: server → proxy, terminal frame (also implies final=true unless overridden)
   * - `stream`: server → proxy, intermediate frame (progress / mid-exchange notification tied to a request)
   * - `notification`: server → proxy, untied (broadcast to all WS clients)
   */
  type: "request" | "response" | "stream" | "notification";
  /** Marks the last frame of an exchange. Defaults to true for `response`, false for `stream`. */
  final?: boolean;
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

  // MCP target endpoint — accepts a single client request and streams every
  // frame of the resulting exchange back as chunked NDJSON
  // (Content-Type: application/x-ndjson). Each line is one JSON-RPC message:
  // intermediate progress notifications, server-initiated requests, and the
  // final response are all delivered over the same response body.
  //
  // No SSE: the framing is just chunked HTTP with one JSON document per line.
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

    let headersWritten = false;
    const writeHeadersOnce = (status?: number, headers?: Record<string, string>) => {
      if (headersWritten || res.headersSent) return;
      headersWritten = true;
      res.status(status ?? 200);
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res.setHeader(k, v);
        }
      }
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    };

    const cleanup = () => {
      clearTimeout(timer);
      pending.delete(correlationId);
      serverPending.get(serverId)?.delete(correlationId);
    };

    const timer = setTimeout(() => {
      cleanup();
      writeHeadersOnce(504);
      if (!res.writableEnded) {
        try {
          res.write(JSON.stringify({ error: "Request timeout", correlationId }) + "\n");
        } catch { /* ignore */ }
        res.end();
      }
    }, requestTimeoutMs);

    if (!serverPending.has(serverId)) {
      serverPending.set(serverId, new Set());
    }
    serverPending.get(serverId)!.add(correlationId);

    const closedByClient = () => {
      // If the client hangs up, drop the pending entry so we stop accumulating.
      cleanup();
    };
    res.on("close", closedByClient);

    pending.set(correlationId, {
      onChunk: (chunk) => {
        writeHeadersOnce(chunk.status, chunk.headers);
        if (!res.writableEnded) {
          try {
            res.write(JSON.stringify(chunk.body) + "\n");
          } catch {
            cleanup();
            return;
          }
        }
        if (chunk.final) {
          cleanup();
          if (!res.writableEnded) res.end();
        }
      },
      reject: (err) => {
        cleanup();
        if (!headersWritten && !res.headersSent) {
          res.status(502).json({ error: err.message, correlationId });
        } else if (!res.writableEnded) {
          try {
            res.write(JSON.stringify({ error: err.message, correlationId }) + "\n");
          } catch { /* ignore */ }
          res.end();
        }
      },
      timer,
    });

    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      cleanup();
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

      if (msg.type === "response" || msg.type === "stream") {
        const p = pending.get(msg.correlationId);
        if (p) {
          const final = msg.final ?? msg.type === "response";
          p.onChunk({
            body: msg.body,
            final,
            headers: msg.headers,
            status: msg.status,
          });
        }
      } else if (msg.type === "notification") {
        // Untied notification — fan out to attached client WebSockets.
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
      // upstream server; every frame the server emits for this exchange is
      // streamed back over the same WebSocket.
      const correlationId = randomUUID();
      clientCorrelations.add(correlationId);

      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(correlationId);
        serverPending.get(serverId)?.delete(correlationId);
        clientCorrelations.delete(correlationId);
      };

      const timer = setTimeout(() => {
        cleanup();
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
        onChunk: (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(chunk.body));
          }
          if (chunk.final) cleanup();
        },
        reject: (err) => {
          cleanup();
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
