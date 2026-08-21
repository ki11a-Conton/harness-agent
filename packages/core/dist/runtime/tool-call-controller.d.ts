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
import { AdaptiveRecoveryPlanner } from "@ar/contracts";
import type { AgentEvent, RecoveryAction, SandboxPolicy, SessionId, SessionStore, Timer, ToolCall, ToolCapability, ToolOrchestrator, ToolResult, TurnId } from "@ar/contracts";
import { AgentState } from "../state/agent-state.js";
import { HookRegistry } from "../lifecycle/hooks.js";
import type { RecoveryPolicy } from "../recovery/recovery.js";
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
 *  `recoveryUsage` is the single shared mutable object. */
export interface ToolCallControllerDeps {
    /** Tool side-effect executor (permission/sandbox enforced inside). */
    orchestrator: ToolOrchestrator;
    /** Session store — used to append adaptive-recovery observations. */
    store: SessionStore;
    /** Lifecycle hooks (beforeTool / afterTool / toolError). */
    hooks: HookRegistry;
    /** Event sink — the runtime's emit (sequence allocation + timestamp). */
    emit: (sessionId: SessionId, type: AgentEvent["type"], payload: Record<string, unknown>, turnId?: TurnId, spans?: {
        spanId?: string;
        parentSpanId?: string;
    }) => Promise<AgentEvent>;
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
    /** Shared mutable recovery-action budget counters (owned by AgentRuntime). */
    recoveryUsage: Partial<Record<RecoveryAction, number>>;
    /** Capability lookup for concurrency + retry gating. */
    toolCapabilityOf: (toolName: string) => ToolCapability;
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
    }) => Promise<{
        delegated: boolean;
        summary?: string;
    } | undefined>;
}
export declare class ToolCallController {
    private readonly deps;
    constructor(deps: ToolCallControllerDeps);
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
    executeToolCalls(ctx: TurnContext, state: AgentState, calls: ToolCall[], 
    /** P9-1: the model call that requested these tool calls (parent span). */
    parentCallId?: string): Promise<ExecutedToolCall[]>;
    /**
     * P2-37: run a batch of concurrency-safe (read-only) tool calls in parallel,
     * but resolve as soon as the user `signal` aborts so an interrupt is honored
     * promptly instead of waiting for every in-flight read. Rejects on a P1-5
     * kill so fault injection still propagates. Settled results are returned in
     * call order.
     */
    runReadBatch(ctx: TurnContext, batch: ToolCall[], parentCallId?: string): Promise<Array<{
        call: ToolCall;
        result: ToolResult;
    }>>;
    /** P2-41: record one executed tool call into the turn's stall window. The
     *  arguments key and result fingerprint let the pure classifier distinguish a
     *  genuine stall (same call + same result) from progress (same call, NEW
     *  result). */
    private recordStallTrace;
    executeToolCall(ctx: TurnContext, call: ToolCall, parentCallId?: string): Promise<ToolResult>;
}
//# sourceMappingURL=tool-call-controller.d.ts.map