import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookClient } from "./skyhook-client.js";
import { registerWithAgentCore } from "./agentcore.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_URL = process.env.PROXY_URL ?? "ws://localhost:3000";
const SERVER_ID = process.env.SERVER_ID ?? "demo";
const SERVER_NAME = process.env.SERVER_NAME ?? "Skyhook Demo Server";

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: SERVER_NAME,
  version: "0.1.0",
});

// Demo tool: echo
mcp.tool(
  "echo",
  "Echoes the input text back, demonstrating basic tool call and _meta.resourceUI passthrough",
  { text: z.string().describe("The text to echo back") },
  async ({ text }) => ({
    content: [{ type: "text", text }],
    _meta: {
      resourceUI: {
        title: "Echo Result",
        icon: "message-circle",
      },
    },
  }),
);

// Demo tool: get-time
mcp.tool(
  "get-time",
  "Returns the current server time as an ISO timestamp",
  {},
  async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
    _meta: {
      resourceUI: {
        title: "Server Time",
        icon: "clock",
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// MCP request handler — routes JSON-RPC to the MCP server
// ---------------------------------------------------------------------------

async function handleMcpRequest(request: unknown): Promise<unknown> {
  // The MCP SDK expects Transport-level communication. Since we're
  // bridging via WebSocket, we handle the JSON-RPC dispatch manually.
  // We create a pair of in-memory transports for each request.

  const req = request as {
    jsonrpc: string;
    method: string;
    params?: unknown;
    id?: string | number;
  };

  // Use the server's internal handler
  const transport = await createRequestTransport(req);
  return transport;
}

/**
 * Creates a one-shot in-memory transport to process a single JSON-RPC request
 * through the MCP server.
 */
async function createRequestTransport(
  request: any,
): Promise<unknown> {
  // For SDK-based handling, we need to use the low-level server API.
  // The McpServer wraps a Server instance that has a direct message handler.
  const server = (mcp as any).server;

  // If the server doesn't have a connection yet, we need to set up a
  // synthetic transport. For simplicity, we use the internal _handleRequest
  // pattern by directly invoking the registered handlers.

  return new Promise<unknown>((resolve, reject) => {
    // Create a minimal in-memory transport pair
    const transport = {
      started: false,
      async start() {
        this.started = true;
      },
      async close() {},
      async send(message: any) {
        resolve(message);
      },
      onclose: undefined as any,
      onerror: undefined as any,
      onmessage: undefined as any,
      sessionId: undefined as string | undefined,
    };

    server
      .connect(transport)
      .then(() => {
        // Deliver the request message
        if (transport.onmessage) {
          transport.onmessage(request);
        }
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Skyhook Client — connects to proxy
// ---------------------------------------------------------------------------

const client = new SkyhookClient({
  proxyUrl: PROXY_URL,
  serverId: SERVER_ID,
  onRequest: handleMcpRequest,
  onConnected: async () => {
    // Compute the HTTP endpoint URL from the WebSocket proxy URL
    const httpUrl = PROXY_URL.replace(/^ws/, "http");
    const endpointUrl = `${httpUrl}/mcp/${encodeURIComponent(SERVER_ID)}`;

    await registerWithAgentCore({
      serverId: SERVER_ID,
      endpointUrl,
      name: SERVER_NAME,
      description: "Demo MCP server connected via Skyhook reverse proxy",
    });
  },
  onDisconnected: () => {
    console.log(`[server] Lost connection to proxy, will reconnect...`);
  },
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`[server] Starting ${SERVER_NAME} (id=${SERVER_ID})`);
console.log(`[server] Proxy: ${PROXY_URL}`);
client.start();

const shutdown = () => {
  console.log("\n[server] Shutting down...");
  client.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
