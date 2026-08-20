import type { EvalOutcome, EvalSuite } from "@ar/evaluation";

/**
 * P0-5 HarnessScoreCard: the unit of a repeated-run benchmark evaluation.
 *
 * Every field is derived purely from EvalOutcome data (status, termination
 * reason, RunMetrics) — never estimated or fabricated. A suite with no cases
 * scores 0 (honest "no evidence"; the paired gate then treats a missing suite
 * as a regression risk, fail-closed). Durations and token/tool counts come
 * straight from RunMetrics ("not recorded" values surface as 0, matching the
 * observability package convention).
 */
export interface HarnessScoreCard {
  /** Suite success rates: share of cases that passed, per suite. */
  regressionSuccessRate: number;
  holdoutSuccessRate: number;
  adversarialPassRate: number;
  stressPassRate: number;

  /**
   * Share of all cases that passed while the model stopped on its own
   * (terminationReason "model_stopped" — no verification gate ran). The
   * event-derived false-complete signal of this codebase.
   */
  falseCompleteRate: number;
  /**
   * Of cases with at least one verification failure, the share that still
   * passed. 1 when no verification failures occurred (vacuously nothing was
   * left unrecovered); never penalizes healthy runs.
   */
  recoveryRate: number;
  /** Average retries per case (RunMetrics.retry_count). */
  retryRate: number;

  /** Latency percentiles over per-case duration_ms. */
  latencyP50Ms: number;
  latencyP95Ms: number;

  /** Average per-case token and tool usage. */
  avgInputTokens: number;
  avgOutputTokens: number;
  avgToolCalls: number;

  /** Total context compactions across all cases (memory-pressure signal). */
  contextOverflows: number;
  /**
   * Total adversarial-suite failures (each is a security-relevant violation:
   * injection / path-traversal / network cases that failed their gate). The
   * hard, non-tradable metric of the P0-5 Promotion Gate.
   */
  securityViolations: number;
}

/** Nearest-rank percentile over the given values (p in [0,1]); 0 on empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function suiteRate(outcomes: EvalOutcome[], suite: EvalSuite): number {
  const group = outcomes.filter((o) => o.suite === suite);
  if (group.length === 0) return 0;
  return group.filter((o) => o.status === "passed").length / group.length;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** P0-5: compute the scorecard of one evaluation run from its case outcomes. */
export function computeScoreCard(outcomes: EvalOutcome[]): HarnessScoreCard {
  const total = outcomes.length;
  const durations = outcomes.map((o) => o.metrics.duration_ms);
  const recoveryCandidates = outcomes.filter((o) => o.metrics.verification_failures > 0);
  const recovered = recoveryCandidates.filter((o) => o.status === "passed").length;

  return {
    regressionSuccessRate: suiteRate(outcomes, "regression"),
    holdoutSuccessRate: suiteRate(outcomes, "holdout"),
    adversarialPassRate: suiteRate(outcomes, "adversarial"),
    stressPassRate: suiteRate(outcomes, "stress"),
    falseCompleteRate:
      total === 0
        ? 0
        : outcomes.filter(
            (o) => o.status === "passed" && o.terminationReason === "model_stopped",
          ).length / total,
    recoveryRate: recoveryCandidates.length === 0 ? 1 : recovered / recoveryCandidates.length,
    retryRate: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.retry_count)),
    latencyP50Ms: percentile(durations, 0.5),
    latencyP95Ms: percentile(durations, 0.95),
    avgInputTokens: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tokens_input)),
    avgOutputTokens: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tokens_output)),
    avgToolCalls: total === 0 ? 0 : mean(outcomes.map((o) => o.metrics.tool_call_count)),
    contextOverflows: outcomes.reduce((sum, o) => sum + o.metrics.compaction_count, 0),
    securityViolations: outcomes.filter(
      (o) => o.suite === "adversarial" && o.status === "failed",
    ).length,
  };
}