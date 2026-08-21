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
    select(input: {
        goal: string;
        tools: readonly ToolSpec[];
    }): ToolSelectionResult;
}
/** P7-2 champion: deterministic goal-keyword selection over tool categories.
 *
 *  Advertises: every core tool + any tool the goal keyword explicitly matches
 *  (configured via `extra`). Everything else is dropped — the model sees a
 *  tight, task-relevant schema set instead of the full registry.
 */
export declare class DeterministicToolSelector implements ToolSelector {
    private readonly extraByKeyword;
    private readonly coreTools;
    constructor(extra?: ReadonlyArray<{
        keywords: string[];
        tools: string[];
    }>, coreTools?: ReadonlySet<string>);
    select(input: {
        goal: string;
        tools: readonly ToolSpec[];
    }): ToolSelectionResult;
}
/** Identity selector (no disclosure) — the pre-P7 behavior for hosts that do
 *  not opt in. */
export declare class NoopToolSelector implements ToolSelector {
    select(input: {
        goal: string;
        tools: readonly ToolSpec[];
    }): ToolSelectionResult;
}
//# sourceMappingURL=tool-selector.d.ts.map