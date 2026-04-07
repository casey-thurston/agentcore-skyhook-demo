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

## Infrastructure at Rest

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

---

## Registration Flow

When an MCP server starts, it registers with the proxy and with AgentCore Gateway:

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

---

## Call Flow

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

---

## Failure Cases

### Server Not Connected

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

### Server Disconnects Mid-Request

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

### Request Timeout

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

### Server Reconnects

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

Backoff resets to 1s after a successful connection. Jitter (0.75x–1.25x) prevents thundering herd when multiple servers reconnect simultaneously.

---

## Quick Start

### Local development (no AWS)

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

### Deploy to AWS

```bash
# Build and deploy the CDK stack
cd packages/infra && npx cdk deploy

# The stack outputs the ALB DNS name — use it as PROXY_URL
# PROXY_URL=ws://<alb-dns> SERVER_ID=my-server npx tsx packages/server/src/index.ts
```

---

## Project Structure

```
packages/
  proxy/              # Skyhook relay proxy (Fargate)
    src/index.ts      # Express + ws server (~200 lines core)
    Dockerfile
    src/__tests__/    # 11 integration tests
  server/             # Demo MCP server
    src/index.ts      # MCP tools (echo, get-time)
    src/skyhook-client.ts   # WebSocket client with reconnect
    src/agentcore.ts  # AgentCore Gateway registration
  infra/              # CDK infrastructure
    lib/skyhook-stack.ts    # VPC, ALB, Fargate, ECR
```
