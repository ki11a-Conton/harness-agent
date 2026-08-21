import type { MemoryEntry } from "@ar/contracts";
/**
 * P2-3: usefulness feedback. Pure functions only — persistence is the
 * store's job. Each retrieval/usage signal bumps the funnel counters and
 * moves the rolling score toward 1 with a signal-specific strength; a
 * memory without any feedback has `usefulness === undefined` and scoring
 * falls back to entry.importance (retrieval.ts proxy).
 */
/** Starting score for the first recorded feedback (neutral). */
export declare const INITIAL_USEFULNESS_SCORE = 0.5;
export type UsefulnessFeedback = {
    kind: "retrieved";
} | {
    kind: "injected";
} | {
    kind: "used";
} | {
    kind: "taskSucceeded";
} | {
    kind: "verificationPassed";
};
/**
 * Return a new entry with the feedback applied (immutable; the caller
 * persists via store.update). `retrieved` only counts; the others also
 * raise the rolling score. Repeated signals saturate toward 1 without
 * overshooting.
 */
export declare function recordUsefulness(entry: MemoryEntry, feedback: UsefulnessFeedback): MemoryEntry;
/** True once any feedback has been recorded for this entry. */
export declare function hasUsefulness(entry: MemoryEntry): boolean;
//# sourceMappingURL=usefulness.d.ts.map