import { describe, expect, it, vi } from "vitest";
import { LearningPromoterV2 } from "./promoter.js";
function card(overrides = {}) {
    return {
        regressionSuccessRate: 1,
        holdoutSuccessRate: 0.5,
        adversarialPassRate: 1,
        stressPassRate: 1,
        falseCompleteRate: 0,
        recoveryRate: 1,
        retryRate: 0.5,
        latencyP50Ms: 500,
        latencyP95Ms: 1_000,
        avgInputTokens: 1_000,
        avgOutputTokens: 500,
        avgToolCalls: 5,
        contextOverflows: 0,
        securityViolations: 0,
        ...overrides,
    };
}
function candidate(overrides = {}) {
    return {
        id: "cand-1",
        kind: "memory",
        content: "learned lesson",
        version: "v1.0.0",
        proposedAt: 1_752_000_000_000,
        securityChecked: false,
        ...overrides,
    };
}
const RUNS = 3;
function makePromoteDeps(overrides = {}) {
    return {
        securityCheck: vi.fn(async () => ({ ok: true })),
        championRuns: vi.fn(async () => card()),
        challengerRuns: vi.fn(async () => card({ holdoutSuccessRate: 0.6 })),
        runs: RUNS,
        persist: vi.fn(async () => { }),
        ...overrides,
    };
}
const promoter = new LearningPromoterV2();
describe("LearningPromoterV2.promote (champion/challenger gate)", () => {
    it("promotes when the paired gate passes and records the full ledger", async () => {
        const c = candidate();
        const deps = makePromoteDeps();
        const decision = await promoter.promote(c, deps);
        expect(decision.action).toBe("promoted");
        expect(decision.report?.overall).toBe("promote");
        expect(deps.persist).toHaveBeenCalledTimes(1);
        expect(deps.championRuns).toHaveBeenCalledTimes(RUNS);
        expect(deps.challengerRuns).toHaveBeenCalledTimes(RUNS);
        expect(c.promotionRecord).toBeDefined();
        const record = c.promotionRecord;
        expect(record.candidateVersion).toBe("v1.0.0");
        expect(record.beforeScorecard.holdoutSuccessRate).toBe(0.5);
        expect(record.afterScorecard.holdoutSuccessRate).toBe(0.6);
    });
    it("records version metadata verbatim and '(not recorded)' when absent", async () => {
        const c = candidate();
        const deps = makePromoteDeps({
            meta: {
                evaluationConfig: "3 runs, seed 42",
                suiteVersions: "regression v2, holdout v1",
                judgeVersion: "1.5.0",
                modelProviderVersion: "model-x/provider-y",
            },
        });
        await promoter.promote(c, deps);
        const record = c.promotionRecord;
        expect(record.evaluationConfig).toBe("3 runs, seed 42");
        expect(record.suiteVersions).toBe("regression v2, holdout v1");
        expect(record.judgeVersion).toBe("1.5.0");
        expect(record.modelProviderVersion).toBe("model-x/provider-y");
        const bare = candidate();
        await promoter.promote(bare, makePromoteDeps());
        expect(bare.promotionRecord.evaluationConfig).toBe("(not recorded)");
        expect(bare.promotionRecord.judgeVersion).toBe("(not recorded)");
    });
    it("rejects on security failure before any benchmark runs, without persisting", async () => {
        const c = candidate();
        const deps = makePromoteDeps({
            securityCheck: vi.fn(async () => ({ ok: false, reason: "dangerous skill change" })),
        });
        const decision = await promoter.promote(c, deps);
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("dangerous skill change");
        expect(decision.report).toBeUndefined();
        expect(deps.championRuns).not.toHaveBeenCalled();
        expect(deps.challengerRuns).not.toHaveBeenCalled();
        expect(deps.persist).not.toHaveBeenCalled();
    });
    it("rejects when runs < MIN_REPEATED_RUNS (single sample is insufficient)", async () => {
        const decision = await promoter.promote(candidate(), makePromoteDeps({ runs: 1 }));
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("one sample is insufficient");
        expect(decision.report).toBeUndefined();
    });
    it("rejects and never persists when champion runs fail", async () => {
        const deps = makePromoteDeps({
            championRuns: vi.fn(async () => {
                throw new Error("benchmark service down");
            }),
        });
        const decision = await promoter.promote(candidate(), deps);
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("benchmark service down");
        expect(deps.persist).not.toHaveBeenCalled();
    });
    it("rejects and never persists when challenger runs fail", async () => {
        const deps = makePromoteDeps({
            challengerRuns: vi.fn(async () => {
                throw new Error("challenger crashed");
            }),
        });
        const decision = await promoter.promote(candidate(), deps);
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("challenger crashed");
        expect(deps.persist).not.toHaveBeenCalled();
    });
    it("rejects when the gate fails and surfaces the report", async () => {
        const c = candidate();
        const deps = makePromoteDeps({
            championRuns: vi.fn(async () => card({ regressionSuccessRate: 1 })),
            challengerRuns: vi.fn(async () => card({ regressionSuccessRate: 0.5 })),
        });
        const decision = await promoter.promote(c, deps);
        expect(decision.action).toBe("rejected");
        expect(decision.report?.overall).toBe("reject");
        expect(decision.reason).toContain("promotion gate rejected");
        expect(deps.persist).not.toHaveBeenCalled();
        expect(c.promotionRecord).toBeUndefined();
    });
    it("requires memory-kind candidates to show positive holdout benefit", async () => {
        const deps = makePromoteDeps({
            challengerRuns: vi.fn(async () => card({ holdoutSuccessRate: 0.5 })),
        });
        const decision = await promoter.promote(candidate({ kind: "memory" }), deps);
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("holdout");
        expect(deps.persist).not.toHaveBeenCalled();
    });
    it("allows tuning kinds to hold the holdout rate (no-regress)", async () => {
        const deps = makePromoteDeps({
            challengerRuns: vi.fn(async () => card({ holdoutSuccessRate: 0.5 })),
        });
        const decision = await promoter.promote(candidate({ kind: "retry_policy" }), deps);
        expect(decision.action).toBe("promoted");
        expect(deps.persist).toHaveBeenCalledTimes(1);
    });
    it("never persists on rejection", async () => {
        const deps = makePromoteDeps({
            challengerRuns: vi.fn(async () => card({ securityViolations: 1 })),
        });
        const decision = await promoter.promote(candidate(), deps);
        expect(decision.action).toBe("rejected");
        expect(deps.persist).not.toHaveBeenCalled();
    });
});
describe("LearningPromoterV2.reEvaluate (§70/§777-797 rollback)", () => {
    async function promoteOnce(overrides = {}) {
        const c = candidate();
        await promoter.promote(c, makePromoteDeps(overrides));
        return c;
    }
    function makeReEvalDeps(currentRuns = async () => card({ holdoutSuccessRate: 0.6 })) {
        return {
            currentRuns: vi.fn(currentRuns),
            runs: RUNS,
        };
    }
    it("keeps the promotion while the current scorecard holds", async () => {
        const c = await promoteOnce();
        const decision = await promoter.reEvaluate(c, makeReEvalDeps());
        expect(decision.action).toBe("promoted");
        expect(decision.report?.overall).toBe("promote");
    });
    it("rolls back on a security violation that the champion never had", async () => {
        const c = await promoteOnce();
        const deps = makeReEvalDeps(async () => card({ holdoutSuccessRate: 0.6, securityViolations: 1 }));
        const decision = await promoter.reEvaluate(c, deps);
        expect(decision.action).toBe("rolled_back");
        expect(decision.report?.overall).toBe("reject");
        expect(decision.reason).toContain("regression detected");
        expect(decision.reason).toContain("securityViolations");
    });
    it("rolls back on a regression below the recorded post-promotion median", async () => {
        const c = await promoteOnce();
        const deps = makeReEvalDeps(async () => card({ holdoutSuccessRate: 0.6, regressionSuccessRate: 0.4 }));
        const decision = await promoter.reEvaluate(c, deps);
        expect(decision.action).toBe("rolled_back");
        expect(decision.reason).toContain("regression");
    });
    it("rolls back when current runs cannot be collected (fail-closed)", async () => {
        const c = await promoteOnce();
        const deps = makeReEvalDeps(async () => {
            throw new Error("evaluation environment down");
        });
        const decision = await promoter.reEvaluate(c, deps);
        expect(decision.action).toBe("rolled_back");
        expect(decision.reason).toContain("evaluation environment down");
    });
    it("rolls back when fewer than MIN_REPEATED_RUNS current runs are supplied", async () => {
        const c = await promoteOnce();
        const decision = await promoter.reEvaluate(c, { currentRuns: vi.fn(async () => card()), runs: 1 });
        expect(decision.action).toBe("rolled_back");
        expect(decision.reason).toContain("repeated re-evaluation");
    });
    it("rejects when the candidate was never promoted", async () => {
        const decision = await promoter.reEvaluate(candidate(), makeReEvalDeps());
        expect(decision.action).toBe("rejected");
        expect(decision.reason).toContain("never promoted");
    });
    it("rollback never persists (undoing the live change is the caller's action)", async () => {
        const c = await promoteOnce();
        await promoter.reEvaluate(c, makeReEvalDeps(async () => card({ securityViolations: 2 })));
        expect(c.promotionRecord).toBeDefined();
    });
});
//# sourceMappingURL=promoter-v2.test.js.map