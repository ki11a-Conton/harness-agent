import type { AgentId, DelegationLimits, EventStore, SessionId, SessionStore, Timer, ToolPolicy } from "@ar/contracts";
import { AgentError } from "@ar/contracts";
import type { AgentRuntime } from "@ar/core";
import type { DelegationRequest, DelegationResult } from "./delegation.js";
import { AgentExecutionScheduler } from "./scheduler.js";
import type { ChildWorkspaceManager } from "./workspace-isolation.js";
export interface DelegatorDeps {
    runtime: AgentRuntime;
    /** Session store used to read the parent session and enforce INV-009 bounds. */
    store: SessionStore;
    /** Default agent for child sessions when DelegationRequest.agentId is absent. */
    agentId: AgentId;
    limits?: Partial<DelegationLimits>;
    /** Event store for subagent.* events. AgentRuntime does not expose its
     *  EventStore, so delegation events are emitted through this dependency. */
    events?: EventStore;
    /** P1-6: global scheduler. When set, every delegation acquires a scheduling
     *  slot before its child session is created (queueing/fairness/global
     *  concurrency/depth/wall-clock) and releases it when the child turn ends. */
    scheduler?: AgentExecutionScheduler;
    now?: () => number;
    /** P1-7: injectable timer for delegation timeouts (deterministic tests). */
    timer?: Timer;
    /** P3-4: child workspace isolation. When set, `writable:true` delegations
     *  run the child in an isolated copy and return a workspacePatch (P3-5);
     *  without it, writable delegations are denied (P14-3 fail-closed). */
    workspaceManager?: ChildWorkspaceManager;
    /** P14-3: test-only escape hatch — when true, writable delegations without
     *  a workspaceManager fall back to the shared parent root (same as the
     *  pre-P14-3 behavior). NEVER set in production config; only useful for
     *  tests that do not care about workspace isolation. */
    testOnlyUnsafeSharedWorkspace?: boolean;
    /** P3-6: called when a child's isolated workspace root is created, so the
     *  host can admit that root into the child session's sandbox (the child
     *  must be able to write its own workspace). */
    onChildWorkspace?: (childSessionId: SessionId, root: string) => void;
    /** P3-6: called when the child's isolated workspace is disposed, so the
     *  host can remove the root from the sandbox allow-list. */
    onChildWorkspaceDisposed?: (childSessionId: SessionId) => void;
}
/**
 * SUBAGENT-001: spawns an isolated child session (INV-005) under the bounded
 * recursion guarantees of INV-009, then returns a structured result (§57).
 *
 * Pre-flight rejections (unknown parent/agent, limits breached) throw an
 * AgentError: no child session exists yet, so no DelegationResult can be
 * produced. Once the child session exists, failures return a structured
 * DelegationResult with a real childSessionId.
 */
export declare class Delegator {
    private readonly runtime;
    private readonly store;
    private readonly agentId;
    private readonly limits;
    private readonly events?;
    private readonly scheduler?;
    private readonly now;
    private readonly timer;
    private readonly workspaceManager?;
    private readonly testOnlyUnsafeSharedWorkspace;
    private readonly onChildWorkspace?;
    private readonly onChildWorkspaceDisposed?;
    constructor(deps: DelegatorDeps);
    delegate(req: DelegationRequest, signal: AbortSignal): Promise<DelegationResult>;
    private requireSession;
    /** INV-009: reject before creating any child when recursion bounds are hit.
     *  P3-3: the historical `maxChildren` is the backward-compatible alias of
     *  `maxChildrenTotal`; `maxActiveChildren` additionally caps concurrent
     *  ACTIVE children (running/waiting turns) — completed children never
     *  occupy an active slot, so a long-lived parent is never permanently
     *  exhausted by its own history. */
    private enforceBounds;
    /** P3-3: a child is ACTIVE while its latest turn is still running or
     *  waiting (for user/approval); a session with no turn yet (just created,
     *  delegation about to start it) counts as active too. Sessions whose
     *  latest turn reached a terminal state are done and free their slot. */
    private countActiveChildren;
    private boundError;
    private depthOf;
    /** INV-005: the child carries only the injected context — never parent history.
     *  P0-8: low-trust blocks (untrusted/semi-trusted) are scanned for prompt
     *  injection before being seeded into the child; a hit is dropped and
     *  reported through the security event store when one is configured. */
    private seedContext;
    private settleToResult;
    /** Summary from the final assistant message; falls back to the outcome. */
    private summarize;
    /** Evidence from verification-gate events and persisted tool results. */
    private collectEvidence;
    /** Path-like tokens extracted from tool outputs. */
    private collectArtifacts;
    /** P1-8: verification-gate events of the child, with their stable refs. */
    private collectVerificationEvents;
    /** P1-8: the child's final answer, verbatim from the final assistant
     *  message (truncated). Not a paraphrase: the parent can quote it. */
    private answerOf;
    /** P1-8: findings are derived from the child's verification-gate events —
     *  claim + stable event refs + confidence. No verification, no fabricated
     *  findings. */
    private collectFindings;
    /** P1-8: real changed artifacts — the working state is the authoritative
     *  source; each path is linked to the tool result message that produced it
     *  so the parent can open the original result. */
    private collectChangedArtifacts;
    /** P1-8: tests/verification the child ran — test commands from the working
     *  state (linked to their tool result messages) plus verification-gate
     *  events (stable event refs). */
    private collectTestRuns;
    /** P1-8: blockers — observed working-state failures, verification failures
     *  and the turn error (when present). */
    private collectBlockers;
    private emitFinished;
    private emit;
}
/** P14-3: writable delegation requires a ChildWorkspaceManager — fail-closed.
 *  No implicit shared-write fallback exists in production; the only escape
 *  hatch is the explicitly test-only `testOnlyUnsafeSharedWorkspace` flag.
 *  Returns the typed SECURITY_DENIED error when isolation is unavailable. */
export declare function writableIsolationError(deps: {
    workspaceManager: ChildWorkspaceManager | undefined;
    testOnlyUnsafeSharedWorkspace: boolean;
}): AgentError | undefined;
/** §54: the child's effective tool policy is the agent's policy restricted by
 *  the delegation request — allow-lists intersect, deny-lists union. */
export declare function restrictToolPolicy(base: ToolPolicy, restrict: ToolPolicy): ToolPolicy;
//# sourceMappingURL=delegator.d.ts.map