/** Keyword → tools whose schema is relevant when the goal mentions the topic.
 *  Categories are additive: matching any category keeps those tools. */
const CATEGORY_KEYWORDS = [
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
const CORE_TOOLS = new Set([
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
const EXTRA_TOOLS_BY_CATEGORY = [
    { keywords: ["test", "unit", "integration", "spec"], tools: [] },
];
/** P7-2 champion: deterministic goal-keyword selection over tool categories.
 *
 *  Advertises: every core tool + any tool the goal keyword explicitly matches
 *  (configured via `extra`). Everything else is dropped — the model sees a
 *  tight, task-relevant schema set instead of the full registry.
 */
export class DeterministicToolSelector {
    extraByKeyword;
    coreTools;
    constructor(extra = EXTRA_TOOLS_BY_CATEGORY, coreTools = CORE_TOOLS) {
        this.extraByKeyword = extra;
        this.coreTools = coreTools;
    }
    select(input) {
        const goal = input.goal.toLowerCase();
        const keep = new Set(this.coreTools);
        for (const category of this.extraByKeyword) {
            if (category.keywords.some((keyword) => goal.includes(keyword))) {
                for (const tool of category.tools)
                    keep.add(tool);
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
export class NoopToolSelector {
    select(input) {
        return { selected: [...input.tools], dropped: [] };
    }
}
//# sourceMappingURL=tool-selector.js.map