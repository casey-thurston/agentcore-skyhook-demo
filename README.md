# Skyhook

**Reverse call flow proxy for MCP servers behind network partitions.**

Skyhook lets an MCP server that can't accept inbound connections serve clients as if it could. The server connects *out* to a lightweight proxy, and clients connect to the proxy using standard HTTP Streamable Transport — no DNS changes, no firewall rules, no VPN.

```
┌─────────────────────┐          ┌─────────────────────┐          ┌─────────────────────┐
│                     │          │                     │          │                     │
│     MCP Client      │──HTTP───▶│   Skyhook Proxy     │◀──WS────│    MCP Server       │
│                     │          │   (Fargate + ALB)    │          │   (behind firewall) │
│                     │◀─HTTP───│                     │───WS───▶│                     │
│                     │          │                     │          │                     │
└─────────────────────┘          └─────────────────────┘          └─────────────────────┘
      Your network                    AWS (shared)                  Partitioned network
```

The proxy is multi-tenant — one deployment serves any number of MCP servers, each identified by a `serverId`.

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

**Skyhook MCP server** — connects outbound through a proxy:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkyhookTransport } from "./skyhook-transport.js";

// 1. Define your server and tools (exactly the same!)
const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));

// 2. Connect via Skyhook (no Express, no inbound access needed)
const transport = new SkyhookTransport({
  proxyUrl: "ws://your-proxy-alb-dns",
  serverId: "my-server",
});
await server.connect(transport);
```

That's it. No Express server. No inbound ports. No firewall rules. Your tools, resources, prompts, and `_meta.resourceUI` metadata all work unchanged — the proxy relays MCP messages byte-for-byte without inspecting them.

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
| Client URL | `http://your-server/mcp` | `http://proxy-alb/mcp/your-server-id` |

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

From any machine with network access to the ALB:

```bash
# Initialize the MCP session
curl -s -X POST \
  http://skyhook-123456789.us-east-1.elb.amazonaws.com/mcp/my-server \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | jq

# Call a tool
curl -s -X POST \
  http://skyhook-123456789.us-east-1.elb.amazonaws.com/mcp/my-server \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello from the other side"}},"id":2}' | jq
```

### Step 6: Register with AgentCore Gateway (optional)

If you're using AWS AgentCore, register your proxy endpoint so agents can discover your server:

```typescript
import { SkyhookTransport } from "./skyhook-transport.js";

const transport = new SkyhookTransport({
  proxyUrl: process.env.PROXY_URL!,
  serverId: "my-server",
  onConnected: async () => {
    // Register the proxy's HTTP endpoint with AgentCore
    const endpointUrl = process.env.PROXY_URL!
      .replace(/^ws/, "http") + "/mcp/my-server";

    // Your AgentCore registration call here
    await registerWithAgentCore({ endpointUrl, ... });
  },
});
```

The `onConnected` callback fires every time the WebSocket connection is established (including reconnects), so your registration stays current.

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

When an MCP server starts, it connects to the proxy and optionally registers with AgentCore Gateway:

```
  MCP Server                      Skyhook Proxy                  AgentCore Gateway
      │                                │                                │
      │  1. WebSocket UPGRADE          │                                │
      │    GET /register/my-server     │                                │
      │───────────────────────────────▶│                                │
      │                                │                                │
      │  2. 101 Switching Protocols    │                                │
      │◀───────────────────────────────│                                │
      │                                │                                │
      │       WebSocket connected      │                                │
      │◀══════════════════════════════▶│                                │
      │                                │                                │
      │  3. Register endpoint URL      │                                │
      │    with AgentCore Gateway      │                                │
      │────────────────────────────────────────────────────────────────▶│
      │    "my server is reachable at  │                                │
      │     http://alb-dns/mcp/my-server"                               │
      │                                │                                │
      │  4. Registration confirmed     │                                │
      │◀────────────────────────────────────────────────────────────────│
      │                                │                                │
      │  ┌──────────────────────┐      │                                │
      │  │ Proxy sends PING     │      │                                │
      │  │ every 30s to keep    │      │                                │
      │  │ connection alive     │      │                                │
      │  └──────────────────────┘      │                                │
      │                                │                                │
```

The proxy holds the WebSocket open. The server appears in the `/health` endpoint and is ready to receive requests.

### Call Flow

When an MCP client sends a request, the proxy relays it to the server over the existing WebSocket:

```
  MCP Client                      Skyhook Proxy                    MCP Server
      │                                │                                │
      │  1. POST /mcp/my-server        │                                │
      │    { jsonrpc: "2.0",           │                                │
      │      method: "tools/call",     │                                │
      │      params: { name: "echo",   │                                │
      │        arguments: { text: "hi" }│                               │
      │      }, id: 1 }                │                                │
      │───────────────────────────────▶│                                │
      │                                │                                │
      │                                │  2. WebSocket message          │
      │                                │    { correlationId: "abc-123", │
      │                                │      type: "request",          │
      │                                │      body: <original request> }│
      │                                │───────────────────────────────▶│
      │                                │                                │
      │                                │                                │  3. MCP server
      │                                │                                │     processes
      │                                │                                │     request
      │                                │                                │
      │                                │  4. WebSocket message          │
      │                                │    { correlationId: "abc-123", │
      │                                │      type: "response",         │
      │                                │      body: <MCP response> }    │
      │                                │◀───────────────────────────────│
      │                                │                                │
      │  5. HTTP 200                   │                                │
      │    { jsonrpc: "2.0",           │                                │
      │      result: {                 │                                │
      │        content: [{ type: "text",│                               │
      │          text: "hi" }],        │                                │
      │        _meta: { resourceUI:    │                                │
      │          { title: "Echo" }}     │                                │
      │      }, id: 1 }               │                                │
      │◀───────────────────────────────│                                │
      │                                │                                │
```

The proxy never inspects or modifies MCP message content. Fields like `_meta.resourceUI` pass through byte-for-byte.

**Latency overhead:** ~10-20ms (in-memory correlation, no external state store).

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
- Forwards unsolicited notifications via the proxy's SSE broadcast
