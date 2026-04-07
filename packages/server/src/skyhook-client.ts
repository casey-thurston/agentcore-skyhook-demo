import { WebSocket } from "ws";

export interface SkyhookClientOptions {
  proxyUrl: string; // ws://hostname:port
  serverId: string;
  onRequest: (request: unknown) => Promise<unknown>;
  onConnected?: () => void;
  onDisconnected?: () => void;
  maxReconnectDelayMs?: number;
}

/**
 * Skyhook client that connects an MCP server to a Skyhook proxy.
 * Handles reconnection with exponential backoff + jitter.
 */
export class SkyhookClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay: number;
  private closed = false;
  private opts: SkyhookClientOptions;

  constructor(opts: SkyhookClientOptions) {
    this.opts = opts;
    this.maxReconnectDelay = opts.maxReconnectDelayMs ?? 30_000;
  }

  /**
   * Start the client. Connects to the proxy and begins receiving requests.
   * Will automatically reconnect on disconnection until stop() is called.
   */
  start(): void {
    this.closed = false;
    this.connect();
  }

  /**
   * Stop the client. Closes the WebSocket and disables reconnection.
   */
  stop(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close(1000, "Client stopping");
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;

    const url = `${this.opts.proxyUrl}/register/${encodeURIComponent(this.opts.serverId)}`;
    console.log(`[skyhook-client] Connecting to ${url}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[skyhook-client] Connected as ${this.opts.serverId}`);
      this.reconnectDelay = 1000; // reset backoff
      this.opts.onConnected?.();
    });

    ws.on("message", async (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error("[skyhook-client] Invalid message from proxy");
        return;
      }

      if (msg.type === "request") {
        try {
          const response = await this.opts.onRequest(msg.body);
          ws.send(
            JSON.stringify({
              correlationId: msg.correlationId,
              type: "response",
              body: response,
            }),
          );
        } catch (err) {
          ws.send(
            JSON.stringify({
              correlationId: msg.correlationId,
              type: "response",
              body: {
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message:
                    err instanceof Error ? err.message : "Internal error",
                },
                id: msg.body?.id ?? null,
              },
            }),
          );
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(
        `[skyhook-client] Disconnected (code=${code}, reason=${reason.toString()})`,
      );
      this.ws = null;
      this.opts.onDisconnected?.();
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[skyhook-client] WebSocket error: ${err.message}`);
      // 'close' event will follow, which triggers reconnect
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    // Exponential backoff with jitter
    const jitter = Math.random() * 0.5 + 0.75; // 0.75–1.25x
    const delay = Math.min(this.reconnectDelay * jitter, this.maxReconnectDelay);

    console.log(
      `[skyhook-client] Reconnecting in ${Math.round(delay)}ms`,
    );

    setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay,
      );
      this.connect();
    }, delay);
  }
}
