# Skyhook

**Reverse call flow proxy for MCP servers behind network partitions, fronted by AWS Bedrock AgentCore Gateway.**

Skyhook lets an MCP server that can't accept inbound connections serve clients as if it could. The local server connects *out* to a lightweight proxy, and on connect it registers itself as a target of AWS Bedrock **AgentCore Gateway**. Clients talk to the gateway over its bidirectional MCP transport (WebSocket / streamable HTTP — no SSE); the gateway forwards to the Skyhook proxy, which tunnels requests down the existing WebSocket to the local server.

```
┌──────────────┐    WS /       ┌───────────────────┐   HTTPS bidi    ┌──────────────┐     WS      ┌──────────────┐
│              │   streamable  │                   │   (no SSE)      │              │             │              │
│  MCP Client  │──────────────▶│ AgentCore Gateway │────────────────▶│ Skyhook Proxy│────────────▶│  MCP Server  │
│              │◀──────────────│ (AWS-managed MCP) │◀────────────────│  (Fargate)   │◀────────────│ (partitioned)│
│              │               │                   │                 │              │             │              │
└──────────────┘               └───────────────────┘                 └──────────────┘             └──────────────┘
   Your network                       AWS Bedrock                       AWS VPC                    Partitioned
                                                                                                    network
```

The proxy is multi-tenant — one deployment serves any number of MCP servers, each identified by a `serverId` and exposed through the shared AgentCore Gateway as an independent MCP target.

---

## Normal MCP Server vs Skyhook

Your MCP server code stays exactly the same. You only change the transport.

**Normal MCP server** — accepts inbound HTTP connections directly:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

// 1. Define your server and tools (same either way)
const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));

// 2. Serve via HTTP (requires inbound network access)
const app = express();
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
app.post("/mcp", transport.handleRequest);
app.get("/mcp", transport.handleRequest);
await server.connect(transport);
app.listen(3000);
```

**Skyhook MCP server** — connects outbound through a proxy and auto-registers with AgentCore Gateway:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookTransport } from "./skyhook-transport.js";
import { registerWithAgentCore } from "./agentcore.js";

// 1. Define your server and tools (exactly the same!)
const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));

// 2. Connect via Skyhook and register the proxy endpoint
//    with AgentCore Gateway as an MCP target.
const transport = new SkyhookTransport({
  proxyUrl: "ws://your-proxy-alb-dns",
  serverId: "my-server",
  onConnected: async () => {
    await registerWithAgentCore({
      serverId: "my-server",
      proxyBaseUrl: "http://your-proxy-alb-dns",
      name: "My Server",
      gatewayRoleArn: process.env.AGENTCORE_GATEWAY_ROLE_ARN!,
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: process.env.AGENTCORE_JWT_DISCOVERY_URL!,
          allowedAudience: [process.env.AGENTCORE_JWT_ALLOWED_AUDIENCE!],
        },
      },
    });
  },
});
await server.connect(transport);
```

That's it. No Express server. No inbound ports. No firewall rules. Your tools, resources, prompts, and `_meta.resourceUI` metadata all work unchanged — the gateway and proxy relay MCP messages byte-for-byte without inspecting them.

---

## What Changes, What Doesn't

| Aspect | Normal | Skyhook |
|---|---|---|
| Tool definitions | Same | Same |
| Resource definitions | Same | Same |
| Prompt definitions | Same | Same |
| `_meta.resourceUI` | Same | Same |
| Transport | `StreamableHTTPServerTransport` | `SkyhookTransport` |
| Network direction | Client → Server (inbound) | Server → Proxy (outbound) |
| Express/HTTP server | Required | Not needed |
| Inbound ports | Must be open | None |
| Client URL | `http://your-server/mcp` | AgentCore Gateway URL (e.g. `https://<gw-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`) |
| Client transport | HTTP + SSE | WebSocket / Streamable HTTP (bidirectional, no SSE) |
| Discovery | Manual | Auto-registered with AgentCore Gateway on connect |

---

## Step-by-Step Setup Guide

### Step 1: Deploy the Proxy

The proxy is a shared piece of infrastructure. Deploy it once, and any number of MCP servers can connect to it.

