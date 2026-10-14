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

/**
 * R3/F4 — the campaign-deadline refusal reason code, mirrored from `@ar/tools`
 * (`CAMPAIGN_DEADLINE_EXCEEDED`). `@ar/core` must not depend on `@ar/tools`, so the
 * literal is duplicated deliberately; a unit test pins the two together.
 */
const CAMPAIGN_DEADLINE_EXCEEDED = "CAMPAIGN_DEADLINE_EXCEEDED";

/**
 * M8 / DEFECT-2 — map an orchestrator denial CODE onto the security event that
 * classifies it. The event TYPE is what
 * `packages/evaluation/src/security-evidence-execution.ts` groups on
 * (`security.*_denied`), so the dimension must be recoverable from the code
 * alone — the runtime is the last layer that still knows the code before the
 * result is rendered to the model.
 *
 * Codes the orchestrator ALREADY reports itself (`PERMISSION_DENIED` from the
 * permission engine; `SANDBOX_{NETWORK,FILESYSTEM,PROCESS}_DENIED` from the
 * sandbox gate — see `packages/tools/src/orchestrator.ts:554/562/570/702`) are
 * listed as OWNED BY A LOWER LAYER: emitting again here would fabricate a
 * SECOND security fact for one refusal, double-counting it in the evidence
 * stream. They are deliberately absent from the emitted map below and are
 * instead recognised in `ORCHESTRATOR_SELF_REPORTED_DENIAL_CODES`.
 */
const DENIAL_CODE_TO_SECURITY_EVENT = {
  // Filesystem-class refusals the runtime must surface (the tool/orchestrator
  // returns `denied` WITHOUT a security event on these paths).
  WRITE_SAFETY_DENIED: "security.filesystem_denied",
  FILESYSTEM_DENIED: "security.filesystem_denied",
  WORKSPACE_POLICY: "security.filesystem_denied",
  // Process-class.
  SANDBOX_BACKEND_DENIED: "security.process_denied",
  PROCESS_DENIED: "security.process_denied",
  // Capability / identity escalation.
  SECURITY_DENIED: "security.capability_denied",
  CAPABILITY_DENIED: "security.capability_denied",
  TOOL_NOT_IN_STEP: "security.capability_denied",
  // Untrusted-content / external-surface refusals.
  INJECTION_DENIED: "security.injection_denied",
  MCP_DENIED: "security.mcp_denied",
  SKILL_DENIED: "security.skill_denied",
  MEMORY_DENIED: "security.memory_denied",
} as const satisfies Record<string, AgentEvent["type"]>;

/** Denial codes a LOWER layer already journals as `security.*_denied` itself.
 *  The runtime must not emit a second event for the same refusal. */
const ORCHESTRATOR_SELF_REPORTED_DENIAL_CODES: ReadonlySet<string> = new Set([
  "PERMISSION_DENIED",
  "SANDBOX_NETWORK_DENIED",
  "SANDBOX_FILESYSTEM_DENIED",
  "SANDBOX_PROCESS_DENIED",
  "SANDBOX_DENIED",
]);

/** Fail-closed fallback classification for a `denied` result whose code is not
 *  in the map above. INTENTIONALLY fail-closed: an unrecognised refusal is
 *  still a refusal, so it must appear on the security stream as a permission
 *  denial carrying `unmapped_code` — never be dropped. */
const UNMAPPED_DENIAL_EVENT: AgentEvent["type"] = "security.permission_denied";

/** Q-1: one executed tool call as returned to the turn loop. `streak` is the
 *  consecutive-identical-call count AFTER this call was recorded.
 *  E4-R86 (H2): `progressCancelled`/`wouldBeStreak` are set when this repeated
 *  call+args produced a DIFFERENT result fingerprint — observable progress that
 *  cancelled the identical-call streak instead of advancing it. */
export interface ExecutedToolCall {
  call: ToolCall;
  result: ToolResult;
  streak: number;
  progressCancelled?: boolean;
  wouldBeStreak?: number;
  /** P2-41/PROTOCOL: adaptive-recovery observations produced while this call
   *  executed. They are `role:"system"` messages and MUST NOT be persisted
   *  before the batch's `tool` results are durable — the wire protocol requires
   *  an assistant message carrying `tool_calls` to be followed IMMEDIATELY by
   *  one `tool` message per `tool_call_id`. The runtime appends them once the
   *  whole block is durable (see AgentRuntime.handleToolResults). */
  deferredObservations?: string[];
}

