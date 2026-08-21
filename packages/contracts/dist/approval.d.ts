import type { AgentId, ApprovalId, SessionId, TurnId } from "./ids.js";
/**
 * P2-44 — decision scope.
 *
 * An approval request must state exactly what the decision binds, so a host can
 * (a) grant a single call, (b) grant a single tool invocation pattern, or
 * (c) expand to "everything matching for the rest of the session". Scope is a
 * closed taxonomy; anything not listed below is a compile error.
 */
export type ApprovalScope = "one_call" | "one_tool" | "session";
export declare const APPROVAL_SCOPES: readonly ["one_call", "one_tool", "session"];
export declare function isApprovalScope(value: unknown): value is ApprovalScope;
export interface ApprovalRequest {
    id: ApprovalId;
    sessionId: SessionId;
    turnId?: TurnId;
    agentId: AgentId;
    action: string;
    target: string;
    reason: string;
    policyRule?: string;
    /**
     * Decision scope (P2-44). Optional on the wire for backward compatibility;
     * the resolver normalizes it to "one_call" when absent, and the resulting
     * ApprovalDecisionRecord always carries an explicit scope.
     */
    scope?: ApprovalScope;
    createdAt: number;
    expiresAt: number;
}
export type ApprovalDecisionValue = "allow" | "deny" | "expired" | "cancelled";
export interface ApprovalResolver {
    resolve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}
/** A pending approval's host-visible surface: the request plus a waiter that
 *  settles on decision/expiry/abort. */
export interface PendingApproval {
    request: ApprovalRequest;
    /** Resolves when the store decides, the entry expires, or the signal aborts. */
    wait(signal: AbortSignal): Promise<ApprovalDecision>;
}
export interface ApprovalDecision {
    id: ApprovalId;
    value: ApprovalDecisionValue;
    decidedAt: number;
    decidedBy?: string;
}
/**
 * Durable, auditable decision record (P2-44). Every resolved approval produces
 * exactly one record capturing WHO decided, WHEN, AT what scope, and for WHICH
 * action/target. Records are append-only: they are never deleted, so a decision
 * can be audited long after the process that made it has gone away.
 */
export interface ApprovalDecisionRecord extends ApprovalDecision {
    sessionId: SessionId;
    turnId?: TurnId;
    agentId: AgentId;
    action: string;
    target: string;
    /** Always explicit — resolved from `request.scope ?? "one_call"`. */
    scope: ApprovalScope;
    /** True when the outcome is "expired" (late allow ⇒ expired). */
    expired: boolean;
}
/**
 * Pure projection of a settled decision into its auditable record. No storage
 * side effects, so it is unit-testable and usable by any host/UI auditing an
 * approval stream.
 */
export declare function approvalDecisionRecord(request: ApprovalRequest, decision: ApprovalDecision): ApprovalDecisionRecord;
/**
 * Persistence seam for approvals (P2-44). A durable implementation keeps a
 * pending request re-enumerable and resolvable after a process restart, and
 * keeps the decision audit log append-only so it survives restarts unchanged.
 *
 * A live waiter waiting on a promise cannot be re-hydrated across a restart
 * (that is the job of the host), but the request itself is NOT lost: the host
 * re-surfaces it from {@link listPending} and resolves it as normal.
 */
export interface ApprovalStore {
    /** Registers a pending request and returns a waiter for its decision. */
    create(request: ApprovalRequest): PendingApproval;
    resolve(id: ApprovalId, value: ApprovalDecisionValue, decidedBy?: string): ApprovalDecision;
    cancelAll(sessionId: SessionId): void;
    listPending(sessionId?: SessionId): ApprovalRequest[];
    /** Append-only audit log of every decision (never deleted). */
    listDecisions(sessionId?: SessionId): ApprovalDecisionRecord[];
}
//# sourceMappingURL=approval.d.ts.map