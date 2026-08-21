import type { ContextBlock, WorkingState } from "@ar/contracts";
import type { DelegationResult, SubagentFinding, TestRunRef } from "./delegation.js";
/**
 * P1-9 Parent / Child State Handoff.
 *
 * Two pure helpers that make the handoff explicit:
 *
 *   Parent WorkingState
 *        ↓ scopedContextFromWorkingState   (selected scoped context)
 *   Child WorkingState
 *        ↓ structured completion           (P1-8 DelegationResult)
 *   Parent merge                            (mergeChildCompletion)
 *
 * Forbidden: forking the entire parent transcript. The scoped context is
 * derived only from the parent's working state — never from messages.
 */
export interface ConflictRecord {
    path: string;
    detail: string;
}
export type MergeSkipReason = "failed" | "partial" | "duplicate" | "stale";
export interface MergeSkip {
    reason: MergeSkipReason;
    detail: string;
}
export interface MergeReport {
    /** Paths adopted from the child into the parent's filesChanged/artifactRefs. */
    mergedPaths: string[];
    adoptedFindings: SubagentFinding[];
    adoptedTestsRun: TestRunRef[];
    adoptedOpenQuestions: string[];
    adoptedNextActions: string[];
    /** Paths both parent and child modified — child's version is NOT applied. */
    conflicts: ConflictRecord[];
    skipped: MergeSkip[];
}
export interface ScopedContextOptions {
    /** Working-state sections to carry into the child. Defaults to
     *  goal/constraints/plan/decisions — the minimal necessary context. */
    include?: ReadonlySet<string>;
    maxBlockChars?: number;
    maxEntries?: number;
}
/** Minimal necessary context from the parent's working state. Never forks
 *  the parent transcript: only state sections are projected, each as a
 *  trusted system block. */
export declare function scopedContextFromWorkingState(state: WorkingState, opts?: ScopedContextOptions): ContextBlock[];
/** Merge a child's structured completion into the parent's working state.
 *  Mutates `parent` and returns a report of what was adopted/skipped.
 *
 *  - failed child: nothing is adopted; the failure is recorded.
 *  - partial child (cancelled/timeout): nothing ref-backed exists to merge
 *    (P1-8 emits no fabricated artifacts), recorded as partial.
 *  - artifact ownership: child-modified paths become the child's; a path the
 *    parent also modified is a conflict — the child version is recorded but
 *    not applied, and the conflict is reported as stale.
 *  - duplicate findings: deduplicated by claim.
 */
export declare function mergeChildCompletion(parent: WorkingState, child: DelegationResult): MergeReport;
//# sourceMappingURL=state-handoff.d.ts.map