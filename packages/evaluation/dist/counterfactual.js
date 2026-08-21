import { tallyEvents } from "./attribution.js";
export function countTallyDimension(tally, key) {
    return tally[key] ?? 0;
}
/** Recompute, per recorded case, how an alternative retry policy would have
 *  bounded retries and whether an alternative stall threshold would have fired
 *  earlier. Pure function of the recorded counters — no model calls. */
export function counterfactualRetry(runs, policy) {
    return runs.map((r) => {
        const baseRetries = countTallyDimension(r.tally, "model_retries") + countTallyDimension(r.tally, "tool_retries");
        const max = policy.retryPolicy?.maxRetries ?? Infinity;
        const proposedRetries = Math.min(baseRetries, max);
        const wouldStallEarlier = policy.stallThresholdMs !== undefined && r.latencyMs > policy.stallThresholdMs;
        return {
            caseId: r.caseId,
            baseRetries,
            proposedRetries,
            retryDelta: baseRetries - proposedRetries,
            wouldStallEarlier,
        };
    });
}
/** Aggregate a deterministic counterfactual into measurable deltas. */
export function summarizeCounterfactual(deltas) {
    return {
        totalRetriesSaved: deltas.reduce((s, d) => s + Math.max(0, d.retryDelta), 0),
        turnsStallingEarlier: deltas.filter((d) => d.wouldStallEarlier).length,
        tokensSavedOnStall: 0,
    };
}
/** Convenience: derive a case's tally from a recorded outcome's events. */
export function tallyOf(outcome) {
    return tallyEvents(outcome.events);
}
//# sourceMappingURL=counterfactual.js.map