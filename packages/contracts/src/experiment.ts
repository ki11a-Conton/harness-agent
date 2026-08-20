/**
 * P2-9: Mechanism Experiment Harness — variant comparison framework.
 *
 * Allows running multiple strategy variants (e.g. Compaction A vs B,
 * Retry A vs B) against the same benchmark without duplicating the
 * runtime. A config file declares variants; the harness runs each
 * variant and produces a comparison report.
 */

/** One variant of a mechanism: named overrides applied to a config. */
export interface ExperimentVariant {
  name: string;
  mechanism: string;
  overrides: Record<string, unknown>;
}

/** Experiment config: which variants to compare, how to run them. */
export interface ExperimentConfig {
  id: string;
  description?: string;
  variants: ExperimentVariant[];
  /** Name of the baseline variant; defaults to the first variant. */
  baseline?: string;
  /** Benchmark suite to run each variant against. */
  benchmarkSuite?: string;
  /** Number of repeated runs per variant (default 3). */
  runs?: number;
  /** Random seeds for reproducibility (default empty = auto). */
  seeds?: number[];
  /**
   * P2-15: models to evaluate each variant against, listed strongest-first.
   * Defaults to ["default"] for single-model runs. Cross-model analysis needs
   * ≥2 models so that "improves only one model" / "harms weaker model"
   * regressions can be detected.
   */
  models?: string[];
  /** P2-15: explicit capability tag per model ("strong" | "weak"). When
   *  omitted, the first entry in `models` is the strong model and the rest
   *  are weak. */
  modelCapabilities?: Record<string, "strong" | "weak">;
}

/** Result of running one variant through the benchmark. */
export interface ExperimentVariantResult {
  variantName: string;
  mechanism: string;
  status: "completed" | "failed" | "skipped";
  /** Key metrics collected from the run (e.g. { passRate, latencyP50, latencyP95, tokens }). */
  metrics: Record<string, number>;
  error?: string;
  startedAt: number;
  durationMs: number;
  /** P2-15: the model this variant result was produced under ("" = default/single-model). */
  model?: string;
}

/** Comparison of two variants on one metric. */
export interface ExperimentComparison {
  variantA: string;
  variantB: string;
  metric: string;
  /** Absolute delta (A - B); positive means A is better. */
  delta: number;
  /** Which variant is better, or null if tied. */
  winner: string | null;
  /** P2-15: the model the two variants were compared under. */
  model?: string;
}

/**
 * P2-15: a cross-model finding for one mechanism (non-baseline variant) on
 * one metric. Flags the two regressions a single-model eval cannot surface:
 *
 * - "harms-weaker":  the mechanism improves the strong model's metric but
 *                    regresses the weak model's — the exact trap P2-15 exists
 *                    to catch (over-fitting an optimization to one prompt style).
 * - "improves-only-strong" / "improves-only-weak": the mechanism moves only one
 *                    model's metric; the other is untouched or regressed.
 * - "consistent":   both models move in the same beneficial direction.
 * - "mixed":        both move against the baseline; neither improvement holds.
 *
 * `strongDelta` / `weakDelta` are arithmetic deltas (mechanism − baseline);
 * positive means the mechanism moved that model's metric in the direction the
 * benchmark treats as better (higher-is-better metrics).
 */
export interface CrossModelFinding {
  mechanism: string;
  metric: string;
  strongDelta: number;
  weakDelta: number;
  kind:
    | "harms-weaker"
    | "improves-only-strong"
    | "improves-only-weak"
    | "consistent"
    | "mixed";
  detail: string;
}

/** P2-15: per-model break-down of a mechanism and which model it actually serves. */
export interface CrossModelAnalysis {
  model: { strong: string; weak: string };
  findings: CrossModelFinding[];
  /** Counts of each finding kind (for quick CLI/report scanning). */
  counts: Record<string, number>;
}

/** Full experiment report: results + comparisons. */
export interface ExperimentReport {
  configId: string;
  description?: string;
  results: ExperimentVariantResult[];
  comparisons: ExperimentComparison[];
  startedAt: number;
  completedAt: number;
  /** P2-15: cross-model findings when the config evaluates ≥2 models. */
  crossModel?: CrossModelAnalysis;
}