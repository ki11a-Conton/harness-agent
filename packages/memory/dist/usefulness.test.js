import { describe, expect, it } from "vitest";
import { newMemoryId } from "@ar/contracts";
import { hasUsefulness, INITIAL_USEFULNESS_SCORE, recordUsefulness, } from "./usefulness.js";
function makeEntry(overrides = {}) {
    return {
        id: newMemoryId(),
        content: "lesson content",
        type: "procedural",
        sourceSession: "session_a",
        scope: "session",
        importance: 0.7,
        confidence: 0.6,
        novelty: 0.5,
        stability: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        deleted: false,
        ...overrides,
    };
}
function tracked(score, overrides = {}) {
    return {
        retrievedCount: 0,
        injectedCount: 0,
        usedCount: 0,
        taskSuccessCount: 0,
        verificationPassedCount: 0,
        score,
        ...overrides,
    };
}
describe("P2-3 usefulness feedback", () => {
    it("retrieved only counts and does not move the score", () => {
        const entry = makeEntry({ usefulness: tracked(0.5) });
        const next = recordUsefulness(entry, { kind: "retrieved" });
        expect(next.usefulness.retrievedCount).toBe(1);
        expect(next.usefulness.score).toBe(0.5);
    });
    it("a bare entry starts with neutral score on first feedback (immutable)", () => {
        const entry = makeEntry();
        const next = recordUsefulness(entry, { kind: "used" });
        expect(entry.usefulness).toBeUndefined();
        expect(next.usefulness.usedCount).toBe(1);
        expect(next.usefulness.score).toBeGreaterThan(INITIAL_USEFULNESS_SCORE);
    });
    it("signals raise the score toward 1 with increasing strength", () => {
        let entry = makeEntry({ usefulness: tracked(0.1) });
        entry = recordUsefulness(entry, { kind: "injected" });
        entry = recordUsefulness(entry, { kind: "used" });
        entry = recordUsefulness(entry, { kind: "taskSucceeded" });
        entry = recordUsefulness(entry, { kind: "verificationPassed" });
        expect(entry.usefulness.injectedCount).toBe(1);
        expect(entry.usefulness.usedCount).toBe(1);
        expect(entry.usefulness.taskSuccessCount).toBe(1);
        expect(entry.usefulness.verificationPassedCount).toBe(1);
        expect(entry.usefulness.score).toBeGreaterThan(0.85);
    });
    it("repeated feedback saturates at 1 without overshooting", () => {
        let entry = makeEntry({ usefulness: tracked(0.99) });
        for (let i = 0; i < 10; i += 1) {
            entry = recordUsefulness(entry, { kind: "taskSucceeded" });
        }
        expect(entry.usefulness.taskSuccessCount).toBe(10);
        expect(entry.usefulness.score).toBeCloseTo(1, 4);
        expect(entry.usefulness.score).toBeLessThanOrEqual(1);
    });
    it("hasUsefulness is false until the first feedback", () => {
        expect(hasUsefulness(makeEntry())).toBe(false);
        expect(hasUsefulness(recordUsefulness(makeEntry(), { kind: "retrieved" }))).toBe(true);
    });
});
//# sourceMappingURL=usefulness.test.js.map