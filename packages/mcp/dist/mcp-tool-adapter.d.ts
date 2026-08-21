import type { McpClient } from "./mcp-client.js";
import type { ContextBlockProvenance, EventSink, NetworkBoundary, SessionId, TrustLevel, TurnId } from "@ar/contracts";
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
export declare function createMcpToolAdapter(client: McpToolSource, opts?: {
    events?: EventSink;
    sessionId?: SessionId;
    turnId?: TurnId;
    /** P2-21: local provenance context (server id + trust + boundary). */
    provenance?: McpProvenanceContext;
}): Promise<ToolLike[]>;
//# sourceMappingURL=mcp-tool-adapter.d.ts.map