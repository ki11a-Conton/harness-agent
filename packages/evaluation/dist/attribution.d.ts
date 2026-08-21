import type { AgentEvent } from "@ar/contracts";
/**
 * P2-10: Automated Regression Attribution.
 *
 * When a challenger regresses (its metrics fall behind the baseline), a bare
 * "passRate 83% → 80%" is not actionable. This module reduces a case's event
 * trail into a per-dimension signal summary (model retries, tool retries,
 * compactions, verification failures, permission/security failures, context
 * overflow, latency, tokens, false completion, subagent failures), then
 * compares baseline vs challenger to name the likely regression source with
 * concrete event evidence.
 *
 * It is deliberately a pure function of event streams — the same traffic the
 * runner already judges on — so it never depends on model wording and never
 * fabricates a source that has no supporting counters.
 */
/** All regression signal dimensions we can attribute. Each maps to a counter. */
export declare const REGRESSION_DIMENSIONS: readonly ["model_retries", "tool_retries", "compactions", "verification_failures", "permission_failures", "security_failures", "context_overflow", "latency_ms", "tokens", "false_complete", "subagent_failures"];
export type RegressionDimension = (typeof REGRESSION_DIMENSIONS)[number];
export interface EventTally {
    model_retries: number;
    tool_retries: number;
    compactions: number;
    verification_failures: number;
    permission_failures: number;
    security_failures: number;
    context_overflow: number;
    /** Model-call latency in ms (sum of model.completed durationMs). */
    latency_ms: number;
    /** Total output tokens consumed in the run. */
    tokens: number;
    /** Turns that declared success but were later signalled as a false complete. */
    false_complete: number;
    subagent_failures: number;
}
/** Reduce one case's event trail into per-dimension tallies. */
export declare function tallyEvents(events: AgentEvent[]): EventTally;
export interface RegressionEvidence {
    dimension: RegressionDimension;
    baseline: number;
    challenger: number;
    delta: number;
    /** Unequivocal event counts supporting this dimension: [baselineEvents, challengerEvents]. */
    evidence: [string[], string[]];
}
/** Someone regressed: the challenger's tally collides with the baseline's. */
export interface RegressionAttribution {
    /** Named source: regression suspected ("" when none of the counters moved). */
    likelySource: RegressionDimension | "";
    /** Whether the challenger fell behind at all on the attributed dimension. */
    regressed: boolean;
    /** Every dimension that worsened, ordered by |delta| desc. */
    contributors: RegressionEvidence[];
    /** Case ids whose baseline tally beats the challenger's on the primary source. */
    affectedCases: string[];
}
/**
 * Compare per-case tallies. `baselineCases`/`challengerCases` may each contain
 * repeated tallies (one per benchmark case). The primary source is the
 * dimension with the largest challenger-minus-baseline delta margin across
 * the summed tallies; affectedCases are the case labels where the challenger
 * exceeded the baseline on that dimension.
 */
export declare function attributeRegression(baselineCases: readonly {
    caseId: string;
    tally: EventTally;
}[], challengerCases: readonly {
    caseId: string;
    tally: EventTally;
}[]): RegressionAttribution;
/** Deterministic tally of an empty stream — used to keep the contract honest. */
export declare function zeroTally(): EventTally;
//# sourceMappingURL=attribution.d.ts.map