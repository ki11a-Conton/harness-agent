/**
 * P2-20 dynamic MCP tool refresh — snapshot-isolated tool view.
 *
 * A remote server can change its tool set at any time. The hard questions the
 * plan asks:
 *
 *   1. Is the current turn's tool view a snapshot?   YES.
 *      `beginTurn(turnId)` pins the committed view; a turn never sees tools
 *      added/removed mid-turn. `toolsForTurn(turnId)` is stable.
 *
 *   2. Can new tools bypass policy mid-turn?         NO.
 *      A refresh that runs while a turn holds a snapshot only *stages* the
 *      diff. Nothing reaches the active view until the next safe boundary
 *      (`commitStaged()` on the following turn start). A newly discovered tool
 *      is thus registered as an ordinary tool at a boundary and still flows
 *      through the normal permission/sandbox pipeline — it can never appear
 *      inside an already-running turn.
 *
 *   3. Schema mismatch fails structurally?           YES.
 *      `resolveTool` hashes the remote schema and compares it to the frozen
 *      snapshot entry; a changed schema at call time is a structured
 *      TOOL_SCHEMA_ERROR, never a silently-wrong invocation.
 *
 * Diff & validation:
 *   - duplicate tool name    → refresh throws (no partial apply).
 *   - tool removed           → diff.removed is reported and the committed view
 *                               drops it (on commit).
 *   - schema changed         → diff.changed reports (name, oldHash, newHash).
 *   - partial/malformed tool → refresh throws TOOL_SCHEMA_ERROR, view unchanged.
 */
export type McpToolInfoLike = {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
};
export interface McpToolViewEntry {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    schemaHash: string;
}
export declare function schemaHash(schema?: Record<string, unknown>): string;
export interface McpToolViewDiff {
    added: string[];
    removed: string[];
    changed: Array<{
        name: string;
        oldHash: string;
        newHash: string;
    }>;
}
/** The minimal listTools surface the view needs (McpClient satisfies it). */
export interface McpToolListSource {
    listTools(): Promise<McpToolInfoLike[]>;
}
export declare class McpToolView {
    private readonly source;
    private committed;
    private staged;
    private pinnedTurn;
    constructor(source: McpToolListSource);
    /** Committed tool names (visible at the next safe boundary). */
    committedNames(): string[];
    /** Number of committed tools. */
    size(): number;
    /** Whether a tool is visible to the current turn. */
    has(name: string): boolean;
    /**
     * Fetch the latest remote tools and stage a refresh. If no turn has pinned a
     * snapshot, the refresh is applied immediately; otherwise it is only staged
     * until the next `commitStaged()` (safe-boundary). Returns the computed diff
     * against the committed view. Throws (duplicate name / malformed entry)
     * WITHOUT mutating the view.
     */
    refresh(): Promise<McpToolViewDiff>;
    /**
     * Commit any staged refresh. Called at a safe boundary (e.g. the start of a
     * turn after the previous turn finished). No-op when nothing is staged.
     */
    commitStaged(): McpToolViewDiff;
    /**
     * Pin the current committed view as the snapshot for this turn. Any staged
     * refresh is committed here (the turn boundary), then frozen for the turn.
     * A mid-turn refresh can no longer influence this turn's view.
     */
    beginTurn(turnId: string): McpToolViewDiff;
    endTurn(turnId: string): void;
    /** The frozen snapshot for the current turn. */
    snapshot(): McpToolViewEntry[];
    /**
     * Resolve a tool for invocation: verifies the requested tool exists and that
     * the *provided* schema still matches the frozen snapshot. A missing tool or
     * a schema mismatch is a structured TOOL_SCHEMA_ERROR (fail structurally).
     */
    resolveTool(name: string, providedSchema?: Record<string, unknown>): McpToolViewEntry;
    private validate;
    private diff;
    private toEntry;
    private applyCommitted;
}
//# sourceMappingURL=mcp-tool-view.d.ts.map