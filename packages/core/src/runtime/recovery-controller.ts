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

import {
  buildCheckpoint,
  computeArgsHash,
  EFFECTIVE_AGENT_SNAPSHOT_KEY,
  errorInfo,
  isAskReason,
  newAskId,
  newCheckpointId,
} from "@ar/contracts";
import type {
  AgentEvent,
  AskUserReply,
  AskUserRequest,
  AskUserStore,
  CheckpointBudgetUsage,
  CheckpointData,
  CheckpointStore,
  EventStore,
  SessionId,
  SessionStore,
  TerminationReason,
  ToolCall,
  ToolCallId,
  ToolExecutionRecord,
  ToolSemantics,
  Turn,
  TurnId,
  UnresolvedToolExecution,
  WorkingState,
} from "@ar/contracts";
import { AgentError } from "../errors.js";
import { AgentState } from "../state/agent-state.js";
import { updateWorkingState } from "./turn-helpers.js";
import type {
  TurnContext,
  TurnOutcome,
  TurnOutcomeDetail,
  TurnOutcomeStatus,
} from "./turn-helpers.js";

export interface RecoveryControllerDeps {
  store: SessionStore;
  events: EventStore;
  emit: (
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    turnId?: TurnId,
    spans?: { spanId?: string; parentSpanId?: string },
  ) => Promise<AgentEvent>;
  now: () => number;
  checkpointStore?: CheckpointStore;
  askUserStore?: AskUserStore;
  askUser?: (request: AskUserRequest) => Promise<AskUserReply | undefined>;
  semanticsOf: (name: string) => ToolSemantics;
}

export class RecoveryController {
  constructor(private readonly deps: RecoveryControllerDeps) {}

  /**
   * P2-38 — partial-failure classification. The coarse public `status` stays
   * "completed" | "failed" | "cancelled"; this finer taxonomy distinguishes
   * whether a termination left committed side effects behind (blocked /
   * *_with_effects / *_no_effect / waiting_*).
   */
  classifyStatusDetail(
    status: TurnOutcomeStatus,
    ledger: ToolExecutionRecord[],
  ): TurnOutcomeDetail {
    if (status === "completed") return "completed";
    // P2-43: waiting_for_user is a PAUSE, not a failure/cancel — it carries
    // whatever side effects committed up to the ask, but never a blocked/
    // failed label (nothing failed).
    if (status === "waiting_for_user") {
      const committedEffect = ledger.some((e) => e.sideEffect === true && e.status === "success");
      return committedEffect ? "waiting_with_effects" : "waiting_no_effect";
    }
    // P1-1: waiting_for_approval is a PAUSE, same semantics as waiting_for_user.
    if (status === "waiting_for_approval") {
      const committedEffect = ledger.some((e) => e.sideEffect === true && e.status === "success");
      return committedEffect ? "waiting_approval_with_effects" : "waiting_approval_no_effect";
    }
    // A side effect is "committed" only when a side-effect-scoped tool
    // returned success (it landed in the durable ledger as applied).
    const committedEffect = ledger.some((e) => e.sideEffect === true && e.status === "success");
    if (status === "cancelled") {
      return committedEffect ? "cancelled_with_effects" : "cancelled_no_effect";
    }
    // failed: blocked = no committed effect AND a hard policy denial observed
    // (permission / sandbox / security gate stopped real progress).
    const anyDenial = ledger.some((e) => e.status === "denied");
    if (!committedEffect && anyDenial) return "blocked";
    return committedEffect ? "failed_with_effects" : "failed_no_effect";
  }

