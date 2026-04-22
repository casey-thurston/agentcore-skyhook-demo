import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Options for creating a SkyhookTransport.
 */
export interface SkyhookTransportOptions {
  /** WebSocket URL of the Skyhook proxy (e.g. "ws://proxy-host:3000") */
  proxyUrl: string;

  /** Unique identifier for this server in the proxy's routing table */
  serverId: string;

  /** Called when the WebSocket connection to the proxy is established */
  onConnected?: () => void;

  /** Called when the WebSocket connection to the proxy is lost (before reconnect) */
  onDisconnected?: () => void;

  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
}

/**
 * MCP Transport that connects to a Skyhook proxy via WebSocket.
 *
 * This is a drop-in replacement for StreamableHTTPServerTransport or
 * StdioServerTransport. Use it when your MCP server is behind a network
 * partition and can't accept inbound connections:
 *
 * ```typescript
 * // Normal MCP server — accepts inbound HTTP
 * const transport = new StreamableHTTPServerTransport({ ... });
 *
 * // Skyhook — connects outbound to proxy, clients connect to proxy
 * const transport = new SkyhookTransport({ proxyUrl: "ws://proxy", serverId: "my-server" });
 *
 * // Everything else stays the same
 * await server.connect(transport);
 * ```
 */
export class SkyhookTransport implements Transport {
  // ── Transport interface fields ──────────────────────────────────────

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  sessionId?: string;

  // ── Internal state ──────────────────────────────────────────────────

  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1000;
  private opts: SkyhookTransportOptions;
  private maxReconnectDelay: number;

  /**
   * Maps JSON-RPC request id → Skyhook proxy correlationId.
   * Used to route responses back to the correct proxy request.
   */
  private correlationMap = new Map<string | number, string>();

  constructor(opts: SkyhookTransportOptions) {
    this.opts = opts;
    this.maxReconnectDelay = opts.maxReconnectDelayMs ?? 30_000;
    this.sessionId = randomUUID();
  }

  // ── Transport interface methods ─────────────────────────────────────

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to Skyhook proxy");
    }

    const m = message as Record<string, unknown>;
    const isResponse = "result" in m || "error" in m;

    // Find the correlationId for this exchange.
    // For final responses (matched by message.id), or progress notifications
    // tied via TransportSendOptions.relatedRequestId, we route on the same
    // proxy correlationId so the proxy can stream multiple frames per request.
    const relatedId =
      options?.relatedRequestId ??
      (isResponse && "id" in m ? (m.id as string | number) : undefined);

    if (relatedId !== undefined) {
      const correlationId = this.correlationMap.get(relatedId);
      if (correlationId) {
        if (isResponse) {
          // Terminal frame — proxy will end the streamed HTTP response.
          this.ws.send(
            JSON.stringify({
              correlationId,
              type: "response",
              final: true,
              body: message,
            }),
          );
          this.correlationMap.delete(relatedId);
        } else {
          // Intermediate frame (progress notification, server-initiated
          // request mid-exchange, etc.) — proxy keeps the response open.
          this.ws.send(
            JSON.stringify({
              correlationId,
              type: "stream",
              final: false,
              body: message,
            }),
          );
        }
        return;
      }
    }

    // No correlationId — this is an unsolicited notification (e.g. logging).
    // The proxy fans this out to any WebSocket clients attached to /mcp-ws/:serverId.
    this.ws.send(
      JSON.stringify({
        correlationId: randomUUID(),
        type: "notification",
        body: message,
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.correlationMap.clear();
    if (this.ws) {
      this.ws.close(1000, "Transport closing");
      this.ws = null;
    }
    this.onclose?.();
  }

  // ── Connection management ───────────────────────────────────────────

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Transport is closed"));
        return;
      }

      const url = `${this.opts.proxyUrl}/register/${encodeURIComponent(this.opts.serverId)}`;
      console.log(`[skyhook] Connecting to ${url}`);

      const ws = new WebSocket(url);
      this.ws = ws;

      let resolved = false;

      ws.on("open", () => {
        console.log(`[skyhook] Connected as "${this.opts.serverId}"`);
        this.reconnectDelay = 1000;
        this.opts.onConnected?.();
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          this.onerror?.(new Error("Invalid message from proxy"));
          return;
        }

        if (msg.type === "request" && msg.body) {
          // Store correlation mapping: JSON-RPC id → proxy correlationId
          if (msg.body.id !== undefined) {
            this.correlationMap.set(msg.body.id, msg.correlationId);
          }
          // Deliver to the MCP server
          this.onmessage?.(msg.body);
        }
      });

      ws.on("close", (code, reason) => {
        console.log(
          `[skyhook] Disconnected (code=${code}, reason=${reason.toString()})`,
        );
        this.ws = null;
        this.opts.onDisconnected?.();

        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed: ${code}`));
          return;
        }

        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        console.error(`[skyhook] WebSocket error: ${err.message}`);
        this.onerror?.(err);
        // 'close' event follows, which handles reconnect
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    const jitter = Math.random() * 0.5 + 0.75; // 0.75–1.25x
    const delay = Math.min(
      this.reconnectDelay * jitter,
      this.maxReconnectDelay,
    );

    console.log(`[skyhook] Reconnecting in ${Math.round(delay)}ms`);

    setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay,
      );
      this.connect().catch((err) => {
        this.onerror?.(err);
      });
    }, delay);
  }
}
