/**
 * Q-1: tool-call execution extracted from runtime.ts. Owns the batch planner
 * (serial writes + bounded parallel read batches), the single-call pipeline
 * (policy gate → hooks → orchestrator → legacy/adaptive recovery → events)
 * and the stall-trace recorder. The AgentRuntime keeps the turn loop and
 * delegates here via `this.toolCallController`.
 *
 * All method bodies are byte-for-byte the ones that lived on AgentRuntime —
 * the only change is `this.<member>` → `this.deps.<member>` for the runtime
 * fields, and `emit` / `failAt` arriving as injected functions bound to the
 * runtime instance (same event sequence, same timestamps, same clock).
 * `recoveryUsage` is passed BY REFERENCE: it is the runtime-owned mutable
 * budget counter map the adaptive planner reads and writes.
 */

import {
  AdaptiveRecoveryPlanner,
  computeArgsHash,
  errorInfo,
  isToolAllowedByPolicy,
  newMessageId,
  resourceConflicts,
  sleep as timerSleep,
  stableFingerprint,
} from "@ar/contracts";
import type {
  AgentEvent,
  RecoveryAction,
  SandboxPolicy,
  SessionId,
  SessionStore,
  Timer,
  ToolCall,
  ToolCallRequest,
  ToolCallTrace,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
  ToolSemantics,
  StepExecutionSnapshot,
  TurnExecutionState,
  TurnId,
} from "@ar/contracts";
import { AgentError } from "../errors.js";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
import { defaultSandboxPolicy, rethrowIfKill, RuntimeKilledError } from "./turn-helpers.js";
import type { FaultPoint, FaultPointContext, TurnContext } from "./turn-helpers.js";

/** Q-1: one executed tool call as returned to the turn loop. `streak` is the
 *  consecutive-identical-call count AFTER this call was recorded. */
export interface ExecutedToolCall {
  call: ToolCall;
  result: ToolResult;
  streak: number;
}

/** Q-1: everything ToolCallController needs from the runtime. All fields are
 *  read-only bindings captured when the runtime constructs the controller;
 *  per-turn mutable state (P15-1 recoveryUsage) is NOT here — it is threaded
 *  by value into executeToolCalls. */
export interface ToolCallControllerDeps {
  /** Tool side-effect executor (permission/sandbox enforced inside). */
  orchestrator: ToolOrchestrator;
  /** Session store — used to append adaptive-recovery observations. */
  store: SessionStore;
  /** Lifecycle hooks (beforeTool / afterTool / toolError). */
  hooks: HookRegistry;
  /** Event sink — the runtime's emit (sequence allocation + timestamp). */
  emit: (
    sessionId: SessionId,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    turnId?: TurnId,
    spans?: { spanId?: string; parentSpanId?: string },
  ) => Promise<AgentEvent>;
  /** P1-5 fault-injection kill point (no-op when absent). */
  failAt: (point: FaultPoint, ctx: FaultPointContext) => Promise<void>;
  /** Injected clock (event timestamps / message createdAt). */
  now: () => number;
  /** Q-7 timer for retry backoff sleeps. */
  timer: Timer;
  /** Optional sandbox policy override; the default is applied per call. */
  sandboxPolicy?: SandboxPolicy;
  /** Legacy recovery policy (Phase 3.6) — bounded safe retries. */
  recovery?: RecoveryPolicy;
  /** P2-42 adaptive recovery planner. */
  adaptiveRecovery?: AdaptiveRecoveryPlanner;
  /** P18-1: ToolSemantics lookup for concurrency + retry gating — the only
   *  execution-policy source. Legacy ToolCapability is never consulted here. */
  toolSemanticsOf: (toolName: string) => ToolSemantics;
  /** P18-6: per-call resource conflict key (args-derived, e.g. canonical file
   *  path for write_file). Calls sharing a key are never batched in parallel.
   *  Absent → no static conflict detection (unknown targets stay serial via
   *  concurrencySafety). */
  resourceConflictOf?: (call: ToolCall) => import("@ar/contracts").ResourceConflictKey | undefined;
  /** Max parallel concurrency-safe calls per read batch. */
  maxParallelToolCalls: number;
  /** P3-9: host-provided specialist delegation. When adaptive recovery picks
   *  `delegate_specialist`, the host decides whether to actually delegate
   *  (budget allows + task decomposable) and returns a bounded observation
   *  for the model; absent → the legacy "try a different approach" message. */
  delegateSpecialist?: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    goal: string;
    tool: string;
    failure: string;
    signal: AbortSignal;
  }) => Promise<{ delegated: boolean; summary?: string } | undefined>;
}

