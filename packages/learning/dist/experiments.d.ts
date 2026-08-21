/**
 * PHASE 13 — 更激进实验（EXPERIMENT，只能最后做）。
 *
 * Every item here is a CHALLENGER: it is NOT the champion path, it must pass
 * the benchmark gate before promotion (P10), and it is explicitly marked
 * experimental. This module provides the deterministic, testable pieces;
 * wiring them into the runtime is a separate, gated change.
 */
export declare const PLANNER_EXECUTOR_SYSTEM_PROMPT: string;
export interface SpecialistProfile {
    id: "explorer" | "debugger" | "reviewer";
    systemPrompt: string;
    /** Tool names the profile may use (subset). */
    allowTools: readonly string[];
}
export declare const EXPLORER_PROFILE: SpecialistProfile;
export declare const DEBUGGER_PROFILE: SpecialistProfile;
export declare const REVIEWER_PROFILE: SpecialistProfile;
/** P13-3: deterministic specialist routing by goal keywords. First matching
 *  profile wins; generalist (undefined) when nothing matches. */
export declare function routeSpecialist(goal: string): SpecialistProfile | undefined;
export declare function profileOf(id: SpecialistProfile["id"]): SpecialistProfile;
export interface TokenRoiObservation {
    roiPer1k: number;
}
/** Suggest memory topK from per-entry ROI: keep entries whose ROI is above
 *  the mean, capped at [1, 10]. Degenerate/no data → the default. */
export declare function suggestMemoryTopK(roi: TokenRoiObservation[], fallback?: number): number;
export interface SchedulerObservation {
    activeChildren: number;
    maxConcurrent: number;
    tokenBudgetRemainingFraction: number;
    recentConflicts: number;
    recentRecoveries: number;
}
/** Conservative adaptive concurrency: only grow when there is budget headroom
 *  and no recent conflict/recovery storm; shrink under pressure. Returns the
 *  suggested maxConcurrent (integer, ≥1). */
export declare function suggestConcurrency(obs: SchedulerObservation): number;
//# sourceMappingURL=experiments.d.ts.map