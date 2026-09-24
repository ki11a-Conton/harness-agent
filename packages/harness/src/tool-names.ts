/**
 * P22-1 — shared tool-name constants (extracted from create-harness.ts so the
 * composition helpers and agent definitions import them without a cycle).
 */

/** Tool profile shared by every production harness (plan.md P0-5 single
 *  source: packages/tools/src/production-tools.ts). ask_user is a core
 *  runtime phase — ASK_GATE_TOOL — and must NOT be registered as a
 *  ToolDefinition. */
export const PRODUCTION_TOOL_NAMES = [
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