export class ToolCallController {
  constructor(private readonly deps: ToolCallControllerDeps) {}

  /** P18-6: per-call resource conflict key, when a resolver is wired. */
  private conflictKeyOf(call: ToolCall): import("@ar/contracts").ResourceConflictKey | undefined {
    return this.deps.resourceConflictOf?.(call);
  }

  /**
   * Execute the iteration's tool calls. Consecutive concurrency-safe calls
   * (read-only, stateless — plan.md Phase 3.3) run in parallel up to
   * `maxParallelToolCalls`; everything else runs serially. Results are always
   * returned in CALL ORDER regardless of completion order, so the message
   * trail stays deterministic.
   *
   * The phase machine is single-threaded by design: the tool_pending
   * transition happens once per batch (or per serial call), and the
   * observing → thinking transitions run in the caller's results loop.
   */
  async executeToolCalls(
    ctx: TurnContext,
    state: AgentState,
    calls: ToolCall[],
    /** P15-1: the per-turn execution state (recoveryUsage etc.) — threaded by
     *  value from the runtime, created fresh per turn in prepareTurn. */
    turnState: TurnExecutionState,
    /** P15-2: the immutable step this batch belongs to. The SAME object is
     *  used for every tool call of this model response — a mid-batch config/
     *  policy change cannot affect the already-started batch. */
    step: StepExecutionSnapshot,
    /** P9-1: the model call that requested these tool calls (parent span). */
    parentCallId?: string,
  ): Promise<ExecutedToolCall[]> {
    const { signal } = ctx;
    const executed: ExecutedToolCall[] = [];
    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        // P15-6: cancellation settlement — every not-yet-started call in this
        // model batch still gets a synthetic cancelled settlement; a tool call
        // must never vanish from the transcript (abort mid-batch).
        for (; i < calls.length; i++) {
          const pending = calls[i]!;
          executed.push({
            call: pending,
            result: {
              status: "cancelled",
              error: errorInfo("USER_CANCELLED", "turn aborted before this tool call started"),
            },
            streak: state.noteToolCall(pending.name, pending.args),
          });
        }
        break;
      }
      const call = calls[i]!;
      const safe = this.deps.toolSemanticsOf(call.name).concurrencySafety;
      if (safe && this.deps.maxParallelToolCalls > 1 && i + 1 < calls.length) {
        const batch: ToolCall[] = [call];
        let j = i + 1;
        while (
          j < calls.length &&
          batch.length < this.deps.maxParallelToolCalls &&
          this.deps.toolSemanticsOf(calls[j]!.name).concurrencySafety &&
          // P18-6: a candidate that CONFLICTS on a resource key with a call
          // already admitted to the batch is NOT merged — same-resource
          // mutations must stay serial even if both are concurrencySafe.
          !resourceConflicts(
            batch.map((c) => ({ conflictKey: this.conflictKeyOf(c) })),
            { conflictKey: this.conflictKeyOf(calls[j]!) },
          )
        ) {
          batch.push(calls[j]!);
          j += 1;
        }
        state.transition("tool_pending");
        // P2-37: the parallel READ batch aborts as soon as `signal` fires rather
        // than waiting for every in-flight read to finish. Reads are stateless,
        // so a read that has not settled at abort time is simply dropped (its
        // result is not recorded); the reads themselves observe the aborted
        // signal and terminate promptly.
        const settled = await this.runReadBatch(ctx, batch, turnState, step, parentCallId);
        state.transition("observing");
        state.transition("thinking");
        for (const { call: c, result } of settled) {
          executed.push({
            call: c,
            result,
            streak: state.noteToolCall(c.name, c.args),
          });
          this.recordStallTrace(state, c, result);
        }
        i = j;
      } else {
        state.transition("tool_pending");
        const result = await this.executeToolCall(ctx, call, turnState, step, parentCallId);
        state.transition("observing");
        state.transition("thinking");
        if (signal.aborted) {
          // P2-37: serial (write) chain — the interrupt took effect during this
          // call. It returned a CANCELLED outcome (or the call already committed
          // and returned success). Stop the remaining calls: do not keep firing
          // later writes into an aborted turn, and never pretend the committed
          // ones rolled back. P15-6: every not-yet-started call still gets a
          // synthetic cancelled settlement (no tool call disappears).
          executed.push({
            call,
            result,
            streak: state.noteToolCall(call.name, call.args),
          });
          this.recordStallTrace(state, call, result);
          for (let k = i + 1; k < calls.length; k++) {
            const pending = calls[k]!;
            executed.push({
              call: pending,
              result: {
                status: "cancelled",
                error: errorInfo("USER_CANCELLED", "turn aborted before this tool call started"),
              },
              streak: state.noteToolCall(pending.name, pending.args),
            });
          }
          break;
        }
        executed.push({
          call,
          result,
          streak: state.noteToolCall(call.name, call.args),
        });
        this.recordStallTrace(state, call, result);
        i += 1;
      }
    }
    return executed;
  }

  /**
   * P2-37: run a batch of concurrency-safe (read-only) tool calls in parallel,
   * but resolve as soon as the user `signal` aborts so an interrupt is honored
   * promptly instead of waiting for every in-flight read. Rejects on a P1-5
   * kill so fault injection still propagates. Settled results are returned in
   * call order.
   */
  async runReadBatch(
    ctx: TurnContext,
    batch: ToolCall[],
    /** P15-1: per-turn execution state threaded through to each call. */
    turnState: TurnExecutionState,
    /** P15-2: the immutable step shared by every call in this batch. */
    step: StepExecutionSnapshot,
    parentCallId?: string,
  ): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
    const { signal } = ctx;
    if (signal.aborted || batch.length === 0) return [];
    return new Promise<Array<{ call: ToolCall; result: ToolResult }>>((resolve, reject) => {
      const results: Array<{ call: ToolCall; result: ToolResult } | undefined> = new Array(batch.length);
      // P18-5: per-call settlement promises — the abort path needs them to
      // WAIT for non-cancellable in-flight calls instead of lying about them.
      const settlePromises: Array<Promise<void> | undefined> = new Array(batch.length);
      let remaining = batch.length;
      let done = false;
      const finish = (arr: Array<{ call: ToolCall; result: ToolResult }>) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve(arr);
      };
      const fail = (err: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      };
      const onAbort = () => {
        // P18-5 cancellable-aware settlement. Every call in the batch must
        // settle (P15-6 — none may vanish from the transcript/replay), but
        // the settlement must HONOR cancellable semantics:
        //   - already settled        → keep the real result.
        //   - in-flight + cancellable → synthetic cancelled (the tool's own
        //     signal fired; a cleanly aborted read has no side effect).
        //   - in-flight + NON-cancellable → NEVER lied about as cancelled (a
        //     non-cancellable tool may have produced side effects). We wait
        //     for its REAL settlement and record what actually happened.
        const immediate: Array<{ call: ToolCall; result: ToolResult }> = [];
        const waitIdx: number[] = [];
        for (let i = 0; i < batch.length; i++) {
          const existing = results[i];
          if (existing !== undefined) {
            immediate.push(existing);
          } else if (this.deps.toolSemanticsOf(batch[i]!.name).cancellable) {
            immediate.push({
              call: batch[i]!,
              result: {
                status: "cancelled",
                error: errorInfo("USER_CANCELLED", "read batch aborted before the call settled (cancellable)"),
              },
            });
          } else {
            waitIdx.push(i);
          }
        }
        if (waitIdx.length === 0) {
          finish(immediate);
          return;
        }
        // Wait for the non-cancellable calls to settle with their REAL result
        // (they may ignore the abort and complete; the transcript then shows
        // success/failure instead of a fabricated cancellation).
        void Promise.all(waitIdx.map((i) => settlePromises[i]!)).then(() => {
          finish([...immediate, ...waitIdx.map((i) => results[i]!)]);
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      batch.forEach((c, idx) => {
        const promise = this.executeToolCall(ctx, c, turnState, step, parentCallId);
        // P18-5: the settle signal ALWAYS resolves (the rejection is already
        // recorded into results by the catch below — the abort wait path only
        // needs to know WHEN settlement happened, never to see the error).
        settlePromises[idx] = promise.then(
          () => undefined,
          () => undefined,
        );
        promise
          .then((result) => {
            results[idx] = { call: c, result };
            remaining -= 1;
            if (remaining === 0 && !done) {
              finish(results.filter((r): r is { call: ToolCall; result: ToolResult } => r !== undefined));
            }
          })
          .catch((err) => {
            // P1-5 kills propagate to the batch's caller (never swallowed or
            // mislabeled as a tool failure).
            if (err instanceof RuntimeKilledError) {
              fail(err);
              return;
            }
            results[idx] = {
              call: c,
              result: {
                status: "failed",
                error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
              },
            };
            remaining -= 1;
            if (remaining === 0 && !done) {
              finish(results.filter((r): r is { call: ToolCall; result: ToolResult } => r !== undefined));
            }
          });
      });
    });
  }

  /** P2-41: record one executed tool call into the turn's stall window. The
   *  arguments key and result fingerprint let the pure classifier distinguish a
   *  genuine stall (same call + same result) from progress (same call, NEW
   *  result). */
  private recordStallTrace(state: AgentState, call: ToolCall, result: ToolResult): void {
    const isRead = this.deps.toolSemanticsOf(call.name).readOnly;
    if (result.status === "success") {
      const trace: ToolCallTrace = {
        name: call.name,
        argsKey: computeArgsHash(call.args),
        resultFingerprint: computeArgsHash({ output: result.output ?? "" }),
        ...(isRead ? { isRead: true } : {}),
      };
      // A read whose RESULT CHANGED vs the same prior call is evidence advancing
      // (a verification moving from failing->passing, new search hits, ...).
      // That is concrete progress, so it cancels any pending stall score.
      if (isRead && state.priorResultChanged(trace)) {
        state.recordProgress("new_evidence");
        state.recordProgress("verification_improved");
      }
      state.recordToolCall(trace);
    } else if (result.status === "failed" && result.error !== undefined) {
      state.recordToolCall({
        name: call.name,
        argsKey: computeArgsHash(call.args),
        errorCode: result.error.code,
        ...(isRead ? { isRead: true } : {}),
      });
    } else {
      state.recordToolCall({
        name: call.name,
        argsKey: computeArgsHash(call.args),
        ...(isRead ? { isRead: true } : {}),
      });
    }
  }

  async executeToolCall(
    ctx: TurnContext,
    call: ToolCall,
    /** P15-1: per-turn execution state (recoveryUsage is read/written here). */
    turnState: TurnExecutionState,
    /** P15-2: the immutable step this tool call belongs to. */
    step: StepExecutionSnapshot,
    parentCallId?: string,
  ): Promise<ToolResult> {
    const { session, turnId, signal, agent } = ctx;
    // P1-20: tool latency starts at the request (includes policy gates,
    // permission/sandbox evaluation and retries).
    const toolStartedAt = this.deps.now();
    await this.deps.emit(session.id, "tool.requested", { toolCallId: call.id, name: call.name, args: call.args, stepId: step.record.stepId }, turnId, { spanId: call.id, parentSpanId: parentCallId });

    // P23-5: the STEP's frozen permission profile is the first gate
    // (fail-closed). A mid-run widening of the global agent config can only
    // affect a NEW step — S1 keeps the authority it was sampled under.
    // Permission/sandbox evaluation still happens downstream in the
    // orchestrator; a policy-denied call never reaches hooks or execution.
    // P24-5: MCP tools bound into the step carry their server-level
    // authorization (the descriptor's conferred allow-list was enforced at
    // registration); they are gated by provenance, not the agent allow-list.
    const stepToolPolicy = step.permissions.toolPolicy;
    const boundTool = step.tools.resolve(call.name);
    const isMcpBound = boundTool?.provenance.kind === "mcp";
    if (!isMcpBound && !isToolAllowedByPolicy(stepToolPolicy, call.name)) {
      const error = errorInfo(
        "PERMISSION_DENIED",
        `tool ${call.name} is denied by the step tool policy (allow=${JSON.stringify(stepToolPolicy.allow ?? null)} deny=${JSON.stringify(stepToolPolicy.deny ?? null)})`,
      );
      const result: ToolResult = { status: "denied", error };
      await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error, durationMs: this.deps.now() - toolStartedAt }, turnId);
      await this.deps.emit(session.id, "security.permission_denied", {
        toolCallId: call.id,
        tool: call.name,
        target: call.name,
        reason: error.message,
        source: "tool-policy",
        code: "PERMISSION_DENIED",
      }, turnId);
      return result;
    }

    const hookCtx = { sessionId: session.id, turnId, agentId: session.agentId, timestamp: this.deps.now() };
    const allowed = await this.deps.hooks.beforeTool(hookCtx, call);
    if (allowed === null) {
      const error = errorInfo("PERMISSION_DENIED", `tool ${call.name} blocked by hook`);
      const result: ToolResult = { status: "denied", error };
      await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error, durationMs: this.deps.now() - toolStartedAt }, turnId);
      await this.deps.emit(session.id, "security.permission_denied", {
        toolCallId: call.id,
        tool: call.name,
        target: call.name,
        reason: error.message,
        source: "hook",
        code: "PERMISSION_DENIED",
      }, turnId);
      await this.deps.hooks.toolError(hookCtx, call, result);
      return result;
    }
    // P14-4 hook boundary: a before_tool transform may enrich the call with
    // bounded context (args), but it may NOT swap the tool identity. The
    // frozen tool policy above was evaluated against the ORIGINAL name; a
    // hook returning a different name would route a different tool past the
    // policy gate (only the orchestrator's permission/sandbox — a separate
    // rule set — would still run). Renaming the tool is therefore a tool-
    // capability widening attempt: deny fail-closed and surface it as a
    // capability escalation, never as a silent substitution.
    if (allowed.name !== call.name) {
      const error = errorInfo(
        "SECURITY_DENIED",
        `hook attempted to change tool identity: ${call.name} → ${allowed.name}`,
      );
      const result: ToolResult = { status: "denied", error };
      await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error, durationMs: this.deps.now() - toolStartedAt }, turnId);
      await this.deps.emit(session.id, "security.capability_denied", {
        toolCallId: call.id,
        tool: call.name,
        target: allowed.name,
        reason: error.message,
        source: "hook",
        code: "SECURITY_DENIED",
        details: [`tool_escalation: ${call.name} → ${allowed.name}`],
      }, turnId);
      await this.deps.hooks.toolError(hookCtx, call, result);
      return result;
    }

    const request: ToolCallRequest = {
      id: call.id,
      sessionId: session.id,
      turnId,
      agentId: session.agentId,
      call: allowed,
    };
    // P23-4: the tool this call executes against is the FROZEN step binding —
    // the exact definition the model saw. A tool present globally but absent
    // from the step router fails TOOL_NOT_IN_STEP; it never falls through to
    // the mutable global registry.
    const frozenBinding = step.tools.resolve(call.name);
    if (frozenBinding === undefined) {
      const info = errorInfo("TOOL_NOT_IN_STEP", `tool "${call.name}" is not in the frozen step router`);
      await this.deps.hooks.toolError(hookCtx, call, { status: "failed", error: info });
      return { status: "failed", error: info };
    }
    const execCtx: ToolExecutionContext = {
      sessionId: session.id,
      turnId,
      agentId: session.agentId,
      // P23-5: the orchestrator receives the STEP authority — permissions,
      // sandbox and environment from the frozen snapshot, not live state.
      cwd: step.environment.cwd,
      signal,
      permissions: step.permissions.permissions,
      sandboxPolicy: step.permissions.sandboxPolicy,
    };

    let result: ToolResult;
    try {
      // P16-6: kill BEFORE the durable tool intent is persisted — all gates
      // (policy/hook/permission/approval/sandbox) passed but NOTHING is on
      // record; the call can be retried fresh on resume.
      await this.deps.failAt("tool.intent_persisting", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
      // P1-5: a kill here leaves the tool outcome unknown (reconciliation).
      await this.deps.failAt("tool.executing", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
      result = await this.deps.orchestrator.executeBound(
        {
          ...request,
          binding: frozenBinding,
          // P26-4: frozen step-world identity for the intent journal — the
          // crash-recovery can attribute an intent to the exact step/router.
          stepId: step.record.stepId,
          routerFingerprint: step.record.toolRouterFingerprint,
          toolBindingFingerprint: stableFingerprint([
            frozenBinding.name,
            frozenBinding.provenance,
            frozenBinding.semantics,
          ]),
        },
        execCtx,
      );
    } catch (err) {
      // P1-5: a simulated kill is not a tool failure to recover from.
      rethrowIfKill(err);
      if (signal.aborted) {
        // P2-37: a user interrupt while the tool is in-flight must surface as a
        // CANCELLED tool outcome, not a fabricated failure the model would then
        // react to. The turn itself is cancelled by the caller; the committed
        // side effects are reported separately, never rolled back.
        result = { status: "cancelled" };
      } else {
        result = {
          status: "failed",
          error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
        };
      }
    }
    await this.deps.hooks.afterTool(hookCtx, call, result);
    if (result.status === "failed" || result.status === "denied") {
      await this.deps.hooks.toolError(hookCtx, call, result);
    }
    if ((result.status === "failed" || result.status === "timeout") && this.deps.recovery !== undefined) {
      // plan.md Phase 3.6: auto-retry ONLY idempotent read-only tools
      // (retry: "safe"). Tools with unknown or non-idempotent effects are
      // never blindly re-executed — the failed result flows to the model,
      // which decides. Retries are bounded by RecoveryPolicy and honor its
      // per-kind delay. P19-3: the legacy branch emits the SAME typed
      // `recovery.decided` event as adaptive recovery (action names mapped to
      // the V3 taxonomy), so every recovery decision is observable uniformly.
      const retryPolicy = this.deps.toolSemanticsOf(call.name).retrySafety;
      for (let attempt = 1; ; attempt += 1) {
        const decision = this.deps.recovery.decide(result.status === "timeout" ? "timeout" : "tool_failure", attempt);
        await this.deps.emit(session.id, "recovery.decided", {
          action: decision.action === "retry" ? "retry_safe" : decision.action === "ask" ? "ask_user" : "fail_safe",
          input: result.status === "timeout" ? "timeout" : "tool_failure",
          toolCallId: call.id,
          tool: call.name,
          used: attempt - 1,
          remaining: Math.max(0, decision.maxAttempts - attempt),
          reason: decision.reason,
        }, turnId);
        if (decision.action === "retry") {
          if (retryPolicy !== "safe") break;
          if ((decision.retryDelayMs ?? 0) > 0) {
            await timerSleep(this.deps.timer, decision.retryDelayMs ?? 0);
          }
          try {
            result = await this.deps.orchestrator.executeBound({ ...request, binding: frozenBinding }, execCtx);
          } catch (err) {
            // P1-5: a simulated kill is not a tool failure to recover from.
            rethrowIfKill(err);
            result = {
              status: "failed",
              error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
            };
          }
          await this.deps.hooks.afterTool(hookCtx, call, result);
          continue;
        }
        if (decision.action === "ask") {
          const info = errorInfo("RESOURCE_LIMIT", `ask user: ${decision.reason}`);
          result = { status: "failed", error: info };
          await this.deps.hooks.toolError(hookCtx, call, result);
        }
        break;
      }
    } else if (
      (result.status === "failed" || result.status === "timeout") &&
      this.deps.adaptiveRecovery !== undefined
    ) {
      // P19-3: adaptive recovery over the CLOSED six-action taxonomy
      // (retry_safe / change_strategy / reconcile_unknown_effect / ask_user /
      // delegate_specialist / fail_safe). A non-idempotent tool is never
      // re-executed, so `retry_safe` is kept off its budget for this call;
      // the failed result still flows to the model at the end (the turn's
      // maxToolCalls / stall / iteration budgets bound the overall run).
      // Every decision is observable via `recovery.decided` — consumers never
      // branch on `reason` string text.
      const retryPolicy = this.deps.toolSemanticsOf(call.name).retrySafety;
      const planner =
        retryPolicy === "safe"
          ? this.deps.adaptiveRecovery
          : new AdaptiveRecoveryPlanner({ retry_safe: { budget: 0 } });
      for (;;) {
        const decision = planner.decide(
          result.status === "timeout" ? "timeout" : "tool_failure",
          turnState.recoveryUsage,
        );
        turnState.recoveryUsage[decision.action] = (turnState.recoveryUsage[decision.action] ?? 0) + 1;
        // P19-3: every recovery decision is observable — action, input, budget
        // position, and rationale — so recovery is auditable, never implicit.
        await this.deps.emit(session.id, "recovery.decided", {
          action: decision.action,
          input: decision.input,
          toolCallId: call.id,
          tool: call.name,
          used: decision.used,
          remaining: decision.remaining,
          reason: decision.reason,
        }, turnId);
        if (decision.action === "retry_safe") {
          if (retryPolicy !== "safe") break;
          try {
            result = await this.deps.orchestrator.executeBound({ ...request, binding: frozenBinding }, execCtx);
          } catch (err) {
            rethrowIfKill(err);
            result = {
              status: "failed",
              error: err instanceof AgentError ? err.info : errorInfo("INTERNAL_ERROR", String(err)),
            };
          }
          await this.deps.hooks.afterTool(hookCtx, call, result);
          continue;
        }
        // Self-heal actions: inject a bounded observation so the model changes
        // approach (vs. blindly retrying), then feed the failed result onward.
        // P3-9: delegate_specialist ACTUALLY delegates when the host wired a
        // specialist service (budget allows + task decomposable) instead of
        // only printing "try a different approach".
        if (decision.action === "change_strategy" || decision.action === "delegate_specialist") {
          let content: string;
          if (decision.action === "delegate_specialist" && this.deps.delegateSpecialist !== undefined) {
            let turn;
            try {
              turn = await this.deps.store.getTurn(turnId);
            } catch {
              turn = undefined;
            }
            try {
              const outcome = await this.deps.delegateSpecialist({
                sessionId: session.id,
                turnId,
                goal: turn?.input.text ?? "",
                tool: call.name,
                failure: decision.reason,
                signal: execCtx.signal,
              });
              content =
                outcome?.delegated === true
                  ? `[recovery:delegate_specialist] a specialist subagent is investigating "${call.name}" failure in isolation. ${outcome.summary ?? "Its findings will appear when it completes."}`
                  : `[recovery:delegate_specialist] specialist delegation unavailable (${outcome?.summary ?? "outside budget or scope"}); stop repeating "${call.name}" and try a different approach.`;
            } catch (cause) {
              content = `[recovery:delegate_specialist] specialist delegation failed (${cause instanceof Error ? cause.message : String(cause)}); stop repeating "${call.name}" and try a different approach.`;
            }
          } else {
            content =
              `[recovery:${decision.action}] "${call.name}" failed without a safe retry (${decision.reason}); ` +
              "stop repeating it and try a different approach.";
          }
          await this.deps.store.appendMessage({
            id: newMessageId(),
            sessionId: session.id,
            turnId,
            role: "system",
            content,
            createdAt: this.deps.now(),
          });
          break;
        }
        // P19-3: reconcile_unknown_effect — the call may have STARTED and
        // committed side effects whose outcome is unknown (timeout / ambiguous
        // failure). The runtime never re-executes it and never pretends: it
        // surfaces a typed reconciliation observation so the model/user
        // confirms the actual effect state before any next step.
        if (decision.action === "reconcile_unknown_effect") {
          await this.deps.store.appendMessage({
            id: newMessageId(),
            sessionId: session.id,
            turnId,
            role: "system",
            content:
              `[recovery:reconcile_unknown_effect] "${call.name}" may have taken effect but its outcome is unknown (${decision.reason}). ` +
              "Do NOT re-run it. Inspect the current state (files/processes/output) and reconcile what actually happened before continuing.",
            createdAt: this.deps.now(),
          });
          break;
        }
        // ask_user / fail_safe: cease auto-recovery here; the failed result is
        // surfaced to the model, and the turn's own budgets terminate it.
        break;
      }
    }
    // P1-20: every executed tool closes the loop with a duration (denied
    // calls already emitted tool.failed at their gate, no double emission).
    const durationMs = this.deps.now() - toolStartedAt;
    // P26-8: crash window #4 — the executor RETURNED (a side effect may have
    // committed) but the terminal outcome event has NOT been written yet. A
    // crash here leaves the effect on record but un-journaled.
    await this.deps.failAt("tool.effect_committed", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
    if (result.status === "success") {
      await this.deps.emit(session.id, "tool.completed", { toolCallId: call.id, tool: call.name, durationMs }, turnId, { spanId: call.id, parentSpanId: parentCallId });
    } else if (result.status === "failed" || result.status === "timeout") {
      // P2-37: a CANCELLED tool outcome (user interrupt during execution) is not
      // a tool failure — do not mislabel it as one. The turn's cancellation is
      // emitted separately by finishTurn.
      await this.deps.emit(session.id, "tool.failed", { toolCallId: call.id, tool: call.name, error: result.error, durationMs }, turnId);
    }
    return result;
  }
}
