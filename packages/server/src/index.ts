import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookTransport } from "./skyhook-transport.js";
import { registerWithAgentCore } from "./agentcore.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_URL = process.env.PROXY_URL ?? "ws://localhost:3000";
const SERVER_ID = process.env.SERVER_ID ?? "demo";
const SERVER_NAME = process.env.SERVER_NAME ?? "Skyhook Demo Server";

// ---------------------------------------------------------------------------
// 1. Create your MCP server — exactly the same as any normal MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: SERVER_NAME,
  version: "0.1.0",
});

server.tool(
  "echo",
  "Echoes the input text back",
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

server.tool(
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
// 2. Connect via Skyhook instead of serving HTTP directly
//    This is the ONLY difference from a normal MCP server.
// ---------------------------------------------------------------------------

const transport = new SkyhookTransport({
  proxyUrl: PROXY_URL,
  serverId: SERVER_ID,
  onConnected: async () => {
    const httpUrl = PROXY_URL.replace(/^ws/, "http");
    const endpointUrl = `${httpUrl}/mcp/${encodeURIComponent(SERVER_ID)}`;
    await registerWithAgentCore({
      serverId: SERVER_ID,
      endpointUrl,
      name: SERVER_NAME,
      description: "Demo MCP server connected via Skyhook reverse proxy",
    });
  },
});

console.log(`[server] Starting ${SERVER_NAME} (id=${SERVER_ID})`);
console.log(`[server] Proxy: ${PROXY_URL}`);

await server.connect(transport);

const shutdown = () => {
  console.log("\n[server] Shutting down...");
  transport.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
