import type { ToolDefinition } from "@ar/contracts";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { searchFilesTool } from "./tools/search-files.js";
import { execTool } from "./tools/exec.js";
import { grepSearchTool, repoTreeTool, symbolSearchTool } from "./tools/navigation-tools.js";
import { discoverCommandsTool } from "./tools/discover-commands-tool.js";
import { updatePlanTool } from "./tools/update-plan-tool.js";
import { createRepoMapTool, makeRepoMapResolver, type RepoMapResolver } from "./tools/repo-map-tool.js";
import { createEnvSnapshotTool } from "./tools/env-snapshot-tool.js";

/** The shared default repo-map resolver for hosts using createProductionTools
 *  without injecting their own (P0-6: cache survives across calls/turns). */
let sharedRepoMapResolver: RepoMapResolver | undefined;

export function getSharedRepoMapResolver(): RepoMapResolver {
  if (sharedRepoMapResolver === undefined) {
    sharedRepoMapResolver = makeRepoMapResolver();
  }
  return sharedRepoMapResolver;
}

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
export const CODING_TOOL_PROFILE = [
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "grep_search",
  "repo_tree",
  "symbol_search",
  "repo_map",
  "discover_commands",
  "env_snapshot",
  "exec",
  "update_plan",
] as const;

/**
 * Single production tool set (plan.md P0-5): one source of truth so CLI /
 * Web / benchmark cannot drift separate BUILTIN_TOOLS lists. repo_map gets an
 * injected resolver (P0-6), env_snapshot gets the host's network mode +
 * registered tool names instead of an empty list.
 */
export function createProductionTools(deps: ProductionToolDeps): ToolDefinition[] {
  const repoMap = createRepoMapTool(deps.repoMapResolver ?? getSharedRepoMapResolver());
  const networkPolicy = deps.networkMode;
  const networkMode: () => string =
    typeof networkPolicy === "function" ? networkPolicy : () => networkPolicy;
  const envSnapshot = createEnvSnapshotTool({
    networkMode,
    availableTools: deps.availableTools,
    ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {}),
    ...(deps.harnessProfile !== undefined ? { harnessProfile: deps.harnessProfile } : {}),
  });
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    searchFilesTool,
    grepSearchTool,
    repoTreeTool,
    symbolSearchTool,
    repoMap,
    discoverCommandsTool,
    envSnapshot,
    execTool,
    updatePlanTool,
  ];
}

/** The 11 names in profile order (registry introspection contract). */
export const PRODUCTION_TOOL_NAMES = CODING_TOOL_PROFILE;

/** Default network policy for the interactive/coding profile. */
export const DEFAULT_NETWORK_MODE = "deny";

/** Read-only subset (subagent tools): all profile tools except write/edit/exec/update_plan. */
export const READONLY_TOOL_NAMES = [
  "read_file",
  "search_files",
  "grep_search",
  "repo_tree",
  "symbol_search",
  "repo_map",
  "discover_commands",
  "env_snapshot",
] as const;

export type { RepoMapResolver };