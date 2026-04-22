import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookTransport } from "./skyhook-transport.js";
import { registerWithAgentCore, deregisterFromAgentCore } from "./agentcore.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_URL = process.env.PROXY_URL ?? "ws://localhost:3000";
const SERVER_ID = process.env.SERVER_ID ?? "demo";
const SERVER_NAME = process.env.SERVER_NAME ?? "Skyhook Demo Server";

// AgentCore Gateway configuration — clients connect to the gateway URL,
// the gateway forwards to the Skyhook proxy as an MCP target.
const GATEWAY_NAME = process.env.AGENTCORE_GATEWAY_NAME ?? "skyhook-gateway";
const GATEWAY_ROLE_ARN = process.env.AGENTCORE_GATEWAY_ROLE_ARN;
const JWT_DISCOVERY_URL = process.env.AGENTCORE_JWT_DISCOVERY_URL;
const JWT_ALLOWED_AUDIENCE = process.env.AGENTCORE_JWT_ALLOWED_AUDIENCE?.split(",");
const JWT_ALLOWED_CLIENTS = process.env.AGENTCORE_JWT_ALLOWED_CLIENTS?.split(",");

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
// 2. Connect via Skyhook and register with AgentCore Gateway
// ---------------------------------------------------------------------------

const transport = new SkyhookTransport({
  proxyUrl: PROXY_URL,
  serverId: SERVER_ID,
  onConnected: async () => {
    const proxyBaseUrl = PROXY_URL.replace(/^ws/, "http");
    const target = await registerWithAgentCore({
      serverId: SERVER_ID,
      proxyBaseUrl,
      name: SERVER_NAME,
      description: "MCP server reached via Skyhook reverse tunnel",
      gatewayName: GATEWAY_NAME,
      gatewayRoleArn: GATEWAY_ROLE_ARN,
      authorizerConfiguration:
        JWT_DISCOVERY_URL
          ? {
              customJWTAuthorizer: {
                discoveryUrl: JWT_DISCOVERY_URL,
                allowedAudience: JWT_ALLOWED_AUDIENCE,
                allowedClients: JWT_ALLOWED_CLIENTS,
              },
            }
          : undefined,
    });
    console.log(
      `[server] Clients should connect to AgentCore Gateway: ${target.gatewayUrl}`,
    );
  },
});

console.log(`[server] Starting ${SERVER_NAME} (id=${SERVER_ID})`);
console.log(`[server] Proxy: ${PROXY_URL}`);

await server.connect(transport);

const shutdown = async () => {
  console.log("\n[server] Shutting down...");
  try {
    await deregisterFromAgentCore(SERVER_ID);
  } catch (err) {
    console.error("[server] Deregister failed:", err);
  }
  transport.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
