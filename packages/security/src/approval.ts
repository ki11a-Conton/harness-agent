import type {
  AgentId,
  ApprovalDecision,
  ApprovalDecisionValue,
  ApprovalId,
  ApprovalRequest,
  ApprovalResolver,
  SessionId,
} from "@ar/contracts";
import { newApprovalId } from "@ar/contracts";

export interface PendingApproval {
  request: ApprovalRequest;
  /** Resolves when the store decides, the entry expires, or the signal aborts. */
  wait(signal: AbortSignal): Promise<ApprovalDecision>;
}

interface PendingEntry {
  request: ApprovalRequest;
  /** Idempotent: first call settles; later calls return the existing decision. */
  settle(value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
  wait(signal: AbortSignal): Promise<ApprovalDecision>;
}

function createPendingEntry(request: ApprovalRequest, now: () => number): PendingEntry {
  let resolveWait!: (d: ApprovalDecision) => void;
  let settled = false;
  let decision: ApprovalDecision | undefined;
  const waitPromise = new Promise<ApprovalDecision>((resolve) => {
    resolveWait = resolve;
  });

  function settle(value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision {
    if (settled && decision !== undefined) return decision;
    const expired = now() > request.expiresAt;
    decision = {
      id: request.id,
      value: expired && value === "allow" ? "expired" : value,
      decidedAt: now(),
      ...(decidedBy !== undefined ? { decidedBy } : {}),
    };
    settled = true;
    resolveWait(decision);
    return decision;
  }

  function wait(signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) {
      settle("cancelled");
      return Promise.resolve(decision!);
    }
    const onAbort = () => settle("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const delay = request.expiresAt - now();
    const timer = setTimeout(() => settle("expired"), Math.max(0, delay));
    return waitPromise.finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  }

  return { request, settle, wait };
}

export class InMemoryApprovalStore {
  private pending = new Map<ApprovalId, PendingEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(request: ApprovalRequest): PendingEntry {
    if (this.pending.has(request.id)) {
      throw new Error(`approval already exists: ${request.id}`);
    }
    const entry = createPendingEntry(request, this.now);
    this.pending.set(request.id, entry);
    return entry;
  }

  /** Returns the final decision (may be "expired" if already past expiresAt). */
  resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision {
    const entry = this.pending.get(id);
    if (!entry) throw new Error(`unknown or already-resolved approval: ${id}`);
    const d = entry.settle(value, decidedBy);
    this.pending.delete(id);
    return d;
  }

  cancelAll(sessionId: SessionId): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) {
        entry.settle("cancelled");
        this.pending.delete(id);
      }
    }
  }

  listPending(sessionId?: SessionId): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((e) => e.request)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }
}

export interface StoreApprovalResolverOptions {
  expiresAfterMs?: number;
  now?: () => number;
}

/** ApprovalResolver backed by an InMemoryApprovalStore. */
export class StoreApprovalResolver implements ApprovalResolver {
  private readonly store: InMemoryApprovalStore;
  private readonly expiresAfterMs: number;
  private readonly now: () => number;

  constructor(store: InMemoryApprovalStore, opts: StoreApprovalResolverOptions = {}) {
    this.store = store;
    this.expiresAfterMs = opts.expiresAfterMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  createApprovalRequest(input: {
    sessionId: SessionId;
    agentId: AgentId;
    action: string;
    target: string;
    reason: string;
    policyRule?: string;
    expiresAt?: number;
  }): ApprovalRequest {
    return {
      id: newApprovalId(),
      ...(input.policyRule !== undefined ? { policyRule: input.policyRule } : {}),
      sessionId: input.sessionId,
      agentId: input.agentId,
      action: input.action,
      target: input.target,
      reason: input.reason,
      createdAt: this.now(),
      expiresAt: input.expiresAt ?? this.now() + this.expiresAfterMs,
    };
  }

  async resolve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const entry = this.store.create(request);
    return entry.wait(signal);
  }
}

export type { ApprovalRequest, ApprovalDecision, ApprovalDecisionValue, ApprovalId };