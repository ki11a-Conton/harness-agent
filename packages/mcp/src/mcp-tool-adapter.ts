import type { McpClient } from "./mcp-client.js";
import type {
  ContextBlockProvenance,
  EventSink,
  NetworkBoundary,
  SessionId,
  TrustLevel,
  TurnId,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { detectPromptInjection, securityErrorCode } from "@ar/security";
import { schemaHash } from "./mcp-tool-view.js";

export interface ToolLikeHandlerContext {
  args: unknown;
  /** P1-10: caller-provided cancellation, forwarded to the MCP call. */
  signal?: AbortSignal;
}

/**
 * Adapter-shaped tool description. There is no shared ToolLike in
 * @ar/tools yet, so the shape is declared here: everything the client
 * knows about a remote tool plus a handler that invokes it.
 */
export interface ToolLike {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  /** P2-21: provenance pinned by the adapter when a server context is provided. */
  provenance?: ContextBlockProvenance;
  handler(ctx: ToolLikeHandlerContext): Promise<unknown>;
}

/** The client surface the adapter needs; McpClient satisfies it structurally. */
export type McpToolSource = Pick<McpClient, "listTools" | "callTool" | "ensureReconnected">;

/**
 * Local-only provenance context for an MCP server. All of these come from the
 * operator's SERVER CONFIGURATION (never from the remote response), so the
 * trust level / network boundary cannot be spoofed by untrusted content.
 * The schema hash is derived locally from the tool's snapshot schema.
 */
export interface McpProvenanceContext {
  serverId: string;
  trust: TrustLevel;
  networkBoundary?: NetworkBoundary;
}

/** Maps every tool exposed by the client into a ToolLike that calls it.
 *  P0-8: a remote tool whose description carries prompt-injection material
 *  is rejected (fail-closed) — MCP descriptions are low-trust content and
 *  must not smuggle instructions into the agent's context.
 *  P0-7: when an EventSink + session identity are provided, the rejection is
 *  also observable on the event stream as security.mcp_denied (never silent,
 *  never stderr-only). */
export async function createMcpToolAdapter(
  client: McpToolSource,
  opts: {
    events?: EventSink;
    sessionId?: SessionId;
    turnId?: TurnId;
    /** P2-21: local provenance context (server id + trust + boundary). */
    provenance?: McpProvenanceContext;
  } = {},
): Promise<ToolLike[]> {
  const tools = await client.listTools();
  return tools.map((tool) => {
    if (tool.description !== undefined) {
      const report = detectPromptInjection(tool.description);
      if (report.hasInjection) {
        if (opts.events !== undefined && opts.sessionId !== undefined) {
          void opts.events
            .emit(opts.sessionId, "security.mcp_denied", {
              target: tool.name,
              reason: `mcp tool description blocked for prompt injection (${report.reasons.join(", ")})`,
              source: "mcp-adapter",
              code: securityErrorCode("mcp"),
              details: report.reasons,
            }, opts.turnId)
            .catch(() => {});
        }
        throw new AgentError(
          errorInfo(
            "MCP_DENIED",
            `mcp tool "${tool.name}" rejected: description contains prompt-injection material (${report.reasons.join(", ")})`,
          ),
        );
      }
    }
    const proven = opts.provenance;
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
      // P2-21: pin local provenance onto the tool so a result can always be
      // traced back to its source server and the exact schema that produced it.
      ...(proven !== undefined
        ? {
            provenance: {
              kind: "mcp",
              serviceId: proven.serverId,
              toolId: tool.name,
              version: schemaHash(tool.inputSchema),
              trust: proven.trust,
              ...(proven.networkBoundary !== undefined
                ? { networkBoundary: proven.networkBoundary }
                : {}),
            } satisfies ContextBlockProvenance,
          }
        : {}),
      handler: async (ctx: ToolLikeHandlerContext) => {
        // P2-40: auto-reconnect a disconnected client before the call (bounded by
        // the mcpReconnect retry-kind spec). A successful re-handshake is emitted
        // as a retry.mcpReconnect event when an event sink is wired.
        const reconnected = await client.ensureReconnected();
        if (reconnected && opts.events !== undefined && opts.sessionId !== undefined) {
          await opts.events
            .emit(opts.sessionId, "retry.mcpReconnect", { target: tool.name, source: "mcp-adapter" }, opts.turnId)
            .catch(() => {});
        }
        return client.callTool(tool.name, ctx.args, ctx.signal);
      },
    };
  });
}
