import type { SkillIndexEntry } from "@ar/contracts";
/**
 * P2-6: skill selection (index → relevant selection → body on demand).
 * Deterministic lexical selection of skill index rows against the task goal:
 * the goal's tokens are matched against each row's name+description via
 * Jaccard similarity. No LLM, no side effects.
 */
export interface SelectSkillsOptions {
    /** Result cap (default 5). */
    k?: number;
    /** Minimum similarity for a skill to be selected (default 0.2). */
    minScore?: number;
}
export interface SkillSelection {
    /** Rows worth injecting into the system prompt (order preserved). */
    selected: SkillIndexEntry[];
    /** Rows pruned from the index (still discoverable via events). */
    excluded: SkillIndexEntry[];
}
export declare const DEFAULT_SELECT_K = 5;
export declare const DEFAULT_SELECT_MIN_SCORE = 0.2;
/** Jaccard similarity of two token sets (0 = disjoint, 1 = identical). */
export declare function skillSimilarity(goalTokens: Set<string>, rowTokens: Set<string>): number;
/**
 * Select relevant index rows for a task goal. An empty goal selects nothing
 * (no relevance signal) but also excludes nothing — the caller's default
 * (full index) behavior is preserved by returning every row as selected.
 */
export declare function selectSkills(index: readonly SkillIndexEntry[], taskGoal: string, opts?: SelectSkillsOptions): SkillSelection;
//# sourceMappingURL=selection.d.ts.map