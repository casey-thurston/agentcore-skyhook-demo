import { WebSocket } from "ws";
import { createProxy, type SkyhookProxy, type ProxyOptions } from "../index.js";
import type { AddressInfo } from "node:net";

export interface TestProxy {
  url: string; // http://localhost:<port>
  wsUrl: string; // ws://localhost:<port>
  proxy: SkyhookProxy;
  close: () => Promise<void>;
}

export interface MockServer {
  ws: WebSocket;
  messages: unknown[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

/**
 * Start the proxy on a random port. Returns HTTP and WebSocket base URLs.
 */
export async function startProxy(
  opts?: { requestTimeoutMs?: number },
): Promise<TestProxy> {
  const proxy = createProxy({
    port: 0,
    requestTimeoutMs: opts?.requestTimeoutMs,
  });
  await proxy.start();

  const addr = proxy.httpServer.address() as AddressInfo;
  const url = `http://localhost:${addr.port}`;
  const wsUrl = `ws://localhost:${addr.port}`;

  const handle: TestProxy = {
    url,
    wsUrl,
    proxy,
    close: async () => {
      await proxy.close();
    },
  };

  cleanups.push(handle.close);
  return handle;
}

/**
 * Connect a mock MCP server to the proxy via WebSocket.
 * handler is called for each message; return a response to send back,
 * or undefined to not respond.
 */
export async function connectMockServer(
  wsUrl: string,
  serverId: string,
  handler?: (msg: any) => any | undefined,
): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/register/${encodeURIComponent(serverId)}`);
    const messages: unknown[] = [];

    ws.on("open", () => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (handler) {
          const response = handler(msg);
          if (response !== undefined) {
            ws.send(JSON.stringify(response));
          }
        }
      });

      const handle: MockServer = {
        ws,
        messages,
        close: () =>
          new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) {
              res();
              return;
            }
            ws.on("close", () => res());
            ws.close();
          }),
      };
      cleanups.push(handle.close);
      resolve(handle);
    });

    ws.on("error", reject);
  });
}

/**
 * Create a standard echo handler that sends back the request body as the response.
 */
export function echoHandler() {
  return (msg: any) => {
    if (msg.type === "request") {
      return {
        correlationId: msg.correlationId,
        type: "response",
        body: msg.body,
      };
    }
    return undefined;
  };
}

/**
 * Clean up all proxies and connections created during a test.
 */
export async function cleanupAll(): Promise<void> {
  // Close in reverse order
  const toClean = cleanups.splice(0);
  for (const fn of toClean.reverse()) {
    try {
      await fn();
    } catch {
      // ignore cleanup errors
    }
  }
}
