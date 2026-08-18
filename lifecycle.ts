import type { MemoryEntry, MemoryId, MemoryState } from "@ar/contracts";

/**
 * P2-4: memory lifecycle (decay / deprecation / supersession / conflict).
 * Pure functions only — the caller persists via store.update. Everything is
 * soft: history (content, evidence ledger, usefulness) is never physically
 * deleted, states are always appended, and confidence only ever drops.
 */

/** A memory with no usage feedback stays fresh for this long. */
export const DEFAULT_MAX_IDLE_MS = 30 * 24 * 3600 * 1000;

/** Failures recorded in the evidence ledger beyond this mark the memory stale. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Confidence multiplier applied once per stale evaluation. */
export const DEFAULT_CONFIDENCE_DECAY_FACTOR = 0.7;

export interface LifecycleOptions {
  /** Clock value for state timestamps; defaults to Date.now(). */
  now?: number;
  /** Idle limit for feedback-less memories (default 30 days). */
  maxIdleMs?: number;
  /** Failure count that marks the memory stale (default 3). */
  failureThreshold?: number;
  /** Confidence multiplier on stale marking (default 0.7). */
  confidenceDecayFactor?: number;
}

export interface LifecycleResult {
  /** Next lifecycle state (undefined when nothing changed). */
  state?: MemoryState;
  /** Next confidence (undefined when unchanged). */
  confidence?: number;
}

/** Mark the memory superseded by a newer, validated one. */
export function supersede(
  entry: MemoryEntry,
  byId: MemoryId,
  opts: { now?: number; reason?: string } = {},
): MemoryEntry {
  return {
    ...entry,
    state: {
      kind: "superseded",
      byId,
      at: opts.now ?? Date.now(),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
  };
}

/** Mark the memory deprecated; history stays intact. */
export function deprecate(
  entry: MemoryEntry,
  opts: { now?: number; reason?: string } = {},
): MemoryEntry {
  return {
    ...entry,
    state: {
      kind: "deprecated",
      at: opts.now ?? Date.now(),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
  };
}

/** Record that two memories contradict each other. */
export function markConflicting(
  entry: MemoryEntry,
  withId: MemoryId,
  opts: { now?: number } = {},
): MemoryEntry {
  return {
    ...entry,
    state: { kind: "conflicting", withId, at: opts.now ?? Date.now() },
  };
}

/**
 * Evaluate decay without mutating anything: returns the next state and
 * confidence when a rule fires, otherwise undefined.
 *
 * Rules (deterministic, first match wins):
 * 1. Already in a non-active state → nothing (historical states are stable).
 * 2. Evidence failureCount >= threshold → stale + confidence × decayFactor.
 * 3. No usage feedback ever (usefulness undefined) and idle beyond
 *    maxIdleMs → stale (never used, gone cold).
 */
export function evaluateLifecycle(
  entry: MemoryEntry,
  opts: LifecycleOptions = {},
): LifecycleResult {
  if (entry.state !== undefined && entry.state.kind !== "active") return {};
  const now = opts.now ?? Date.now();
  const failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const failures = entry.evidence?.failureCount ?? 0;

  if (failures >= failureThreshold) {
    return {
      state: { kind: "stale", at: now },
      confidence:
        entry.confidence * (opts.confidenceDecayFactor ?? DEFAULT_CONFIDENCE_DECAY_FACTOR),
    };
  }

  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  if (entry.usefulness === undefined && now - entry.updatedAt > maxIdleMs) {
    return { state: { kind: "stale", at: now } };
  }

  return {};
}

/** True when the memory is still worth retrieving (not retired). */
export function isRetrievable(entry: MemoryEntry): boolean {
  return entry.state === undefined || entry.state.kind === "active";
}