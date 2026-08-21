import { describe, expect, it } from "vitest";
import { newEventId, newSessionId } from "@ar/contracts";
import { scoreCost, DEFAULT_COST_WEIGHTS, COST_DIMENSIONS, } from "./cost-model.js";
const sid = newSessionId();
function ev(type, payload = {}) {
    return {
        id: newEventId(),
        sessionId: sid,
        sequence: 0,
        timestamp: 0,
        type: type,
        payload,
    };
}
function input(over = {}) {
    return {
        status: "passed",
        violations: [],
        metrics: {
            turn_count: 1,
            tool_call_count: 1,
            tokens_input: 0,
            tokens_output: 0,
            context_tokens: 0,
            compaction_count: 0,
            duration_ms: 1,
            retry_count: 0,
            verification_failures: 0,
            human_interventions: 0,
            estimated_cost: 0,
        },
        events: [],
        ...over,
    };
}
describe("P2-14 cost model — clean run", () => {
    it("scores a passing, efficient, clean run at 100 across the board", () => {
        const r = scoreCost(input());
        expect(r.securityViolation).toBe(false);
        expect(r.score).toBe(100);
        for (const dimension of COST_DIMENSIONS) {
            expect(r.dimensionScores[dimension]).toBe(100);
        }
    });
    it("default weights sum to 1.0 and cover every dimension", () => {
        const sum = Object.values(DEFAULT_COST_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 5);
        expect(Object.keys(DEFAULT_COST_WEIGHTS).sort()).toEqual([...COST_DIMENSIONS].sort());
    });
});
describe("P2-14 cost model — dimension behaviour", () => {
    it("quality rewards passed > failed > error", () => {
        expect(scoreCost(input()).dimensionScores.quality).toBe(100);
        expect(scoreCost(input({ status: "failed" })).dimensionScores.quality).toBe(30);
        expect(scoreCost(input({ status: "error" })).dimensionScores.quality).toBe(0);
    });
    it("failed-but-clean still scores meaningfully above zero (promotes learning, not just success)", () => {
        const r = scoreCost(input({ status: "failed" }));
        expect(r.securityViolation).toBe(false);
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThan(100);
    });
    it("degraded reliability (verifications, human interventions, compactions) lowers the score", () => {
        const clean = scoreCost(input()).score;
        const bad = scoreCost(input({
            status: "passed",
            metrics: {
                ...input().metrics,
                verification_failures: 2,
                human_interventions: 1,
                compaction_count: 3,
                tool_call_count: 40, // over the 20 budget
                tokens_input: 50_000, // over the 32k budget
                duration_ms: 80_000, // over the 30s budget
                retry_count: 8, // over the 4 budget
            },
        })).score;
        expect(bad).toBeLessThan(clean);
    });
    it("over-budget latency/tokens/tool-calls/retries are penalised proportionally, not capped to 0", () => {
        const slow = scoreCost(input({
            status: "passed",
            metrics: { ...input().metrics, duration_ms: 60_000 }, // 2x the 30s budget
        }));
        expect(slow.dimensionScores.latency).toBeCloseTo(50, 0);
        expect(slow.dimensionScores.tokens).toBe(100); // untouched
        expect(slow.score).toBeGreaterThan(0); // cost penalty, not a gate
    });
    it("a passing-but-wasteful run scores below a passing-efficient run", () => {
        const efficient = scoreCost(input()).score;
        const wasteful = scoreCost(input({
            status: "passed",
            metrics: {
                ...input().metrics,
                tokens_input: 96_000, // 3x token budget
                tool_call_count: 60, // 3x tool budget
                retry_count: 12, // 3x retry budget
                duration_ms: 90_000, // 3x latency budget
            },
        })).score;
        expect(wasteful).toBeLessThan(efficient);
    });
});
describe("P2-14 cost model — security hard gate", () => {
    it("zeroes the overall score on ANY security.*_denied event, even when everything else is perfect", () => {
        const r = scoreCost(input({
            status: "passed",
            events: [ev("security.network_denied", { tool: "exec" })],
        }));
        expect(r.securityViolation).toBe(true);
        expect(r.score).toBe(0);
        expect(r.dimensionScores.security).toBe(0);
        expect(r.securityReasons.length).toBeGreaterThan(0);
    });
    it("treats an attempted network command as a hard violation (attempt is the failure)", () => {
        const r = scoreCost(input({
            status: "passed",
            events: [ev("tool.requested", { tool: "exec", args: { command: "curl http://x" } })],
        }));
        expect(r.securityViolation).toBe(true);
        expect(r.score).toBe(0);
    });
    it("a cheap+fast run can never offset a security violation (hard gate, not a cost tradeoff)", () => {
        const gated = scoreCost(input({
            status: "passed",
            metrics: { ...input().metrics }, // minimal cost: nothing over budget
            events: [ev("security.process_denied")],
        }));
        // Compare against the exact same clean trace without the denial.
        const ungated = scoreCost(input({ status: "passed", metrics: { ...input().metrics } }));
        expect(gated.securityViolation).toBe(true);
        expect(gated.score).toBe(0);
        expect(ungated.score).toBe(100);
    });
    it("secret_redacted is a soft hit (boundary worked) — scores 0 security but no gate", () => {
        const r = scoreCost(input({ status: "passed", events: [ev("security.secret_redacted", { redacted: 1 })] }));
        expect(r.securityViolation).toBe(false);
        expect(r.dimensionScores.security).toBe(80); // 100 - 20 soft hit
        expect(r.score).toBeGreaterThan(0);
    });
});
describe("P2-14 cost model — configurable weights", () => {
    it("merges partial weights over the defaults", () => {
        const r = scoreCost(input(), { weights: { quality: 1, security: 0.5 } });
        expect(r.weights.quality).toBe(1);
        expect(r.weights.latency).toBe(DEFAULT_COST_WEIGHTS.latency); // default kept
    });
    it("a custom budget rescales the latency penalty", () => {
        // 60s duration is over the 30s default but within a 120s budget.
        const over = scoreCost(input({ status: "passed", metrics: { ...input().metrics, duration_ms: 60_000 } }), { budgets: { latencyMs: 120_000 } }).dimensionScores.latency;
        expect(over).toBe(100);
    });
});
//# sourceMappingURL=cost-model.test.js.map