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

export const DEFAULT_SELECT_K = 5;
export const DEFAULT_SELECT_MIN_SCORE = 0.2;

/** Normalized token set (lowercase alphanumerics only). */
function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ""));
}

/** Jaccard similarity of two token sets (0 = disjoint, 1 = identical). */
export function skillSimilarity(goalTokens: Set<string>, rowTokens: Set<string>): number {
  if (goalTokens.size === 0 || rowTokens.size === 0) return 0;
  let inter = 0;
  for (const t of goalTokens) if (rowTokens.has(t)) inter += 1;
  return inter / (goalTokens.size + rowTokens.size - inter);
}

/**
 * Select relevant index rows for a task goal. An empty goal selects nothing
 * (no relevance signal) but also excludes nothing — the caller's default
 * (full index) behavior is preserved by returning every row as selected.
 */
export function selectSkills(
  index: readonly SkillIndexEntry[],
  taskGoal: string,
  opts: SelectSkillsOptions = {},
): SkillSelection {
  const k = opts.k ?? DEFAULT_SELECT_K;
  const minScore = opts.minScore ?? DEFAULT_SELECT_MIN_SCORE;
  const goalTokens = tokensOf(taskGoal);
  if (goalTokens.size === 0) {
    return { selected: [...index], excluded: [] };
  }

  const scored: Array<{ row: SkillIndexEntry; score: number }> = index.map((row) => ({
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