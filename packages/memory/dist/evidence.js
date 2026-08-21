/**
 * Return a new entry with the validation applied (immutable; the caller
 * persists via store.update). Success/failure counts bump, lastValidated
 * moves forward, and the backing event id is appended once.
 */
export function recordValidation(entry, passed, opts) {
    const evidence = entry.evidence ?? emptyEvidence();
    const eventId = opts?.eventId;
    return {
        ...entry,
        evidence: {
            ...evidence,
            successCount: evidence.successCount + (passed ? 1 : 0),
            failureCount: evidence.failureCount + (passed ? 0 : 1),
            lastValidated: opts?.at ?? Date.now(),
            sourceEvents: eventId !== undefined && !evidence.sourceEvents.includes(eventId)
                ? [...evidence.sourceEvents, eventId]
                : evidence.sourceEvents,
        },
    };
}
/**
 * Seed an evidence ledger from a candidate: the candidate's session is the
 * first source session; P2-1 structured evidenceRefs become the first
 * source events. Candidates without structured evidence start empty (their
 * evidence accrues from future validations).
 */
export function evidenceFromCandidate(candidate) {
    return {
        sourceSessions: [candidate.sourceSession],
        sourceEvents: [...(candidate.structured?.evidenceRefs ?? [])],
        successCount: 0,
        failureCount: 0,
    };
}
/** Merge another session's observations into an existing ledger (dedup). */
export function mergeEvidence(base, other) {
    return {
        sourceSessions: dedupe([...base.sourceSessions, ...other.sourceSessions]),
        sourceEvents: dedupe([...base.sourceEvents, ...other.sourceEvents]),
        successCount: base.successCount + other.successCount,
        failureCount: base.failureCount + other.failureCount,
        lastValidated: Math.max(base.lastValidated ?? 0, other.lastValidated ?? 0) || undefined,
    };
}
function emptyEvidence() {
    return { sourceSessions: [], sourceEvents: [], successCount: 0, failureCount: 0 };
}
function dedupe(items) {
    return [...new Set(items)];
}
//# sourceMappingURL=evidence.js.map