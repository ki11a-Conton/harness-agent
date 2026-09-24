import { describe, expect, it } from "vitest";
import {
  createRecoveryTask,
  recoveryPolicy,
  transitionRecoveryTask,
  nextTaskToDrain,
  retryDue,
  taskTerminal,
  type RecoveryTaskRecord,
  type RecoveryClock,
} from "./recovery-state-machine.js";

class ManualClock implements RecoveryClock {
  t = 0;
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

const policy = () => recoveryPolicy({ maxRecoveryAttempts: 2, backoffBaseMs: 100, exhaustedPolicy: "block-queue" });

function mkTask(clock: ManualClock, taskId = "T1", lineageId = "L1"): RecoveryTaskRecord {
  return createRecoveryTask(taskId, lineageId, policy(), clock);
}

describe("E2-10 same-T bounded recovery state machine", () => {
  it("1. T1 attempt1 fails -> attempt2 succeeds -> only then T2 starts (strict order)", () => {
    const clock = new ManualClock();
    const t1 = mkTask(clock, "T1");
    const t2 = mkTask(clock, "T2", "L2");
    const tasks = [t1, t2];

    // Begin T1 (attempt 1).
    let s = transitionRecoveryTask(tasks[0]!, { type: "begin" }, policy(), clock);
    expect(s.state).toBe("RECOVERY_IN_PROGRESS");
    expect(s.attempt).toBe(1);
    expect(nextTaskToDrain([s, tasks[1]!], clock)!.taskId).toBe("T1");
    // Handler fails (retryable).
    s = transitionRecoveryTask(s, { type: "handler_failed", error: "boom", retryable: true }, policy(), clock);
    expect(s.state).toBe("RETRY_SCHEDULED");
    expect(s.attempt).toBe(1);
    // Backoff NOT elapsed -> T1 still head, T2 blocked.
    expect(retryDue(s, clock)).toBe(false);
    expect(nextTaskToDrain([s, tasks[1]!], clock)!.taskId).toBe("T1");
    // Advance clock; begin same T again (attempt 2).
    clock.advance(150);
    expect(retryDue(s, clock)).toBe(true);
    s = transitionRecoveryTask(s, { type: "begin" }, policy(), clock);
    expect(s.attempt).toBe(2);
    // Handler succeeds.
    s = transitionRecoveryTask(s, { type: "handler_succeeded" }, policy(), clock);
    expect(s.state).toBe("RECOVERED");
    expect(taskTerminal(s)).toBe(true);
    // Only NOW may T2 drain (T1 terminal).
    expect(nextTaskToDrain([s, tasks[1]!], clock)!.taskId).toBe("T2");
  });

  it("2. T1 exhausts its recovery budget -> policy decides; no silent bypass (block-queue default)", () => {
    const clock = new ManualClock();
    let t = mkTask(clock, "T1");
    // Attempt 1 fails, attempt 2 fails (max=2) -> EXHAUSTED.
    t = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "e1", retryable: true }, policy(), clock);
    clock.advance(150);
    t = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "e2", retryable: true }, policy(), clock);
    expect(t.state).toBe("EXHAUSTED");
    expect(t.lastError).toBe("e2");
    expect(t.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
    // EXHAUSTED is terminal; with block-queue the caller stops draining entirely
    // and dead-letters — the policy is explicit, never a silent bypass.
    expect(taskTerminal(t)).toBe(true);
  });

  it("3. backoff: before nextAttemptAt no extra call; after it exactly one retry", () => {
    const clock = new ManualClock();
    const p3 = recoveryPolicy({ maxRecoveryAttempts: 3, backoffBaseMs: 100, exhaustedPolicy: "block-queue" });
    let t = createRecoveryTask("T1", "L1", p3, clock);
    t = transitionRecoveryTask(t, { type: "begin" }, p3, clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "x", retryable: true }, p3, clock);
    expect(t.nextAttemptAt).toBe(100); // first failure: base * 2^0
    // Before 100: not due.
    clock.advance(50);
    expect(retryDue(t, clock)).toBe(false);
    // Advance past: exactly eligible.
    clock.advance(60);
    expect(retryDue(t, clock)).toBe(true);
    // A second handler_failed schedules backoff base*2^(2-1) = 200.
    t = transitionRecoveryTask(t, { type: "begin" }, p3, clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "y", retryable: true }, p3, clock);
    expect(t.nextAttemptAt).toBe(clock.now() + 200);
    expect(retryDue(t, clock)).toBe(false);
  });

  it("4. restart: re-instantiating the actor re-drains the SAME T from persisted state", () => {
    const clock = new ManualClock();
    // Actor "crashes" mid-recovery: T1 persisted as RECOVERY_IN_PROGRESS.
    const crashed = transitionRecoveryTask(mkTask(clock, "T1"), { type: "begin" }, policy(), clock);
    expect(crashed.state).toBe("RECOVERY_IN_PROGRESS");
    // New actor instance re-reads the durable record (same taskId/lineage).
    const restarted = createRecoveryTask(crashed.taskId, crashed.lineageId, policy(), clock);
    // Same T is the head; recovery reuse (same T) is preserved — attempt 0 in
    // the new instance, but the durable record keeps the lineage identity.
    const head = nextTaskToDrain([restarted, mkTask(clock, "T2", "L2")], clock);
    expect(head!.taskId).toBe("T1");
    expect(head!.lineageId).toBe("L1");
  });

  it("5. replaying the same recovered completion twice does NOT double-produce followups (idempotent terminal)", () => {
    const clock = new ManualClock();
    let t = mkTask(clock, "T1");
    t = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    t = transitionRecoveryTask(t, { type: "handler_succeeded" }, policy(), clock);
    // Replaying "handler_succeeded" again is illegal (fail-closed), and a
    // RECOVERED record never re-enters RECOVERY_IN_PROGRESS — no duplicate.
    expect(() => transitionRecoveryTask(t, { type: "handler_succeeded" }, policy(), clock)).toThrow(/illegal/);
    expect(() => transitionRecoveryTask(t, { type: "begin" }, policy(), clock)).toThrow(/illegal begin from RECOVERED/);
    expect(t.attempt).toBe(1);
  });

  it("6. rapid failures have no hot loop — scheduler returns head without mutating", () => {
    const clock = new ManualClock();
    let t = mkTask(clock, "T1");
    const tasks = [t];
    for (let i = 0; i < 100; i++) {
      // nextTaskToDrain is a pure query — never advances state, never fires
      // anything; the caller must use retryDue to wait. No recursion, no drain.
      const head = nextTaskToDrain(tasks, clock);
      expect(head).not.toBeNull();
    }
    // And a RETRY_SCHEDULED head stays RETRY_SCHEDULED after many queries.
    t = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "x", retryable: true }, policy(), clock);
    for (let i = 0; i < 50; i++) {
      nextTaskToDrain([t], clock);
      expect(t.state).toBe("RETRY_SCHEDULED");
    }
  });

  it("7. non-retryable handler failure -> TERMINAL_FAILED (block, never silent)", () => {
    const clock = new ManualClock();
    let t = mkTask(clock, "T1");
    t = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    t = transitionRecoveryTask(t, { type: "handler_failed", error: "permanent", retryable: false }, policy(), clock);
    expect(t.state).toBe("TERMINAL_FAILED");
    expect(t.lastError).toBe("permanent");
    expect(taskTerminal(t)).toBe(true);
  });

  it("illegal transitions are fail-closed", () => {
    const clock = new ManualClock();
    const t = mkTask(clock, "T1");
    // handler_succeeded from PENDING is illegal.
    expect(() => transitionRecoveryTask(t, { type: "handler_succeeded" }, policy(), clock)).toThrow(/illegal/);
    // begin while backoff pending is illegal.
    let s = transitionRecoveryTask(t, { type: "begin" }, policy(), clock);
    s = transitionRecoveryTask(s, { type: "handler_failed", error: "x", retryable: true }, policy(), clock);
    expect(() => transitionRecoveryTask(s, { type: "begin" }, policy(), clock)).toThrow(/backoff not elapsed/);
  });
});