```bash
# Clone this repo
git clone <repo-url> && cd agentcore-skyhook-demo

# Install dependencies
npm install

# Deploy the CDK stack (requires AWS credentials + CDK bootstrap)
cd packages/infra
npx cdk bootstrap   # first time only
npx cdk deploy
```

CDK outputs the ALB DNS name:

```
Outputs:
SkyhookStack.AlbDnsName = skyhook-123456789.us-east-1.elb.amazonaws.com
SkyhookStack.ProxyUrl = http://skyhook-123456789.us-east-1.elb.amazonaws.com
SkyhookStack.WebSocketUrl = ws://skyhook-123456789.us-east-1.elb.amazonaws.com
```

Save the `WebSocketUrl` — your MCP servers will need it.

### Step 2: Add SkyhookTransport to Your Server

Copy `packages/server/src/skyhook-transport.ts` into your project, or install the dependencies it needs:

```bash
npm install ws
npm install -D @types/ws
```

The transport is a single file (~170 lines) with one dependency (`ws`). It implements the MCP SDK's `Transport` interface, so it works with `server.connect()` like any other transport.

### Step 3: Swap the Transport

In your MCP server, replace the HTTP transport with `SkyhookTransport`:

```diff
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
- import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
- import express from "express";
+ import { SkyhookTransport } from "./skyhook-transport.js";

  const server = new McpServer({ name: "my-server", version: "1.0.0" });

  // ... your tools, resources, prompts stay exactly the same ...

- const app = express();
- const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
- app.post("/mcp", transport.handleRequest);
- app.get("/mcp", transport.handleRequest);
- await server.connect(transport);
- app.listen(3000);
+ const transport = new SkyhookTransport({
+   proxyUrl: process.env.PROXY_URL ?? "ws://localhost:3000",
+   serverId: process.env.SERVER_ID ?? "my-server",
+ });
+ await server.connect(transport);
```

You can also remove `express` from your dependencies if it was only used for MCP.

### Step 4: Run Your Server

```bash
PROXY_URL=ws://skyhook-123456789.us-east-1.elb.amazonaws.com \
SERVER_ID=my-server \
node dist/index.js
```

You should see:

```
[skyhook] Connecting to ws://skyhook-123456789.us-east-1.elb.amazonaws.com/register/my-server
[skyhook] Connected as "my-server"
```

### Step 5: Verify

The server logs the AgentCore Gateway URL it registered with on startup — that's the URL your clients use.

Verify the proxy is healthy and has your server connected:

```bash
curl -s http://skyhook-123456789.us-east-1.elb.amazonaws.com/health | jq
# → { "status": "ok", "servers": ["my-server"] }
```

Then send an MCP request to the **gateway** (not the proxy directly):

```bash
# Replace with the gatewayUrl printed by the server on startup.
GATEWAY_URL="https://<gw-id>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"
TOKEN="$(./get-jwt.sh)"   # JWT from whatever IdP your authorizer trusts

curl -s -X POST "$GATEWAY_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}},"id":1}' | jq
```

For fully bidirectional clients (notifications, server-initiated streams) use the WebSocket MCP transport that the Gateway exposes — the gateway multiplexes requests/notifications over a single socket rather than falling back to SSE.

### Step 6: (Optional) Hit the proxy directly, bypassing the gateway

For local debugging you can connect straight to the proxy's WebSocket MCP endpoint:

```bash
wscat -c ws://localhost:3000/mcp-ws/my-server
> {"jsonrpc":"2.0","method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}},"id":1}
< {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"hi"}]},"id":1}
```

The proxy also accepts one-shot `POST /mcp/<serverId>` for simple request/response (this is the endpoint AgentCore Gateway uses as its MCP target).

---

## Migrating an Existing MCP Server

Here's a complete before-and-after for a realistic MCP server that provides database query tools.

### Before: Standard HTTP Serving

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { queryDatabase } from "./db.js";

const server = new McpServer({
  name: "db-explorer",
  version: "2.1.0",
});

server.tool(
  "query",
  "Execute a read-only SQL query",
  { sql: z.string(), limit: z.number().default(100) },
  async ({ sql, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await queryDatabase(sql, limit)) }],
    _meta: {
      resourceUI: { title: "Query Results", icon: "database" },
    },
  }),
);

server.resource("schema", "database://schema", async () => ({
  contents: [{ uri: "database://schema", mimeType: "application/json", text: JSON.stringify(await getSchema()) }],
}));

