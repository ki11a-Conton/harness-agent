/**
 * Q-1: recovery / persistence processing extracted from runtime.ts. Owns the
 * durable, side-effect-safe machinery that the other controllers call back
 * into: classifyStatusDetail (partial-failure taxonomy), finishTurn (turn
 * status + completion event), parkForUserInput (ask-user pause),
 * checkpoint (durable snapshot + event), and reconstructResumeState
 * (post-checkpoint activity replay for crash resume).
 *
 * Method bodies are byte-for-byte the ones that lived on AgentRuntime — only
 * `this.<field>` → `this.deps.<field>` changed. `semanticsOf` arrives as an
 * injected function (it stays on the runtime). The public entry points that
 * drive a full turn (runTurn / resumeTurn / submitUserAnswer / resolveAgent)
 * remain on AgentRuntime because they re-enter runTurn (a controller ↔
 * runtime cycle); this controller only holds the leaf recovery helpers.
 */
import { errorInfo } from "@ar/contracts";
import type { AgentEvent, AskUserReply, AskUserRequest, AskUserStore, CheckpointBudgetUsage, CheckpointData, CheckpointStore, EventStore, SessionId, SessionStore, TerminationReason, ToolCall, ToolExecutionRecord, ToolSemantics, TurnId, UnresolvedToolExecution, WorkingState } from "@ar/contracts";
import { AgentState } from "../state/agent-state.js";
import type { TurnContext, TurnOutcome, TurnOutcomeDetail, TurnOutcomeStatus } from "./turn-helpers.js";
export interface RecoveryControllerDeps {
    store: SessionStore;
    events: EventStore;
    emit: (sessionId: SessionId, type: AgentEvent["type"], payload: Record<string, unknown>, turnId?: TurnId, spans?: {
        spanId?: string;
        parentSpanId?: string;
    }) => Promise<AgentEvent>;
    now: () => number;
    checkpointStore?: CheckpointStore;
    askUserStore?: AskUserStore;
    askUser?: (request: AskUserRequest) => Promise<AskUserReply | undefined>;
    semanticsOf: (name: string) => ToolSemantics;
}
export declare class RecoveryController {
    private readonly deps;
    constructor(deps: RecoveryControllerDeps);
    /**
     * P2-38 — partial-failure classification. The coarse public `status` stays
     * "completed" | "failed" | "cancelled"; this finer taxonomy distinguishes
     * whether a termination left committed side effects behind (blocked /
     * *_with_effects / *_no_effect / waiting_*).
     */
    classifyStatusDetail(status: TurnOutcomeStatus, ledger: ToolExecutionRecord[]): TurnOutcomeDetail;
    finishTurn(ctx: TurnContext, status: TurnOutcomeStatus, state: AgentState, working: WorkingState, error?: ReturnType<typeof errorInfo>, terminationReason?: TerminationReason, ledger?: ToolExecutionRecord[]): Promise<TurnOutcome>;
    parkForUserInput(ctx: TurnContext, state: AgentState, working: WorkingState, call: ToolCall, ledger: ToolExecutionRecord[]): Promise<TurnOutcome>;
    /** P1-1: park the turn waiting for approval resolution. */
    parkForApproval(ctx: TurnContext, state: AgentState, working: WorkingState, toolCallId: string, toolName: string, args: Record<string, unknown>, argsHash: string, ledger: ToolExecutionRecord[]): Promise<TurnOutcome>;
    checkpoint(ctx: TurnContext, working: WorkingState, state: AgentState, toolLedger: ToolExecutionRecord[], reason: string, budgetUsage?: CheckpointBudgetUsage): Promise<void>;
    reconstructResumeState(sessionId: SessionId, turnId: TurnId | undefined, checkpoint: CheckpointData): Promise<{
        working: WorkingState;
        committedSideEffects: ToolExecutionRecord[];
        unresolvedTools: UnresolvedToolExecution[];
        replayedEventCount: number;
    }>;
}
//# sourceMappingURL=recovery-controller.d.ts.map