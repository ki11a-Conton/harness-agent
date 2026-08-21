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
/** Mark the memory superseded by a newer, validated one. */
export function supersede(entry, byId, opts = {}) {
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
export function deprecate(entry, opts = {}) {
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
export function markConflicting(entry, withId, opts = {}) {
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
export function evaluateLifecycle(entry, opts = {}) {
    if (entry.state !== undefined && entry.state.kind !== "active")
        return {};
    const now = opts.now ?? Date.now();
    const failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    const failures = entry.evidence?.failureCount ?? 0;
    if (failures >= failureThreshold) {
        return {
            state: { kind: "stale", at: now },
            confidence: entry.confidence * (opts.confidenceDecayFactor ?? DEFAULT_CONFIDENCE_DECAY_FACTOR),
        };
    }
    const maxIdleMs = opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    if (entry.usefulness === undefined && now - entry.updatedAt > maxIdleMs) {
        return { state: { kind: "stale", at: now } };
    }
    return {};
}
/** True when the memory is still worth retrieving (not retired). */
export function isRetrievable(entry) {
    return entry.state === undefined || entry.state.kind === "active";
}
//# sourceMappingURL=lifecycle.js.map