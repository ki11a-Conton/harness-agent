import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { RepositoryMapCache, type RepositoryMap } from "../repo-map.js";

/**
 * P2-30 repo_map tool. Read-only; policy (permission + sandbox path scoping)
 * stays in the orchestrator. Returns the ephemeral repository map (file tree,
 * package map, entrypoints, test-command hints, languages) so the agent stops
 * re-scanning the workspace each turn.
 */

export interface RepoMapToolInput {
  refresh?: boolean;
  maxFiles?: number;
}

const repoMapSchema = z.object({
  refresh: z.boolean().optional(),
  maxFiles: z.number().int().positive().max(500_000).optional(),
});

/**
 * Holds one cache instance per resolver returned by `makeRepoMapResolver`, so
 * callers (tests, runtime) can control which process-local cache a tool uses.
 */
export function makeRepoMapResolver(): {
  cache: RepositoryMapCache | null;
  resolve: (input: RepoMapToolInput, cwd: string) => Promise<RepositoryMap>;
} {
  let cache: RepositoryMapCache | null = null;
  return {
    get cache() {
      return cache;
    },
    async resolve(input: RepoMapToolInput, cwd: string): Promise<RepositoryMap> {
      if (!cache) cache = new RepositoryMapCache({ root: cwd, maxFiles: input.maxFiles });
      if (input.refresh) cache.invalidate();
      return cache.get();
    },
  };
}

export const repoMapTool: ToolDefinition<RepoMapToolInput, RepositoryMap> = {
  name: "repo_map",
  description:
    "Return the cached repository map: file tree, package manifests, entrypoints, test-command hints and languages. Serves incremental invalidation on repo change; pass refresh:true to force a rebuild.",
  inputSchema: repoMapSchema,
  risk: "readonly",
  metadata: {
    name: "repo_map",
    version: "1.0.0",
    sideEffect: false,
    network: false,
    filesystem: true,
    process: false,
    interactive: false,
    retry: "safe",
    concurrencySafe: false, // builds can be expensive; orchestrator serializes
  },
  async execute(input: RepoMapToolInput, context: ToolExecutionContext): Promise<ToolResult<RepositoryMap>> {
    try {
      const resolver = makeRepoMapResolver();
      const map = await resolver.resolve(input, context.cwd);
      return {
        status: "success",
        output: map,
        evidence: [{ type: "file", description: `repo_map: ${map.fileCount} file(s), ${map.packages.length} package(s)`, source: map.root, timestamp: Date.now() }],
      };
    } catch (err) {
      return {
        status: "failed",
        error: errorInfo("PROCESS_ERROR", err instanceof Error ? err.message : String(err)),
      };
    }
  },
};