import type { MemoryCandidate, MemoryEntry, MemoryEvidence } from "@ar/contracts";
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
export declare function recordValidation(entry: MemoryEntry, passed: boolean, opts?: ValidationRecord): MemoryEntry;
/**
 * Seed an evidence ledger from a candidate: the candidate's session is the
 * first source session; P2-1 structured evidenceRefs become the first
 * source events. Candidates without structured evidence start empty (their
 * evidence accrues from future validations).
 */
export declare function evidenceFromCandidate(candidate: MemoryCandidate): MemoryEvidence;
/** Merge another session's observations into an existing ledger (dedup). */
export declare function mergeEvidence(base: MemoryEvidence, other: MemoryEvidence): MemoryEvidence;
//# sourceMappingURL=evidence.d.ts.map