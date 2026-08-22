/**
 * P24-1/5 — composition helper: MCP runtime V2 (lazy).
 *
 * Replaces the eager "connect every configured server at startup" path.
 * `composeMcp` now returns a McpServerCatalog (declaration only) plus a
 * McpConnectionManager (lazy lifecycle) and the need-driven resolver. NOTHING
 * connects at harness creation unless a descriptor is explicitly `eager`.
 *
 * Dependency direction stays: harness → @ar/mcp.
 */
import { createHash } from "node:crypto";
import { McpServerCatalog, McpConnectionManager, McpDependencyResolver, buildMcpBindingSnapshot } from "@ar/mcp";
import type { McpBindingSnapshot } from "@ar/contracts";
import type { HarnessConfig } from "../config.js";

export interface ComposedMcp {
  catalog: McpServerCatalog;
  connectionManager: McpConnectionManager;
  resolver: McpDependencyResolver;
  /** Observed connection failures (serverId + error) for observability. */
  readonly failures: Array<{ serverId: string; error: unknown }>;
  /** Lazy binding provider consumed by the runtime at step build. */
  bindingProvider(input: { goal: string }): Promise<McpBindingSnapshot | undefined>;
  /** Close every connected generation (no orphan stdio children). */
  close(): Promise<void>;
  /** serverId → known tool names from currently ready generations. */
  knownTools(): Record<string, readonly string[]>;
  /** P24-1: connect servers explicitly marked eager (opt-in). A failure
   *  here ABORTS harness creation — eager is an operator's hard requirement. */
  connectEager(): Promise<void>;
}

/** P24-5 — compose the MCP runtime WITHOUT connecting anything. */
export function composeMcp(
  config: HarnessConfig,
  onEvent?: (event: { type: "mcp.connect_failed"; serverId: string; error: unknown }) => void,
): ComposedMcp {
  const mcpConfigs = config.mcp ?? [];
  const catalog = McpServerCatalog.fromConfig(mcpConfigs, {
    trustFor: (_id, kind) => (kind === "stdio" ? "untrusted" : "untrusted"),
    boundaryFor: (_id, kind) => (kind === "stdio" ? "loopback" : "internet"),
  });

  const failures: Array<{ serverId: string; error: unknown }> = [];
  const connectionManager = new McpConnectionManager({
    catalog,
    onEvent: (e) => {
      if (e.type === "mcp.connect_failed") {
        failures.push({ serverId: e.serverId, error: e.error });
        onEvent?.({ type: "mcp.connect_failed", serverId: e.serverId, error: e.error });
      }
    },
  });

  const resolver = new McpDependencyResolver({
    requiredByDefault: () => catalog.requiredByDefault().map((d) => d.id),
  });

  return {
    catalog,
    connectionManager,
    resolver,
    failures,
    knownTools: () => {
      const out: Record<string, readonly string[]> = {};
      for (const d of catalog.list()) {
        const gen = connectionManager.getGeneration(d.id);
        if (gen !== undefined) out[d.id] = gen.tools.map((t) => t.name);
      }
      return out;
    },
    async bindingProvider(input) {
      // resolve which servers THIS step needs (mentions + requiredByDefault;
      // explicit tool-name matching uses the current known tools)
      const needed = resolver.resolve({
        goal: input.goal,
        explicitToolNames: undefined,
        selectedSkills: [],
        selectedPlugins: [],
      });
      const neededServers = [...needed];
      if (neededServers.length === 0) return undefined;
      // connect lazily — one shared promise per server (P24-2)
      const generations = await Promise.all(
        neededServers.map(async (serverId) => {
          const descriptor = catalog.get(serverId);
          if (descriptor === undefined) return undefined;
          // P24-7: a broken-but-needed server never crashes the step — the
          // failure is observable (onEvent) and the step proceeds WITHOUT it.
          let generation: Awaited<ReturnType<typeof connectionManager.getOrConnect>> | undefined;
          try {
            generation = await connectionManager.getOrConnect(serverId);
          } catch (err) {
            failures.push({ serverId, error: err });
            onEvent?.({ type: "mcp.connect_failed", serverId, error: err });
            return undefined;
          }
          if (generation === undefined) return undefined;
          const tools = generation.tools.map((def) => {
            const spec = def.inputSchema;
            const schemaHash = hashOf(def);
            return { name: def.name, schemaHash, definition: def };
          });
          return { serverId, generation: generation.id, tools, trust: descriptor.trust };
        }),
      );
      const inputs = generations.filter((g): g is NonNullable<typeof g> => g !== undefined);
      if (inputs.length === 0) return undefined;
      return buildMcpBindingSnapshot(inputs, Date.now);
    },
    async connectEager() {
      for (const d of catalog.eagerServers()) {
        await connectionManager.getOrConnect(d.id);
      }
    },
    async close() {
      await connectionManager.closeAll();
    },
  };
}

/** Structural schema hash for one tool definition (deterministic). */
function hashOf(def: { name: string; description?: string; inputSchema?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ name: def.name, description: def.description, schema: def.inputSchema ?? null }))
    .digest("hex");
}
