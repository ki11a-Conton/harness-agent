import { AgentError, errorInfo } from "@ar/contracts";
import { createHash } from "node:crypto";
export function schemaHash(schema) {
    const sortKeys = (value) => {
        if (Array.isArray(value))
            return value.map(sortKeys);
        if (value !== null && typeof value === "object") {
            const out = {};
            for (const key of Object.keys(value).sort()) {
                out[key] = sortKeys(value[key]);
            }
            return out;
        }
        return value;
    };
    return createHash("sha256").update(JSON.stringify(sortKeys(schema ?? {}))).digest("hex");
}
export class McpToolView {
    source;
    committed = new Map();
    staged;
    pinnedTurn;
    constructor(source) {
        this.source = source;
    }
    /** Committed tool names (visible at the next safe boundary). */
    committedNames() {
        return [...this.committed.keys()];
    }
    /** Number of committed tools. */
    size() {
        return this.committed.size;
    }
    /** Whether a tool is visible to the current turn. */
    has(name) {
        return this.committed.has(name);
    }
    /**
     * Fetch the latest remote tools and stage a refresh. If no turn has pinned a
     * snapshot, the refresh is applied immediately; otherwise it is only staged
     * until the next `commitStaged()` (safe-boundary). Returns the computed diff
     * against the committed view. Throws (duplicate name / malformed entry)
     * WITHOUT mutating the view.
     */
    async refresh() {
        const remote = await this.source.listTools();
        this.validate(remote);
        const diff = this.diff(remote);
        if (this.pinnedTurn === undefined) {
            this.applyCommitted(remote);
        }
        this.staged = remote;
        return diff;
    }
    /**
     * Commit any staged refresh. Called at a safe boundary (e.g. the start of a
     * turn after the previous turn finished). No-op when nothing is staged.
     */
    commitStaged() {
        if (this.staged === undefined)
            return { added: [], removed: [], changed: [] };
        const diff = this.diff(this.staged);
        this.applyCommitted(this.staged);
        this.staged = undefined;
        return diff;
    }
    /**
     * Pin the current committed view as the snapshot for this turn. Any staged
     * refresh is committed here (the turn boundary), then frozen for the turn.
     * A mid-turn refresh can no longer influence this turn's view.
     */
    beginTurn(turnId) {
        const boundaryDiff = this.commitStaged();
        this.pinnedTurn = turnId;
        return boundaryDiff;
    }
    endTurn(turnId) {
        if (this.pinnedTurn === turnId)
            this.pinnedTurn = undefined;
    }
    /** The frozen snapshot for the current turn. */
    snapshot() {
        return [...this.committed.values()];
    }
    /**
     * Resolve a tool for invocation: verifies the requested tool exists and that
     * the *provided* schema still matches the frozen snapshot. A missing tool or
     * a schema mismatch is a structured TOOL_SCHEMA_ERROR (fail structurally).
     */
    resolveTool(name, providedSchema) {
        const entry = this.committed.get(name);
        if (entry === undefined) {
            throw new AgentError(errorInfo("TOOL_SCHEMA_ERROR", `mcp tool "${name}" is not in the current tool snapshot`));
        }
        if (providedSchema !== undefined) {
            const providedHash = schemaHash(providedSchema);
            if (providedHash !== entry.schemaHash) {
                throw new AgentError(errorInfo("TOOL_SCHEMA_ERROR", `mcp tool "${name}" schema changed since snapshot (${entry.schemaHash.slice(0, 8)} → ${providedHash.slice(0, 8)})`));
            }
        }
        return entry;
    }
    validate(tools) {
        const seen = new Set();
        for (const tool of tools) {
            if (typeof tool.name !== "string" || tool.name.trim() === "") {
                throw new AgentError(errorInfo("TOOL_SCHEMA_ERROR", "mcp tools/list included a tool without a name"));
            }
            if (seen.has(tool.name)) {
                throw new AgentError(errorInfo("TOOL_SCHEMA_ERROR", `mcp tools/list returned duplicate tool name "${tool.name}"`));
            }
            seen.add(tool.name);
        }
    }
    diff(tools) {
        const next = new Map(tools.map((t) => [t.name, this.toEntry(t)]));
        const added = [];
        const removed = [];
        const changed = [];
        for (const [name, entry] of next) {
            const prev = this.committed.get(name);
            if (prev === undefined)
                added.push(name);
            else if (prev.schemaHash !== entry.schemaHash) {
                changed.push({ name, oldHash: prev.schemaHash, newHash: entry.schemaHash });
            }
        }
        for (const name of this.committed.keys()) {
            if (!next.has(name))
                removed.push(name);
        }
        return { added, removed, changed };
    }
    toEntry(tool) {
        return {
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            schemaHash: schemaHash(tool.inputSchema),
        };
    }
    applyCommitted(tools) {
        const next = new Map();
        for (const tool of tools)
            next.set(tool.name, this.toEntry(tool));
        this.committed = next;
    }
}
//# sourceMappingURL=mcp-tool-view.js.map