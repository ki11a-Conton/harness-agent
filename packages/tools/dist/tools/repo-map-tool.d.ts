import type { ToolDefinition } from "@ar/contracts";
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
/** A resolver created once by `makeRepoMapResolver` (plan.md P0-6: never a
 *  fresh per-execute resolver — the cache would be rebuilt on every call). */
export interface RepoMapResolver {
    cache: RepositoryMapCache | null;
    resolve(input: RepoMapToolInput, cwd: string): Promise<RepositoryMap>;
}
/**
 * Holds one cache instance per resolver returned by `makeRepoMapResolver`, so
 * callers (tests, runtime) can control which process-local cache a tool uses.
 */
export declare function makeRepoMapResolver(): RepoMapResolver;
/**
 * Factory (plan.md P0-5/§1994): bind an injected resolver so the cache
 * survives across calls/turns. The resolver default keeps a single shared
 * instance per created tool, so the default and the factory both avoid the
 * pre-P0-6 per-execute rebuild.
 */
export declare function createRepoMapTool(resolver?: RepoMapResolver): ToolDefinition<RepoMapToolInput, RepositoryMap>;
/** Backward-compatible default instance (shared per-instance resolver). */
export declare const repoMapTool: ToolDefinition<RepoMapToolInput, RepositoryMap>;
//# sourceMappingURL=repo-map-tool.d.ts.map