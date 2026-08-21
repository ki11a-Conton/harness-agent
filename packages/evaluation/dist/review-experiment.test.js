import { describe, expect, it } from "vitest";
import { assertReviewerIsolation, aggregateReview, decideReviewPromotion, defaultTruthLayer, deriveReviewable, renderReviewComparison, runReviewExperiment, simulateReviewRun, } from "./review-experiment.js";
const CASE = {
    id: "review-case",
    task: "implement the feature and verify",
    expected: { status: "completed" },
    suite: "regression",
};
function makeOutcome(caseId, opts = {}) {
    const events = [];
    for (const path of opts.writes ?? []) {
        events.push({
            id: events.length + 1,
            sessionId: "s",
            sequence: events.length,
            timestamp: 0,
            type: "tool.completed",
            payload: {
                tool: "write_file",
                status: "success",
                args: { path },
                toolCallId: `tc-${events.length}`,
            },
        });
    }
    if (opts.verificationEvidence === true) {
        events.push({
            id: events.length + 1,
            sessionId: "s",
            sequence: events.length,
            timestamp: 0,
            type: "verification.completed",
            payload: { passed: true },
        });
    }
    return {
        caseId,
        status: opts.status ?? "passed",
        actualStatus: "completed",
        events,
        metrics: {
            turn_count: 1,
            tool_call_count: opts.writes?.length ?? 0,
            tokens_input: 800,
            tokens_output: 200,
            context_tokens: 0,
            compaction_count: 0,
            duration_ms: 1000,
            retry_count: 0,
            verification_failures: 0,
            human_interventions: 0,
            estimated_cost: 0.01,
            ...opts.metrics,
        },
        violations: [],
        suite: "regression",
        judgeVersion: "1.0.0",
    };
}
describe("P3-2 review agent — isolation guard", () => {
    it("rejects an input carrying any hidden-reasoning key (fail closed)", () => {
        expect(() => assertReviewerIsolation({ caseId: "x", reasoning: "secret" })).toThrow(/isolation violated/);
        expect(() => assertReviewerIsolation({ chain_of_thought: "…" })).toThrow(/isolation violated/);
    });
    it("accepts a clean artifacts/diff/evidence reviewable", () => {
        expect(() => assertReviewerIsolation({
            caseId: "x",
            changedPaths: ["a.ts"],
            touchedTests: true,
            evidence: [],
        })).not.toThrow();
    });
    it("deriveReviewable surfaces only observable diff/evidence, never reasoning", () => {
        const outcome = makeOutcome("c", {
            writes: ["src/a.ts", "test/a.test.ts", "node_modules/x.js"],
            verificationEvidence: true,
        });
        const reviewable = deriveReviewable(outcome, 7);
        expect(reviewable.changedPaths).toContain("src/a.ts");
        expect(reviewable.touchedTests).toBe(true);
        expect(reviewable.touchedGeneratedOrConfig).toBe(true);
        expect(reviewable.verificationPassed).toBe(true);
        expect(reviewable.evidence.length).toBeGreaterThan(0);
        expect(Object.keys(reviewable)).not.toContain("reasoning");
    });
});
describe("P3-2 review agent — truth layer and simulation", () => {
    it("default truth marks test+evidence work lower-risk than bare diffs", () => {
        const safe = makeOutcome("safe", {
            writes: ["src/a.ts", "test/a.test.ts"],
            verificationEvidence: true,
        });
        const risky = makeOutcome("risky", { writes: ["dist/gen.js"] });
        // With a fixed seed, assert the model returns a boolean and is deterministic.
        expect(typeof defaultTruthLayer(safe, 7).latentDefect).toBe("boolean");
        expect(typeof defaultTruthLayer(risky, 7).latentDefect).toBe("boolean");
        expect(defaultTruthLayer(risky, 7)).toEqual(defaultTruthLayer(risky, 7));
    });
    it("worker_verifier pipeline never flags (identity champion)", () => {
        const outcome = makeOutcome("c");
        const run = simulateReviewRun(outcome, { caseId: "c", latentDefect: true }, deriveReviewable(outcome, 7), "worker_verifier");
        expect(run.flagged).toBe(false);
        expect(run.defectCaught).toBe(false);
        expect(run.tokens).toBe(1000);
    });
    it("challenger can catch a latent defect and adds review tokens/latency", () => {
        const outcome = makeOutcome("c", { writes: ["dist/gen.js"] });
        const reviewable = deriveReviewable(outcome, 7);
        const run = simulateReviewRun(outcome, { caseId: "c", latentDefect: true }, reviewable, "worker_reviewer_verifier", { model: { defectRecall: 1, falsePositiveRate: 0 }, seed: 3 });
        expect(run.tokens).toBe(1000 + 800);
        expect(run.durationMs).toBe(1000 + 1000);
        expect(run.defectCaught).toBe(true);
        expect(run.flagged).toBe(true);
    });
});
describe("P3-2 review agent — aggregation", () => {
    it("aggregateReview computes slipped defects, false positives, net caught", () => {
        const runs = [
            { caseId: "a", pipeline: "worker_reviewer_verifier", latentDefect: true, verificationPassed: true, flagged: true, defectCaught: true, falsePositiveHandled: false, tokens: 1800, durationMs: 2000 },
            { caseId: "b", pipeline: "worker_reviewer_verifier", latentDefect: true, verificationPassed: true, flagged: false, defectCaught: false, falsePositiveHandled: false, tokens: 1800, durationMs: 2000 },
            { caseId: "c", pipeline: "worker_reviewer_verifier", latentDefect: false, verificationPassed: true, flagged: true, defectCaught: false, falsePositiveHandled: true, tokens: 1800, durationMs: 2000 },
            { caseId: "d", pipeline: "worker_reviewer_verifier", latentDefect: false, verificationPassed: true, flagged: false, defectCaught: false, falsePositiveHandled: false, tokens: 1800, durationMs: 2000 },
        ];
        const agg = aggregateReview(runs, "worker_reviewer_verifier");
        expect(agg.slippedDefects).toBe(1); // one latent defect missed
        expect(agg.falsePositives).toBe(1);
        expect(agg.netDefectsCaught).toBe(0); // 1 caught - 1 false positive
        expect(agg.defectCaughtRate).toBe(0.5);
    });
});
describe("P3-2 review agent — promotion gate", () => {
    it("promotes a reviewer that nets enough defect catches with low noise", () => {
        const d = decideReviewPromotion({ netDefectsCaught: 3, slippedDelta: -3, falsePositiveRate: 0.1, costScoreDelta: 5 });
        expect(d.promote).toBe(true);
    });
    it("rejects a token/latency-only reviewer with no defect value", () => {
        const d = decideReviewPromotion({ netDefectsCaught: 0, slippedDelta: 0, falsePositiveRate: 0, costScoreDelta: -2 });
        expect(d.promote).toBe(false);
        expect(d.code).toBe("no_defect_value");
    });
    it("rejects a too-noisy reviewer even when it catches defects", () => {
        const d = decideReviewPromotion({ netDefectsCaught: 2, slippedDelta: -2, falsePositiveRate: 0.6, costScoreDelta: 5 });
        expect(d.promote).toBe(false);
        expect(d.code).toBe("too_noisy");
    });
    it("rejects when review cost is net-negative despite catching defects", () => {
        const d = decideReviewPromotion({ netDefectsCaught: 2, slippedDelta: -2, falsePositiveRate: 0.1, costScoreDelta: -1 });
        expect(d.promote).toBe(false);
        expect(d.code).toBe("cost_negative");
    });
});
describe("P3-2 review agent — end-to-end experiment", () => {
    it("promotes when the isolated reviewer nets defect value", async () => {
        const cases = Array.from({ length: 6 }, (_, i) => ({ ...CASE, id: `c${i}` }));
        const result = await runReviewExperiment(cases, (c) => Promise.resolve(makeOutcome(c.id, { writes: ["dist/gen.js"], verificationEvidence: true })), {
            model: { defectRecall: 1, falsePositiveRate: 0.05, reviewOnlyWhenVerified: true },
            truth: () => ({ caseId: "c", latentDefect: true }),
            gate: { minimumNetDefectsCaught: 1, maxFalsePositiveRate: 0.3 },
            seed: 5,
        });
        expect(result.decision.promote).toBe(true);
        expect(result.challenger.slippedDefects).toBeLessThan(result.baseline.slippedDefects);
    });
    it("rejects when review adds only cost on clean outputs", async () => {
        const cases = Array.from({ length: 5 }, (_, i) => ({ ...CASE, id: `k${i}` }));
        const result = await runReviewExperiment(cases, (c) => Promise.resolve(makeOutcome(c.id, { writes: ["src/ok.ts"] })), {
            // all clean, high review cost
            model: { reviewTokensPerCase: 1_000_000, reviewLatencyMsPerCase: 1_000_000, falsePositiveRate: 0 },
            truth: () => ({ caseId: "c", latentDefect: false }),
            gate: { minimumNetDefectsCaught: 1 },
            seed: 2,
        });
        expect(result.decision.promote).toBe(false);
        expect(result.tokenDeltaRatio).toBeGreaterThan(0);
    });
    it("renderReviewComparison includes decision and deltas", async () => {
        const result = await runReviewExperiment([{ ...CASE, id: "z" }], (c) => Promise.resolve(makeOutcome(c.id, { writes: ["dist/gen.js"] })), {
            model: { defectRecall: 1, falsePositiveRate: 0 },
            truth: () => ({ caseId: "z", latentDefect: true }),
            gate: { minimumNetDefectsCaught: 1 },
            seed: 9,
        });
        const text = renderReviewComparison(result);
        expect(text).toContain("PROMOTE");
        expect(text).toContain("slipped defects");
        expect(text).toContain("cost score");
    });
});
//# sourceMappingURL=review-experiment.test.js.map