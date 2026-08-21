import type { AgentId, ContextBlock, DelegationLimits, Evidence, SessionId, ToolPolicy, WorkingState } from "@ar/contracts";
import type { WorkspacePatch } from "./workspace-isolation.js";
/** SUBAGENT-001: structured delegation request (plan §53). */
export interface DelegationRequest {
    parentSessionId: SessionId;
    goal: string;
    /** Isolated child context: only these blocks are seeded into the child
     *  session; the parent conversation is never visible to the child. */
    context?: ContextBlock[];
    /** Agent to run the child session in; defaults to the Delegator's agentId. */
    agentId?: AgentId;
    /** Further restriction of the child agent's tool policy. */
    toolPolicy?: ToolPolicy;
    /** P3-4: whether the child may write to the workspace. false (default) →
     *  the child shares the parent root read-only; true → the child runs in an
     *  isolated copy and its changes return as a workspacePatch (P3-5). Only
     *  meaningful when the delegator has a ChildWorkspaceManager wired. */
    writable?: boolean;
    limits?: Partial<DelegationLimits>;
}
/** SUBAGENT-001: structured delegation result (plan §57). */
export type DelegationStatus = "success" | "failed" | "cancelled" | "timeout";
/** P1-8: a claimed finding of the child. Evidence refs are stable refs into
 *  the child session (event:<id>, message:<id>), never free-text guesses. */
export interface SubagentFinding {
    claim: string;
    evidenceRefs: string[];
    confidence: "high" | "medium" | "low";
}
/** P1-8: a real artifact reference. The path comes from the child's working
 *  state (authoritative), and sourceRef links it to the tool result message
 *  that produced it — the parent can open the original result, not a
 *  regex-guessed string. */
export interface ChangedArtifactRef {
    path: string;
    sourceRef: string;
}
/** P1-8: a test/verification the child claims to have run. */
export interface TestRunRef {
    description: string;
    passed: boolean;
    /** Stable ref when the run is observable (event:<id> / message:<id>). */
    sourceRef?: string;
}
/** P1-8: budget actually consumed by the child turn. */
export interface SubagentBudgetUsed {
    toolCalls: number;
    durationMs: number;
}
export interface DelegationResult {
    status: DelegationStatus;
    /** Summarized from the final assistant message (or the turn outcome). */
    summary: string;
    /** Always a real session: results are only produced once the child session exists. */
    childSessionId: SessionId;
    toolCalls: number;
    durationMs: number;
    /** Reconstructed from verification-gate events and tool results. */
    evidence: Evidence[];
    /** Path-like tokens extracted from tool outputs. */
    artifacts: string[];
    /** P1-1: the child turn's working state (when the child runtime produced
     *  one) — the same structure the child's compaction digest was rendered
     *  from, so the parent can fold it into its own state (childAgentRefs). */
    workingState?: WorkingState;
    /** Present when status is "failed" or "timeout". */
    error?: string;
    /** P1-8: the child's final answer verbatim (truncated), not a paraphrase. */
    answer: string;
    /** P1-8: verifiable findings — derived from the child's verification-gate
     *  events (claim + stable refs + confidence). Never fabricated. */
    findings: SubagentFinding[];
    /** P1-8: real changed artifacts from the working state, each with a stable
     *  source ref — the parent can verify instead of trusting the summary. */
    changedArtifacts: ChangedArtifactRef[];
    /** P1-8: tests/verification runs the child performed, with refs. */
    testsRun: TestRunRef[];
    /** P1-8: open questions the child left (working state, when present). */
    openQuestions: string[];
    /** P1-8: blockers — observed failures, verification failures, turn error. */
    blockers: string[];
    /** P1-8: next actions the child suggests (pending work, when present). */
    suggestedNextActions: string[];
    /** P1-8: budget consumed by the child turn. */
    budgetUsed: SubagentBudgetUsed;
    /** P1-8: true only when the child's completion passed a verification gate
     *  (terminationReason "verified_complete"). A child that merely stopped
     *  ("model_stopped") is NOT marked verified — "I'm done" is not success. */
    verified: boolean;
    /** P3-5: the child's workspace changes (isolated-copy mode only) as a
     *  structured patch the parent may apply under conflict detection. Absent
     *  for read-only children and for failed/cancelled/timeout outcomes. */
    workspacePatch?: WorkspacePatch;
}
//# sourceMappingURL=delegation.d.ts.map