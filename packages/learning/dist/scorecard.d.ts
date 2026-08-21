import type { EvalOutcome } from "@ar/evaluation";
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
export declare function percentile(values: number[], p: number): number;
/** P0-5: compute the scorecard of one evaluation run from its case outcomes. */
export declare function computeScoreCard(outcomes: EvalOutcome[]): HarnessScoreCard;
//# sourceMappingURL=scorecard.d.ts.map