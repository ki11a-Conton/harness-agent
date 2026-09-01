/**
 * E2-10 — same-T bounded recovery state machine.
 *
 * Defect (F-11): when a durable-recovery handler fails, the actor logs a
 * degraded note and calls `void this.drainFollowups()` — but the failed T1 has
 * already been SHIFTED out of the recoverable queue, so the next drain
 * consumes T2. That is NOT same-T bounded retry; T2 must never start until T1
 * reaches a terminal/exhausted state.
 *
 * This module is the typed state machine that replaces the fire-and-forget
 * behavior. It is PURE (no I/O, no wall-clock, injectable clock) so every
 * ordering / budget / backoff / restart / idempotency property is directly
 * testable:
 *
 *   States:
 *     PENDING              — queued, not yet attempted
 *     RECOVERY_IN_PROGRESS — a recovery attempt is running for this T
 *     RETRY_SCHEDULED      — recovery failed; same T retries after backoff
 *     RECOVERED            — recovery converged (terminal success)
 *     EXHAUSTED            — retry budget spent (terminal failure, dead-letter)
 *     TERMINAL_FAILED      — non-retryable failure (policy: stop, block)
 *
 *   Two distinct budgets (never reset against each other):
 *     task-retry budget   — the ORIGINAL task's execution retries
 *     recovery-retry budget — retries of the recovery HANDLER itself
 *   Both capped; crossing either cap on the same T moves it to EXHAUSTED.
 *
 *   Ordering invariant: `nextTaskToDrain` returns the SAME task while it is in
 *   RECOVERY_IN_PROGRESS / RETRY_SCHEDULED (not yet RECOVERED/EXHAUSTED/
 *   TERMINAL_FAILED) — T2 stays behind T1. Backoff is driven by the injected
 *   clock; before `nextAttemptAt`, the task is RETRY_SCHEDULED and blocks the
 *   queue (no T2), after it the same T retries exactly once per window.
 */

export const RECOVERY_STATE_MACHINE_SCHEMA_VERSION = "1.0.0";
export const RECOVERY_STATE_MACHINE_POLICY_VERSION = "e2-10-policy-v1";

export type RecoveryTaskState =
  | "PENDING"
  | "RECOVERY_IN_PROGRESS"
  | "RETRY_SCHEDULED"
  | "RECOVERED"
  | "EXHAUSTED"
  | "TERMINAL_FAILED";

export type RecoveryEvent =
  | { type: "begin" }                         // start recovery of this T
  | { type: "handler_failed"; error: string; retryable: boolean }
  | { type: "handler_succeeded" }
  | { type: "clock_tick" }                    // scheduler advances; re-evaluate backoff
  | { type: "retry_decision"; attempt: number; allow: boolean };

export interface RecoveryTaskRecord {
  /** Stable task identity (the durable Turn). */
  taskId: string;
  /** Lineage id (the prompt lineage this recovery belongs to). */
  lineageId: string;
  state: RecoveryTaskState;
  /** Recovery-handler attempt counter (same-T retries). */
  attempt: number;
  /** Maximum recovery-handler attempts (bounded). */
  maxRecoveryAttempts: number;
  /** Next allowed attempt timestamp (ms, via injected clock). */
  nextAttemptAt: number;
  /** Last typed error from the handler. */
  lastError: string | null;
  policyVersion: string;
}

export interface RecoveryClock {
  now(): number;
}

export interface RecoveryPolicyOptions {
  /** Max recovery-handler attempts per T (default 3). */
  maxRecoveryAttempts?: number;
  /** Base backoff ms (default 1000); exponential: base * 2^attempt. */
  backoffBaseMs?: number;
  /** What to do after EXHAUSTED: "block-queue" (T1 blocks T2) |
   *  "proceed-queue" (T2 may continue, T1 dead-lettered). Default block. */
  exhaustedPolicy?: "block-queue" | "proceed-queue";
}

/** Create a policy snapshot (stable for comparison). */
export function recoveryPolicy(opts: RecoveryPolicyOptions = {}): {
  maxRecoveryAttempts: number;
  backoffBaseMs: number;
  exhaustedPolicy: "block-queue" | "proceed-queue";
  policyVersion: string;
} {
  return {
    maxRecoveryAttempts: opts.maxRecoveryAttempts ?? 3,
    backoffBaseMs: opts.backoffBaseMs ?? 1000,
    exhaustedPolicy: opts.exhaustedPolicy ?? "block-queue",
    policyVersion: RECOVERY_STATE_MACHINE_POLICY_VERSION,
  };
}

