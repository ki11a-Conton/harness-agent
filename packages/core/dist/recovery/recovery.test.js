import { describe, expect, it } from "vitest";
import { RecoveryPolicy } from "./recovery.js";
const KINDS = ["tool_failure", "test_failure", "timeout", "context_overflow", "model_error"];
describe("RecoveryPolicy default matrix", () => {
    it("model_error retries like other non-context kinds, then fails safely", () => {
        const policy = new RecoveryPolicy();
        expect(policy.decide("model_error", 1).action).toBe("retry");
        expect(policy.decide("model_error", 2).action).toBe("retry");
        expect(policy.decide("model_error", 3).action).toBe("fail_safe");
    });
    it("tool_failure attempt 1 and 2 retry with 500ms delay", () => {
        const policy = new RecoveryPolicy();
        const d1 = policy.decide("tool_failure", 1);
        expect(d1.action).toBe("retry");
        expect(d1.retryDelayMs).toBe(500);
        expect(d1.maxAttempts).toBe(3);
        const d2 = policy.decide("tool_failure", 2);
        expect(d2.action).toBe("retry");
        expect(d2.retryDelayMs).toBe(500);
    });
    it("tool_failure attempt 3 fails safely", () => {
        const d = new RecoveryPolicy().decide("tool_failure", 3);
        expect(d.action).toBe("fail_safe");
        expect(d.retryDelayMs).toBeUndefined();
        expect(d.reason).toMatch(/exhausted/);
    });
    it("context_overflow attempt 3 asks", () => {
        const d = new RecoveryPolicy().decide("context_overflow", 3);
        expect(d.action).toBe("ask");
        expect(d.reason).toMatch(/compress|ask the user/i);
    });
    it("context_overflow attempt 1 and 2 retry", () => {
        const policy = new RecoveryPolicy();
        expect(policy.decide("context_overflow", 1).action).toBe("retry");
        expect(policy.decide("context_overflow", 2).action).toBe("retry");
    });
});
describe("RecoveryPolicy full kind matrix", () => {
    it("non-context kinds fail safely once attempts are exhausted", () => {
        const policy = new RecoveryPolicy();
        for (const kind of ["tool_failure", "test_failure", "timeout"]) {
            expect(policy.decide(kind, 1).action).toBe("retry");
            expect(policy.decide(kind, 2).action).toBe("retry");
            const d = policy.decide(kind, 3);
            expect(d.action).toBe("fail_safe");
            expect(d.retryDelayMs).toBeUndefined();
        }
    });
    it("attempts above the cap never retry", () => {
        const policy = new RecoveryPolicy();
        for (const kind of KINDS) {
            const d = policy.decide(kind, 99);
            expect(d.action === "retry").toBe(false);
            expect(d.maxAttempts).toBe(3);
        }
    });
});
describe("RecoveryPolicy per-kind overrides", () => {
    it("maxAttemptsByKind { timeout: 1 } caps only timeout", () => {
        const policy = new RecoveryPolicy({ maxAttemptsByKind: { timeout: 1 } });
        const d = policy.decide("timeout", 1);
        expect(d.action).toBe("fail_safe");
        expect(d.maxAttempts).toBe(1);
        expect(policy.decide("test_failure", 1).action).toBe("retry");
        expect(policy.decide("test_failure", 3).action).toBe("fail_safe");
    });
    it("askOn { test_failure } asks when exhausted", () => {
        const policy = new RecoveryPolicy({ askOn: new Set(["test_failure"]) });
        const d = policy.decide("test_failure", 3);
        expect(d.action).toBe("ask");
        expect(policy.decide("tool_failure", 3).action).toBe("fail_safe");
    });
    it("retryDelayByKind overrides only the named kind", () => {
        const policy = new RecoveryPolicy({ retryDelayByKind: { tool_failure: 100 } });
        expect(policy.decide("tool_failure", 1).retryDelayMs).toBe(100);
        expect(policy.decide("test_failure", 1).retryDelayMs).toBe(500);
    });
    it("global retryDelayMs applies to all kinds without per-kind override", () => {
        const policy = new RecoveryPolicy({ retryDelayMs: 1000 });
        for (const kind of KINDS) {
            expect(policy.decide(kind, 1).retryDelayMs).toBe(1000);
        }
    });
});
describe("RecoveryPolicy boundaries", () => {
    it("maxAttempts 0 never retries: context_overflow asks, others fail safe", () => {
        const policy = new RecoveryPolicy({ maxAttempts: 0 });
        expect(policy.decide("context_overflow", 1).action).toBe("ask");
        expect(policy.decide("tool_failure", 1).action).toBe("fail_safe");
        expect(policy.decide("test_failure", 1).action).toBe("fail_safe");
        expect(policy.decide("timeout", 1).action).toBe("fail_safe");
    });
    it("per-kind maxAttempts 0 applies the same boundary to that kind", () => {
        const policy = new RecoveryPolicy({ maxAttemptsByKind: { timeout: 0 } });
        expect(policy.decide("timeout", 1).action).toBe("fail_safe");
        expect(policy.decide("tool_failure", 1).action).toBe("retry");
    });
    it("throws TypeError for attempt <= 0", () => {
        const policy = new RecoveryPolicy();
        expect(() => policy.decide("tool_failure", 0)).toThrow(TypeError);
        expect(() => policy.decide("tool_failure", -1)).toThrow(TypeError);
    });
    it("throws TypeError for non-integer attempt", () => {
        expect(() => new RecoveryPolicy().decide("timeout", 1.5)).toThrow(TypeError);
    });
});
describe("RecoveryPolicy determinism", () => {
    it("same inputs produce identical decisions", () => {
        const policy = new RecoveryPolicy({ maxAttemptsByKind: { timeout: 2 }, askOn: new Set(["timeout"]) });
        const read = (d) => JSON.stringify(d);
        for (const kind of KINDS) {
            for (const attempt of [1, 2, 3]) {
                expect(read(policy.decide(kind, attempt))).toBe(read(policy.decide(kind, attempt)));
            }
        }
    });
});
//# sourceMappingURL=recovery.test.js.map