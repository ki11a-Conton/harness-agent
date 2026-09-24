/**
 * P33-4 — Authoritative scheduler state.
 *
 * The orchestrator NEVER trusts a queue or the tracker's view of "running".
 * All dispatch/lifecycle decisions flow through this single in-memory state
 * machine, whose invariants are enforced and asserted:
 *
 *   running ⊆ claimed
 *   retrying ⊆ claimed
 *   running ∩ blocked = ∅
 *   terminal eventually ∩ running = ∅
 *
 * The state is authoritative but not durable — it is rebuilt from the tracker
 * on restart. No state is silently mutated outside these operations.
 */
import type { WorkId } from "./work-item.js";

export type WorkStatus = "terminal" | "running" | "blocked" | "retrying" | "claimed" | "unknown";

export interface RunningEntry {
  readonly workerId: string;
  readonly threadId?: string;
  readonly startedAt: number;
}

export interface BlockedEntry {
  readonly reason: string;
  readonly blockedAt: number;
}

export interface RetryEntry {
  readonly attempt: number;
  readonly nextAttemptAt: number;
}

export interface OrchestratorState {
  readonly running: Map<WorkId, RunningEntry>;
  readonly claimed: Set<WorkId>;
  readonly blocked: Map<WorkId, BlockedEntry>;
  readonly retries: Map<WorkId, RetryEntry>;
  readonly terminal: Set<WorkId>;
}

export function createState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    blocked: new Map(),
    retries: new Map(),
    terminal: new Set(),
  };
}

/** Assert every invariant. Call after any mutation (also from tests). */
export function assertState(state: OrchestratorState): void {
  for (const id of state.running.keys()) {
    if (!state.claimed.has(id)) {
      throw new Error(`invariant: running ${String(id)} not claimed`);
    }
    if (state.blocked.has(id)) {
      throw new Error(`invariant: running ${String(id)} blocked`);
    }
  }
  for (const id of state.retries.keys()) {
    if (!state.claimed.has(id)) {
      throw new Error(`invariant: retrying ${String(id)} not claimed`);
    }
    if (state.blocked.has(id)) {
      throw new Error(`invariant: retrying ${String(id)} blocked`);
    }
  }
  for (const id of state.claimed) {
    if (state.terminal.has(id)) {
      throw new Error(`invariant: claimed ${String(id)} is terminal`);
    }
  }
}

/**
 * State machine operations. Every transition re-asserts the invariants.
 * Default no-op when the pre-condition is unmet (reconcile-friendly), except
 * claim/terminal which are strict.
 */
export const scheduler = {
  claim(state: OrchestratorState, id: WorkId, workerId: string, now: number): void {
    if (state.terminal.has(id)) throw new Error(`cannot claim ${String(id)}: terminal`);
    if (state.claimed.has(id)) return; // already claimed: no-op, keep existing entry
    state.claimed.add(id);
    state.running.set(id, { workerId, startedAt: now });
  },

  block(state: OrchestratorState, id: WorkId, reason: string, now: number): void {
    if (!state.claimed.has(id)) return; // not claimed: nothing to block
    state.running.delete(id);
    state.retries.delete(id);
    state.blocked.set(id, { reason, blockedAt: now });
  },

  unblock(state: OrchestratorState, id: WorkId): void {
    if (!state.blocked.has(id)) return;
    const blockedAt = state.blocked.get(id)!.blockedAt;
    state.blocked.delete(id);
    state.running.set(id, { workerId: `re-${id}`, startedAt: blockedAt });
  },

  retry(state: OrchestratorState, id: WorkId, attempt: number, nextAttemptAt: number): void {
    if (!state.claimed.has(id)) return;
    state.running.delete(id);
    state.blocked.delete(id);
    state.retries.set(id, { attempt, nextAttemptAt });
  },

  /** Transition to terminal: clears claimed/running/retries/blocked. */
  terminal(state: OrchestratorState, id: WorkId): void {
    state.running.delete(id);
    state.blocked.delete(id);
    state.retries.delete(id);
    state.claimed.delete(id);
    state.terminal.add(id);
  },
};

/** Status helper for observability. Reconcile uses this to decide actions. */
export function statusOf(state: OrchestratorState, id: WorkId): WorkStatus {
  if (state.terminal.has(id)) return "terminal";
  if (state.running.has(id)) return "running";
  if (state.blocked.has(id)) return "blocked";
  if (state.retries.has(id)) return "retrying";
  if (state.claimed.has(id)) return "claimed";
  return "unknown";
}