// ---- HTTP serving (requires inbound access on port 3000) ----
const app = express();
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
app.post("/mcp", transport.handleRequest.bind(transport));
app.get("/mcp", transport.handleRequest.bind(transport));
app.delete("/mcp", transport.handleRequest.bind(transport));
await server.connect(transport);
app.listen(3000, () => console.log("MCP server on port 3000"));
```

### After: Skyhook (Behind a Partition)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookTransport } from "./skyhook-transport.js";    // ← new import
import { z } from "zod";
import { queryDatabase } from "./db.js";

const server = new McpServer({
  name: "db-explorer",
  version: "2.1.0",
});

server.tool(
  "query",
  "Execute a read-only SQL query",
  { sql: z.string(), limit: z.number().default(100) },
  async ({ sql, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await queryDatabase(sql, limit)) }],
    _meta: {
      resourceUI: { title: "Query Results", icon: "database" },
    },
  }),
);

server.resource("schema", "database://schema", async () => ({
  contents: [{ uri: "database://schema", mimeType: "application/json", text: JSON.stringify(await getSchema()) }],
}));

// ---- Skyhook (connects outbound, no inbound ports needed) ----     // ← changed
const transport = new SkyhookTransport({                               // ← changed
  proxyUrl: process.env.PROXY_URL ?? "ws://localhost:3000",            // ← changed
  serverId: process.env.SERVER_ID ?? "db-explorer",                    // ← changed
});                                                                    // ← changed
await server.connect(transport);                                       // ← changed
```

**Lines changed: 11 removed, 6 added.** Everything above the transport section is identical.

### What to watch out for

- **Client URL changes**: Clients now connect to `http://<proxy-alb>/mcp/<serverId>` instead of `http://<your-server>/mcp`. Update any client configurations or AgentCore registrations.
- **Express is no longer needed** for MCP serving. If your server used Express for other purposes (health checks, metrics), you can keep it — it just won't be serving MCP requests anymore.
- **Environment variables**: Your server now needs `PROXY_URL` and `SERVER_ID` instead of (or in addition to) `PORT`.
- **Reconnection is automatic**: If the network blips, Skyhook reconnects with exponential backoff (1s → 2s → 4s → ... → 30s max, with jitter). You don't need to add retry logic.
- **Multiple servers per proxy**: You can run many MCP servers (different `serverId`s) against the same proxy. No additional infrastructure needed.

---

## Local Development (No AWS)

You can run the full stack locally for development and testing:

```bash
# Install dependencies
npm install

# Terminal 1 — start the proxy
cd packages/proxy && npx tsx src/index.ts

# Terminal 2 — start the demo MCP server
cd packages/server && PROXY_URL=ws://localhost:3000 SERVER_ID=demo npx tsx src/index.ts

# Terminal 3 — send an MCP request
curl -s -X POST http://localhost:3000/mcp/demo \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}},"id":1}' | jq
```

### Run tests

```bash
cd packages/proxy && npx vitest run
```

The integration tests spin up real proxy instances and WebSocket connections in-process — no AWS credentials needed.

---

## Architecture Details

### Infrastructure at Rest

After `cdk deploy`, the following resources exist in your AWS account:

```
                         ┌──────────────────────────────────────────────────┐
                         │                  AWS Account                     │
                         │                                                  │
   Internet              │   ┌──────────┐       ┌────────────────────┐     │
  ─────────────────────────▶│          │       │   ECS Fargate       │     │
                         │   │   ALB    │──────▶│                    │     │
  ◀─────────────────────────│          │       │   skyhook-proxy     │     │
                         │   │  :80     │       │   :3000             │     │
                         │   └──────────┘       │                    │     │
                         │        │              │   0.25 vCPU        │     │
                         │   idle timeout:       │   512 MB           │     │
                         │   3600s (for WS)      └────────────────────┘     │
                         │                                                  │
                         │   ┌──────────┐       ┌────────────────────┐     │
                         │   │   ECR    │       │   CloudWatch Logs  │     │
                         │   │   Repo   │       │   (1 week retention)│     │
                         │   └──────────┘       └────────────────────┘     │
                         │                                                  │
                         │   VPC: 2 public subnets, no NAT gateway          │
                         └──────────────────────────────────────────────────┘
```

