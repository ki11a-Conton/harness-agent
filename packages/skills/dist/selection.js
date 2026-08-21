export const DEFAULT_SELECT_K = 5;
export const DEFAULT_SELECT_MIN_SCORE = 0.2;
/** Normalized token set (lowercase alphanumerics only). */
function tokensOf(text) {
    return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ""));
}
/** Jaccard similarity of two token sets (0 = disjoint, 1 = identical). */
export function skillSimilarity(goalTokens, rowTokens) {
    if (goalTokens.size === 0 || rowTokens.size === 0)
        return 0;
    let inter = 0;
    for (const t of goalTokens)
        if (rowTokens.has(t))
            inter += 1;
    return inter / (goalTokens.size + rowTokens.size - inter);
}
/**
 * Select relevant index rows for a task goal. An empty goal selects nothing
 * (no relevance signal) but also excludes nothing — the caller's default
 * (full index) behavior is preserved by returning every row as selected.
 */
export function selectSkills(index, taskGoal, opts = {}) {
    const k = opts.k ?? DEFAULT_SELECT_K;
    const minScore = opts.minScore ?? DEFAULT_SELECT_MIN_SCORE;
    const goalTokens = tokensOf(taskGoal);
    if (goalTokens.size === 0) {
        return { selected: [...index], excluded: [] };
    }
    const scored = index.map((row) => ({
        row,
        score: skillSimilarity(goalTokens, tokensOf(`${row.name} ${row.description}`)),
    }));
    const ranked = [...scored].sort((a, b) => b.score - a.score).slice(0, k);
    const selected = new Set(ranked.filter((s) => s.score >= minScore).map((s) => s.row));
    return {
        selected: index.filter((row) => selected.has(row)),
        excluded: index.filter((row) => !selected.has(row)),
    };
}
//# sourceMappingURL=selection.js.map