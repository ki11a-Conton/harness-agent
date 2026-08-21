import { describe, expect, it } from "vitest";
import { RunBudgetTracker } from "./run-budget.js";
describe("P0-10 RunBudgetTracker", () => {
    it("tracks tool calls and breaches maxToolCalls", () => {
        const tracker = new RunBudgetTracker({ maxToolCalls: 3, maxDurationMs: 60000 }, () => 0);
        expect(tracker.onToolCall()).toBeUndefined();
        expect(tracker.onToolCall()).toBeUndefined();
        expect(tracker.onToolCall()).toBeUndefined();
        const breach = tracker.onToolCall();
        expect(breach).toBeDefined();
        expect(breach.limit).toBe("maxToolCalls");
        expect(breach.used).toBe(4);
        expect(breach.allowed).toBe(3);
    });
    it("tracks duration and breaches maxDurationMs", () => {
        let now = 1000;
        const tracker = new RunBudgetTracker({ maxDurationMs: 100 }, () => now);
        expect(tracker.onDurationCheck()).toBeUndefined();
        now += 101;
        const breach = tracker.onDurationCheck();
        expect(breach).toBeDefined();
        expect(breach.limit).toBe("maxDurationMs");
        expect(breach.used).toBe(101);
        expect(breach.allowed).toBe(100);
    });
    it("reports the first breach only (subsequent checks are no-ops)", () => {
        const tracker = new RunBudgetTracker({ maxToolCalls: 1, maxDurationMs: 1 }, () => 0);
        const first = tracker.onToolCall();
        expect(first).toBeUndefined(); // 1 <= 1, not yet breached
        const second = tracker.onToolCall(); // 2 > 1 → breached
        expect(second).toBeDefined();
        // After breach, all subsequent checks return undefined.
        expect(tracker.onToolCall()).toBeUndefined();
        expect(tracker.onDurationCheck()).toBeUndefined();
    });
    it("snapshot() returns the current accumulated state", () => {
        let now = 0;
        const tracker = new RunBudgetTracker({ maxToolCalls: 10, maxDurationMs: 5000, maxRetries: 2 }, () => now);
        tracker.onToolCall();
        tracker.onToolCall();
        tracker.onRetry();
        now += 1234;
        const snap = tracker.snapshot();
        expect(snap.usedToolCalls).toBe(2);
        expect(snap.retries).toBe(1);
        expect(snap.durationMs).toBe(1234);
        expect(snap.limits.maxToolCalls).toBe(10);
    });
    it("onModelUsage accumulates token and cost deltas", () => {
        const tracker = new RunBudgetTracker({ maxEstimatedCostUsd: 5 }, () => 0);
        expect(tracker.onModelUsage(100, 50, 0.5)).toBeUndefined();
        expect(tracker.onModelUsage(200, 25, 1.0)).toBeUndefined();
        const breach = tracker.onModelUsage(300, 75, 4.5);
        expect(breach).toBeDefined();
        expect(breach.limit).toBe("maxEstimatedCostUsd");
        expect(breach.used).toBeCloseTo(6.0, 6);
        expect(breach.allowed).toBe(5);
        const snap = tracker.snapshot();
        // inputTokens and outputTokens are accumulated on the tracker's internal
        // counters, but RunBudget doesn't have those fields — only estimatedCost.
        expect(snap.estimatedCostUsd).toBeCloseTo(6.0, 6);
    });
    it("onOutput accumulates output chars", () => {
        const tracker = new RunBudgetTracker({ maxOutputChars: 100 }, () => 0);
        expect(tracker.onOutput(40)).toBeUndefined();
        expect(tracker.onOutput(60)).toBeUndefined();
        const breach = tracker.onOutput(5);
        expect(breach).toBeDefined();
        expect(breach.limit).toBe("maxOutputChars");
        expect(breach.used).toBe(105);
        expect(breach.allowed).toBe(100);
    });
    it("onSubagentSpawn tracks subagent count", () => {
        const tracker = new RunBudgetTracker({ maxSubagents: 2 }, () => 0);
        expect(tracker.onSubagentSpawn()).toBeUndefined();
        expect(tracker.onSubagentSpawn()).toBeUndefined();
        const breach = tracker.onSubagentSpawn();
        expect(breach).toBeDefined();
        expect(breach.limit).toBe("maxSubagents");
    });
    it("does not breach when a limit is undefined (no limit configured)", () => {
        const tracker = new RunBudgetTracker({}, () => 0);
        for (let i = 0; i < 1000; i++) {
            expect(tracker.onToolCall()).toBeUndefined();
            expect(tracker.onDurationCheck()).toBeUndefined();
            expect(tracker.onRetry()).toBeUndefined();
            expect(tracker.onSubagentSpawn()).toBeUndefined();
            expect(tracker.onModelUsage(1, 1, 1)).toBeUndefined();
            expect(tracker.onOutput(1)).toBeUndefined();
        }
    });
});
//# sourceMappingURL=run-budget.test.js.map