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
}

/** Full experiment report: results + comparisons. */
export interface ExperimentReport {
  configId: string;
  description?: string;
  results: ExperimentVariantResult[];
  comparisons: ExperimentComparison[];
  startedAt: number;
  completedAt: number;
}