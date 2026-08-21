/**
 * Q-1: stateless helpers extracted from runtime.ts. Holding these outside the
 * AgentRuntime class keeps the loop focused on orchestration and gives the
 * pure logic independent, deterministic unit coverage. None of these functions
 * read instance state — any derived value is passed in explicitly, so behavior
 * is byte-for-byte identical to when they lived as class methods / module
 * functions in runtime.ts.
 */
import { errorInfo } from "@ar/contracts";
import type { AgentDefinition, AskUserRequest, CheckpointId, CompactionSummary, ContextBlock, EffectiveAgentConfig, Message, ModelCallId, ModelFinalResult, SandboxPolicy, Session, SessionId, Skill, TerminationReason, ToolCall, ToolCallId, ToolExecutionRecord, ToolResult, ToolSemantics, Turn, TurnId, UnresolvedToolExecution, UsageSnapshot, WorkingState } from "@ar/contracts";
/**
 * Q-1: immutable per-turn context. Bundles the five values resolved once at the
 * start of `runTurn` and passed (unchanged) to every private method. Packaging
 * them as a single object reduces parameter noise and makes the dependency
 * surface explicit for the later controller extraction. None of these fields
 * are reassigned during the turn; `state` / `working` / `toolLedger` are shared
 * mutable accumulators and stay as separate parameters.
 */
export interface TurnContext {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly signal: AbortSignal;
    readonly session: Session;
    readonly agent: AgentDefinition;
}
/** Tool output rendered as a string the model can read. Non-success results
 *  become a bracketed status line; success output is the raw string, a JSON
 *  dump for structured values, or an empty string for undefined/null. */
export declare function renderToolResult(result: ToolResult): string;
/** P0-1: shape guard for the persisted effective-agent snapshot. */
export declare function isEffectiveAgentConfig(v: unknown): v is EffectiveAgentConfig;
/** P1-11: built-in semantics that preserve the historical behavior when the
 *  host does not inject a lookup. Real hosts pass semanticsOf(toolRegistry)
 *  instead — this registry only exists so unconfigured runtimes keep their
 *  side-effect/checkpoint boundaries. */
export declare const DEFAULT_RUNTIME_TOOL_SEMANTICS: Readonly<Record<string, ToolSemantics>>;
/** P1-1: tool effects recorded into the working state (the single run-state
 *  structure). Filesystem-scoped write tools become filesChanged; process
 *  tools become commandsRun (test-looking commands also testsRun);
 *  failed/timeout/denied results become failures. All scope decisions come
 *  from the tool's execution semantics — never from its name. */
export declare function updateWorkingState(call: ToolCall, result: ToolResult, working: WorkingState, semantics: ToolSemantics): void;
/** P1-1/P1-2: derive the compaction view (CompactionSummary) from the working
 *  state. The pipeline consumes this instead of synthesizing a summary;
 *  P1-2 completes the mapping with the fields that must survive compaction
 *  (completed work, artifact refs, child-agent refs). Empty lists stay empty
 *  (the compactor omits empty sections, so a sparse state yields a sparse
 *  summary). */
export declare function workingStateToCompactionSummary(working: WorkingState): CompactionSummary;
/** P1-4: the resume prompt handed to the model. Resume is deliberately NOT a
 *  full-transcript replay (plan §1258): the model gets the restored working
 *  state, the side effects that already happened (must not be redone) and the
 *  started-but-unconfirmed tools (must be reconciled, never blindly rerun). */
export declare function buildResumePrompt(working: WorkingState, committedSideEffects: ToolExecutionRecord[], unresolvedTools: UnresolvedToolExecution[]): string;
/** Context-length model errors (API 413 / "maximum context length") — the
 *  signal for reactive compact, never blind retries. */
export declare function isContextOverflowError(info: ReturnType<typeof errorInfo>): boolean;
/** LOOP-001: tool result rendered as a compressible context block so the
 *  context pipeline can budget and compact it on overflow. `contentOverride`
 *  carries the output-budgeted rendering when one applies. */
export declare function toContextBlock(toolCallId: string, result: ToolResult, contentOverride?: string): ContextBlock;
/** Structured state digest for compaction (plan.md Phase 4.4): what the
 *  model must remember after older tool outputs are folded away. Rendered
 *  from the single working state (P1-1) — no parallel journal. */
