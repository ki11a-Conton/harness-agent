/**
 * P1-1 WorkingState — the single, authoritative run-state structure.
 *
 * Every capability that needs to know "what happened so far" reads from this
 * structure instead of maintaining its own drifting summary:
 * compaction, checkpoint, resume, subagent handoff, verification, final
 * summary and observability.
 *
 * Field set intentionally mirrors the compaction contract (CompactionSummary)
 * where the semantics overlap; fields the compaction view does not carry
 * (plan, completed, pending, openQuestions, tool/artifact/memory/childAgent
 * refs) exist for checkpoint/resume and handoff consumers.
 */
export interface WorkingState {
    /** Exact user goal (turn input verbatim). */
    goal: string;
    /** Hard constraints that must survive any compaction. */
    constraints: string[];
    /** Working plan steps, kept by the runtime as it observes the run. */
    plan: string[];
    /** Decisions taken during the run. */
    decisions: string[];
    /** Completed work items. */
    completed: string[];
    /** Pending / in-flight work items. */
    pending: string[];
    /** Paths modified by successful write/edit tool calls. */
    filesChanged: string[];
    /** Commands executed (exec tool calls). */
    commandsRun: string[];
    /** Commands that look like test runs (exec commands matching /test/i). */
    testsRun: string[];
    /** Failures observed (failed/timeout/denied tool results). */
    failures: string[];
    /** Important facts learned during the run. */
    importantFacts: string[];
    /** Open questions that still need answering. */
    openQuestions: string[];
    /** Tool call references (tool name or call id) relevant to the run. */
    toolRefs: string[];
    /** Artifact references (paths) produced during the run. */
    artifactRefs: string[];
    /** Memory references (memory ids) relevant to the run. */
    memoryRefs: string[];
    /** Child-agent (subagent) session references. */
    childAgentRefs: string[];
}
/**
 * P0-12: controlled mutation contract for the model to update its working
 * state. The runtime rejects mutations that would overwrite protected fields
 * (goal, filesChanged, commandsRun, testsRun, failures, toolRefs,
 * artifactRefs, memoryRefs, childAgentRefs — these are auto-populated).
 */
export type WorkingStateMutation = {
    op: "set_constraints";
    constraints: string[];
} | {
    op: "set_plan";
    steps: string[];
} | {
    op: "mark_completed";
    step: string;
} | {
    op: "set_pending";
    steps: string[];
} | {
    op: "add_decision";
    decision: string;
} | {
    op: "add_fact";
    fact: string;
} | {
    op: "add_open_question";
    question: string;
} | {
    op: "resolve_open_question";
    question: string;
};
/** P0-12: apply a single mutation to a WorkingState (mutates in place). */
export declare function applyWorkingStateMutation(state: WorkingState, mutation: WorkingStateMutation): string;
/** Empty working state with the goal pre-filled. */
export declare function newWorkingState(goal: string): WorkingState;
//# sourceMappingURL=working-state.d.ts.map