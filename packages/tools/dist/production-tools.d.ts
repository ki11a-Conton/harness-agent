import type { ToolDefinition } from "@ar/contracts";
import { type RepoMapResolver } from "./tools/repo-map-tool.js";
export declare function getSharedRepoMapResolver(): RepoMapResolver;
export interface ProductionToolDeps {
    /** repo_map resolver; defaults to a shared process-local instance so the
     *  cache is reused by every production host in this process. */
    repoMapResolver?: RepoMapResolver;
    /** Network policy the env_snapshot tool reports (never probed). Read as a
     *  function per call so it always reflects the live composition root. */
    networkMode: string | (() => string);
    /** Tool names visible to the default registry (env_snapshot input). */
    availableTools: () => readonly string[];
    /** Host wiring facts (plan.md P0-7 output additions). */
    workspaceRoot?: () => string;
    harnessProfile?: () => string;
}
/** Canonical production tool profile (plan.md P0-5): the exact order the
 *  registry must expose. ask_user is a core runtime phase (ASK_GATE_TOOL),
 *  never a ToolDefinition. */
export declare const CODING_TOOL_PROFILE: readonly ["read_file", "write_file", "edit_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot", "exec", "update_plan"];
/**
 * Single production tool set (plan.md P0-5): one source of truth so CLI /
 * Web / benchmark cannot drift separate BUILTIN_TOOLS lists. repo_map gets an
 * injected resolver (P0-6), env_snapshot gets the host's network mode +
 * registered tool names instead of an empty list.
 */
export declare function createProductionTools(deps: ProductionToolDeps): ToolDefinition[];
/** The 11 names in profile order (registry introspection contract). */
export declare const PRODUCTION_TOOL_NAMES: readonly ["read_file", "write_file", "edit_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot", "exec", "update_plan"];
/** Default network policy for the interactive/coding profile. */
export declare const DEFAULT_NETWORK_MODE = "deny";
/** Read-only subset (subagent tools): all profile tools except write/edit/exec/update_plan. */
export declare const READONLY_TOOL_NAMES: readonly ["read_file", "search_files", "grep_search", "repo_tree", "symbol_search", "repo_map", "discover_commands", "env_snapshot"];
export type { RepoMapResolver };
//# sourceMappingURL=production-tools.d.ts.map