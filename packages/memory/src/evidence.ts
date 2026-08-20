import type { MemoryCandidate, MemoryEntry, MemoryEvidence, SessionId } from "@ar/contracts";

/**
 * P2-2: evidence model helpers. Pure functions only — persistence is the
 * store's job. Memory is not absolute knowledge: entries carry an evidence
 * ledger (source sessions/events, success/failure counts, last validation)
 * that downstream decay/conflict logic (P2-3/P2-4) consumes.
 */

export interface ValidationRecord {
  /** Event id backing this validation; appended to sourceEvents (deduped). */
  eventId?: string;
  /** Validation timestamp; defaults to Date.now(). */
  at?: number;
}

/**
 * Return a new entry with the validation applied (immutable; the caller
 * persists via store.update). Success/failure counts bump, lastValidated
 * moves forward, and the backing event id is appended once.
 */
export function recordValidation(
  entry: MemoryEntry,
  passed: boolean,
  opts?: ValidationRecord,
): MemoryEntry {
  const evidence = entry.evidence ?? emptyEvidence();
  const eventId = opts?.eventId;
  return {
    ...entry,
    evidence: {
      ...evidence,
      successCount: evidence.successCount + (passed ? 1 : 0),
      failureCount: evidence.failureCount + (passed ? 0 : 1),
      lastValidated: opts?.at ?? Date.now(),
      sourceEvents:
        eventId !== undefined && !evidence.sourceEvents.includes(eventId)
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
export function evidenceFromCandidate(candidate: MemoryCandidate): MemoryEvidence {
  return {
    sourceSessions: [candidate.sourceSession],
    sourceEvents: [...(candidate.structured?.evidenceRefs ?? [])],
    successCount: 0,
    failureCount: 0,
  };
}

/** Merge another session's observations into an existing ledger (dedup). */
export function mergeEvidence(
  base: MemoryEvidence,
  other: MemoryEvidence,
): MemoryEvidence {
  return {
    sourceSessions: dedupe([...base.sourceSessions, ...other.sourceSessions]) as SessionId[],
    sourceEvents: dedupe([...base.sourceEvents, ...other.sourceEvents]),
    successCount: base.successCount + other.successCount,
    failureCount: base.failureCount + other.failureCount,
    lastValidated: Math.max(
      base.lastValidated ?? 0,
      other.lastValidated ?? 0,
    ) || undefined,
  };
}

function emptyEvidence(): MemoryEvidence {
  return { sourceSessions: [], sourceEvents: [], successCount: 0, failureCount: 0 };
}

function dedupe(items: readonly (SessionId | string)[]): string[] {
  return [...new Set(items)];
}