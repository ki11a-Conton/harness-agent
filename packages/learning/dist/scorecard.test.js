import { describe, expect, it } from "vitest";
import { computeScoreCard, percentile } from "./scorecard.js";
function metrics(overrides = {}) {
    return {
        turn_count: 1,
        tool_call_count: 5,
        tokens_input: 1_000,
        tokens_output: 500,
        context_tokens: 0,
        compaction_count: 0,
        duration_ms: 1_000,
        retry_count: 0,
        verification_failures: 0,
        human_interventions: 0,
        estimated_cost: 0,
        ...overrides,
    };
}
function outcome(overrides = {}) {
    const suite = overrides.suite ?? "regression";
    const passed = overrides.passed ?? true;
    const durationMs = overrides.durationMs ?? 1_000;
    const { suite: _suite, passed: _passed, durationMs: _durationMs, metrics: metricsOverride, ...rest } = overrides;
    return {
        caseId: `case-${Math.random()}`,
        status: passed ? "passed" : "failed",
        actualStatus: passed ? "completed" : "failed",
        events: [],
        metrics: metrics({ duration_ms: durationMs, ...metricsOverride }),
        violations: passed ? [] : ["expected completed but turn failed"],
        suite,
        judgeVersion: "1.0.0",
        ...rest,
    };
}
describe("percentile", () => {
    it("uses nearest-rank semantics", () => {
        expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
        expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
        expect(percentile([1, 2, 3, 4], 0.25)).toBe(1);
    });
    it("returns 0 for empty input", () => {
        expect(percentile([], 0.5)).toBe(0);
    });
    it("handles single values and p = 1", () => {
        expect(percentile([7], 0.5)).toBe(7);
        expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    });
});
describe("computeScoreCard", () => {
    it("scores suite success rates from case statuses", () => {
        const card = computeScoreCard([
            outcome({ suite: "regression" }),
            outcome({ suite: "regression", passed: false }),
            outcome({ suite: "holdout" }),
            outcome({ suite: "adversarial", passed: false }),
            outcome({ suite: "stress" }),
        ]);
        expect(card.regressionSuccessRate).toBe(0.5);
        expect(card.holdoutSuccessRate).toBe(1);
        expect(card.adversarialPassRate).toBe(0);
        expect(card.stressPassRate).toBe(1);
    });
    it("scores 0 for suites with no cases (honest no-evidence)", () => {
        const card = computeScoreCard([outcome({ suite: "regression" })]);
        expect(card.holdoutSuccessRate).toBe(0);
        expect(card.adversarialPassRate).toBe(0);
        expect(card.stressPassRate).toBe(0);
    });
    it("counts false completes only among passed model_stopped cases", () => {
        const card = computeScoreCard([
            outcome({ terminationReason: "model_stopped" }),
            outcome({ terminationReason: "verified_complete" }),
            outcome({ passed: false, terminationReason: "verification_failed" }),
        ]);
        expect(card.falseCompleteRate).toBeCloseTo(1 / 3);
        const clean = computeScoreCard([
            outcome({ terminationReason: "verified_complete" }),
            outcome({ passed: false, terminationReason: "verification_failed" }),
        ]);
        expect(clean.falseCompleteRate).toBe(0);
    });
    it("computes recovery rate from verification failures that still pass", () => {
        const recovering = computeScoreCard([
            outcome({ metrics: { verification_failures: 2 }, terminationReason: "verified_complete" }),
            outcome({ metrics: { verification_failures: 1 }, passed: false }),
        ]);
        expect(recovering.recoveryRate).toBe(0.5);
        const noFailures = computeScoreCard([outcome({ terminationReason: "verified_complete" })]);
        expect(noFailures.recoveryRate).toBe(1);
    });
    it("averages retries and token/tool usage per case", () => {
        const card = computeScoreCard([
            outcome({ metrics: { retry_count: 2, tokens_input: 2_000, tokens_output: 1_000, tool_call_count: 10 } }),
            outcome({ metrics: { retry_count: 0, tokens_input: 4_000, tokens_output: 2_000, tool_call_count: 4 } }),
        ]);
        expect(card.retryRate).toBe(1);
        expect(card.avgInputTokens).toBe(3_000);
        expect(card.avgOutputTokens).toBe(1_500);
        expect(card.avgToolCalls).toBe(7);
    });
    it("computes latency percentiles from per-case durations", () => {
        const card = computeScoreCard([
            outcome({ durationMs: 100 }),
            outcome({ durationMs: 200 }),
            outcome({ durationMs: 300 }),
            outcome({ durationMs: 1_000 }),
        ]);
        expect(card.latencyP50Ms).toBe(200);
        expect(card.latencyP95Ms).toBe(1_000);
    });
    it("sums context overflows (compaction events)", () => {
        const card = computeScoreCard([
            outcome({ metrics: { compaction_count: 2 } }),
            outcome({ metrics: { compaction_count: 0 } }),
            outcome({ metrics: { compaction_count: 3 } }),
        ]);
        expect(card.contextOverflows).toBe(5);
    });
    it("counts only adversarial failures as security violations", () => {
        const card = computeScoreCard([
            outcome({ suite: "adversarial", passed: false }),
            outcome({ suite: "adversarial" }),
            outcome({ suite: "regression", passed: false }),
            outcome({ suite: "stress", passed: false }),
        ]);
        expect(card.securityViolations).toBe(1);
    });
    it("produces a zero card for empty outcomes (no NaN)", () => {
        const card = computeScoreCard([]);
        for (const value of Object.values(card)) {
            expect(Number.isFinite(value)).toBe(true);
        }
        expect(card.regressionSuccessRate).toBe(0);
        expect(card.recoveryRate).toBe(1);
        expect(card.latencyP50Ms).toBe(0);
    });
});
//# sourceMappingURL=scorecard.test.js.map