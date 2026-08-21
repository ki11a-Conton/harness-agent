/**
 * Q-1: model-call + post-completion processing extracted from runtime.ts.
 * Owns callModelWithRetry (streaming receive, pure retry decision, reactive
 * compaction) and handleModelCompletion (wall-clock, append assistant
 * message, verification gate + retry, finishReason dispatch, ask-user gate).
 *
 * Method bodies are byte-for-byte the ones that lived on AgentRuntime — only
 * `this.<field>` → `this.deps.<field>` changed. Cross-cutting runtime methods
 * (checkpoint / finishTurn / parkForUserInput / runVerificationGate /
 * wallClockExceeded) arrive as injected functions bound to the runtime (or to
 * the verification controller), so this module never imports runtime.ts.
 * `compactCounter` is shared BY REFERENCE with the context controller.
 */
import { errorInfo } from "@ar/contracts";
import type { AgentDefinition, AgentEvent, CheckpointBudgetUsage, Message, ModelCallId, ModelClient, ModelFinalResult, SessionId, SessionStore, TerminationReason, Timer, ToolCall, ToolExecutionRecord, ToolSpec, Turn, TurnId, WorkingState } from "@ar/contracts";
import type { ToolSelector } from "../tools/tool-selector.js";
import { AgentState } from "../state/agent-state.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import type { FaultPoint, FaultPointContext, ModelCallResult, TurnContext, TurnOutcome, TurnOutcomeStatus } from "./turn-helpers.js";
import type { VerificationGateResult } from "./verification-controller.js";
import type { UsageSnapshot } from "@ar/contracts";
/**
 * P0-9: merge a usage snapshot into an accumulator. CONTRACT: `usage` events
 * are cumulative snapshots (inputTokens = tokens this call consumed so far),
 * never deltas — so a later snapshot REPLACES the fields it carries instead of
 * adding. Fields absent from a snapshot keep the previous value. This feeds
 * `model.completed.usage`, the single usage record metrics sum (no double
 * count between model.usage and model.completed).
 */
export declare function mergeUsage(current: UsageSnapshot | undefined, snap: UsageSnapshot): UsageSnapshot;
/** Q-1: result of handleModelCompletion — tells the turn loop what to do next. */
export type CompletionResult = {
    action: "continue_loop";
    verificationFailures: number;
} | {
    action: "finish";
    outcome: TurnOutcome;
} | {
    action: "proceed";
    toolCalls: ToolCall[];
};
/** The completed branch of ModelCallResult, minus the loop-local
 *  `reactiveCompacted` flag (handled by the caller). */
export type ModelCompletionInput = {
    status: "completed";
    callId: ModelCallId;
    assistantText: string;
    calls: ToolCall[];
    final: ModelFinalResult | undefined;
    callStartedAt: number;
    timeToFirstTokenMs: number | undefined;
    /** P0-9: usage accumulated from usage snapshots for THIS call. */
    usage: UsageSnapshot | undefined;
};
export interface ModelCallControllerDeps {
    store: SessionStore;
    emit: (sessionId: SessionId, type: AgentEvent["type"], payload: Record<string, unknown>, turnId?: TurnId, spans?: {
        spanId?: string;
        parentSpanId?: string;
    }) => Promise<AgentEvent>;
    now: () => number;
    failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
    toolSpecs: readonly ToolSpec[];
    /** P7-1/P7-2: progressive disclosure — narrows the advertised tool schemas
     *  per goal. Absent → every spec is advertised (identity). */
    toolSelector?: ToolSelector;
    recovery?: RecoveryPolicy;
    timer: Timer;
    compactCounter: {
        value: number;
    };
    maxVerificationFailures: number;
    /** checkpointPolicy.afterVerification — resolved once at construction. */
    afterVerificationCheckpoint: boolean;
    /** this.context?.budget.maxTokens ?? 0 — resolved once at construction. */
    contextBudgetMaxTokens: number;
    checkpoint: (ctx: TurnContext, working: WorkingState, state: AgentState, toolLedger: ToolExecutionRecord[], reason: string, budgetUsage?: CheckpointBudgetUsage) => Promise<void>;
    finishTurn: (ctx: TurnContext, status: TurnOutcomeStatus, state: AgentState, working: WorkingState, error?: ReturnType<typeof errorInfo>, terminationReason?: TerminationReason, ledger?: ToolExecutionRecord[]) => Promise<TurnOutcome>;
    parkForUserInput: (ctx: TurnContext, state: AgentState, working: WorkingState, call: ToolCall, ledger: ToolExecutionRecord[]) => Promise<TurnOutcome>;
    runVerificationGate: (ctx: TurnContext) => Promise<VerificationGateResult | undefined>;
    wallClockExceeded: (agent: AgentDefinition, turn: Turn) => number | undefined;
}
export declare class ModelCallController {
    private readonly deps;
    constructor(deps: ModelCallControllerDeps);
    /**
     * Q-1: post-completion processing extracted from runTurn. Handles:
     *   - signal aborted / final undefined / wall clock exceeded
     *   - append assistant message + emit model.completed
     *   - finishReason dispatch (stop → verification gate; tool_calls → proceed;
     *     error/cancelled → fail)
     *   - ask-user gate detection
     * Returns a discriminated union telling the caller what to do next.
     */
    handleModelCompletion(ctx: TurnContext, modelResult: ModelCompletionInput, turn: Turn, working: WorkingState, state: AgentState, toolLedger: ToolExecutionRecord[], lastReportTokens: number | undefined, verificationFailures: number): Promise<CompletionResult>;
    /**
     * Q-1: model call with bounded retry — extracted from runTurn. Handles:
     *   - streaming model responses (text/reasoning/tool-call deltas)
     *   - per-attempt latency (time to first token + total)
     *   - retry decisions via decideModelRetry (pure)
     *   - reactive compaction on context overflow (checkpoint + state digest)
     *   - provider-internal retry events
     * Returns a discriminated union; the caller handles finishTurn for
     * cancelled/failed and runs post-completion for completed.
     */
    callModelWithRetry(ctx: TurnContext, client: ModelClient, history: Message[], system: string, working: WorkingState, state: AgentState, toolLedger: ToolExecutionRecord[], lastReportTokens: number | undefined, reactiveCompacted: boolean, budget?: import("./run-budget.js").RunBudgetTracker): Promise<ModelCallResult>;
}
//# sourceMappingURL=model-call-controller.d.ts.map