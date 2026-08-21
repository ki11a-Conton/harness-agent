import type { ContextBlock, ContextBlockProvenance, NetworkBoundary, TrustLevel } from "@ar/contracts";
/**
 * P2-21 MCP Trust / Provenance.
 *
 * Every MCP tool that contributes content to the run must be attributable:
 *
 *   server id       → which MCP server exposed the tool
 *   tool id         → which tool produced the result
 *   version/schema  → fingerprint of the tool's schema at call time
 *   trust level     → how much the source is trusted (trusted/semi -trusted/
 *                     untrusted) so downstream context consumers can weigh it
 *   network boundary→ where the result originated (loopback / lan / internet)
 *
 * `McpResultProvenance` binds the schema hash of the exact snapshot the result
 * was resolved against, so a result can always be traced back to the tool shape
 * that produced it. `toContextBlock()` preserves the provenance on the
 * ContextBlock that enters the pipeline — content and metadata travel together.
 */
export interface McpProvenanceInput {
    serverId: string;
    toolId: string;
    /** Version or schema hash of the tool that produced the result. */
    version?: string;
    trust: TrustLevel;
    networkBoundary?: NetworkBoundary;
}
export declare function buildMcpProvenance(input: McpProvenanceInput): ContextBlockProvenance;
export interface ToContextBlockOptions {
    id: string;
    content: string;
    priority?: number;
    compressible?: boolean;
    ephemeral?: boolean;
    scope?: string;
    path?: string;
    timestamp?: number;
}
/**
 * Wrap an MCP result as a ContextBlock, PINNING the provenance that produced
 * it (server id, tool id, schema hash, trust, network boundary). The caller
 * decides trust/network boundary from the server config, never from the remote
 * response, so provenance cannot be spoofed by untrusted content.
 */
export declare function toContextBlock(input: McpProvenanceInput, opts: ToContextBlockOptions): ContextBlock;
/** Coarse token estimate consistent with the local tokenizer's char budget. */
export declare function estimateMcpTokens(content: string): number;
//# sourceMappingURL=mcp-provenance.d.ts.map