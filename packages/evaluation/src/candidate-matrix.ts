/**
 * P21-2 — candidate feature matrix.
 *
 * Every mechanism that may enter the Champion is a named, individually
 * toggleable CANDIDATE. Evaluation is single-variable FIRST (baseline vs ONE
 * candidate on), and only afterwards a few reviewed combinations. A candidate
 * that cannot be switched off in isolation is not a candidate.
 *
 * The config mapping below is the switch the harness composition root honors
 * (feature flags / runtime deps). The matrix is data — a reviewed config,
 * not prose — so a benchmark can enumerate candidates mechanically.
 */

export type CandidateDefaultPolicy = "yes" | "no" | "evidence";

export interface CandidateFeature {
  /** Stable candidate id (the single-variable switch name). */
  id: string;
  description: string;
  /** Harness config key(s) the candidate flips. */
  configKey: string;
  /** Config values that turn the candidate OFF (the baseline state). */
  disabled: Record<string, unknown>;
  /** Config values that turn the candidate ON. */
  enabled: Record<string, unknown>;
  /**
   * P21-5 champion default policy:
   *   "yes"      — default ON in the champion preset.
   *   "no"       — default OFF (trust surface / user-configured only).
   *   "evidence" — champion inclusion requires benchmark proof (P21-4).
   */
  defaultOn: CandidateDefaultPolicy;
}

/** The nine candidates plan.md P21-2 requires. */
export const CANDIDATE_FEATURES: CandidateFeature[] = [
  {
    id: "context_pipeline_v5",
    description: "context pipeline V5 (budget + instruction discovery + compaction)",
    configKey: "features.context",
    disabled: { features: { context: false } },
    enabled: { features: { context: true } },
    defaultOn: "yes",
  },
  {
    id: "tool_selector_deferred_schema",
    description: "tool selector / deferred schema advertisement (P18-2)",
    configKey: "toolSelector.enabled",
    disabled: { toolSelector: { enabled: false } },
    enabled: { toolSelector: { enabled: true } },
    defaultOn: "yes",
  },
  {
    id: "memory_retrieval",
    description: "pre-turn memory retrieval into context (P2-2)",
    configKey: "features.memory",
    disabled: { features: { memory: false } },
    enabled: { features: { memory: true } },
    defaultOn: "evidence",
  },
  {
    id: "memory_write_learning",
    description: "post-turn reflection + procedural memory write gate (P2-5)",
    configKey: "features.learning",
    disabled: { features: { learning: false } },
    enabled: { features: { learning: true } },
    defaultOn: "evidence",
  },
  {
    id: "adaptive_recovery",
    description: "bounded recovery taxonomy planner (P19-3)",
    configKey: "adaptiveRecovery.enabled",
    disabled: { adaptiveRecovery: { enabled: false } },
    enabled: { adaptiveRecovery: { enabled: true } },
    defaultOn: "evidence",
  },
  {
    id: "independent_reviewer",
    description: "read-only independent reviewer candidate (P19-2, not default)",
    configKey: "reviewer.enabled",
    disabled: { reviewer: { enabled: false } },
    enabled: { reviewer: { enabled: true } },
    defaultOn: "no",
  },
  {
    id: "delegation",
    description: "subagent delegation (worker/explore/batch)",
    configKey: "features.delegation",
    disabled: { features: { delegation: false } },
    enabled: { features: { delegation: true } },
    defaultOn: "evidence",
  },
  {
    id: "adaptive_context_policy",
    description: "adaptive context budget policy (evaluation/context-policy)",
    configKey: "contextPolicy.adaptive",
    disabled: { contextPolicy: { adaptive: false } },
    enabled: { contextPolicy: { adaptive: true } },
    defaultOn: "evidence",
  },
  {
    id: "adaptive_scheduler",
    description: "adaptive tree scheduler with per-agent budgets",
    configKey: "scheduler.adaptive",
    disabled: { scheduler: { adaptive: false } },
    enabled: { scheduler: { adaptive: true } },
    defaultOn: "evidence",
  },
];

/** Look up a candidate by id; undefined when unknown (callers fail closed). */
export function candidateOf(id: string): CandidateFeature | undefined {
  return CANDIDATE_FEATURES.find((c) => c.id === id);
}

/** The nine candidate ids, in order. */
export function candidateIds(): string[] {
  return CANDIDATE_FEATURES.map((c) => c.id);
}

/** Reviewed two-candidate combinations (run AFTER all single variables). */
export const CANDIDATE_COMBINATIONS: ReadonlyArray<readonly [string, string]> = [
  ["independent_reviewer", "delegation"],
  ["memory_retrieval", "memory_write_learning"],
  ["adaptive_context_policy", "adaptive_scheduler"],
];

/**
 * P21-2 — the evaluation plan: baseline (all candidates off) → every single
 * variable → the reviewed combinations. Single variables MUST be evaluated
 * before combinations so a combined effect is never mistaken for a single
 * mechanism's contribution.
 */
export interface CandidateMatrixPlan {
  baseline: "baseline";
  singleVariable: string[];
  combinations: ReadonlyArray<readonly [string, string]>;
}

export function buildCandidateMatrixPlan(): CandidateMatrixPlan {
  return {
    baseline: "baseline",
    singleVariable: candidateIds(),
    combinations: CANDIDATE_COMBINATIONS,
  };
}

/**
 * Apply a candidate (or the baseline) to a base harness config. The baseline
 * disables EVERY candidate; a candidate flips only its own keys on top of
 * the baseline (so a single-variable run differs by exactly one mechanism).
 */
export function applyCandidateConfig(
  base: Record<string, unknown>,
  candidateId: "baseline" | string,
): Record<string, unknown> {
  // Start from the baseline: every candidate disabled.
  let config = { ...base };
  for (const candidate of CANDIDATE_FEATURES) {
    config = deepMerge(config, candidate.disabled);
  }
  if (candidateId === "baseline") return config;
  const candidate = candidateOf(candidateId);
  if (candidate === undefined) {
    throw new TypeError(`unknown candidate: ${candidateId}`);
  }
  return deepMerge(config, candidate.enabled);
}

/** Shallow-merge helper (values replaced wholesale — flags are scalars). */
function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const existing = typeof out[key] === "object" && out[key] !== null && !Array.isArray(out[key])
        ? (out[key] as Record<string, unknown>)
        : {};
      out[key] = deepMerge(existing, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
