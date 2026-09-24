import { stableFingerprint, type McpBindingSnapshot, type McpFrozenToolBinding, type ToolDefinition } from "@ar/contracts";

/**
 * P24-3 — need-driven MCP dependency resolution.
 *
 * Phase-1 PRAGMATIC policy (no fragile LLM-based discovery inside the
 * runtime): a server is needed when it is EXPLICITLY referenced —
 *
 *   - an explicit tool/server mention (`mcp:<serverId>` in the goal, or a
 *     declared `mcpServers` requirement on a selected skill/plugin);
 *   - `requiredByDefault` on the descriptor;
 *   - an explicit tool name that matches a known MCP tool of that server.
 *
 * A config existing is NEVER a reason to connect.
 */
export interface McpDependencyInput {
  goal?: string;
  /** Tool names the current step may call (from the turn/task). */
  explicitToolNames?: readonly string[];
  selectedSkills?: readonly { id: string; mcpServers?: readonly string[] }[];
  selectedPlugins?: readonly { id: string; mcpServers?: readonly string[] }[];
}

export interface McpDependencyResolverOptions {
  /** serverId → known MCP tool names (from connected generations, if any). */
  knownTools?: Record<string, readonly string[]>;
  /** Servers that resolve as needed even without an explicit mention. */
  requiredByDefault?: () => readonly string[];
}

/** Extracts `mcp:<serverId>` mentions from free text. */
export function extractMcpMentions(text: string | undefined): string[] {
  if (text === undefined) return [];
  const out = new Set<string>();
  const re = /mcp:([a-zA-Z0-9_.-]+)/g;
  for (const m of text.matchAll(re)) {
    const id = m[1]!;
    if (id.length > 0) out.add(id);
  }
  return [...out];
}

export class McpDependencyResolver {
  constructor(private readonly opts: McpDependencyResolverOptions = {}) {}

  resolve(input: McpDependencyInput): ReadonlySet<string> {
    const needed = new Set<string>();
    const add = (id: string | undefined) => {
      if (id !== undefined && id.length > 0) needed.add(id);
    };

    // 1) explicit mentions in the goal / task text
    for (const id of extractMcpMentions(input.goal)) add(id);

    // 2) explicit tool names that belong to a known MCP server
    if (input.explicitToolNames !== undefined && this.opts.knownTools !== undefined) {
      for (const tool of input.explicitToolNames) {
        // mcp:<serverId> qualified reference
        const mcpRef = extractMcpMentions(tool)[0];
        if (mcpRef !== undefined) add(mcpRef);
        // scan known servers for a matching tool name
        for (const [sid, known] of Object.entries(this.opts.knownTools)) {
          if (known.includes(tool)) add(sid);
        }
      }
    }

    // 3) declared requirements on selected skills / plugins
    for (const skill of input.selectedSkills ?? []) {
      for (const id of skill.mcpServers ?? []) add(id);
    }
    for (const plugin of input.selectedPlugins ?? []) {
      for (const id of plugin.mcpServers ?? []) add(id);
    }

    // 4) requiredByDefault
    for (const id of this.opts.requiredByDefault?.() ?? []) add(id);

    return needed;
  }
}

/**
 * P24-4 — build an immutable McpBindingSnapshot from the generations a step
 * needs. The snapshot's fingerprint covers every binding; a refresh that
 * changes any schema/generation produces a NEW fingerprint, so a step bound
 * to snapshot S never sees a later generation.
 */
export function buildMcpBindingSnapshot(
  inputs: readonly {
    serverId: string;
    generation: string;
    tools: readonly { name: string; schemaHash: string; definition: ToolDefinition }[];
    trust: "trusted" | "untrusted";
  }[],
  now: () => number,
): McpBindingSnapshot {
  const tools: McpFrozenToolBinding[] = [];
  const generations = new Map<string, string>();
  for (const server of inputs) {
    generations.set(server.serverId, server.generation);
    for (const tool of server.tools) {
      tools.push({
        serverId: server.serverId,
        generation: server.generation,
        toolName: tool.name,
        schemaHash: tool.schemaHash,
        definition: tool.definition,
        trust: server.trust,
      });
    }
  }
  const fingerprint = stableFingerprint([
    tools.map((t) => ({ serverId: t.serverId, generation: t.generation, toolName: t.toolName, schemaHash: t.schemaHash, trust: t.trust })),
  ]);
  return {
    id: `mcp-binding-${fingerprint.slice(0, 12)}`,
    fingerprint,
    generations,
    tools,
    createdAt: now(),
  };
}
