import type { ToolSpec } from "@ar/contracts";

/**
 * P7-1/P7-2: progressive tool disclosure — instead of always shoving every
 * tool schema into the model request (expensive and noisy when MCP/plugin
 * tool sets grow to 100+), a ToolSelector narrows the advertised schemas to
 * the ones relevant to the current goal.
 *
 * Champion strategy (P7-2): deterministic keyword/category selection — never
 * an LLM router in the first version. It only ever DROPS peripheral tools:
 * the core filesystem/exec/search set is always kept, so a misclassification
 * cannot leave the model without the tools a coding task needs.
 */
export interface ToolSelectionResult {
  selected: ToolSpec[];
  /** Names dropped by the selector (P7-3 telemetry). */
  dropped: string[];
}

export interface ToolSelector {
  select(input: { goal: string; tools: readonly ToolSpec[] }): ToolSelectionResult;
}

/** Keyword → tools whose schema is relevant when the goal mentions the topic.
 *  Categories are additive: matching any category keeps those tools. */
const CATEGORY_KEYWORDS: ReadonlyArray<{ keywords: string[]; tools: string[] }> = [
  {
    keywords: ["web", "http", "url", "api", "curl", "fetch", "rest", "download", "network"],
    tools: [],
  },
  {
    keywords: ["database", "sql", "query", "postgres", "mysql", "sqlite"],
    tools: [],
  },
];

/** Core tools that must always be advertised: without them a coding agent
 *  cannot read/edit/run anything, and the disclosure would break tasks. */
const CORE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "exec",
  "search_files",
  "grep_search",
  "repo_tree",
  "repo_map",
  "update_plan",
  "navigate",
  "symbol_search",
  "discover_commands",
  "env_snapshot",
  "ask_user",
  "delegate_explore",
  "delegate_worker",
  "delegate_batch",
]);

/** Optional: categories can carry an allowlist of extra (non-core) tools. When
 *  empty, only core tools are advertised (conservative champion). */
const EXTRA_TOOLS_BY_CATEGORY: ReadonlyArray<{ keywords: string[]; tools: string[] }> = [
  { keywords: ["test", "unit", "integration", "spec"], tools: [] },
];

/** P7-2 champion: deterministic goal-keyword selection over tool categories.
 *
 *  Advertises: every core tool + any tool the goal keyword explicitly matches
 *  (configured via `extra`). Everything else is dropped — the model sees a
 *  tight, task-relevant schema set instead of the full registry.
 */
export class DeterministicToolSelector implements ToolSelector {
  private readonly extraByKeyword: ReadonlyArray<{ keywords: string[]; tools: string[] }>;
  private readonly coreTools: ReadonlySet<string>;

  constructor(
    extra: ReadonlyArray<{ keywords: string[]; tools: string[] }> = EXTRA_TOOLS_BY_CATEGORY,
    coreTools: ReadonlySet<string> = CORE_TOOLS,
  ) {
    this.extraByKeyword = extra;
    this.coreTools = coreTools;
  }

  select(input: { goal: string; tools: readonly ToolSpec[] }): ToolSelectionResult {
    const goal = input.goal.toLowerCase();
    const keep = new Set<string>(this.coreTools);
    for (const category of this.extraByKeyword) {
      if (category.keywords.some((keyword) => goal.includes(keyword))) {
        for (const tool of category.tools) keep.add(tool);
      }
    }
    // Category placeholders (empty tool lists) exercise the matching path but
    // keep the champion conservative.
    void CATEGORY_KEYWORDS;
    const selected = input.tools.filter((spec) => keep.has(spec.name));
    const dropped = input.tools.filter((spec) => !keep.has(spec.name)).map((spec) => spec.name);
    return { selected, dropped };
  }
}

/** Identity selector (no disclosure) — the pre-P7 behavior for hosts that do
 *  not opt in. */
export class NoopToolSelector implements ToolSelector {
  select(input: { goal: string; tools: readonly ToolSpec[] }): ToolSelectionResult {
    return { selected: [...input.tools], dropped: [] };
  }
}
