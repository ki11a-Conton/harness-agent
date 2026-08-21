import { describe, expect, it } from "vitest";
import { counterfactualRetry, summarizeCounterfactual, tallyOf, } from "./counterfactual.js";
function outcome(caseId, retries, latencyMs) {
    const retryEvents = Array.from({ length: retries }, (_, i) => ({
        id: i + 1,
        sessionId: "s",
        sequence: i,
        timestamp: 0,
        type: "retry.provider",
        payload: { reason: "counterfactual-fixture" },
    }));
    return {
        caseId,
        status: "passed",
        actualStatus: "completed",
        events: retryEvents,
        metrics: {
            turn_count: 1,
            tool_call_count: 1,
            tokens_input: 500,
            tokens_output: 50,
            context_tokens: 0,
            compaction_count: 0,
            duration_ms: latencyMs,
            retry_count: retries,
            verification_failures: 0,
            human_interventions: 0,
            estimated_cost: 0,
        },
        violations: [],
        suite: "regression",
        judgeVersion: "1.0.0",
    };
}
describe("P3-16 counterfactual — retry & stall, deterministic only", () => {
    it("recomputes bounded retries under an alternative policy from recorded tallies", () => {
        const runs = [
            { caseId: "a", tally: tallyOf(outcome("a", 8, 1000)), latencyMs: 1000 },
            { caseId: "b", tally: tallyOf(outcome("b", 2, 1000)), latencyMs: 1000 },
        ];
        const deltas = counterfactualRetry(runs, { retryPolicy: { maxRetries: 3 } });
        expect(deltas.find((d) => d.caseId === "a")).toMatchObject({ baseRetries: 8, proposedRetries: 3, retryDelta: 5 });
        expect(deltas.find((d) => d.caseId === "b")).toMatchObject({ baseRetries: 2, proposedRetries: 2, retryDelta: 0 });
    });
    it("flags turns that would stall earlier under a smaller threshold", () => {
        const runs = [
            { caseId: "slow", tally: tallyOf(outcome("slow", 2, 2500)), latencyMs: 2500 },
            { caseId: "fast", tally: tallyOf(outcome("fast", 2, 300)), latencyMs: 300 },
        ];
        const deltas = counterfactualRetry(runs, { stallThresholdMs: 1000 });
        expect(deltas.find((d) => d.caseId === "slow").wouldStallEarlier).toBe(true);
        expect(deltas.find((d) => d.caseId === "fast").wouldStallEarlier).toBe(false);
    });
    it("summarizes retries saved and stalling-earlier turns", () => {
        const runs = [
            { caseId: "a", tally: tallyOf(outcome("a", 6, 1000)), latencyMs: 1000 },
            { caseId: "b", tally: tallyOf(outcome("b", 1, 1000)), latencyMs: 1000 },
        ];
        const sum = summarizeCounterfactual(counterfactualRetry(runs, { retryPolicy: { maxRetries: 2 } }));
        expect(sum.totalRetriesSaved).toBe(4);
    });
    it("never fabricates model output — it only re-tallies recorded events", () => {
        const runs = [
            { caseId: "a", tally: tallyOf(outcome("a", 3, 500)), latencyMs: 500 },
        ];
        const deltas = counterfactualRetry(runs, { retryPolicy: { maxRetries: 10 } });
        // A larger max retry cap cannot increase recorded retries.
        expect(deltas[0].retryDelta).toBe(0);
    });
});
//# sourceMappingURL=counterfactual.test.js.map