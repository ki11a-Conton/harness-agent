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

import { errorInfo, newMessageId, newModelCallId, sleep as timerSleep } from "@ar/contracts";
import type {
  AgentDefinition,
  AgentEvent,
  CheckpointBudgetUsage,
  Message,
  ModelCallId,
  ModelClient,
  ModelFinalResult,
  ModelRetryPayload,
  SessionId,
  SessionStore,
  TerminationReason,
  Timer,
  ToolCall,
  ToolExecutionRecord,
  ToolSpec,
  Turn,
  TurnId,
  Usage,
  WorkingState,
} from "@ar/contracts";
import { AgentError } from "../errors.js";
import type { ToolSelector } from "../tools/tool-selector.js";
import { AgentState } from "../state/agent-state.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import {
  ASK_GATE_TOOL,
  buildStateDigest,
  decideModelRetry,
  rethrowIfKill,
} from "./turn-helpers.js";
import type {
  FaultPoint,
  FaultPointContext,
  ModelCallResult,
  TurnContext,
  TurnOutcome,
  TurnOutcomeStatus,
} from "./turn-helpers.js";
import type { VerificationGateResult } from "./verification-controller.js";

import type {
  UsageSnapshot,
} from "@ar/contracts";

/**
 * P0-9: merge a usage snapshot into an accumulator. CONTRACT: `usage` events
 * are cumulative snapshots (inputTokens = tokens this call consumed so far),
 * never deltas — so a later snapshot REPLACES the fields it carries instead of
 * adding. Fields absent from a snapshot keep the previous value. This feeds
 * `model.completed.usage`, the single usage record metrics sum (no double
 * count between model.usage and model.completed).
 */
export function mergeUsage(current: UsageSnapshot | undefined, snap: UsageSnapshot): UsageSnapshot {
  const next: UsageSnapshot = { ...current };
  if (snap.inputTokens !== undefined) next.inputTokens = snap.inputTokens;
  if (snap.outputTokens !== undefined) next.outputTokens = snap.outputTokens;
  if (snap.contextTokens !== undefined) next.contextTokens = snap.contextTokens;
  if (snap.estimatedCostUsd !== undefined) next.estimatedCostUsd = snap.estimatedCostUsd;
  return next;
}

/** Q-1: result of handleModelCompletion — tells the turn loop what to do next. */
export type CompletionResult =
  | { action: "continue_loop"; verificationFailures: number }
  | { action: "finish"; outcome: TurnOutcome }
  | { action: "proceed"; toolCalls: ToolCall[] };

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
  emit: (
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    turnId?: TurnId,
    spans?: { spanId?: string; parentSpanId?: string },
  ) => Promise<AgentEvent>;
  now: () => number;
  failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
  toolSpecs: readonly ToolSpec[];
  /** P7-1/P7-2: progressive disclosure — narrows the advertised tool schemas
   *  per goal. Absent → every spec is advertised (identity). */
  toolSelector?: ToolSelector;
  recovery?: RecoveryPolicy;
  timer: Timer;
  compactCounter: { value: number };
  maxVerificationFailures: number;
  /** checkpointPolicy.afterVerification — resolved once at construction. */
  afterVerificationCheckpoint: boolean;
  /** this.context?.budget.maxTokens ?? 0 — resolved once at construction. */
  contextBudgetMaxTokens: number;
  checkpoint: (
    ctx: TurnContext,
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    reason: string,
    budgetUsage?: CheckpointBudgetUsage,
  ) => Promise<void>;
  finishTurn: (
    ctx: TurnContext,
    status: TurnOutcomeStatus,
    state: AgentState,
    working: WorkingState,
    error?: ReturnType<typeof errorInfo>,
    terminationReason?: TerminationReason,
    ledger?: ToolExecutionRecord[],
  ) => Promise<TurnOutcome>;
  parkForUserInput: (
    ctx: TurnContext,
    state: AgentState,
    working: WorkingState,
    call: ToolCall,
    ledger: ToolExecutionRecord[],
  ) => Promise<TurnOutcome>;
  runVerificationGate: (ctx: TurnContext) => Promise<VerificationGateResult | undefined>;
  wallClockExceeded: (agent: AgentDefinition, turn: Turn) => number | undefined;
}

export class ModelCallController {
  constructor(private readonly deps: ModelCallControllerDeps) {}

