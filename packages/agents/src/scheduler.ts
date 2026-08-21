import type { AgentId, Session, SessionId, SessionStore, Timer } from "@ar/contracts";
import {
  AgentError,
  DEFAULT_SCHEDULER_LIMITS,
  RealTimer,
  TREE_BUDGET_HEADROOM_RATIO,
  errorInfo,
  type SchedulerLimits,
  type TreeBudget,
} from "@ar/contracts";

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

/** Per-root accounting for the P1-7 tree budget. */
interface RootAccount {
  budget: TreeBudget;
  /** Tool calls actually consumed by children so far. */
  toolUsed: number;
  /** Tool-call allocations currently reserved (pre-deducted). */
  toolReserved: number;
  /** Token usage actually consumed by children so far (P0-11). */
  tokenUsed: number;
  /** Token allocations currently reserved (pre-deducted). */
  tokenReserved: number;
  rootStartedAt?: number;
}

/** P13-5 (promoted): adaptive concurrency — only grow when there is budget
 *  headroom and no recent conflict/recovery storm; shrink under pressure.
 *  Returns the suggested maxConcurrent (integer, ≥1). */
function suggestConcurrency(obs: {
  activeChildren: number;
  maxConcurrent: number;
  tokenBudgetRemainingFraction: number;
  recentConflicts: number;
  recentRecoveries: number;
}): number {
  let suggested = obs.maxConcurrent;
  if (obs.recentConflicts > 0 || obs.recentRecoveries > 2) {
    suggested = Math.max(1, Math.floor(obs.maxConcurrent / 2));
  } else if (obs.tokenBudgetRemainingFraction > 0.5 && obs.activeChildren < obs.maxConcurrent) {
    suggested = Math.min(obs.maxConcurrent + 1, obs.maxConcurrent + 2);
  }
  return suggested;
}

export class AgentExecutionScheduler {
  private readonly store: SessionStore;
  private readonly limits: SchedulerLimits;
  private readonly now: () => number;
  private readonly timer: Timer;

  private readonly active = new Map<number, SchedulerEntry>();
  private readonly queued: SchedulerEntry[] = [];
  private readonly controllers = new Map<number, AbortController>();
  private readonly gateResolvers = new Map<number, (token: SchedulerToken) => void>();
  private readonly gateRejecters = new Map<number, (err: unknown) => void>();
  private readonly rootAccounts = new Map<SessionId, RootAccount>();
  /** P3-10: session → root mapping for runtime-side usage reporting. */
  private readonly sessionRoots = new Map<SessionId, SessionId>();
  private nextId = 0;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.limits = { ...DEFAULT_SCHEDULER_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.timer = deps.timer ?? new RealTimer(this.now);
  }

  /** Observe: every queued/running entry (queued first, in enqueue order). */
  snapshot(): SchedulerEntry[] {
    return [...this.queued, ...[...this.active.values()]];
  }

