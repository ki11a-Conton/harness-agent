import type { AgentId, ApprovalDecision, ApprovalDecisionRecord, ApprovalDecisionValue, ApprovalId, ApprovalRequest, ApprovalResolver, ApprovalScope, ApprovalStore, PendingApproval, SessionId } from "@ar/contracts";
import { type Timer } from "@ar/contracts";
export type { PendingApproval };
interface PendingEntry {
    request: ApprovalRequest;
    /** Idempotent: first call settles; later calls return the existing decision. */
    settle(value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
    wait(signal: AbortSignal): Promise<ApprovalDecision>;
}
export declare class InMemoryApprovalStore implements ApprovalStore {
    private pending;
    /** Append-only decision audit log (P2-44): never deleted, survives via listDecisions. */
    private readonly decisions;
    private readonly now;
    private readonly timer;
    constructor(now?: () => number, timer?: Timer);
    private record;
    create(request: ApprovalRequest): PendingEntry;
    /** Returns the final decision (may be "expired" if already past expiresAt). */
    resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
    cancelAll(sessionId: SessionId): void;
    listPending(sessionId?: SessionId): ApprovalRequest[];
    /** P2-44 audit: append-only decision log, optionally filtered by session. */
    listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[];
}
export interface StoreApprovalResolverOptions {
    expiresAfterMs?: number;
    now?: () => number;
}
/** ApprovalResolver backed by an ApprovalStore. */
export declare class StoreApprovalResolver implements ApprovalResolver {
    private readonly store;
    private readonly expiresAfterMs;
    private readonly now;
    constructor(store: ApprovalStore, opts?: StoreApprovalResolverOptions);
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
    }): ApprovalRequest;
    resolve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}
export declare class DurableApprovalStore implements ApprovalStore {
    private readonly inner;
    private readonly filePath;
    private readonly pending;
    private decisions;
    private readonly now;
    constructor(filePath: string, opts?: {
        now?: () => number;
    });
    /** Full stop: append the pending request to durable state and start waiting. */
    create(request: ApprovalRequest): PendingEntry;
    resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
    cancelAll(sessionId: SessionId): void;
    listPending(sessionId?: SessionId): ApprovalRequest[];
    /** P2-44 audit: append-only decision log, optionally filtered by session. */
    listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[];
    private persist;
}
export type { ApprovalRequest, ApprovalDecision, ApprovalDecisionValue, ApprovalId, ApprovalScope };
//# sourceMappingURL=approval.d.ts.map