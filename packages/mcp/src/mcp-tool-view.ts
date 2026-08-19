import { AgentError, errorInfo } from "@ar/contracts";
import { createHash } from "node:crypto";

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

export function schemaHash(schema?: Record<string, unknown>): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(sortKeys(schema ?? {}))).digest("hex");
}

export interface McpToolViewDiff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; oldHash: string; newHash: string }>;
}

/** The minimal listTools surface the view needs (McpClient satisfies it). */
export interface McpToolListSource {
  listTools(): Promise<McpToolInfoLike[]>;
}

export class McpToolView {
  private committed = new Map<string, McpToolViewEntry>();
  private staged: McpToolInfoLike[] | undefined;
  private pinnedTurn: string | undefined;

  constructor(private readonly source: McpToolListSource) {}

  /** Committed tool names (visible at the next safe boundary). */
  committedNames(): string[] {
    return [...this.committed.keys()];
  }

  /** Number of committed tools. */
  size(): number {
    return this.committed.size;
  }

  /** Whether a tool is visible to the current turn. */
  has(name: string): boolean {
    return this.committed.has(name);
  }

  /**
   * Fetch the latest remote tools and stage a refresh. If no turn has pinned a
   * snapshot, the refresh is applied immediately; otherwise it is only staged
   * until the next `commitStaged()` (safe-boundary). Returns the computed diff
   * against the committed view. Throws (duplicate name / malformed entry)
   * WITHOUT mutating the view.
   */
  async refresh(): Promise<McpToolViewDiff> {
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
  commitStaged(): McpToolViewDiff {
    if (this.staged === undefined) return { added: [], removed: [], changed: [] };
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
  beginTurn(turnId: string): McpToolViewDiff {
    const boundaryDiff = this.commitStaged();
    this.pinnedTurn = turnId;
    return boundaryDiff;
  }

  endTurn(turnId: string): void {
    if (this.pinnedTurn === turnId) this.pinnedTurn = undefined;
  }

  /** The frozen snapshot for the current turn. */
  snapshot(): McpToolViewEntry[] {
    return [...this.committed.values()];
  }

  /**
   * Resolve a tool for invocation: verifies the requested tool exists and that
   * the *provided* schema still matches the frozen snapshot. A missing tool or
   * a schema mismatch is a structured TOOL_SCHEMA_ERROR (fail structurally).
   */
  resolveTool(name: string, providedSchema?: Record<string, unknown>): McpToolViewEntry {
    const entry = this.committed.get(name);
    if (entry === undefined) {
      throw new AgentError(
        errorInfo("TOOL_SCHEMA_ERROR", `mcp tool "${name}" is not in the current tool snapshot`),
      );
    }
    if (providedSchema !== undefined) {
      const providedHash = schemaHash(providedSchema);
      if (providedHash !== entry.schemaHash) {
        throw new AgentError(
          errorInfo(
            "TOOL_SCHEMA_ERROR",
            `mcp tool "${name}" schema changed since snapshot (${entry.schemaHash.slice(0, 8)} → ${providedHash.slice(0, 8)})`,
          ),
        );
      }
    }
    return entry;
  }

  private validate(tools: McpToolInfoLike[]): void {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (typeof tool.name !== "string" || tool.name.trim() === "") {
        throw new AgentError(
          errorInfo("TOOL_SCHEMA_ERROR", "mcp tools/list included a tool without a name"),
        );
      }
      if (seen.has(tool.name)) {
        throw new AgentError(
          errorInfo("TOOL_SCHEMA_ERROR", `mcp tools/list returned duplicate tool name "${tool.name}"`),
        );
      }
      seen.add(tool.name);
    }
  }

  private diff(tools: McpToolInfoLike[]): McpToolViewDiff {
    const next = new Map(tools.map((t) => [t.name, this.toEntry(t)]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: Array<{ name: string; oldHash: string; newHash: string }> = [];
    for (const [name, entry] of next) {
      const prev = this.committed.get(name);
      if (prev === undefined) added.push(name);
      else if (prev.schemaHash !== entry.schemaHash) {
        changed.push({ name, oldHash: prev.schemaHash, newHash: entry.schemaHash });
      }
    }
    for (const name of this.committed.keys()) {
      if (!next.has(name)) removed.push(name);
    }
    return { added, removed, changed };
  }

  private toEntry(tool: McpToolInfoLike): McpToolViewEntry {
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      schemaHash: schemaHash(tool.inputSchema),
    };
  }

  private applyCommitted(tools: McpToolInfoLike[]): void {
    const next = new Map<string, McpToolViewEntry>();
    for (const tool of tools) next.set(tool.name, this.toEntry(tool));
    this.committed = next;
  }
}