import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";
import { resolve } from "node:path";
import { DEFAULT_MAX_FILES, RepositoryMapCache, type RepositoryMap } from "../repo-map.js";
import { buildRelevantCodeMap } from "../relevant-code-map.js";

/**
 * P2-30 repo_map tool. Read-only; policy (permission + sandbox path scoping)
 * stays in the orchestrator. Returns the ephemeral repository map (file tree,
 * package map, entrypoints, test-command hints, languages) so the agent stops
 * re-scanning the workspace each turn.
 */

export interface RepoMapToolInput {
  refresh?: boolean;
  maxFiles?: number;
  query?: string;
  maxCodeTokens?: number;
}

const repoMapSchema = z.object({
  refresh: z.boolean().optional(),
  maxFiles: z.number().int().positive().max(500_000).optional(),
  query: z.string().trim().min(1).max(512).optional(),
  maxCodeTokens: z.number().int().min(128).max(4000).optional(),
});

/** A resolver created once by `makeRepoMapResolver` (plan.md P0-6: never a
 *  fresh per-execute resolver — the cache would be rebuilt on every call). */
export interface RepoMapResolver {
  cache: RepositoryMapCache | null;
  resolve(input: RepoMapToolInput, cwd: string): Promise<RepositoryMap>;
}

/**
 * Keeps bounded process-local caches by workspace and file budget. The cache
 * getter exposes the most recently requested entry for lifecycle diagnostics.
 */
export function makeRepoMapResolver(): RepoMapResolver {
  const caches = new Map<string, RepositoryMapCache>();
  const maxEntries = 8;
  let cache: RepositoryMapCache | null = null;
  return {
    get cache() {
      return cache;
    },
    async resolve(input: RepoMapToolInput, cwd: string): Promise<RepositoryMap> {
      const root = resolve(cwd);
      const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
      const key = JSON.stringify([root, maxFiles]);
      cache = caches.get(key) ?? new RepositoryMapCache({ root, maxFiles });
      // Map insertion order records actual use, including warm hits.
      caches.delete(key);
      caches.set(key, cache);
      if (caches.size > maxEntries) caches.delete(caches.keys().next().value!);
      if (input.refresh) cache.invalidate();
      return cache.get();
    },
  };
}

/**
 * Factory (plan.md P0-5/§1994): bind an injected resolver so the cache
 * survives across calls/turns. The resolver default keeps a single shared
 * instance per created tool, so the default and the factory both avoid the
 * pre-P0-6 per-execute rebuild.
 */
export function createRepoMapTool(
  resolver: RepoMapResolver = makeRepoMapResolver(),
): ToolDefinition<RepoMapToolInput, RepositoryMap> {
  return {
    name: "repo_map",
    description:
      "Return the cached repository overview. query additionally produces a task-related Tree-sitter symbol/reference graph for TS/JS, Python, Rust and Go; maxCodeTokens bounds that additional section (default 1600). References are candidates, not semantic resolution. refresh:true rebuilds the overview.",
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
        const map = await resolver.resolve(input, context.cwd);
        const relevantCode = input.query === undefined ? undefined : await buildRelevantCodeMap({
          root: context.cwd, query: input.query, maxTokens: input.maxCodeTokens, signal: context.signal,
        });
        return {
          status: "success",
          output: relevantCode === undefined ? map : { ...map, relevantCode },
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
}

/** Backward-compatible default instance (shared per-instance resolver). */
export const repoMapTool = createRepoMapTool();
