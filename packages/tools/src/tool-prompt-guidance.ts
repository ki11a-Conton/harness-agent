/** Native operating advice, attached to the same definitions that own schemas.
 * Advice does not grant permissions or change execution semantics. */
const nativeGuidance: Record<string, string[]> = {
  read_file: ["Inspect relevant ranges; request versioned=true before editing and retain the returned sha256. Retrieve truncated ranges before relying on them."],
  write_file: ["Create or replace deliberately; preserve unrelated content and use expectedSha256 when changing an existing file."],
  edit_file: ["Anchor focused changes in current content and pass expectedSha256. On stale or ambiguous anchors, reread and recalculate."],
  search_files: ["Find candidate paths with a narrow pattern before reading contents."],
  grep_search: ["Search specific symbols, usages and diagnostics; narrow broad results and observe truncation."],
  repo_tree: ["Use a bounded directory view to orient in an unfamiliar repository."],
  symbol_search: ["Use mode:syntax for TS/JS, Python, Rust and Go definitions and candidate references; narrow path and verify matches in source. Other languages retain lexical search."],
  repo_map: ["Use query for task-related files, symbols and candidate reference relationships; maxCodeTokens bounds that section. Verify its versioned candidates before editing."],
  discover_commands: ["Read the project's declared check/build/test commands before choosing verification."],
  env_snapshot: ["Confirm the actual platform and workspace; do not guess available capabilities."],
  exec: ["Prefer command plus args for portable execution. Inspect real exit status and diagnostics; a successful dispatch is not a successful check."],
  update_plan: ["Track substantial work with short steps and a concrete completion check; skip unnecessary plans for simple tasks."],
};
export const NATIVE_TOOL_GUIDANCE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(nativeGuidance).map(([name, advice]) => [name, Object.freeze(advice)])),
);