  async finishTurn(
    ctx: TurnContext,
    status: TurnOutcomeStatus,
    state: AgentState,
    working: WorkingState,
    error?: ReturnType<typeof errorInfo>,
    terminationReason?: TerminationReason,
    ledger?: ToolExecutionRecord[],
  ): Promise<TurnOutcome> {
    const { sessionId, turnId } = ctx;
    const turn = await this.deps.store.getTurn(turnId);
    if (!turn) throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown turn ${turnId}`));
    const updated: Turn = { ...turn, status, completedAt: this.deps.now() };
    await this.deps.store.updateTurn(updated);
    // P2-38: derive the partial-failure classification from the durable tool
    // ledger (the side-effect-safety source of truth), so failed_with_effects /
    // cancelled_with_effects / blocked are observable, not lost.
    const statusDetail = this.classifyStatusDetail(status, ledger ?? []);
    await this.deps.emit(
      sessionId,
      status === "completed" ? "turn.completed" : status === "cancelled" ? "turn.cancelled" : "turn.failed",
      { turnId, status, statusDetail, ...(error !== undefined ? { error } : {}), ...(terminationReason !== undefined ? { terminationReason } : {}) },
      turnId,
    );
    return {
      status,
      statusDetail,
      turn: updated,
      toolCalls: state.getToolCallsExecuted(),
      iterations: state.getIteration(),
      state: working,
      ...(error !== undefined ? { error } : {}),
      ...(terminationReason !== undefined ? { terminationReason } : {}),
    };
  }

  async parkForUserInput(
    ctx: TurnContext,
    state: AgentState,
    working: WorkingState,
    call: ToolCall,
    ledger: ToolExecutionRecord[],
  ): Promise<TurnOutcome> {
    const { sessionId, turnId } = ctx;
    const question = typeof call.args.question === "string" ? call.args.question : "";
    const reason = isAskReason(call.args.reason)
      ? (call.args.reason)
      : "missing_critical_input";
    const options =
      Array.isArray(call.args.options) && call.args.options.length > 0
        ? call.args.options.map((o) => String(o))
        : undefined;
    const request: AskUserRequest = {
      id: newAskId(),
      sessionId,
      turnId,
      reason,
      question,
      ...(options !== undefined ? { options } : {}),
      status: "pending",
      createdAt: this.deps.now(),
    };
    if (this.deps.askUserStore !== undefined) {
      await this.deps.askUserStore.create(request);
    }
    // Emit before parking so the host/UI can start rendering the prompt.
    await this.deps.emit(sessionId, "ask.user_asked", {
      askId: request.id,
      turnId,
      reason,
      question,
      ...(options !== undefined ? { options } : {}),
    }, turnId);
    await this.deps.emit(sessionId, "ask.turn_waiting", {
      askId: request.id,
      turnId,
      reason,
    }, turnId);
    // Advance the phase machine into the resumable waiting_user phase (not a
    // terminal). If a handler is wired, deliver the question synchronously
    // (a UI may still be out of band — the reply is captured via submitUserAnswer).
    if (this.deps.askUser !== undefined) {
      try {
        void this.deps.askUser({ ...request });
      } catch {
        // handler errors are observable but never fail the turn
      }
    }
    state.transition("waiting_user");
    // Persist the paused status on the turn record (not a completion).
    const turn = await this.deps.store.getTurn(turnId);
    if (turn) {
      const updated: Turn = { ...turn, status: "waiting_for_user" };
      await this.deps.store.updateTurn(updated);
    }
    const detail: TurnOutcomeDetail = this.classifyStatusDetail("waiting_for_user", ledger);
    return {
      status: "waiting_for_user",
      statusDetail: detail,
      turn:
        (await this.deps.store.getTurn(turnId)) ??
        ({ id: turnId, sessionId, input: { sessionId, text: "" }, status: "waiting_for_user", startedAt: this.deps.now() } as Turn),
      toolCalls: state.getToolCallsExecuted(),
      iterations: state.getIteration(),
      state: working,
      pendingAsk: request,
    };
  }

  /** P1-1: park the turn waiting for approval resolution. */
  async parkForApproval(
    ctx: TurnContext,
    state: AgentState,
    working: WorkingState,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    argsHash: string,
    ledger: ToolExecutionRecord[],
  ): Promise<TurnOutcome> {
    const { sessionId, turnId } = ctx;
    state.transition("waiting_approval");
    const turn = await this.deps.store.getTurn(turnId);
    if (turn) {
      const updated: Turn = { ...turn, status: "waiting_for_approval" };
      await this.deps.store.updateTurn(updated);
    }
    const detail: TurnOutcomeDetail = this.classifyStatusDetail("waiting_for_approval", ledger);
    return {
      status: "waiting_for_approval",
      statusDetail: detail,
      turn:
        (await this.deps.store.getTurn(turnId)) ??
        ({ id: turnId, sessionId, input: { sessionId, text: "" }, status: "waiting_for_approval", startedAt: this.deps.now() } as Turn),
      toolCalls: state.getToolCallsExecuted(),
      iterations: state.getIteration(),
      state: working,
      pendingApproval: { toolCallId, toolName, args, argsHash },
    };
  }

  async checkpoint(
    ctx: TurnContext,
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    reason: string,
    budgetUsage?: CheckpointBudgetUsage,
  ): Promise<void> {
    const { session, turnId } = ctx;
    if (this.deps.checkpointStore === undefined) return;
    const snapshot = state.snapshot();
    let childSessions: SessionId[];
    let lastEventSequence: number;
    try {
      childSessions = (await this.deps.store.listSessions({ parentId: session.id })).map((s) => s.id);
      lastEventSequence = (await this.deps.events.nextSequence(session.id)) - 1;
    } catch (err) {
      await this.deps.emit(session.id, "checkpoint.failed", {
        turnId,
        reason,
        error: `session/event read failed: ${err instanceof Error ? err.message : String(err)}`,
      }, turnId);
      return;
    }
    try {
      const checkpoint: CheckpointData = buildCheckpoint({
        checkpointId: newCheckpointId(),
        schemaVersion: 1,
        sessionId: session.id,
        turnId,
        agentId: session.agentId,
        createdAt: this.deps.now(),
        reason,
        phase: snapshot.phase,
        iteration: snapshot.iteration,
        state: working,
        ...(budgetUsage !== undefined ? { budgetUsage } : {}),
        toolLedger,
        childSessions,
        lastEventSequence,
        effectiveAgentConfigRef: EFFECTIVE_AGENT_SNAPSHOT_KEY,
        contextRefs: [],
      });
      await this.deps.checkpointStore.save(checkpoint);
      await this.deps.emit(session.id, "checkpoint.created", {
        turnId,
        checkpointId: checkpoint.checkpointId,
        reason,
        iteration: snapshot.iteration,
        phase: snapshot.phase,
        lastEventSequence,
      }, turnId);
    } catch (err) {
      // Observable, non-fatal: a checkpoint write failure must not kill the
      // agent loop (the transcript/state stores are unchanged).
      await this.deps.emit(session.id, "checkpoint.failed", {
        turnId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      }, turnId);
    }
  }

  async reconstructResumeState(
    sessionId: SessionId,
    turnId: TurnId | undefined,
    checkpoint: CheckpointData,
  ): Promise<{
    working: WorkingState;
    committedSideEffects: ToolExecutionRecord[];
    unresolvedTools: UnresolvedToolExecution[];
    replayedEventCount: number;
  }> {
    const working: WorkingState = structuredClone(checkpoint.state) as WorkingState;
    const events = (await this.deps.events.list(sessionId, { afterSequence: checkpoint.lastEventSequence })).sort(
      (a, b) => a.sequence - b.sequence,
    );
    const replayedEventCount = events.length;

    // Which tools produced a persisted result message after the checkpoint?
    const completedIds = new Set<string>();
    const failedIds = new Set<string>();
    if (turnId !== undefined) {
      const messages = await this.deps.store.listMessagesByTurn(sessionId, turnId);
      for (const message of messages) {
        if (message.role === "tool" && message.toolCallId !== undefined) {
          completedIds.add(message.toolCallId);
        }
      }
    }
    for (const event of events) {
      if (event.type === "tool.failed") {
        const key = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : event.id;
        failedIds.add(key);
      }
    }

    // Reconstruct requested calls from the post-checkpoint event log.
    const requested = new Map<
      string,
      { id: string; name: string; args: Record<string, unknown>; started: number }
    >();
    const terminalIds = new Set<string>();
    for (const event of events) {
      if (event.type === "tool.requested") {
        const id = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : event.id;
        requested.set(id, {
          id,
          name: typeof event.payload.name === "string" ? event.payload.name : "unknown",
          args: (event.payload.args as Record<string, unknown> | undefined) ?? {},
          started: event.timestamp,
        });
      } else if (event.type === "tool.completed" || event.type === "tool.failed") {
        const key = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : event.id;
        terminalIds.add(key);
      }
    }

    const committedSideEffects: ToolExecutionRecord[] = [];
    const unresolvedTools: UnresolvedToolExecution[] = [];
    for (const info of requested.values()) {
      const sideEffect = this.deps.semanticsOf(info.name).sideEffectScope !== "none";
      const done = completedIds.has(info.id) || terminalIds.has(info.id);
      if (!done) {
        unresolvedTools.push({
          toolCallId: info.id as ToolCallId,
          tool: info.name,
          argsHash: computeArgsHash(info.args),
          started: info.started,
          sideEffect,
        });
        continue;
      }
      // The result exists in the store: fold it back into the working state
      // so resume does not re-lose already-applied work. side-effect tools
      // that were not reported failed are committed — never blindly replayed.
      const failed = failedIds.has(info.id);
      const fakeCall = { id: info.id as ToolCallId, name: info.name, args: info.args };
      updateWorkingState(
        fakeCall,
        { status: failed ? "failed" : "success", output: "" },
        working,
        this.deps.semanticsOf(fakeCall.name),
      );
      if (sideEffect) {
        committedSideEffects.push({
          toolCallId: info.id as ToolCallId,
          tool: info.name,
          argsHash: computeArgsHash(info.args),
          started: info.started,
          completed: info.started,
          status: failed ? "failed" : "success",
          sideEffect,
        });
      }
    }

    return { working, committedSideEffects, unresolvedTools, replayedEventCount };
  }
}