/** P2-41/PROTOCOL: one settled call from a parallel read batch, carrying the
 *  observations produced during its execution so the caller can persist them
 *  only AFTER the batch's tool results are durable. */
export interface SettledToolCall {
  call: ToolCall;
  result: ToolResult;
  deferredObservations?: string[];
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
  /**
   * R3/F4 — the campaign's SINGLE wall-clock deadline (epoch ms, read through
   * `now`). Checked before EVERY dispatch this controller makes, including each
   * recovery retry, so a hung tool cannot be re-dispatched after the deadline. The
   * orchestrator enforces the same deadline at the real dispatch point this
   * controller calls; this gate makes the guarantee explicit at the controller's
   * own retry boundary (and works even when the host wired no tool budget).
   * Absent or returning `null` = no campaign deadline.
   */
  dispatchDeadlineAtMs?: () => number | null;
  /** E4-R87 (Phase A): when `false`, `noteExecutedCall` passes NO result
   *  fingerprint to `AgentState.noteToolCall` — the pre-R86 name+args-only
   *  streak contract (byte-identical to source SHA e9776ba). Default/absent =
   *  true (R86 result-aware behavior). Replay-only; no existing caller opts
   *  out. */
  streakResultAware?: boolean;
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
   * P2-41/PROTOCOL: buffer an adaptive-recovery observation instead of
   * persisting it now.
   *
   * The observation is a `role:"system"` message. Persisting it during tool
   * EXECUTION would place it between the assistant message carrying
   * `tool_calls` and the `tool` results that `handleToolResults` persists
   * afterwards:
   *
   *   assistant(tool_calls) -> system(recovery) -> tool(result)
   *
   * A strict OpenAI-compatible upstream rejects that ordering with HTTP 400
   * ("An assistant message with 'tool_calls' must be followed by tool messages
   * responding to each 'tool_call_id'"). The observation is therefore collected
   * per call and appended by the runtime once the whole tool block is durable.
   *
   * The collector is REQUIRED (every in-class call site supplies a per-call
   * array) so an observation can never be silently dropped or persisted in the
   * wrong position.
   */
  private deferObservation(collector: string[], content: string): void {
    collector.push(content);
  }

  /**
   * M8 / DEFECT-2 — journal an orchestrator-returned denial as a `security.*_denied`
   * event so the security evidence stream cannot show a refusal as "clean".
   *
   * DEDUPLICATION: the runtime-side gates emit their own events (step tool
   * policy / hook block / hook identity swap) and the `@ar/tools` orchestrator
   * journals `PERMISSION_DENIED` + `SANDBOX_*` itself on its own gates. This
   * method is reached ONLY for a `denied` RESULT (i.e. the call went through the
   * orchestrator and came back refused), and it skips codes a lower layer
   * already owns — so exactly ONE security fact is produced per refusal.
   */
  private async emitOrchestratorDenial(
    sessionId: SessionId,
    turnId: TurnId,
    call: ToolCall,
    result: ToolResult,
  ): Promise<void> {
    // A denial with NO code at all is still a denial: it must NOT be treated as
    // a lower-layer-owned `PERMISSION_DENIED` (that would silently drop it —
    // the exact fail-open behavior this fix removes). Only a code that really
    // IS one of the self-reported ones is skipped.
    const rawCode = result.error?.code;
    if (rawCode !== undefined && ORCHESTRATOR_SELF_REPORTED_DENIAL_CODES.has(rawCode)) return;
    const mapped = rawCode === undefined
      ? undefined
      : (DENIAL_CODE_TO_SECURITY_EVENT as Record<string, AgentEvent["type"]>)[rawCode];
    // Fail-closed: an unidentified / absent refusal code still produces a fact.
    const eventType = mapped ?? UNMAPPED_DENIAL_EVENT;
    await this.deps.emit(sessionId, eventType, {
      toolCallId: call.id,
      tool: call.name,
      target: call.name,
      reason: result.error?.message ?? "denied by the tool orchestrator (no error code supplied)",
      source: "orchestrator",
      code: rawCode ?? UNMAPPED_DENIAL_EVENT,
      // Classifiable dimension: consumers group on the event type, but the raw
      // code and whether it was recognised stay auditable on the event.
      ...(mapped === undefined ? { unmapped_code: true } : {}),
    }, turnId);
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
            ...this.noteExecutedCall(state, pending, {
              status: "cancelled",
              error: errorInfo("USER_CANCELLED", "turn aborted before this tool call started"),
            }),
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
        for (const { call: c, result, deferredObservations } of settled) {
          executed.push({
            call: c,
            result,
            ...this.noteExecutedCall(state, c, result),
            ...(deferredObservations !== undefined && deferredObservations.length > 0
              ? { deferredObservations }
              : {}),
          });
          this.recordStallTrace(state, c, result);
        }
        i = j;
      } else {
        state.transition("tool_pending");
        // P2-41/PROTOCOL: observations produced during execution are collected
        // here and persisted by the caller AFTER this batch's tool results.
        const observations: string[] = [];
        const result = await this.executeToolCall(ctx, call, turnState, step, parentCallId, observations);
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
            ...this.noteExecutedCall(state, call, result),
            ...(observations.length > 0 ? { deferredObservations: observations } : {}),
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
              ...this.noteExecutedCall(state, pending, {
                status: "cancelled",
                error: errorInfo("USER_CANCELLED", "turn aborted before this tool call started"),
              }),
            });
          }
          break;
        }
        executed.push({
          call,
          result,
          ...this.noteExecutedCall(state, call, result),
          ...(observations.length > 0 ? { deferredObservations: observations } : {}),
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
  ): Promise<SettledToolCall[]> {
    const { signal } = ctx;
    if (signal.aborted || batch.length === 0) return [];
    return new Promise<SettledToolCall[]>((resolve, reject) => {
      const results: Array<SettledToolCall | undefined> = new Array(batch.length);
      // P2-41/PROTOCOL: one collector PER CALL so a parallel batch cannot
      // interleave observations by completion order; the caller flushes them in
      // call order once every tool result is durable.
      const observationsByIdx: string[][] = batch.map(() => []);
      // P18-5: per-call settlement promises — the abort path needs them to
      // WAIT for non-cancellable in-flight calls instead of lying about them.
      const settlePromises: Array<Promise<void> | undefined> = new Array(batch.length);
      let remaining = batch.length;
      let done = false;
      const finish = (arr: SettledToolCall[]) => {
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
        const immediate: SettledToolCall[] = [];
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
              ...(observationsByIdx[i]!.length > 0
                ? { deferredObservations: observationsByIdx[i]! }
                : {}),
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
        const promise = this.executeToolCall(ctx, c, turnState, step, parentCallId, observationsByIdx[idx]!);
        // P18-5: the settle signal ALWAYS resolves (the rejection is already
        // recorded into results by the catch below — the abort wait path only
        // needs to know WHEN settlement happened, never to see the error).
        settlePromises[idx] = promise.then(
          () => undefined,
          () => undefined,
        );
        promise
          .then((result) => {
            results[idx] = {
              call: c,
              result,
              ...(observationsByIdx[idx]!.length > 0
                ? { deferredObservations: observationsByIdx[idx]! }
                : {}),
            };
            remaining -= 1;
            if (remaining === 0 && !done) {
              finish(results.filter((r): r is SettledToolCall => r !== undefined));
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
              finish(results.filter((r): r is SettledToolCall => r !== undefined));
            }
          });
      });
    });
  }

  /** E4-R86 (H2): the RESULT fingerprint that keys the identical-call streak.
   *  Based on normalized result STATUS + redacted output/error code (never raw
   *  content), matching the plan §R86.2 requirement that a stall fingerprint
   *  cover "tool name, redacted args, result status". A status change (success
   *  → failure) or an output change both break the streak — each is feedback
   *  the model can act on. The pattern-window fingerprint in `recordStallTrace`
   *  is output-only by design (its classifier distinguishes errorCode
   *  separately); the streak is intentionally at least as discriminating. */
  private resultFingerprintOf(result: ToolResult): string {
    if (result.status === "success") {
      return computeArgsHash({ status: result.status, output: result.output ?? "" });
    }
    if (result.status === "failed" && result.error !== undefined) {
      return computeArgsHash({ status: result.status, errorCode: result.error.code });
    }
    return computeArgsHash({ status: result.status });
  }

  /** E4-R86 (H2): note one executed call into the identical-call streak,
   *  result-aware. Returns the streak plus the observability flags: when the
   *  SAME call+args produced a DIFFERENT result, `progressCancelled` is set and
   *  `wouldBeStreak` is what the streak would have been without the cancel. */
  private noteExecutedCall(
    state: AgentState,
    call: ToolCall,
    result: ToolResult,
  ): { streak: number; progressCancelled?: boolean; wouldBeStreak?: number } {
    const streak =
      this.deps.streakResultAware === false
        ? state.noteToolCall(call.name, call.args)
        : state.noteToolCall(call.name, call.args, this.resultFingerprintOf(result));
    if (state.lastCallCancelledStreak) {
      return { streak, progressCancelled: true, wouldBeStreak: state.lastCallWouldBeStreak };
    }
    return { streak };
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
    /** P2-41/PROTOCOL: per-call collector for adaptive-recovery observations.
     *  REQUIRED so an observation can never be persisted inside the tool block
     *  (see `deferObservation`). */
    deferredObservations: string[] = [],
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
    // R3/F4 — the SINGLE campaign deadline, read through the injected clock. This
    // mirrors the orchestrator's own gate; the controller needs its own because it
    // is the layer that RE-DISPATCHES on recovery, and a hung tool must not be
    // restarted after the deadline even when no tool budget was wired.
    // (The literal mirrors `CAMPAIGN_DEADLINE_EXCEEDED` in `@ar/tools`; `@ar/core`
    // must not depend on `@ar/tools`, so it is not imported.)
    const campaignDeadlineExpired = (): boolean => {
      const at = this.deps.dispatchDeadlineAtMs?.() ?? null;
      return at !== null && this.deps.now() >= at;
    };
    // A dispatch refused by the deadline: nothing ran, so it is an explicit
    // pre-dispatch refusal — never `unknown`, and never presented as a cancellation.
    const deadlineRefusal = (): ToolResult => ({
      status: "failed",
      error: errorInfo("RESOURCE_LIMIT", `${CAMPAIGN_DEADLINE_EXCEEDED}: the campaign deadline passed before this tool could start`),
      metadata: { reasonCode: CAMPAIGN_DEADLINE_EXCEEDED, preDispatch: true },
    });
    let deadlineRefused = false;
    try {
      // P16-6: kill BEFORE the durable tool intent is persisted — all gates
      // (policy/hook/permission/approval/sandbox) passed but NOTHING is on
      // record; the call can be retried fresh on resume.
      await this.deps.failAt("tool.intent_persisting", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
      // P1-5: a kill here leaves the tool outcome unknown (reconciliation).
      await this.deps.failAt("tool.executing", { sessionId: session.id, turnId, toolCallId: call.id, tool: call.name });
      // R3/F4 — THE DEADLINE GATE. After the campaign deadline no new tool starts.
      if (campaignDeadlineExpired()) {
        deadlineRefused = true;
        result = deadlineRefusal();
      } else {
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
      }
    } catch (err) {
      // P1-5: a simulated kill is not a tool failure to recover from.
      rethrowIfKill(err);
      if (signal.aborted) {
        // P2-37: a user interrupt while the tool is in-flight must surface as a
        // CANCELLED tool outcome, not a fabricated failure the model would then
        // react to. The turn itself is cancelled by the caller; the committed
        // side effects are reported separately, never rolled back.
        //
        // R3/F4 — for a tool that MAY have had a side effect, "cancelled" must not
        // be read as "nothing happened": the side-effect outcome is UNKNOWN, and it
        // is labelled as such (the durable tool budget records the same fact as
        // `unknown`, charged and never refunded).
        const semantics = this.deps.toolSemanticsOf(call.name);
        result =
          semantics.sideEffectScope !== "none"
            ? {
                status: "cancelled",
                metadata: { reasonCode: "POST_CANCEL_UNKNOWN_EFFECT", sideEffectOutcome: "unknown" },
              }
            : { status: "cancelled" };
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
    // M8 / DEFECT-2 — a denial returned by the ORCHESTRATOR must be visible on
    // the security evidence stream. The three runtime-side gates above
    // (step tool policy, hook block, hook tool-identity swap) emit their own
    // `security.*_denied` events; this branch is the fourth source and used to
    // emit NOTHING, so a refusal produced by the real permission engine /
    // sandbox / write-safety guard left no `security.*_denied` fact behind.
    // `packages/evaluation/src/security-evidence-execution.ts` builds
    // POLICY_DENIED from exactly those events, so such a denial read as
    // "clean" — a fail-OPEN direction bug on the evidence trail.
    if (result.status === "denied") {
      await this.emitOrchestratorDenial(session.id, turnId, call, result);
    }
    if (!deadlineRefused && (result.status === "failed" || result.status === "timeout") && this.deps.recovery !== undefined) {
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
        // M5 / DEFECT-1 — the trace must not lie. The recovery policy may
        // DECIDE to retry while the safety gate (retrySafety) refuses to
        // re-dispatch. Announcing that as `retry_safe` made the journal claim a
        // retry that never happened, so a reviewer could not tell "retried"
        // from "refused to retry". The action is therefore resolved BEFORE
        // emitting, and `retry_safe` is reserved for a retry that is actually
        // about to be dispatched. The refused case reports `retry_refused`
        // with the reason the escalation was declined.
        //
        // `retry_refused` is a value of the OPEN `RecoveryDecidedPayload.action`
        // field (typed `string` in @ar/contracts/event-payloads.ts) — it is NOT
        // a new member of the closed V3 planner taxonomy `RecoveryAction`
        // (packages/contracts/src/recovery.ts), which describes the ADAPTIVE
        // planner's budgeted vocabulary, not the legacy ladder's audit trail.
        // No contract/schema change is required; EVENT_TYPES is unchanged.
        const willDispatchRetry = decision.action === "retry" && retryPolicy === "safe";
        const reportedAction =
          decision.action === "retry"
            ? willDispatchRetry
              ? "retry_safe"
              : "retry_refused"
            : decision.action === "ask"
              ? "ask_user"
              : "fail_safe";
        await this.deps.emit(session.id, "recovery.decided", {
          action: reportedAction,
          input: result.status === "timeout" ? "timeout" : "tool_failure",
          toolCallId: call.id,
          tool: call.name,
          used: attempt - 1,
          remaining: Math.max(0, decision.maxAttempts - attempt),
          reason: willDispatchRetry
            ? decision.reason
            : decision.action === "retry"
              ? `${decision.reason} — NOT re-dispatched: retrySafety="${retryPolicy}" is not "safe"`
              : decision.reason,
        }, turnId);
        if (decision.action === "retry") {
          if (retryPolicy !== "safe") break;
          if ((decision.retryDelayMs ?? 0) > 0) {
            await timerSleep(this.deps.timer, decision.retryDelayMs ?? 0);
          }
          // R3/F4 — a retry is a NEW dispatch: it must not start after the deadline.
          if (campaignDeadlineExpired()) {
            result = deadlineRefusal();
            break;
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
      !deadlineRefused &&
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
          // R3/F4 — a retry is a NEW dispatch: it must not start after the deadline.
          if (campaignDeadlineExpired()) {
            result = deadlineRefusal();
            break;
          }
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
          this.deferObservation(deferredObservations, content);
          break;
        }
        // P19-3: reconcile_unknown_effect — the call may have STARTED and
        // committed side effects whose outcome is unknown (timeout / ambiguous
        // failure). The runtime never re-executes it and never pretends: it
        // surfaces a typed reconciliation observation so the model/user
        // confirms the actual effect state before any next step.
        if (decision.action === "reconcile_unknown_effect") {
          this.deferObservation(
            deferredObservations,
            `[recovery:reconcile_unknown_effect] "${call.name}" may have taken effect but its outcome is unknown (${decision.reason}). ` +
              "Do NOT re-run it. Inspect the current state (files/processes/output) and reconcile what actually happened before continuing.",
          );
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
