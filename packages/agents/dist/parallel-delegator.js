import { AgentError, DEFAULT_DELEGATION_LIMITS, errorInfo, isCancelledErrorCode } from "@ar/contracts";
import { Delegator, writableIsolationError } from "./delegator.js";
/**
 * SUBAGENT-002: parallel delegation (§57, INV-009).
 *
 * Runs many child delegations with a bounded worker pool of
 * `limits.maxConcurrent` (default 3, §55). Every child runs through
 * Delegator.delegate, so each gets its own isolated session (INV-005),
 * per-child bounds checks and a structured result.
 *
 * Before anything starts, all requests are pre-flighted with the same checks
 * Delegator.delegate would run: an invalid request (unknown parent/agent,
 * recursion bounds breached) rejects the whole batch before any child session
 * is created — the batch never partially starts. Batch members claim
 * maxChildren slots during pre-flight, so a batch that is too large for the
 * parent is rejected up front instead of discovering the violation mid-run.
 *
 * Cancellation (P1-10): every child shares the caller's AbortSignal by
 * default — aborting it cancels all children, started and queued alike.
 * A per-child signal (childSignals[i]) cancels exactly that child without
 * touching siblings; a child cancelled while queued resolves as a cancelled
 * result instead of rejecting the whole batch.
 */
export class ParallelDelegator {
    delegator;
    runtime;
    store;
    agentId;
    limits;
    /** P14-3: isolation availability forwarded from deps for the batch
     *  pre-flight gate (the inner Delegator enforces the same gate per child). */
    isolation;
    constructor(deps) {
        this.delegator = new Delegator(deps);
        this.runtime = deps.runtime;
        this.store = deps.store;
        this.agentId = deps.agentId;
        this.limits = { ...DEFAULT_DELEGATION_LIMITS, ...deps.limits };
        this.isolation = {
            workspaceManager: deps.workspaceManager,
            testOnlyUnsafeSharedWorkspace: deps.testOnlyUnsafeSharedWorkspace ?? false,
        };
    }
    /** Runs every request through Delegator.delegate, at most
     *  `limits.maxConcurrent` in flight. Results are placed by request index,
     *  so the returned array always matches the request order.
     *
     *  `opts.childSignals[i]` overrides the shared `signal` for exactly that
     *  child (P1-10: cancel one child without cancelling siblings). */
    async delegateAll(reqs, signal, opts) {
        if (this.limits.maxConcurrent <= 0) {
            throw new AgentError(errorInfo("RESOURCE_LIMIT", `maxConcurrent must be positive (got ${this.limits.maxConcurrent})`));
        }
        await this.preflight(reqs);
        const results = new Array(reqs.length);
        let next = 0;
        const worker = async () => {
            while (next < reqs.length) {
                const index = next;
                next += 1;
                const childSignal = opts?.childSignals?.[index] ?? signal;
                try {
                    results[index] = await this.delegator.delegate(reqs[index], childSignal);
                }
                catch (err) {
                    // P1-10: a child cancelled while queued rejects with
                    // USER_CANCELLED — resolve it as a cancelled result instead of
                    // taking down the whole batch (matches the already-aborted path).
                    if (err instanceof AgentError && isCancelledErrorCode(err.info.code)) {
                        results[index] = {
                            status: "cancelled",
                            summary: "delegation cancelled while queued",
                            childSessionId: "",
                            toolCalls: 0,
                            durationMs: 0,
                            evidence: [],
                            artifacts: [],
                            answer: "",
                            findings: [],
                            changedArtifacts: [],
                            testsRun: [],
                            openQuestions: [],
                            blockers: [],
                            suggestedNextActions: [],
                            budgetUsed: { toolCalls: 0, durationMs: 0 },
                            verified: false,
                        };
                    }
                    else {
                        throw err;
                    }
                }
            }
        };
        const workers = Array.from({ length: Math.min(this.limits.maxConcurrent, reqs.length) }, () => worker());
        await Promise.all(workers);
        return results;
    }
    /** Mirrors Delegator.delegate's pre-flight (requireSession → bounds →
     *  agent), applied to every request before any child session exists.
     *  Batch members claim maxChildren slots so oversize batches are caught
     *  up front, never after a partial start. */
    async preflight(reqs) {
        const claims = new Map();
        for (const req of reqs) {
            const limits = { ...this.limits, ...req.limits };
            const parent = await this.requireSession(req.parentSessionId);
            await this.enforceBounds(parent, limits, claims);
            // P14-3: a writable request without workspace isolation is invalid
            // configuration — reject the whole batch before any child session is
            // created (no partial start, same philosophy as the other pre-flight
            // checks). The inner Delegator enforces the same gate per child.
            const isolationError = writableIsolationError(this.isolation);
            if (req.writable === true && isolationError !== undefined)
                throw isolationError;
            const agentId = req.agentId ?? this.agentId;
            if (this.runtime.getAgent(agentId) === undefined) {
                throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown agent ${agentId}: cannot delegate`));
            }
        }
    }
    async requireSession(sessionId) {
        const session = await this.store.getSession(sessionId);
        if (session === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `unknown parent session ${sessionId}`));
        }
        return session;
    }
    /** Same rules and error codes as Delegator's INV-009 bounds check, plus
     *  this batch's own claims against maxChildren. */
    async enforceBounds(parent, limits, claims) {
        if (limits.maxDepth === 0) {
            throw this.boundError("leaf agent (maxDepth=0) cannot delegate");
        }
        if (limits.maxChildren === 0) {
            throw this.boundError("delegation disabled (maxChildren=0)");
        }
        const depth = await this.depthOf(parent.id);
        if (depth >= limits.maxDepth) {
            throw this.boundError(`max delegation depth ${limits.maxDepth} reached (current depth ${depth})`);
        }
        const children = await this.store.listSessions({ parentId: parent.id });
        const claimed = claims.get(parent.id) ?? 0;
        if (children.length + claimed >= limits.maxChildren) {
            throw this.boundError(`max children ${limits.maxChildren} reached (current ${children.length + claimed})`);
        }
        claims.set(parent.id, claimed + 1);
    }
    boundError(message) {
        return new AgentError(errorInfo("RESOURCE_LIMIT", message));
    }
    async depthOf(sessionId) {
        let depth = 0;
        let session = await this.store.getSession(sessionId);
        while (session?.parentId !== undefined) {
            depth += 1;
            session = await this.store.getSession(session.parentId);
        }
        return depth;
    }
}
//# sourceMappingURL=parallel-delegator.js.map