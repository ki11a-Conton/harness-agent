import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { approvalDecisionRecord, isApprovalScope, newApprovalId, RealTimer } from "@ar/contracts";
function createPendingEntry(request, now, timer) {
    let resolveWait;
    let settled = false;
    let decision;
    const waitPromise = new Promise((resolve) => {
        resolveWait = resolve;
    });
    function settle(value, decidedBy) {
        if (settled && decision !== undefined)
            return decision;
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
    function wait(signal) {
        if (signal.aborted) {
            settle("cancelled");
            return Promise.resolve(decision);
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
export class InMemoryApprovalStore {
    pending = new Map();
    /** Append-only decision audit log (P2-44): never deleted, survives via listDecisions. */
    decisions = [];
    now;
    timer;
    constructor(now = Date.now, timer = new RealTimer(now)) {
        this.now = now;
        this.timer = timer;
    }
    record(entry, decision) {
        this.decisions.push(approvalDecisionRecord(entry.request, decision));
    }
    create(request) {
        if (this.pending.has(request.id)) {
            throw new Error(`approval already exists: ${request.id}`);
        }
        const entry = createPendingEntry(request, this.now, this.timer);
        this.pending.set(request.id, entry);
        return entry;
    }
    /** Returns the final decision (may be "expired" if already past expiresAt). */
    resolve(id, value, decidedBy) {
        const entry = this.pending.get(id);
        if (!entry)
            throw new Error(`unknown or already-resolved approval: ${id}`);
        const d = entry.settle(value, decidedBy);
        this.record(entry, d);
        this.pending.delete(id);
        return d;
    }
    cancelAll(sessionId) {
        for (const [id, entry] of this.pending) {
            if (entry.request.sessionId === sessionId) {
                const d = entry.settle("cancelled");
                this.record(entry, d);
                this.pending.delete(id);
            }
        }
    }
    listPending(sessionId) {
        return [...this.pending.values()]
            .map((e) => e.request)
            .filter((r) => sessionId === undefined || r.sessionId === sessionId);
    }
    /** P2-44 audit: append-only decision log, optionally filtered by session. */
    listDecisions(sessionId) {
        return this.decisions.filter((d) => sessionId === undefined || d.sessionId === sessionId);
    }
}
/** ApprovalResolver backed by an ApprovalStore. */
export class StoreApprovalResolver {
    store;
    expiresAfterMs;
    now;
    constructor(store, opts = {}) {
        this.store = store;
        this.expiresAfterMs = opts.expiresAfterMs ?? 60_000;
        this.now = opts.now ?? Date.now;
    }
    createApprovalRequest(input) {
        return {
            id: newApprovalId(),
            ...(input.policyRule !== undefined ? { policyRule: input.policyRule } : {}),
            scope: isApprovalScope(input.scope) ? input.scope : "one_call",
            sessionId: input.sessionId,
            agentId: input.agentId,
            action: input.action,
            target: input.target,
            reason: input.reason,
            createdAt: this.now(),
            expiresAt: input.expiresAt ?? this.now() + this.expiresAfterMs,
        };
    }
    async resolve(request, signal) {
        const entry = this.store.create(request);
        return entry.wait(signal);
    }
}
export class DurableApprovalStore {
    inner;
    filePath;
    pending = new Map();
    decisions = [];
    now;
    constructor(filePath, opts = {}) {
        this.filePath = filePath;
        this.now = opts.now ?? Date.now;
        this.inner = new InMemoryApprovalStore(this.now);
        let raw;
        try {
            raw = readFileSync(filePath, "utf8");
        }
        catch {
            raw = undefined; // no file yet — fresh store
        }
        if (raw !== undefined && raw.length > 0) {
            const data = JSON.parse(raw);
            if (Array.isArray(data.pending)) {
                for (const r of data.pending)
                    this.pending.set(r.id, r);
            }
            if (Array.isArray(data.decisions))
                this.decisions = data.decisions;
        }
        // Re-create re-hydrated requests inside the live inner store so they are
        // resolvable again.
        for (const request of this.pending.values()) {
            try {
                this.inner.create(request);
            }
            catch {
                // already present (idempotent re-hydration)
            }
        }
    }
    /** Full stop: append the pending request to durable state and start waiting. */
    create(request) {
        const entry = this.inner.create(request);
        this.pending.set(request.id, request);
        this.persist();
        return entry;
    }
    resolve(id, value, decidedBy) {
        const request = this.pending.get(id);
        const d = this.inner.resolve(id, value, decidedBy);
        if (request !== undefined) {
            this.decisions.push(approvalDecisionRecord(request, d));
            this.pending.delete(id);
            this.persist();
        }
        return d;
    }
    cancelAll(sessionId) {
        const toCancel = [...this.pending.values()].filter((r) => r.sessionId === sessionId);
        if (toCancel.length === 0)
            return;
        for (const r of toCancel) {
            const d = this.inner.resolve(r.id, "cancelled");
            this.decisions.push(approvalDecisionRecord(r, d));
            this.pending.delete(r.id);
        }
        this.persist();
    }
    listPending(sessionId) {
        return [...this.pending.values()].filter((r) => sessionId === undefined || r.sessionId === sessionId);
    }
    /** P2-44 audit: append-only decision log, optionally filtered by session. */
    listDecisions(sessionId) {
        return this.decisions.filter((d) => sessionId === undefined || d.sessionId === sessionId);
    }
    persist() {
        const data = {
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
//# sourceMappingURL=approval.js.map