**Cost at rest:** ~$15/month (ALB hourly + Fargate 0.25 vCPU). No NAT gateway costs.

### Registration Flow

When an MCP server starts, it connects to the proxy and registers with AgentCore Gateway using the AWS SDK:

```
  MCP Server                Skyhook Proxy        AgentCore Gateway (AWS)
      │                          │                          │
      │ 1. WebSocket UPGRADE     │                          │
      │    /register/my-server   │                          │
      │─────────────────────────▶│                          │
      │                          │                          │
      │ 2. 101 Switching         │                          │
      │◀─────────────────────────│                          │
      │                          │                          │
      │ 3. ListGateways(name=skyhook-gateway)               │
      │─────────────────────────────────────────────────────▶│
      │    (CreateGateway if missing)                        │
      │◀─────────────────────────────────────────────────────│
      │                          │                          │
      │ 4. CreateGatewayTarget                               │
      │    { targetConfiguration.mcp.mcpServer.endpoint:     │
      │      http://proxy-alb/mcp/my-server }                │
      │─────────────────────────────────────────────────────▶│
      │                          │                          │
      │ 5. Target ready — gateway will forward client        │
      │    MCP traffic to the proxy endpoint over a          │
      │    bidirectional HTTPS stream (no SSE).              │
      │◀─────────────────────────────────────────────────────│
      │                          │                          │
      │  ┌──────────────────────┐│                          │
      │  │ Proxy sends PING     ││                          │
      │  │ every 30s to keep    ││                          │
      │  │ the tunnel alive     ││                          │
      │  └──────────────────────┘│                          │
```

After registration clients connect to the `gatewayUrl` returned by `CreateGateway`, not to the proxy ALB.

### Call Flow

When an MCP client sends a request, it goes through the gateway, then the proxy, then the WebSocket tunnel to the server. Every leg is a single bidirectional channel for the lifetime of the exchange:

```
  MCP Client         AgentCore Gateway          Skyhook Proxy             MCP Server
      │                     │                        │                         │
      │ 1. MCP frame        │                        │                         │
      │    (WS / streamable │                        │                         │
      │     HTTP, no SSE)   │                        │                         │
      │────────────────────▶│                        │                         │
      │                     │                        │                         │
      │                     │ 2. POST /mcp/my-server │                         │
      │                     │    Content-Type:       │                         │
      │                     │      application/      │                         │
      │                     │      x-ndjson          │                         │
      │                     │    (chunked HTTP — one │                         │
      │                     │     JSON frame per line)│                        │
      │                     │───────────────────────▶│                         │
      │                     │                        │                         │
      │                     │                        │ 3. { correlationId,     │
      │                     │                        │     type:"request",     │
      │                     │                        │     body } over WS      │
      │                     │                        │────────────────────────▶│
      │                     │                        │                         │
      │                     │                        │ 4. stream frames        │
      │                     │                        │    type:"stream"        │
      │                     │                        │    final:false          │
      │                     │                        │   (progress / sampling) │
      │                     │                        │◀────────────────────────│
      │                     │ ◀─NDJSON line          │                         │
      │ ◀─MCP frame         │                        │                         │
      │                     │                        │ 5. terminal frame       │
      │                     │                        │    type:"response"      │
      │                     │                        │    final:true           │
      │                     │                        │◀────────────────────────│
      │                     │ ◀─NDJSON line + close  │                         │
      │ ◀─MCP frame + close │                        │                         │
```

Each MCP exchange uses **one** chunked HTTP response on the gateway↔proxy hop and **one** WebSocket on the proxy↔server hop. Intermediate frames (progress notifications, server-initiated requests during a tool call) flow back to the client without opening a new connection or falling back to SSE.

Neither the gateway nor the proxy inspects MCP payloads. `_meta.resourceUI` and other fields pass through byte-for-byte.

**Latency overhead:** ~20-40ms (gateway hop + in-memory proxy correlation, no external state store).

### Caveats / Honest gaps

