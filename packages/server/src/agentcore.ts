import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  UpdateGatewayTargetCommand,
  type GatewaySummary,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";

/**
 * AgentCore Gateway registration.
 *
 * Wires up an AWS Bedrock AgentCore Gateway in front of the Skyhook proxy
 * so that MCP clients connect to the *gateway* MCP endpoint rather than
 * directly to the proxy. The gateway forwards requests to the skyhook proxy
 * endpoint as an MCP target over a bidirectional HTTPS stream.
 *
 *   MCP Client  ──WS/StreamableHTTP──▶  AgentCore Gateway
 *                                             │
 *                                             ▼
 *                              HTTPS bidi stream (no SSE)
 *                                             │
 *                                             ▼
 *                                    Skyhook Proxy
 *                                             │
 *                                             ▼
 *                                  WebSocket tunnel back
 *                                  to local MCP server
 */

export interface AgentCoreRegistration {
  /** Stable identifier for this MCP server (used as the proxy routing key) */
  serverId: string;
  /** Base URL of the Skyhook proxy (e.g. http://alb-dns or http://localhost:3000) */
  proxyBaseUrl: string;
  /** Human-readable name shown in AgentCore */
  name: string;
  /** Optional description */
  description?: string;
  /**
   * Name of the AgentCore Gateway to create-or-reuse. All MCP servers sharing
   * a proxy can register as targets of a single gateway.
   */
  gatewayName?: string;
  /** IAM role the gateway assumes when invoking targets. Required for real registration. */
  gatewayRoleArn?: string;
  /** JWT authorizer configuration (required by AgentCore Gateway CreateGateway) */
  authorizerConfiguration?: {
    customJWTAuthorizer: {
      discoveryUrl: string;
      allowedAudience?: string[];
      allowedClients?: string[];
    };
  };
  /** AWS region; falls back to AWS_REGION env var */
  region?: string;
}

export interface AgentCoreTarget {
  gatewayId: string;
  /** MCP endpoint URL that clients should connect to — this is the Gateway URL, not the proxy URL */
  gatewayUrl: string;
  targetId: string;
}

// Module-level cache so reconnects don't spam CreateGatewayTarget.
const registrationCache = new Map<string, AgentCoreTarget>();

/**
 * Register (or update) this MCP server with AgentCore Gateway.
 *
 * The gateway endpoint is configured to forward to the Skyhook proxy's
 * streamable HTTP endpoint for this serverId. Clients connect to the
 * returned gatewayUrl, not the proxy directly.
 */
export async function registerWithAgentCore(
  registration: AgentCoreRegistration,
): Promise<AgentCoreTarget> {
  const {
    serverId,
    proxyBaseUrl,
    name,
    description,
    gatewayName = "skyhook-gateway",
    gatewayRoleArn,
    authorizerConfiguration,
    region = process.env.AWS_REGION,
  } = registration;

  const targetEndpoint = `${proxyBaseUrl.replace(/\/$/, "")}/mcp/${encodeURIComponent(serverId)}`;

  console.log(
    `[agentcore] Registering "${serverId}" → target ${targetEndpoint}`,
  );

  if (!gatewayRoleArn || !authorizerConfiguration) {
    console.warn(
      "[agentcore] Missing AGENTCORE_GATEWAY_ROLE_ARN or authorizer config — " +
        "skipping real registration. Set AGENTCORE_GATEWAY_ROLE_ARN, " +
        "AGENTCORE_JWT_DISCOVERY_URL, and AGENTCORE_JWT_ALLOWED_AUDIENCE to enable.",
    );
    const stub: AgentCoreTarget = {
      gatewayId: "dev-local",
      gatewayUrl: targetEndpoint,
      targetId: `dev-${serverId}`,
    };
    registrationCache.set(serverId, stub);
    return stub;
  }

  const client = new BedrockAgentCoreControlClient({ region });

  const gateway = await findOrCreateGateway(client, {
    name: gatewayName,
    roleArn: gatewayRoleArn,
    authorizerConfiguration,
    description: "Skyhook — routes MCP traffic to proxied servers",
  });

  const targetName = mcpTargetName(serverId);
  const existingTarget = await findTarget(client, gateway.gatewayId, targetName);

  const targetConfiguration = {
    mcp: {
      mcpServer: {
        endpoint: targetEndpoint,
      },
    },
  };

  let targetId: string;
  if (existingTarget) {
    const res = await client.send(
      new UpdateGatewayTargetCommand({
        gatewayIdentifier: gateway.gatewayId,
        targetId: existingTarget.targetId,
        name: targetName,
        description,
        targetConfiguration,
        credentialProviderConfigurations: [
          { credentialProviderType: "GATEWAY_IAM_ROLE" },
        ],
      }),
    );
    targetId = res.targetId ?? existingTarget.targetId!;
    console.log(`[agentcore] Updated MCP target ${targetId}`);
  } else {
    const res = await client.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: gateway.gatewayId,
        name: targetName,
        description: description ?? `Skyhook target for ${name}`,
        targetConfiguration,
        credentialProviderConfigurations: [
          { credentialProviderType: "GATEWAY_IAM_ROLE" },
        ],
      }),
    );
    targetId = res.targetId!;
    console.log(`[agentcore] Created MCP target ${targetId}`);
  }

  const result: AgentCoreTarget = {
    gatewayId: gateway.gatewayId,
    gatewayUrl: gateway.gatewayUrl,
    targetId,
  };
  registrationCache.set(serverId, result);
  console.log(
    `[agentcore] Clients should connect to gateway MCP endpoint: ${gateway.gatewayUrl}`,
  );
  return result;
}