export declare function buildStateDigest(working: WorkingState, reason: string): string;
/**
 * Phase 8 message-history trim: drop the OLDEST messages until the history
 * fits `headroomTokens`, always keeping the most recent tail (the digest
 * message, the current turn's context and the latest tool results). The
 * store keeps the full transcript — this only bounds what the model sees.
 */
export declare function trimMessageHistory(history: readonly Message[], headroomTokens: number): Message[];
/** Q-1: what the model-call retry loop should do after a model attempt. The
 *  decision is pure; the caller performs side effects (emit, checkpoint, sleep)
 *  based on the returned action. */
export type ModelRetryAction = {
    action: "success";
} | {
    action: "compact-and-retry";
} | {
    action: "retry";
    retryDelayMs: number;
} | {
    action: "fail";
    maxAttempts: number;
    reason: string;
    suppressLimitEvent?: boolean;
};
/** Q-1: pure decision extracted from the model-call retry loop. Given the model
 *  error (or undefined for success), whether reactive compact already happened,
 *  and the recovery policy's decision (or undefined if no policy), returns the
 *  action the loop should take. Side effects stay in the caller.
 *
 *  Structurally compatible with RecoveryPolicy.decide() output — accepts any
 *  object with the relevant fields, keeping turn-helpers decoupled from the
 *  recovery module. */
export declare function decideModelRetry(modelFailed: ReturnType<typeof errorInfo> | undefined, reactiveCompacted: boolean, recovery: {
    action: string;
    retryDelayMs?: number;
    maxAttempts: number;
    reason: string;
} | undefined, attempt: number): ModelRetryAction;
/** Q-1: result of the model-call retry loop. The caller handles finishTurn for
 *  cancelled/failed; on completed it runs post-completion processing (append
 *  message, model.completed event, verification gate). */
export type ModelCallResult = {
    status: "completed";
    callId: ModelCallId;
    assistantText: string;
    calls: ToolCall[];
    final: ModelFinalResult | undefined;
    callStartedAt: number;
    timeToFirstTokenMs: number | undefined;
    /** P0-9: partial usage snapshot for this call (may omit fields). */
    usage: UsageSnapshot | undefined;
    reactiveCompacted: boolean;
} | {
    status: "cancelled";
} | {
    status: "failed";
    error: ReturnType<typeof errorInfo>;
};
/** Default sandbox policy: workspace-write, no network, bounded process execution. */
export declare function defaultSandboxPolicy(): SandboxPolicy;
/** P1-5: named kill points. A fault injector throwing at one of these
 *  simulates the process dying at that exact boundary (crash semantics — the
 *  normal retry/recovery machinery must NOT swallow it). */
export type FaultPoint = 
/** A side-effect tool completed, its effect recorded, but the checkpoint
 *  for it has NOT yet been written. */
"tool.completed"
/** A side-effect tool completed AND its checkpoint was persisted. */
 | "tool.checkpointed"
/** Midauth of a tool execution — outcome unknown (may or may not have
 *  happened) — the reconciliation window. */
 | "tool.executing"
/** Immediately before the next model call. */
 | "model.next_call"
/** Mid model stream (after the first event of the call). */
 | "model.stream"
/** Immediately before the verification gate runs. */
 | "verification.started"
/** Right after a context compaction. */
 | "context.compacted";
/** Context handed to the fault injector at each kill point. */
export interface FaultPointContext {
    sessionId: SessionId;
    turnId?: TurnId;
    toolCallId?: ToolCallId;
    tool?: string;
}
/** Thrown by a fault injector to simulate process death. Distinct from every
 *  recoverable error so the runtime's retry/recovery catch clauses rethrow it
 *  untouched — the turn dies with no turn.completed event, exactly like a
 *  process kill. */
export declare class RuntimeKilledError extends Error {
    readonly point: FaultPoint;
    constructor(point: FaultPoint, message?: string);
}
/** Rethrow a P1-5 simulated kill; swallow nothing else. Used by every
 *  catch clause that maps errors to tool/model failures. */
export declare function rethrowIfKill(err: unknown): void;
export type TurnOutcomeStatus = "completed" | "failed" | "cancelled" | "waiting_for_user" | "waiting_for_approval";
/** P2-43: the name of the ask-user GATE tool. Recognized by the runtime as a
 *  formal phase trigger — it NEVER executes as a workspace tool. Model-facing
 *  name is intentionally stable across hosts so benchmarks can count on it. */
