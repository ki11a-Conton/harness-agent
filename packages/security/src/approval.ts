import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentId,
  ApprovalDecision,
  ApprovalDecisionRecord,
  ApprovalDecisionValue,
  ApprovalId,
  ApprovalRequest,
  ApprovalResolver,
  ApprovalScope,
  ApprovalStore,
  PendingApproval,
  SessionId,
} from "@ar/contracts";
import { approvalDecisionRecord, isApprovalScope, newApprovalId, RealTimer, type Timer } from "@ar/contracts";

export type { PendingApproval };

interface PendingEntry {
  request: ApprovalRequest;
  /** Idempotent: first call settles; later calls return the existing decision. */
  settle(value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
  wait(signal: AbortSignal): Promise<ApprovalDecision>;
}

function createPendingEntry(request: ApprovalRequest, now: () => number, timer: Timer): PendingEntry {
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
    const expiry = timer.schedule(() => settle("expired"), Math.max(0, delay));
    return waitPromise.finally(() => {
      expiry.cancel();
      signal.removeEventListener("abort", onAbort);
    });
  }

  return { request, settle, wait };
}

export class InMemoryApprovalStore implements ApprovalStore {
  private pending = new Map<ApprovalId, PendingEntry>();
  /** Append-only decision audit log (P2-44): never deleted, survives via listDecisions. */
  private readonly decisions: ApprovalDecisionRecord[] = [];
  private readonly now: () => number;
  private readonly timer: Timer;

  constructor(now: () => number = Date.now, timer: Timer = new RealTimer(now)) {
    this.now = now;
    this.timer = timer;
  }

  private record(entry: PendingEntry, decision: ApprovalDecision): void {
    this.decisions.push(approvalDecisionRecord(entry.request, decision));
  }

  create(request: ApprovalRequest): PendingEntry {
    if (this.pending.has(request.id)) {
      throw new Error(`approval already exists: ${request.id}`);
    }
    const entry = createPendingEntry(request, this.now, this.timer);
    this.pending.set(request.id, entry);
    return entry;
  }

  /** Returns the final decision (may be "expired" if already past expiresAt). */
  resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision {
    const entry = this.pending.get(id);
    if (!entry) throw new Error(`unknown or already-resolved approval: ${id}`);
    const d = entry.settle(value, decidedBy);
    this.record(entry, d);
    this.pending.delete(id);
    return d;
  }

  cancelAll(sessionId: SessionId): void {
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) {
        const d = entry.settle("cancelled");
        this.record(entry, d);
        this.pending.delete(id);
      }
    }
  }

  listPending(sessionId?: SessionId): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((e) => e.request)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }

  /** P2-44 audit: append-only decision log, optionally filtered by session. */
  listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[] {
    return this.decisions.filter(
      (d) => sessionId === undefined || d.sessionId === sessionId,
    );
  }
}

export interface StoreApprovalResolverOptions {
  expiresAfterMs?: number;
  now?: () => number;
}

/** ApprovalResolver backed by an ApprovalStore. */
export class StoreApprovalResolver implements ApprovalResolver {
  private readonly store: ApprovalStore;
  private readonly expiresAfterMs: number;
  private readonly now: () => number;

  constructor(store: ApprovalStore, opts: StoreApprovalResolverOptions = {}) {
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
    /** Decision scope (P2-44); defaults to "one_call". */
    scope?: ApprovalScope;
    expiresAt?: number;
  }): ApprovalRequest {
    return {
      id: newApprovalId(),
      ...(input.policyRule !== undefined ? { policyRule: input.policyRule } : {}),
      scope: isApprovalScope(input.scope) ? input.scope : ("one_call" as const),
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

/**
 * Durable approval store (P2-44).
 *
 * Persists pending approval requests and the append-only decision audit log to
 * a JSON file, so a process restart does NOT lose an outstanding approval
 * request nor any resolved decision. On construction it re-hydrates from disk:
 * pending requests are re-enumerable and re-resolvable, and the audit log is
 * reloaded unchanged.
 *
 * A live waiter on a promise cannot survive a process death; what CAN survive —
 * and what this store guarantees — is the request itself and every decision.
 * The host re-surfaces a re-hydrated pending request via {@link listPending} and
 * resolves it as normal; the decision is appended to the same audit log that
 * already existed before the crash.
 */
interface DurableApprovalFile {
  version: 1;
  pending: ApprovalRequest[];
  decisions: ApprovalDecisionRecord[];
}

export class DurableApprovalStore implements ApprovalStore {
  private readonly inner: InMemoryApprovalStore;
  private readonly filePath: string;
  private readonly pending = new Map<ApprovalId, ApprovalRequest>();
  private decisions: ApprovalDecisionRecord[] = [];
  private readonly now: () => number;

  constructor(filePath: string, opts: { now?: () => number } = {}) {
    this.filePath = filePath;
    this.now = opts.now ?? Date.now;
    this.inner = new InMemoryApprovalStore(this.now);
    let raw: string | undefined;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      raw = undefined; // no file yet — fresh store
    }
    if (raw !== undefined && raw.length > 0) {
      const data = JSON.parse(raw) as DurableApprovalFile;
      if (Array.isArray(data.pending)) {
        for (const r of data.pending) this.pending.set(r.id, r);
      }
      if (Array.isArray(data.decisions)) this.decisions = data.decisions;
    }
    // Re-create re-hydrated requests inside the live inner store so they are
    // resolvable again.
    for (const request of this.pending.values()) {
      try {
        this.inner.create(request);
      } catch {
        // already present (idempotent re-hydration)
      }
    }
  }

  /** Full stop: append the pending request to durable state and start waiting. */
  create(request: ApprovalRequest): PendingEntry {
    const entry = this.inner.create(request);
    this.pending.set(request.id, request);
    this.persist();
    return entry;
  }

  resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision {
    const request = this.pending.get(id);
    const d = this.inner.resolve(id, value, decidedBy);
    if (request !== undefined) {
      this.decisions.push(approvalDecisionRecord(request, d));
      this.pending.delete(id);
      this.persist();
    }
    return d;
  }

  cancelAll(sessionId: SessionId): void {
    const toCancel = [...this.pending.values()].filter((r) => r.sessionId === sessionId);
    if (toCancel.length === 0) return;
    for (const r of toCancel) {
      const d = this.inner.resolve(r.id, "cancelled");
      this.decisions.push(approvalDecisionRecord(r, d));
      this.pending.delete(r.id);
    }
    this.persist();
  }

  listPending(sessionId?: SessionId): ApprovalRequest[] {
    return [...this.pending.values()].filter(
      (r) => sessionId === undefined || r.sessionId === sessionId,
    );
  }

  /** P2-44 audit: append-only decision log, optionally filtered by session. */
  listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[] {
    return this.decisions.filter(
      (d) => sessionId === undefined || d.sessionId === sessionId,
    );
  }

  private persist(): void {
    const data: DurableApprovalFile = {
      version: 1,
      pending: [...this.pending.values()],
      decisions: this.decisions,
    };
    // P1-3: atomic write — write a temp sibling then rename over the target,
    // so a crash mid-write never leaves a truncated store. Parent dir is
    // created first (the store owns the file path).
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, this.filePath);
  }
}

export type { ApprovalRequest, ApprovalDecision, ApprovalDecisionValue, ApprovalId, ApprovalScope };