export function buildMcpProvenance(input) {
    return {
        kind: "mcp",
        serviceId: input.serverId,
        toolId: input.toolId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        trust: input.trust,
        ...(input.networkBoundary !== undefined ? { networkBoundary: input.networkBoundary } : {}),
    };
}
/**
 * Wrap an MCP result as a ContextBlock, PINNING the provenance that produced
 * it (server id, tool id, schema hash, trust, network boundary). The caller
 * decides trust/network boundary from the server config, never from the remote
 * response, so provenance cannot be spoofed by untrusted content.
 */
export function toContextBlock(input, opts) {
    return {
        id: opts.id,
        source: "mcp",
        trust: input.trust,
        priority: opts.priority ?? 1,
        tokens: estimateMcpTokens(opts.content),
        content: opts.content,
        compressible: opts.compressible ?? true,
        ephemeral: opts.ephemeral ?? false,
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
        provenance: buildMcpProvenance(input),
    };
}
/** Coarse token estimate consistent with the local tokenizer's char budget. */
export function estimateMcpTokens(content) {
    return Math.max(1, Math.ceil(content.length / 4));
}
//# sourceMappingURL=mcp-provenance.js.map