- **Mid-exchange client→server messages** (e.g. responding to a `sampling/createMessage` from the server) need a separate POST from the client's perspective — chunked HTTP is half-duplex per request. The gateway-to-proxy stream carries everything in the server→client direction; replies in the other direction ride on a fresh POST that the proxy correlates by JSON-RPC `id`.
- **AgentCore Gateway target protocol**: AWS documents MCP targets as Streamable HTTP. We deliberately use `application/x-ndjson` (chunked, no SSE). Most HTTP clients consume this fine; if a future AgentCore Gateway version *requires* `text/event-stream` for streamed targets it would have to be re-enabled there. The proxy's WebSocket endpoint (`/mcp-ws/<serverId>`) remains a fully bidirectional alternative for clients that bypass the gateway.

### Failure Cases

#### Server Not Connected

```
  MCP Client                      Skyhook Proxy
      │                                │
      │  POST /mcp/unknown-server      │          (no WebSocket
      │───────────────────────────────▶│           registered for
      │                                │           this serverId)
      │  HTTP 503                      │
      │  { error: "Server not          │
      │    connected" }                │
      │◀───────────────────────────────│
      │                                │
```

#### Server Disconnects Mid-Request

```
  MCP Client                      Skyhook Proxy                    MCP Server
      │                                │                                │
      │  POST /mcp/my-server           │                                │
      │───────────────────────────────▶│                                │
      │                                │──request──▶│                   │
      │                                │            │                   │
      │                                │      WebSocket closes    ╳ ────│
      │                                │◀─────── (connection lost)      │
      │                                │                                │
      │  HTTP 502                      │  Pending request rejected      │
      │  { error: "Server              │  immediately — no waiting      │
      │    disconnected" }             │  for timeout                   │
      │◀───────────────────────────────│                                │
      │                                │                                │
```

All pending requests for the disconnected server are rejected immediately (502), not after a timeout.

#### Request Timeout

```
  MCP Client                      Skyhook Proxy                    MCP Server
      │                                │                                │
      │  POST /mcp/my-server           │                                │
      │───────────────────────────────▶│                                │
      │                                │──request──────────────────────▶│
      │                                │                                │
      │                                │          ... 30 seconds ...    │  (server is
      │                                │          (configurable)        │   stuck or
      │                                │                                │   very slow)
      │  HTTP 504                      │                                │
      │  { error: "Request timeout" }  │  Timer fires, pending          │
      │◀───────────────────────────────│  request cleaned up            │
      │                                │                                │
```

#### Server Reconnects

```
  MCP Server                      Skyhook Proxy
      │                                │
      │     WebSocket closes     ╳ ────│  (network blip, crash, etc.)
      │                                │
      │  ┌───────────────────┐         │  Proxy removes old connection
      │  │ Exponential backoff│         │  and rejects pending requests
      │  │ 1s → 2s → 4s → 8s│         │
      │  │ (max 30s + jitter)│         │
      │  └───────────────────┘         │
      │                                │
      │  WebSocket UPGRADE             │
      │  GET /register/my-server       │
      │───────────────────────────────▶│
      │                                │
      │  101 Switching Protocols       │  Proxy accepts new connection;
      │◀───────────────────────────────│  serverId is immediately
      │                                │  available for client requests
      │  Re-register with AgentCore    │
      │──────────────────────────────▶ ···
      │                                │
```

Backoff resets to 1s after a successful connection. Jitter (0.75x-1.25x) prevents thundering herd when multiple servers reconnect simultaneously.

---

## Project Structure

```
packages/
  proxy/                          # Skyhook relay proxy (runs on Fargate)
    src/index.ts                  # Express + ws server (~200 lines core)
    Dockerfile
    src/__tests__/                # 11 integration tests
  server/                         # Demo MCP server + reusable transport
    src/skyhook-transport.ts      # ← The file you copy into your project
    src/skyhook-client.ts         # Lower-level WebSocket client (optional)
    src/index.ts                  # Demo server using SkyhookTransport
    src/agentcore.ts              # AgentCore Gateway registration helper
  infra/                          # CDK infrastructure
    lib/skyhook-stack.ts          # VPC, ALB, Fargate, ECR
```

### Key file: `skyhook-transport.ts`

This is the one file you need to add to your MCP server project. It:

- Implements the MCP SDK `Transport` interface (drop-in replacement for `StreamableHTTPServerTransport`)
- Manages the WebSocket connection to the Skyhook proxy
- Handles automatic reconnection with exponential backoff + jitter
- Correlates JSON-RPC request/response IDs to proxy correlation IDs
- Forwards unsolicited notifications over the proxy's client WebSocket fan-out (no SSE)
