import type { EvalOutcome } from "./runner.js";
import type { EventTally } from "./attribution.js";
/**
 * P3-16 — Counterfactual Harness Evaluation.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). Long-term goal:
 * take ONE recorded trace and ask deterministic "what if" questions:
 *
 *   what if the retry policy were different?
 *   what if memory retrieval were different?
 *   what if we stalled earlier?
 *
 * The rule is that we only counterfactual over DETERMINISTIC components and
 * NEVER fabricate model behaviour — the measurable deltas come from tallying
 * recorded events under an alternative deterministic policy, not from guessing
 * what a model would have said.
 */
/**
 * Deterministic counterfactual over a recorded trace's event tally: applying an
 * alternative policy to the *recorded* counters. For example, "stall earlier"
 * recomputes which turns would have stalled/timed out and their cost, without
 * inventing any model output.
 */
export interface CounterfactualPolicies {
    /** Alternative retry strategy: how many retries are countenanced. */
    retryPolicy?: {
        maxRetries: number;
    };
    /** Alternative memory retrieval: how many candidate items retrieved (top-k). */
    memoryTopK?: number;
    /** Alternative stall threshold (ms): stall earlier is a *smaller* threshold. */
    stallThresholdMs?: number;
}
export declare function countTallyDimension(tally: EventTally, key: keyof EventTally): number;
export interface CounterfactualDelta {
    caseId: string;
    baseRetries: number;
    proposedRetries: number;
    retryDelta: number;
    wouldStallEarlier: boolean;
}
/** Recompute, per recorded case, how an alternative retry policy would have
 *  bounded retries and whether an alternative stall threshold would have fired
 *  earlier. Pure function of the recorded counters — no model calls. */
export declare function counterfactualRetry(runs: {
    caseId: string;
    tally: EventTally;
    latencyMs: number;
}[], policy: CounterfactualPolicies): CounterfactualDelta[];
export interface CounterfactualSummary {
    totalRetriesSaved: number;
    turnsStallingEarlier: number;
    /** Apparent token saving if stalled-earlier turns never ran (0 for those that didn't). */
    tokensSavedOnStall: number;
}
/** Aggregate a deterministic counterfactual into measurable deltas. */
export declare function summarizeCounterfactual(deltas: CounterfactualDelta[]): CounterfactualSummary;
/** Convenience: derive a case's tally from a recorded outcome's events. */
export declare function tallyOf(outcome: EvalOutcome): EventTally;
//# sourceMappingURL=counterfactual.d.ts.map