export declare const ASK_GATE_TOOL = "ask_user";
/**
 * P2-38 — partial-failure classification. The coarse public `status` stays
 * "completed" | "failed" | "cancelled" for backwards compatibility; this
 * finer taxonomy is layered on top so hosts / observability can distinguish
 * whether a termination left committed side effects behind:
 *
 *   completed                  — success.
 *   failed_no_effect           — failed with ZERO committed side effects.
 *   failed_with_effects        — failed AFTER a side effect committed
 *                                (the effect is KEPT; failure is not a
 *                                rollback, and callers reconcile the residue).
 *   cancelled_no_effect        — cancelled before any side effect committed.
 *   cancelled_with_effects     — cancelled after a side effect landed; the
 *                                committed effect is KEPT and surfaced for
 *                                reconciliation (cancel never rolls back).
 *   blocked                    — failed with no committed effect AND at least
 *                                one hard policy denial (permission / sandbox
 *                                / security gate): the run was blocked, not
 *                                merely unsuccessful.
 */
export type TurnOutcomeDetail = "completed" | "failed_no_effect" | "failed_with_effects" | "cancelled_no_effect" | "cancelled_with_effects" | "blocked"
/** P2-43: the turn paused waiting for user input. Not a failure and not a
 *  cancellation. The second member notes whether side effects committed
 *  before the pause. */
 | "waiting_no_effect" | "waiting_with_effects"
/** P1-1: the turn paused waiting for approval. Same semantics as
 *  waiting_for_user — not a failure, the turn can resume. */
 | "waiting_approval_no_effect" | "waiting_approval_with_effects";
export interface TurnOutcome {
    status: TurnOutcomeStatus;
    /** P2-38: finer-grained termination classification on top of `status`
     *  (see TurnOutcomeDetail). Always present on the returned outcome. */
    statusDetail: TurnOutcomeDetail;
    turn: Turn;
    toolCalls: number;
    iterations: number;
    error?: ReturnType<typeof errorInfo>;
    /** P2-39: structured termination reason, drawn from the bounded
     *  `TerminationReason` taxonomy (no free-form strings). Completion/main
     *  causes are emitted verbatim; budget limits use the bounded categories
     *  (context_limit / tool_limit / time_limit / agent_limit) instead of the
     *  historical "limit:<kind>" free strings. */
    terminationReason?: TerminationReason;
    /** P1-1: the turn's working state — the single run-state structure the
     *  runtime maintained. Hosts (delegation, resume, observability) read the
     *  same state the compaction digest was rendered from. */
    state?: WorkingState;
    /** P2-43: the pending user question when `status === "waiting_for_user"`.
     *  Present exactly in that case, so a host can render a prompt and call
     *  submitUserAnswer() to resume. Absent otherwise. */
    pendingAsk?: AskUserRequest;
    /** P1-1: the pending approval request when `status === "waiting_for_approval"`.
     *  Present exactly in that case, so a host can show the approval UI and
     *  resolve it. Absent otherwise. */
    pendingApproval?: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        argsHash: string;
    };
}
/** P1-4: outcome of a crash recovery. The interrupted session continues in a
 *  fresh turn seeded from the restored working state. */
export interface ResumeResult {
    sessionId: SessionId;
    checkpointId: CheckpointId;
    /** The interrupted turn the checkpoint belongs to, when one was recorded. */
    turnId?: TurnId;
    /** Restored working state (checkpoint + post-checkpoint activity). */
    state: WorkingState;
    /** Side-effect tools that completed after the checkpoint — never replayed. */
    committedSideEffects: ToolExecutionRecord[];
    /** Started-but-unknown tools — reconciliation, never auto-redone. */
    unresolvedTools: UnresolvedToolExecution[];
    /** Events observed after the checkpoint's last evenmark. */
    replayedEventCount: number;
    outcome: TurnOutcome;
}
/** P0-8: fixed header spliced above the context blocks. Low-trust content is
 *  DATA ONLY — markers like "SYSTEM:" or authority claims inside it are inert
 *  and must never override higher-trust policy. */
export declare const TRUST_BOUNDARY_PROMPT: string;
/** P0-7: a skill rejected at discovery time for injection/secret content. */
export interface SkillSecurityDenialRecord {
    detection: "injection" | "secret";
    reasons: string[];
    /** Denied subject — the skill path. */
    path: string;
    /** Subsystem that surfaced the denial ("skill-loader"). */
    source: string;
}
/** P0-7: skills provider result — the safe index plus rejections to surface. */
export interface SkillDiscovery {
    skills: Skill[];
    security: SkillSecurityDenialRecord[];
}
//# sourceMappingURL=turn-helpers.d.ts.map