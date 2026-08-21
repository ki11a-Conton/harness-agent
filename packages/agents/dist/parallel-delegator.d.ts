import { type DelegatorDeps } from "./delegator.js";
import type { DelegationRequest, DelegationResult } from "./delegation.js";
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
export declare class ParallelDelegator {
    private readonly delegator;
    private readonly runtime;
    private readonly store;
    private readonly agentId;
    private readonly limits;
    /** P14-3: isolation availability forwarded from deps for the batch
     *  pre-flight gate (the inner Delegator enforces the same gate per child). */
    private readonly isolation;
    constructor(deps: DelegatorDeps);
    /** Runs every request through Delegator.delegate, at most
     *  `limits.maxConcurrent` in flight. Results are placed by request index,
     *  so the returned array always matches the request order.
     *
     *  `opts.childSignals[i]` overrides the shared `signal` for exactly that
     *  child (P1-10: cancel one child without cancelling siblings). */
    delegateAll(reqs: DelegationRequest[], signal: AbortSignal, opts?: {
        childSignals?: readonly AbortSignal[];
    }): Promise<DelegationResult[]>;
    /** Mirrors Delegator.delegate's pre-flight (requireSession → bounds →
     *  agent), applied to every request before any child session exists.
     *  Batch members claim maxChildren slots so oversize batches are caught
     *  up front, never after a partial start. */
    private preflight;
    private requireSession;
    /** Same rules and error codes as Delegator's INV-009 bounds check, plus
     *  this batch's own claims against maxChildren. */
    private enforceBounds;
    private boundError;
    private depthOf;
}
//# sourceMappingURL=parallel-delegator.d.ts.map