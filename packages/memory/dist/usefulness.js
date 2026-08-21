/**
 * P2-3: usefulness feedback. Pure functions only — persistence is the
 * store's job. Each retrieval/usage signal bumps the funnel counters and
 * moves the rolling score toward 1 with a signal-specific strength; a
 * memory without any feedback has `usefulness === undefined` and scoring
 * falls back to entry.importance (retrieval.ts proxy).
 */
/** Starting score for the first recorded feedback (neutral). */
export const INITIAL_USEFULNESS_SCORE = 0.5;
/** How much each signal moves score toward 1 (0 = no movement). */
const SCORE_STRENGTH = {
    retrieved: 0,
    injected: 0.1,
    used: 0.3,
    taskSucceeded: 0.5,
    verificationPassed: 0.5,
};
/**
 * Return a new entry with the feedback applied (immutable; the caller
 * persists via store.update). `retrieved` only counts; the others also
 * raise the rolling score. Repeated signals saturate toward 1 without
 * overshooting.
 */
export function recordUsefulness(entry, feedback) {
    const base = entry.usefulness ?? {
        retrievedCount: 0,
        injectedCount: 0,
        usedCount: 0,
        taskSuccessCount: 0,
        verificationPassedCount: 0,
        score: INITIAL_USEFULNESS_SCORE,
    };
    const strength = SCORE_STRENGTH[feedback.kind];
    return {
        ...entry,
        usefulness: {
            ...base,
            retrievedCount: base.retrievedCount + (feedback.kind === "retrieved" ? 1 : 0),
            injectedCount: base.injectedCount + (feedback.kind === "injected" ? 1 : 0),
            usedCount: base.usedCount + (feedback.kind === "used" ? 1 : 0),
            taskSuccessCount: base.taskSuccessCount + (feedback.kind === "taskSucceeded" ? 1 : 0),
            verificationPassedCount: base.verificationPassedCount + (feedback.kind === "verificationPassed" ? 1 : 0),
            score: strength === 0 ? base.score : Math.min(1, base.score + (1 - base.score) * strength),
        },
    };
}
/** True once any feedback has been recorded for this entry. */
export function hasUsefulness(entry) {
    return entry.usefulness !== undefined;
}
//# sourceMappingURL=usefulness.js.map