import type { LearningCandidateKind } from "./candidate.js";
import type { HarnessScoreCard } from "./scorecard.js";
/**
 * P0-5 repeated paired evaluations: N runs per side (paired seed / comparable
 * configuration per index), summarized by median and population variance, then
 * compared through the Promotion Gate. Deliberately dependency-free — no
 * statistics library, per plan.md "不要引入复杂统计库也可以，先实现可靠的
 * repeated-run gate".
 */
/** Repeated runs required per side before any comparison is meaningful. */
export declare const MIN_REPEATED_RUNS = 2;
/** Max allowed median drop of the regression success rate. */
export declare const DEFAULT_REGRESSION_TOLERANCE = 0.02;
/** Max allowed median drop of the stress success rate ("不得明显增加资源故障"). */
export declare const DEFAULT_STRESS_TOLERANCE = 0.03;
/** Adversarial pass rate may not drop at all (security; hard by default). */
export declare const DEFAULT_ADVERSARIAL_TOLERANCE = 0;
/** Challenger variance may exceed the champion's by at most this factor when its median is worse. */
export declare const DEFAULT_VARIANCE_FACTOR = 3;
/** Challenger P95 latency may not exceed champion P95 × this factor. */
export declare const DEFAULT_RELATIVE_LATENCY_P95_FACTOR = 1.2;
/** Context overflow count may rise by no more than this slack. */
export declare const DEFAULT_OVERFLOW_SLACK = 0;
export type HoldoutRequirement = "improve" | "no-regress";
/**
 * Holdout policy per candidate kind: content candidates (memory/skill/
 * workflow/prompt_rule) must show positive holdout benefit; tuning candidates
 * (tool_preference/context_policy/retry_policy/scheduler_policy) must merely
 * not regress.
 */
export declare const HOLD_OUT_REQUIREMENT_BY_KIND: Record<LearningCandidateKind, HoldoutRequirement>;
export interface PairedGateOptions {
    regressionTolerance?: number;
    stressTolerance?: number;
    adversarialTolerance?: number;
    varianceFactor?: number;
    relativeLatencyP95Factor?: number;
    overflowSlack?: number;
    /** Per-kind override of the default holdout requirement. */
    holdoutRequirement?: Partial<Record<LearningCandidateKind, HoldoutRequirement>>;
    /** Absolute budgets for latency/tokens/tool-calls ("受预算约束"). */
    budgets?: {
        latencyP95Ms?: number;
        avgInputTokens?: number;
        avgOutputTokens?: number;
        avgToolCalls?: number;
    };
}
export interface PairedMetricVerdict {
    metric: string;
    /** Whether this metric can fail the gate (informational metrics never fail). */
    gated: boolean;
    championMedian: number;
    challengerMedian: number;
    championVariance: number;
    challengerVariance: number;
    verdict: "pass" | "fail";
    detail: string;
}
export interface PairedComparisonReport {
    overall: "promote" | "reject";
    reasons: string[];
    perMetric: PairedMetricVerdict[];
}
/** Median of a number array (even length: mean of the two middle values). */
export declare function median(values: number[]): number;
/** Population variance (mean of squared deviations); 0 for fewer than 2 samples. */
export declare function populationVariance(values: number[]): number;
/** Per-metric median card: every field replaced by the median across runs. */
export declare function medianCard(cards: HarnessScoreCard[]): HarnessScoreCard;
/**
 * Promotion Gate over N paired repeated runs (both sides evaluated N times
 * with the same seed / comparable configuration per index). Both sides must
 * have repeated runs; mismatched run counts reject.
 */
export declare function comparePaired(champion: HarnessScoreCard[], challenger: HarnessScoreCard[], opts?: PairedGateOptions & {
    holdout?: HoldoutRequirement;
}): PairedComparisonReport;
/**
 * Rollback comparison: the current runs against the single recorded
 * post-promotion scorecard. The challenger side must still be repeated
 * (current evaluations are always re-run N times); the reference side is the
 * frozen promotion record.
 */
export declare function compareVsReference(reference: HarnessScoreCard, current: HarnessScoreCard[], opts?: PairedGateOptions & {
    holdout?: HoldoutRequirement;
}): PairedComparisonReport;
//# sourceMappingURL=paired.d.ts.map