export async function deregisterFromAgentCore(
  serverId: string,
  region = process.env.AWS_REGION,
): Promise<void> {
  const cached = registrationCache.get(serverId);
  if (!cached || cached.gatewayId === "dev-local") {
    registrationCache.delete(serverId);
    return;
  }
  const client = new BedrockAgentCoreControlClient({ region });
  await client.send(
    new DeleteGatewayTargetCommand({
      gatewayIdentifier: cached.gatewayId,
      targetId: cached.targetId,
    }),
  );
  registrationCache.delete(serverId);
  console.log(`[agentcore] Deregistered "${serverId}"`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GatewayHandle {
  gatewayId: string;
  gatewayUrl: string;
}

async function findOrCreateGateway(
  client: BedrockAgentCoreControlClient,
  args: {
    name: string;
    roleArn: string;
    authorizerConfiguration: NonNullable<
      AgentCoreRegistration["authorizerConfiguration"]
    >;
    description: string;
  },
): Promise<GatewayHandle> {
  const list = await client.send(new ListGatewaysCommand({}));
  const existing = (list.items ?? []).find(
    (g: GatewaySummary) => g.name === args.name,
  );
  if (existing?.gatewayId) {
    const details = await client.send(
      new GetGatewayCommand({ gatewayIdentifier: existing.gatewayId }),
    );
    if (details.gatewayUrl) {
      return { gatewayId: existing.gatewayId, gatewayUrl: details.gatewayUrl };
    }
  }

  const created = await client.send(
    new CreateGatewayCommand({
      name: args.name,
      roleArn: args.roleArn,
      protocolType: "MCP",
      protocolConfiguration: {
        mcp: {
          supportedVersions: ["2025-03-26"],
          searchType: "SEMANTIC",
        },
      },
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: args.authorizerConfiguration,
      description: args.description,
    }),
  );
  if (!created.gatewayId || !created.gatewayUrl) {
    throw new Error("CreateGateway response missing gatewayId/gatewayUrl");
  }
  console.log(`[agentcore] Created gateway ${created.gatewayId} at ${created.gatewayUrl}`);
  return { gatewayId: created.gatewayId, gatewayUrl: created.gatewayUrl };
}

async function findTarget(
  client: BedrockAgentCoreControlClient,
  gatewayId: string,
  targetName: string,
): Promise<TargetSummary | undefined> {
  const list = await client.send(
    new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId }),
  );
  return (list.items ?? []).find((t: TargetSummary) => t.name === targetName);
}

function mcpTargetName(serverId: string): string {
  return `skyhook-${serverId}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 64);
}