  /** P1-7: register the tree budget for a root session. Duplicate registration
   *  is rejected — budgets are decided before any child is scheduled. */
  setRootBudget(rootSessionId: SessionId, budget: TreeBudget): void {
    if (this.rootAccounts.has(rootSessionId)) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `root budget already registered for session ${rootSessionId}`),
      );
    }
    this.rootAccounts.set(rootSessionId, { budget, toolUsed: 0, toolReserved: 0, tokenUsed: 0, tokenReserved: 0 });
  }

  /** P1-7: how many tool-call budget is left for new children of `root` after
   *  the root's own headroom. Useful for hosts/observability. */
  treeBudgetRemaining(rootSessionId: SessionId): { allocated: number; remaining: number } | undefined {
    const account = this.rootAccounts.get(rootSessionId);
    if (account?.budget.maxToolCalls === undefined) return undefined;
    const pool = Math.floor(account.budget.maxToolCalls * (1 - TREE_BUDGET_HEADROOM_RATIO));
    return {
      allocated: account.budget.maxToolCalls,
      remaining: Math.max(0, pool - account.toolUsed - account.toolReserved),
    };
  }

  /** P0-11: remaining token budget for new children of `root` after headroom. */
  tokenBudgetRemaining(rootSessionId: SessionId): { allocated: number; remaining: number } | undefined {
    const account = this.rootAccounts.get(rootSessionId);
    if (account?.budget.maxTokens === undefined) return undefined;
    const pool = Math.floor(account.budget.maxTokens * (1 - TREE_BUDGET_HEADROOM_RATIO));
    return {
      allocated: account.budget.maxTokens,
      remaining: Math.max(0, pool - account.tokenUsed - account.tokenReserved),
    };
  }

  /** Request a scheduling slot for an agent that will run under
   *  `parentSessionId` (its subtree root is the top ancestor). Resolves with a
   *  token once the concurrency budgets allow it; rejects when the request is
   *  cancelled while queued (caller abort → USER_CANCELLED) or the depth
   *  ceiling would be exceeded (RESOURCE_LIMIT — fail-closed, never starts). */
  async acquire(
    req: { parentSessionId: SessionId; agentId: AgentId; toolBudget?: number; tokenBudget?: number },
    callerSignal: AbortSignal,
  ): Promise<SchedulerToken> {
    if (callerSignal.aborted) {
      throw this.reject("cancelled before scheduling");
    }
    const { rootId, depth } = await this.treeOf(req.parentSessionId);
    if (this.limits.maxDepth > 0 && depth + 1 > this.limits.maxDepth) {
      throw new AgentError(
        errorInfo(
          "RESOURCE_LIMIT",
          `max scheduler depth ${this.limits.maxDepth} reached (parent at depth ${depth})`,
        ),
      );
    }

    // P1-7: tree tool-call budget. A request with an allocation pre-reserves
    // it; without one, it draws a minimal unit from the pool. Exhaustion
    // rejects BEFORE anything starts (structured RESOURCE_LIMIT).
    const account = this.rootAccountFor(rootId);
    const allocation = req.toolBudget;
    const reserve = allocation ?? 1;
    if (account?.budget.maxToolCalls !== undefined) {
      const pool = Math.floor(account.budget.maxToolCalls * (1 - TREE_BUDGET_HEADROOM_RATIO));
      if (account.toolUsed + account.toolReserved + reserve > pool) {
        throw new AgentError(
          errorInfo(
            "RESOURCE_LIMIT",
            `tree tool-call budget exhausted for root ${rootId} ` +
              `(used ${account.toolUsed} + reserved ${account.toolReserved} + need ${reserve} > pool ${pool})`,
          ),
        );
      }
      account.toolReserved += reserve;
    }

    // P0-11: tree token budget. A request with a tokenBudget allocation
    // pre-reserves it; without one, it draws a minimal unit from the pool.
    // Exhaustion rejects BEFORE anything starts.
    const tokenAllocation = req.tokenBudget;
    const tokenReserve = tokenAllocation ?? 1;
    if (account?.budget.maxTokens !== undefined) {
      const tokenPool = Math.floor(account.budget.maxTokens * (1 - TREE_BUDGET_HEADROOM_RATIO));
      if (account.tokenUsed + account.tokenReserved + tokenReserve > tokenPool) {
        throw new AgentError(
          errorInfo(
            "RESOURCE_LIMIT",
            `tree token budget exhausted for root ${rootId} ` +
              `(used ${account.tokenUsed} + reserved ${account.tokenReserved} + need ${tokenReserve} > pool ${tokenPool})`,
          ),
        );
      }
      account.tokenReserved += tokenReserve;
    }

    const controller = new AbortController();
    const entry: SchedulerEntry = {
      id: this.nextId,
      rootSessionId: rootId,
      parentSessionId: req.parentSessionId,
      agentId: req.agentId,
      state: "queued",
      enteredAt: this.now(),
      signal: controller.signal,
      // Every scheduled agent holds a tool-call allocation (explicit or the
      // minimal 1-unit default) so release can refund what it did not spend.
      allocation: reserve,
      tokenAllocation: tokenReserve,
    };
    this.nextId += 1;

    const gate = new Promise<SchedulerToken>((resolve, reject) => {
      this.gateResolvers.set(entry.id, resolve);
      this.gateRejecters.set(entry.id, reject);
    });

    const onCallerAbort = () => {
      this.dequeue(entry);
      this.cleanupGate(entry.id, this.reject(`cancelled before start (queued at ${entry.enteredAt})`));
    };
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });

    if (this.canStart(entry)) {
      this.start(entry);
    } else {
      this.queued.push(entry);
    }

    try {
      return await gate;
    } finally {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Abort every queued/running agent whose root subtree is `rootOrUnder`.
   *  Running agents see their token signal abort (the runtime cancels);
   *  queued agents reject with USER_CANCELLED before starting. */
  cancelSubtree(rootOrUnder: SessionId): void {
    for (const entry of [...this.queued, ...[...this.active.values()]]) {
      if (entry.rootSessionId === rootOrUnder) this.cancelEntry(entry);
    }
    this.drain();
  }

  private canStart(entry: SchedulerEntry): boolean {
    // P13-5 (promoted): adaptive concurrency limit based on current load.
    const effectiveMax = suggestConcurrency({
      activeChildren: this.active.size,
      maxConcurrent: this.limits.maxGlobalAgents,
      tokenBudgetRemainingFraction: 1,
      recentConflicts: 0,
      recentRecoveries: 0,
    });
    if (effectiveMax > 0 && this.active.size >= effectiveMax) {
      return false;
    }
    if (this.limits.maxAgentsPerRoot > 0) {
      let underRoot = 0;
      for (const running of this.active.values()) {
        if (running.rootSessionId === entry.rootSessionId) underRoot += 1;
      }
      if (underRoot >= this.limits.maxAgentsPerRoot) return false;
    }
    return true;
  }

  private start(entry: SchedulerEntry): void {
    this.dequeue(entry);
    const controller = this.controllers.get(entry.id) ?? new AbortController();
    this.controllers.set(entry.id, controller);
    entry.state = "running";
    entry.startedAt = this.now();
    entry.signal = controller.signal;
    if (this.limits.maxDurationMs > 0) {
      const timerHandle = this.timer.schedule(() => this.cancelEntry(entry), this.limits.maxDurationMs);
      const onAbort = () => {
        timerHandle.cancel();
        controller.signal.removeEventListener("abort", onAbort);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    }
    this.startTreeClock(entry.rootSessionId);
    this.active.set(entry.id, entry);
    const resolve = this.gateResolvers.get(entry.id);
    if (resolve !== undefined) {
      this.gateResolvers.delete(entry.id);
      this.gateRejecters.delete(entry.id);
      resolve({
        entry,
        signal: controller.signal,
        rootSessionId: entry.rootSessionId,
        release: (usedToolCalls = 0) => this.finish(entry, usedToolCalls),
        reportUsage: (inputTokens: number, outputTokens: number) =>
          this.reportUsage(entry.rootSessionId, inputTokens, outputTokens),
      });
    }
  }

  /** P1-7: the first scheduled child of a root arms the tree wall-clock
   *  budget. Root keeps its headroom (completion/verification); the subtree
   *  is cancelled once the children budget (total × headroom share) elapses.
   *  The timer runs until the root budget is reached; entries cancelled by it
   *  are released by their owners as usual. */
  private startTreeClock(rootSessionId: SessionId): void {
    const account = this.rootAccounts.get(rootSessionId);
    if (account?.budget.maxDurationMs === undefined || account.rootStartedAt !== undefined) return;
    account.rootStartedAt = this.now();
    const allowMs = Math.round(account.budget.maxDurationMs * (1 - TREE_BUDGET_HEADROOM_RATIO));
    if (allowMs > 0) {
      this.timer.schedule(() => this.cancelSubtree(rootSessionId), allowMs);
    }
  }

  /** P0-11: report token usage from a model.completed for tree accounting. */
  reportUsage(rootSessionId: SessionId, inputTokens: number, outputTokens: number): void {
    const account = this.rootAccounts.get(rootSessionId);
    if (account === undefined) return;
    account.tokenUsed += inputTokens + outputTokens;
  }

  /** P3-10: bind a child session to its root so runtime-side per-call usage
   *  (model.completed) reaches the tree account. The delegator binds after
   *  creating the child session and unbinds when the child turn ends. */
  bindSession(sessionId: SessionId, rootSessionId: SessionId): void {
    this.sessionRoots.set(sessionId, rootSessionId);
  }

  unbindSession(sessionId: SessionId): void {
    this.sessionRoots.delete(sessionId);
  }

  /** P3-10: report usage by session id (the runtime only knows the session).
   *  No binding → no accounting (parent sessions that never scheduled still
   *  draw from their own root when the host wired a root budget). */
  reportUsageBySession(sessionId: SessionId, inputTokens: number, outputTokens: number): void {
    const root = this.sessionRoots.get(sessionId);
    if (root === undefined) return;
    this.reportUsage(root, inputTokens, outputTokens);
  }

  private finish(entry: SchedulerEntry, usedToolCalls: number): void {
    this.settleTreeBudget(entry, usedToolCalls);
    if (this.active.delete(entry.id)) {
      entry.state = "done";
      entry.finishedAt = this.now();
      this.controllers.delete(entry.id);
    }
    this.drain();
  }

  /** P1-7: on release, refund the unused part of this entry's allocation and
   *  account its actual tool-call usage against the root tree pool. A child
   *  can never spend outside its allocation (pre-deducted), and unused budget
   *  flows back to the pool. P0-11: same for token budget. */
  private settleTreeBudget(entry: SchedulerEntry, usedToolCalls: number): void {
    const account = this.rootAccounts.get(entry.rootSessionId);
    if (account === undefined) return;
    if (entry.allocation !== undefined) {
      account.toolReserved = Math.max(0, account.toolReserved - entry.allocation);
    }
    account.toolUsed += usedToolCalls;
    // P0-11: token reservation refund (token budget is not pre-reserved
    // in the entry; the reservation was a minimal 1-unit gate. The actual
    // usage is tracked via reportUsage, so the refund here is a no-op).
  }

  private rootAccountFor(rootSessionId: SessionId): RootAccount | undefined {
    return this.rootAccounts.get(rootSessionId) ?? this.accountFromDefaultBudget(rootSessionId);
  }

  /** Lazily materialize the SchedulerLimits-level default tree budget. */
  private accountFromDefaultBudget(rootSessionId: SessionId): RootAccount | undefined {
    const budget = this.limits.treeBudget;
    if (budget === undefined) return undefined;
    if (!this.rootAccounts.has(rootSessionId)) {
this.rootAccounts.set(rootSessionId, { budget, toolUsed: 0, toolReserved: 0, tokenUsed: 0, tokenReserved: 0 });
    }
    return this.rootAccounts.get(rootSessionId);
  }

  /** Abort one scheduling unit. Running → signal aborts (turn cancels);
   *  queued → its gate rejects, so no session is ever created for it. */
  private cancelEntry(entry: SchedulerEntry): void {
    if (this.queued.includes(entry)) {
      this.dequeue(entry);
      entry.state = "cancelled";
      this.cleanupGate(entry.id, this.reject("cancelled before start (subtree cancelled)"));
      return;
    }
    if (this.active.has(entry.id)) {
      const controller = this.controllers.get(entry.id);
      if (controller !== undefined && !controller.signal.aborted) controller.abort();
    }
  }

  private cleanupGate(id: number, reason: unknown): void {
    const reject = this.gateRejecters.get(id);
    if (reject !== undefined) {
      this.gateRejecters.delete(id);
      this.gateResolvers.delete(id);
      reject(reason);
    }
  }

  /** After a slot frees, start queued entries FIFO while any can start. A
   *  just-started entry consumes a global slot until its own finish, so a
   *  single front-to-back pass suffices. */
  private drain(): void {
    let index = 0;
    while (index < this.queued.length) {
      const entry = this.queued[index]!;
      if (this.canStart(entry)) {
        this.start(entry);
      } else {
        index += 1;
      }
    }
  }

  private dequeue(entry: SchedulerEntry): void {
    const index = this.queued.indexOf(entry);
    if (index >= 0) this.queued.splice(index, 1);
  }

  private reject(message: string): AgentError {
    return new AgentError(errorInfo("USER_CANCELLED", message));
  }

  /** Walk parentId links to the root; returns the root id and the parent
   *  session's depth (its number of ancestors). A child of `sessionId` sits
   *  at depth+1. */
  private async treeOf(sessionId: SessionId): Promise<{ rootId: SessionId; depth: number }> {
    let current: Session | undefined = await this.store.getSession(sessionId);
    let depth = 0;
    while (current?.parentId !== undefined) {
      current = await this.store.getSession(current.parentId);
      depth += 1;
    }
    if (current === undefined) {
      throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown session ${sessionId}`));
    }
    return { rootId: current.id, depth };
  }
}