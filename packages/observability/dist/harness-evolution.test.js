import { describe, expect, it, vi } from "vitest";
import { newEventId, newSessionId } from "@ar/contracts";
import { evaluateProposal, proposeChange, rollbackProposal, } from "./harness-evolution.js";
function totals(o) {
    return {
        success: o.success ?? 0,
        safety: o.safety ?? 0,
        reliability: o.reliability ?? 0,
        efficiency: o.efficiency ?? 0,
        latency: o.latency ?? 0,
        cost: o.cost ?? 0,
    };
}
function report(a, b) {
    return { cases: [], summary: { a: totals(a), b: totals(b) } };
}
function component(overrides = {}) {
    return {
        name: "@ar/contracts",
        path: "D:\\repo\\packages\\contracts",
        version: "0.1.0",
        deps: ["zod"],
        hasTests: true,
        ...overrides,
    };
}
let sequence = 0;
function evidenceEvent(payload = {}, type = "tool.failed") {
    sequence += 1;
    return {
        id: newEventId(),
        sessionId: newSessionId(),
        sequence,
        timestamp: 1_000 + sequence,
        type,
        payload,
    };
}
const CONTRACTS = component();
const AGENTS = component({
    name: "@ar/agents",
    path: "D:\\repo\\packages\\agents",
    deps: ["@ar/contracts", "@ar/core"],
});
// ---- proposeChange ----------------------------------------------------------
describe("proposeChange", () => {
    it("creates a draft proposal with generated id and preserved hypothesis fields", () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "tests are missing",
            expectedImprovement: "fewer regressions",
        });
        expect(proposal.id).toMatch(/^hc_\d+$/);
        expect(proposal.hypothesis).toBe("tests are missing");
        expect(proposal.expectedImprovement).toBe("fewer regressions");
        expect(proposal.status).toBe("draft");
    });
    it("records evidence event ids that implicate the target component, in order", () => {
        const implicating = evidenceEvent({ file: "D:\\repo\\packages\\contracts\\src\\x.ts" });
        const unrelated = evidenceEvent({ foo: "bar" });
        const byName = evidenceEvent({ package: "@ar/contracts" });
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [implicating, unrelated, byName],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(proposal.component).toBe("@ar/contracts");
        expect(proposal.evidenceRefs).toEqual([implicating.id, byName.id]);
    });
    it("falls back to component 'unknown' with no refs for an empty inventory", () => {
        const proposal = proposeChange({
            inventory: [],
            evidence: [evidenceEvent()],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(proposal.component).toBe("unknown");
        expect(proposal.evidenceRefs).toEqual([]);
    });
    it("picks the first inventory component with empty refs when no evidence mentions anything", () => {
        const proposal = proposeChange({
            inventory: [AGENTS, CONTRACTS],
            evidence: [evidenceEvent({ foo: "bar" })],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(proposal.component).toBe("@ar/agents");
        expect(proposal.evidenceRefs).toEqual([]);
    });
    it("selects the most-mentioned component; ties resolve to the first in inventory order", () => {
        const a1 = evidenceEvent({ file: "D:\\repo\\packages\\agents\\src\\a.ts" });
        const a2 = evidenceEvent({ package: "@ar/agents" });
        const c1 = evidenceEvent({ file: "D:\\repo\\packages\\contracts\\src\\c.ts" });
        const proposal = proposeChange({
            inventory: [CONTRACTS, AGENTS],
            evidence: [a1, a2, c1],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(proposal.component).toBe("@ar/agents");
        expect(proposal.evidenceRefs).toEqual([a1.id, a2.id]);
        const tie = proposeChange({
            inventory: [CONTRACTS, AGENTS],
            evidence: [a1, c1],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(tie.component).toBe("@ar/contracts");
    });
    it("assigns distinct ids to consecutive proposals", () => {
        const first = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const second = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        expect(second.id).not.toBe(first.id);
    });
});
// ---- evaluateProposal -------------------------------------------------------
describe("evaluateProposal", () => {
    it("accepts when success improves by at least the default threshold and safety holds", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 5 }, { success: 7 }),
        });
        expect(result.action).toBe("accept");
        expect(result.reason).toContain("5");
        expect(result.reason).toContain("7");
        expect(proposal.status).toBe("accepted");
    });
    it("accepts when the changed harness is also safer", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 4, safety: 2 }, { success: 6, safety: 4 }),
        });
        expect(result.action).toBe("accept");
        expect(proposal.status).toBe("accepted");
    });
    it("rejects a safety regression even when success improved (§150)", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 4, safety: 3 }, { success: 6, safety: 2 }),
        });
        expect(result.action).toBe("reject");
        expect(result.reason.toLowerCase()).toContain("safety");
        expect(proposal.status).toBe("rejected");
    });
    it("rejects when no baseline benchmark is recorded; benchmarkAfter is never called", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const benchmarkAfter = vi.fn(async () => report({}, {}));
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => undefined,
            benchmarkAfter,
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("baseline");
        expect(benchmarkAfter).not.toHaveBeenCalled();
        expect(proposal.status).toBe("rejected");
    });
    it("rejects when no after-change benchmark is recorded", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => undefined,
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("after-change");
        expect(proposal.status).toBe("rejected");
    });
    it("rejects without significant improvement (equal success, default threshold 1)", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 5 }, { success: 5 }),
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("improvement");
        expect(proposal.status).toBe("rejected");
    });
    it("honors a configurable threshold (boundary inclusive)", async () => {
        const withGain1 = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const rejected = await evaluateProposal(withGain1, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 5 }, { success: 6 }),
            threshold: 2,
        });
        expect(rejected.action).toBe("reject");
        expect(withGain1.status).toBe("rejected");
        const withGain2 = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const accepted = await evaluateProposal(withGain2, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 5 }, { success: 7 }),
            threshold: 2,
        });
        expect(accepted.action).toBe("accept");
        expect(withGain2.status).toBe("accepted");
    });
    it("accepts zero gain when the threshold is 0", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 5 }, { success: 5 }),
            threshold: 0,
        });
        expect(result.action).toBe("accept");
        expect(proposal.status).toBe("accepted");
    });
    it("rejects when the baseline benchmark throws, preserving the message; benchmarkAfter is never called", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const benchmarkAfter = vi.fn(async () => report({}, {}));
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => {
                throw new Error("store unavailable");
            },
            benchmarkAfter,
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("store unavailable");
        expect(benchmarkAfter).not.toHaveBeenCalled();
        expect(proposal.status).toBe("rejected");
    });
    it("rejects fail-closed when the after-change benchmark throws", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const result = await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => {
                throw new Error("simview crashed");
            },
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("simview crashed");
        expect(proposal.status).toBe("rejected");
    });
    it("rejects a non-draft proposal without calling any benchmark", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        proposal.status = "accepted";
        const benchmarkBefore = vi.fn(async () => report({}, {}));
        const benchmarkAfter = vi.fn(async () => report({}, {}));
        const result = await evaluateProposal(proposal, {
            benchmarkBefore,
            benchmarkAfter,
        });
        expect(result.action).toBe("reject");
        expect(result.reason).toContain("draft");
        expect(benchmarkBefore).not.toHaveBeenCalled();
        expect(benchmarkAfter).not.toHaveBeenCalled();
        expect(proposal.status).toBe("accepted");
    });
});
// ---- rollbackProposal -------------------------------------------------------
describe("rollbackProposal", () => {
    it("calls revert exactly once and marks the proposal rolled back", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        await evaluateProposal(proposal, {
            benchmarkBefore: async () => report({}, {}),
            benchmarkAfter: async () => report({ success: 1 }, { success: 3 }),
        });
        const revert = vi.fn(async () => { });
        const result = await rollbackProposal(proposal, { revert });
        expect(result.action).toBe("rolled_back");
        expect(revert).toHaveBeenCalledTimes(1);
        expect(proposal.status).toBe("rolled_back");
    });
    it("throws when the proposal was never accepted; revert is not called", async () => {
        const proposal = proposeChange({
            inventory: [CONTRACTS],
            evidence: [],
            hypothesis: "h",
            expectedImprovement: "e",
        });
        const revert = vi.fn(async () => { });
        await expect(rollbackProposal(proposal, { revert })).rejects.toThrow(/accepted/);
        expect(revert).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=harness-evolution.test.js.map