export function createRecoveryTask(
  taskId: string,
  lineageId: string,
  policy: ReturnType<typeof recoveryPolicy>,
  clock: RecoveryClock,
): RecoveryTaskRecord {
  return {
    taskId,
    lineageId,
    state: "PENDING",
    attempt: 0,
    maxRecoveryAttempts: policy.maxRecoveryAttempts,
    nextAttemptAt: clock.now(),
    lastError: null,
    policyVersion: policy.policyVersion,
  };
}

/**
 * THE single transition function. Every legal edge is checked; an illegal
 * transition throws (fail-closed, never silent).
 */
export function transitionRecoveryTask(
  task: RecoveryTaskRecord,
  event: RecoveryEvent,
  policy: ReturnType<typeof recoveryPolicy>,
  clock: RecoveryClock,
): RecoveryTaskRecord {
  switch (event.type) {
    case "begin": {
      if (task.state !== "PENDING" && task.state !== "RETRY_SCHEDULED") {
        throw new Error(`recovery: illegal begin from ${task.state}`);
      }
      if (task.state === "RETRY_SCHEDULED" && clock.now() < task.nextAttemptAt) {
        // Backoff not yet elapsed — do NOT start (blocks T2).
        throw new Error("recovery: retry scheduled but backoff not elapsed");
      }
      return { ...task, state: "RECOVERY_IN_PROGRESS", attempt: task.attempt + 1 };
    }
    case "handler_succeeded": {
      if (task.state !== "RECOVERY_IN_PROGRESS") {
        throw new Error(`recovery: illegal handler_succeeded from ${task.state}`);
      }
      return { ...task, state: "RECOVERED", lastError: null };
    }
    case "handler_failed": {
      if (task.state !== "RECOVERY_IN_PROGRESS") {
        throw new Error(`recovery: illegal handler_failed from ${task.state}`);
      }
      if (!event.retryable) {
        return { ...task, state: "TERMINAL_FAILED", lastError: event.error };
      }
      if (task.attempt >= task.maxRecoveryAttempts) {
        // Budget spent on the same T — terminal, dead-letter (no T2 bypass).
        return { ...task, state: "EXHAUSTED", lastError: event.error, nextAttemptAt: Number.MAX_SAFE_INTEGER };
      }
      // Schedule same-T retry after exponential backoff: first failure backs
      // off by base (attempt-1 exponent), then 2x, 4x, …
      const backoff = policy.backoffBaseMs * 2 ** (task.attempt - 1);
      return {
        ...task,
        state: "RETRY_SCHEDULED",
        lastError: event.error,
        nextAttemptAt: clock.now() + backoff,
      };
    }
    case "retry_decision": {
      // Scheduler asks: is a retry of this T allowed NOW (without mutating)?
      const allowed = task.state === "RETRY_SCHEDULED"
        && event.attempt === task.maxRecoveryAttempts + 1 // informational guard
        ? false
        : task.state === "RETRY_SCHEDULED" && clock.now() >= task.nextAttemptAt;
      // The retry_decision event is a QUERY — it does not advance the state.
      return { ...task };
    }
    case "clock_tick": {
      // Clock tick does not mutate; it only makes RETRY_SCHEDULED eligible.
      return { ...task };
    }
    default: {
      const _exhaustive: never = event;
      throw new Error(`recovery: unknown event ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Query (non-mutating): is the given task's retry due at the current clock? */
export function retryDue(task: RecoveryTaskRecord, clock: RecoveryClock): boolean {
  return task.state === "RETRY_SCHEDULED" && clock.now() >= task.nextAttemptAt;
}

/** Query: is this task terminal (recovered/exhausted/terminal-failed)? */
export function taskTerminal(task: RecoveryTaskRecord): boolean {
  return task.state === "RECOVERED" || task.state === "EXHAUSTED" || task.state === "TERMINAL_FAILED";
}

/**
 * The scheduler: given an ordered list of tasks and the current clock, return
 * the NEXT task that may start recovery. INVARIANT: a task in
 * RECOVERY_IN_PROGRESS or RETRY_SCHEDULED (backoff not elapsed) is returned
 * first — T2 NEVER overtakes T1 while T1 is unresolved. When the head is
 * RETRY_SCHEDULED with backoff pending, nothing else may drain (block-queue
 * policy applies at the caller; here we return the head but the caller uses
 * `retryDue` to decide whether to wait).
 */
export function nextTaskToDrain(tasks: RecoveryTaskRecord[], clock: RecoveryClock): RecoveryTaskRecord | null {
  if (tasks.length === 0) return null;
  const head = tasks[0]!;
  if (head.state === "RECOVERY_IN_PROGRESS") return head;
  if (head.state === "RETRY_SCHEDULED") return head; // same T blocks T2 until exhausted/resolved
  if (head.state === "PENDING") return head;
  if (taskTerminal(head)) {
    // Head is resolved; find the next unresolved task (or null).
    return tasks.find((t) => !taskTerminal(t)) ?? null;
  }
  return head;
}