  /**
   * Q-1: post-completion processing extracted from runTurn. Handles:
   *   - signal aborted / final undefined / wall clock exceeded
   *   - append assistant message + emit model.completed
   *   - finishReason dispatch (stop → verification gate; tool_calls → proceed;
   *     error/cancelled → fail)
   *   - ask-user gate detection
   * Returns a discriminated union telling the caller what to do next.
   */
  async handleModelCompletion(
    ctx: TurnContext,
    modelResult: ModelCompletionInput,
    turn: Turn,
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    lastReportTokens: number | undefined,
    verificationFailures: number,
  ): Promise<CompletionResult> {
    const { sessionId, turnId, signal, agent } = ctx;
    const { assistantText, calls, final, callStartedAt, timeToFirstTokenMs, callId, usage } = modelResult;

    if (signal.aborted) {
      return { action: "finish", outcome: await this.deps.finishTurn(ctx, "cancelled", state, working, undefined, "cancelled", toolLedger) };
    }
    if (!final) {
      const info = errorInfo("MODEL_ERROR", "model ended without completion");
      await this.deps.emit(sessionId, "model.failed", { error: info }, turnId);
      return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working, info, "model_error", toolLedger) };
    }

    const wallElapsedAfterModel = this.deps.wallClockExceeded(agent, turn);
    if (wallElapsedAfterModel !== undefined) {
      await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxDurationMs", used: wallElapsedAfterModel, allowed: agent.limits.maxDurationMs }, turnId);
      return { action: "finish", outcome: await this.deps.finishTurn(
        ctx, "failed", state, working,
        errorInfo("RESOURCE_LIMIT", `maxDurationMs (${agent.limits.maxDurationMs}ms) exceeded after ${wallElapsedAfterModel}ms`),
        "time_limit",
        toolLedger,
      ) };
    }

    const toolCalls = final.toolCalls ?? calls;
    await this.deps.store.appendMessage({
      id: newMessageId(),
      sessionId,
      turnId,
      role: "assistant",
      content: final.text ?? assistantText,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      createdAt: this.deps.now(),
    });
    await this.deps.emit(sessionId, "model.completed", {
      callId,
      finishReason: final.finishReason,
      toolCalls: toolCalls.length,
      durationMs: this.deps.now() - callStartedAt,
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }, turnId, { spanId: callId });

    if (final.finishReason === "stop") {
      await this.deps.failAt("verification.started", { sessionId, turnId });
      const verificationStartedAt = this.deps.now();
      const gate = await this.deps.runVerificationGate(ctx);
      if (gate !== undefined) {
        // P1-3: after a verification gate (passed or failed) is a
        // checkpoint safety boundary.
        if (this.deps.afterVerificationCheckpoint) {
          await this.deps.checkpoint(
            ctx, working, state, toolLedger,
            gate.status === "passed" ? "verification:passed" : "verification:failed",
            lastReportTokens !== undefined ? { maxTokens: this.deps.contextBudgetMaxTokens, usedTokens: lastReportTokens } : undefined,
          );
        }
        if (gate.status !== "passed") {
          verificationFailures += 1;
          if (verificationFailures < this.deps.maxVerificationFailures) {
            // plan.md Phase 4/7: MODEL_STOPPED ≠ done. Inject a structured
            // failure observation and continue the loop; the model gets a
            // bounded number of chances to fix the reported problem.
            await this.deps.emit(sessionId, "verification.failed", { error: gate.reason, attempt: verificationFailures, maxAttempts: this.deps.maxVerificationFailures, durationMs: this.deps.now() - verificationStartedAt }, turnId);
            await this.deps.store.appendMessage({
              id: newMessageId(),
              sessionId,
              turnId,
              role: "system",
              content:
                `[verification failed — attempt ${verificationFailures}/${this.deps.maxVerificationFailures}]\n` +
                `${gate.reason}\n` +
                "The task is NOT complete. Fix the reported problem and verify again.",
              createdAt: this.deps.now(),
            });
            return { action: "continue_loop", verificationFailures };
          }
          await this.deps.emit(sessionId, "verification.failed", { error: gate.reason, attempt: verificationFailures, maxAttempts: this.deps.maxVerificationFailures, durationMs: this.deps.now() - verificationStartedAt }, turnId);
          await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxVerificationFailures", used: verificationFailures, allowed: this.deps.maxVerificationFailures }, turnId);
          return { action: "finish", outcome: await this.deps.finishTurn(
            ctx, "failed", state, working,
            errorInfo("VERIFICATION_FAILED", gate.reason),
            "verification_failed",
            toolLedger,
          ) };
        }
        await this.deps.emit(sessionId, "verification.completed", { passed: true, durationMs: this.deps.now() - verificationStartedAt }, turnId);
        state.terminate("completed");
        return { action: "finish", outcome: await this.deps.finishTurn(ctx, "completed", state, working, undefined, "verified_complete", toolLedger) };
      }
      state.terminate("completed");
      return { action: "finish", outcome: await this.deps.finishTurn(ctx, "completed", state, working, undefined, "model_stopped", toolLedger) };
    }
    if (final.finishReason === "tool_calls" && toolCalls.length === 0) {
      const info = errorInfo("MODEL_ERROR", "model requested tool calls but produced none");
      await this.deps.emit(sessionId, "model.failed", { error: info }, turnId);
      return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working, info, "model_error", toolLedger) };
    }
    if (final.finishReason === "error" || final.finishReason === "cancelled") {
      const info = final.error ?? errorInfo("MODEL_ERROR", `model finished with ${final.finishReason}`);
      await this.deps.emit(sessionId, "model.failed", { error: info }, turnId);
      return { action: "finish", outcome: await this.deps.finishTurn(ctx, "failed", state, working, info, "model_error", toolLedger) };
    }

    state.nextIteration();
    // P2-43: the ask-user gate is a FORMAL runtime phase, not a tool that
    // executes. When the model targets ASK_GATE_TOOL, park the turn as
    // `waiting_for_user` (durable pending request recorded; phase = waiting_user;
    // ask.user_asked + ask.turn_waiting emitted) and return that outcome. The
    // host captures the reply through the askUserStore / askUser handler and
    // resumes (see submitUserAnswer + resume). If the gate is not configured
    // (no store), the call becomes an explicit "tool unavailable" observation —
    // still NOT a fabricated side-effect error.
    const askCall = toolCalls.find((c) => c.name === ASK_GATE_TOOL);
    if (askCall !== undefined) {
      return { action: "finish", outcome: await this.deps.parkForUserInput(ctx, state, working, askCall, toolLedger) };
    }
    return { action: "proceed", toolCalls };
  }

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
  async callModelWithRetry(
    ctx: TurnContext,
    client: ModelClient,
    history: Message[],
    system: string,
    working: WorkingState,
    state: AgentState,
    toolLedger: ToolExecutionRecord[],
    lastReportTokens: number | undefined,
    reactiveCompacted: boolean,
  ): Promise<ModelCallResult> {
    const { sessionId, turnId, signal } = ctx;

    let assistantText = "";
    const calls: ToolCall[] = [];
    let final: ModelFinalResult | undefined;

    // Model request with bounded retry (plan.md Phase 4 recovery ladder:
    // "retry request" before surfacing failure). The RecoveryPolicy
    // bounds the attempts; each retry is observable via model.retry.
    // P1-20: per-attempt latency measurement (time to first token + total).
    // P0-9: every attempt is a distinct model call with its own callId so
    // usage + latency + retries attribute to the exact call that produced it.
    let callStartedAt = 0;
    let timeToFirstTokenMs: number | undefined;
    let firstTokenSeen = false;
    let callId: ModelCallId;
    let usage: UsageSnapshot | undefined;
    for (let attempt = 1; ; attempt += 1) {
      callId = newModelCallId();
      let modelFailed: ReturnType<typeof errorInfo> | undefined;
      usage = undefined;
      callStartedAt = this.deps.now();
      timeToFirstTokenMs = undefined;
      firstTokenSeen = false;
      await this.deps.emit(sessionId, "model.started", { callId }, turnId, { spanId: callId });
      try {
        await this.deps.failAt("model.next_call", { sessionId, turnId });
        // P7-1/P7-2: progressive tool disclosure — the model request advertises
        // only the goal-relevant schemas (deterministic keyword champion).
        const advertisedTools = this.deps.toolSelector?.select({
          goal: working.goal,
          tools: this.deps.toolSpecs,
        });
        const tools: readonly ToolSpec[] = advertisedTools?.selected ?? this.deps.toolSpecs;
        // P7-3: selection is observable (availability vs admitted vs dropped).
        await this.deps.emit(
          sessionId,
          "tools.selected",
          {
            callId,
            available: this.deps.toolSpecs.length,
            selected: tools.length,
            dropped: advertisedTools?.dropped ?? [],
          },
          turnId,
        );
        for await (const ev of client.generate({ messages: history, system, tools: [...tools] }, signal)) {
          if (signal.aborted) break;
          await this.deps.failAt("model.stream", { sessionId, turnId });
          switch (ev.type) {
            case "text_delta":
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                timeToFirstTokenMs = this.deps.now() - callStartedAt;
              }
              assistantText += ev.text;
              break;
            case "reasoning_delta":
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                timeToFirstTokenMs = this.deps.now() - callStartedAt;
              }
              break;
            case "tool_call_delta":
              calls.push(ev.toolCall);
              await this.deps.emit(sessionId, "model.delta", { kind: "tool_call", name: ev.toolCall.name }, turnId);
              break;
            case "completed":
              final = ev.result;
              // P0-9: a provider may only surface usage on the final result
              // (no usage events). Fold it in with the same snapshot semantics.
              if (final.usage !== undefined) usage = mergeUsage(usage, final.usage);
              break;
            case "error":
              throw new AgentError(ev.error);
            case "started":
              break;
            case "usage":
              // P0-9: cumulative snapshot contract — later snapshots replace
              // fields; never summed inline (see mergeUsage).
              usage = mergeUsage(usage, ev.usage);
              break;
            case "retry":
              // Provider-internal retry (retry taxonomy kind "provider",
              // Phase 11): observable, never swallowed.
              await this.deps.emit(sessionId, "retry.provider", { attempt: ev.attempt, error: ev.error }, turnId);
              break;
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return { status: "cancelled" };
        }
        // P1-5: a simulated kill is not a recoverable model error.
        rethrowIfKill(err);
        modelFailed = err instanceof AgentError ? err.info : errorInfo("MODEL_ERROR", String(err));
      }

      // Q-1: pure retry decision extracted to turn-helpers.decideModelRetry.
      // The caller performs side effects based on the returned action.
      const retryAction = decideModelRetry(
        modelFailed,
        reactiveCompacted,
        this.deps.recovery?.decide("model_error", attempt),
        attempt,
      );

      if (retryAction.action === "success") break; // generate completed

      if (retryAction.action === "compact-and-retry") {
        // Reactive compact (plan.md Phase 4/5 Stage 4): a context-length
        // model error is NOT a retry — the runtime compacts once (state
        // digest + reduced history) and tries again; a second overflow
        // surfaces the failure without burning the retry budget.
        reactiveCompacted = true;
        await this.deps.emit(sessionId, "context.compacted", {
          compressed: 1,
          reason: "reactive compact (context-length model error)",
          reactive: true,
          totalCount: ++this.deps.compactCounter.value,
        }, turnId);
        await this.deps.store.appendMessage({
          id: newMessageId(),
          sessionId,
          turnId,
          role: "system",
          content: buildStateDigest(working, "context is full — reactive compact; continue concisely"),
          createdAt: this.deps.now(),
        });
        // P1-3: reactive compaction is a checkpoint safety boundary
        // (the loop is about to restart against a shrunken context).
        await this.deps.checkpoint(
          ctx, working, state, toolLedger, "context:reactive-compact",
          lastReportTokens !== undefined ? { maxTokens: this.deps.contextBudgetMaxTokens, usedTokens: lastReportTokens } : undefined,
        );
        history = await this.deps.store.listMessages(sessionId);
        if (history.length > 12) history = history.slice(-12);
        assistantText = "";
        calls.length = 0;
        final = undefined;
        continue;
      }

      if (retryAction.action === "retry") {
        const retryPayload: ModelRetryPayload = { callId, attempt, error: modelFailed };
        await this.deps.emit(sessionId, "model.retry", { ...retryPayload }, turnId);
        if (retryAction.retryDelayMs > 0) {
          await timerSleep(this.deps.timer, retryAction.retryDelayMs);
        }
        assistantText = "";
        calls.length = 0;
        final = undefined;
        continue;
      }

      // fail
      await this.deps.emit(sessionId, "model.failed", { callId, error: modelFailed }, turnId);
      if (retryAction.suppressLimitEvent !== true && attempt >= retryAction.maxAttempts) {
        await this.deps.emit(sessionId, "run.limit_reached", { limit: "maxRetries", used: attempt, allowed: retryAction.maxAttempts }, turnId);
      }
      return { status: "failed", error: modelFailed! };
    }

    return {
      status: "completed",
      callId,
      assistantText,
      calls,
      final,
      callStartedAt,
      timeToFirstTokenMs,
      usage,
      reactiveCompacted,
    };
  }
}
