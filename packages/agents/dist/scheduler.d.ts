import type { AgentId, SessionId, SessionStore, Timer } from "@ar/contracts";
import { type SchedulerLimits, type TreeBudget } from "@ar/contracts";
/**
 * P1-6 AgentExecutionScheduler — global scheduling of the whole agent tree
 * (beyond single-batch/invocation limits).
 *
 * Limits (SchedulerLimits):
 * - maxGlobalAgents: agents running anywhere at once.
 * - maxAgentsPerRoot: agents running under one root subtree at once.
 * - maxDepth: delegation depth ceiling for the tree (defense against
 *   exponential fan-out; depth measured from the root session).
 * - maxDurationMs: wall-clock budget per scheduled agent (subtree cancel).
 *
 * Semantics:
 * - Requests beyond the concurrency budgets QUEUE (FIFO across all roots),
 *   they do not auto-reject.
 * - A queued request whose caller aborts is cancelled before it ever starts
 *   (no session is created for it).
 * - `cancelSubtree(rootSessionId)` aborts every queued/running agent under
 *   that root — the cancellation tree.
 * - Token budgets (tokens/tool-calls) belong to P1-7 hierarchical budgeting
 *   and are intentionally NOT here; the scheduler only gates and times.
 */
export type SchedulerEntryState = "queued" | "running" | "done" | "cancelled";
export interface SchedulerEntry {
    id: number;
    rootSessionId: SessionId;
    parentSessionId: SessionId;
    agentId: AgentId;
    state: SchedulerEntryState;
    /** When the request entered the scheduler (queueing time). */
    enteredAt: number;
    startedAt?: number;
    finishedAt?: number;
    /** Cancellation handle for this scheduling unit (wall-clock, subtree). */
    signal: AbortSignal;
    /** P1-7: tool-call budget pre-reserved from the root tree pool for this
     *  agent (its allocation; the unused part returns on release). */
    allocation?: number;
    /** P0-11: token budget pre-reserved for this agent. */
    tokenAllocation?: number;
}
/** Granted scheduling slot: holds the entry until `release()` (the agent's
 *  turn finished). Aborting `signal` means this agent must stop. */
export interface SchedulerToken {
    entry: SchedulerEntry;
    signal: AbortSignal;
    /** Release the slot; report the tool calls the agent actually executed so
     *  the tree budget can account usage and refund unused allocation (P1-7). */
    release: (usedToolCalls?: number) => void;
    /** P0-11: report token usage from a model.completed for tree accounting. */
    reportUsage: (inputTokens: number, outputTokens: number) => void;
    /** Root session id for tree budget lookups. */
    rootSessionId: SessionId;
}
export interface SchedulerDeps {
    /** Session store used to resolve the root + depth of a parent session. */
    store: SessionStore;
    limits?: Partial<SchedulerLimits>;
    now?: () => number;
    /** P1-7: injectable timer for budget timeouts (deterministic tests). */
    timer?: Timer;
}
export declare class AgentExecutionScheduler {
    private readonly store;
    private readonly limits;
    private readonly now;
    private readonly timer;
    private readonly active;
    private readonly queued;
    private readonly controllers;
    private readonly gateResolvers;
    private readonly gateRejecters;
    private readonly rootAccounts;
    /** P3-10: session → root mapping for runtime-side usage reporting. */
    private readonly sessionRoots;
    private nextId;
    constructor(deps: SchedulerDeps);
    /** Observe: every queued/running entry (queued first, in enqueue order). */
    snapshot(): SchedulerEntry[];
    /** P1-7: register the tree budget for a root session. Duplicate registration
     *  is rejected — budgets are decided before any child is scheduled. */
    setRootBudget(rootSessionId: SessionId, budget: TreeBudget): void;
    /** P1-7: how many tool-call budget is left for new children of `root` after
     *  the root's own headroom. Useful for hosts/observability. */
    treeBudgetRemaining(rootSessionId: SessionId): {
        allocated: number;
        remaining: number;
    } | undefined;
    /** P0-11: remaining token budget for new children of `root` after headroom. */
    tokenBudgetRemaining(rootSessionId: SessionId): {
        allocated: number;
        remaining: number;
    } | undefined;
    /** Request a scheduling slot for an agent that will run under
     *  `parentSessionId` (its subtree root is the top ancestor). Resolves with a
     *  token once the concurrency budgets allow it; rejects when the request is
     *  cancelled while queued (caller abort → USER_CANCELLED) or the depth
     *  ceiling would be exceeded (RESOURCE_LIMIT — fail-closed, never starts). */
    acquire(req: {
        parentSessionId: SessionId;
        agentId: AgentId;
        toolBudget?: number;
        tokenBudget?: number;
    }, callerSignal: AbortSignal): Promise<SchedulerToken>;
    /** Abort every queued/running agent whose root subtree is `rootOrUnder`.
     *  Running agents see their token signal abort (the runtime cancels);
     *  queued agents reject with USER_CANCELLED before starting. */
    cancelSubtree(rootOrUnder: SessionId): void;
    private canStart;
    private start;
    /** P1-7: the first scheduled child of a root arms the tree wall-clock
     *  budget. Root keeps its headroom (completion/verification); the subtree
     *  is cancelled once the children budget (total × headroom share) elapses.
     *  The timer runs until the root budget is reached; entries cancelled by it
     *  are released by their owners as usual. */
    private startTreeClock;
    /** P0-11: report token usage from a model.completed for tree accounting. */
    reportUsage(rootSessionId: SessionId, inputTokens: number, outputTokens: number): void;
    /** P3-10: bind a child session to its root so runtime-side per-call usage
     *  (model.completed) reaches the tree account. The delegator binds after
     *  creating the child session and unbinds when the child turn ends. */
    bindSession(sessionId: SessionId, rootSessionId: SessionId): void;
    unbindSession(sessionId: SessionId): void;
    /** P3-10: report usage by session id (the runtime only knows the session).
     *  No binding → no accounting (parent sessions that never scheduled still
     *  draw from their own root when the host wired a root budget). */
    reportUsageBySession(sessionId: SessionId, inputTokens: number, outputTokens: number): void;
    private finish;
    /** P1-7: on release, refund the unused part of this entry's allocation and
     *  account its actual tool-call usage against the root tree pool. A child
     *  can never spend outside its allocation (pre-deducted), and unused budget
     *  flows back to the pool. P0-11: same for token budget. */
    private settleTreeBudget;
    private rootAccountFor;
    /** Lazily materialize the SchedulerLimits-level default tree budget. */
    private accountFromDefaultBudget;
    /** Abort one scheduling unit. Running → signal aborts (turn cancels);
     *  queued → its gate rejects, so no session is ever created for it. */
    private cancelEntry;
    private cleanupGate;
    /** After a slot frees, start queued entries FIFO while any can start. A
     *  just-started entry consumes a global slot until its own finish, so a
     *  single front-to-back pass suffices. */
    private drain;
    private dequeue;
    private reject;
    /** Walk parentId links to the root; returns the root id and the parent
     *  session's depth (its number of ancestors). A child of `sessionId` sits
     *  at depth+1. */
    private treeOf;
}
//# sourceMappingURL=scheduler.d.ts.map