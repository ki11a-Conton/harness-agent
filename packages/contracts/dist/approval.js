export const APPROVAL_SCOPES = [
    "one_call",
    "one_tool",
    "session",
];
export function isApprovalScope(value) {
    return (typeof value === "string" && APPROVAL_SCOPES.includes(value));
}
/**
 * Pure projection of a settled decision into its auditable record. No storage
 * side effects, so it is unit-testable and usable by any host/UI auditing an
 * approval stream.
 */
export function approvalDecisionRecord(request, decision) {
    return {
        id: decision.id,
        sessionId: request.sessionId,
        ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
        agentId: request.agentId,
        action: request.action,
        target: request.target,
        scope: isApprovalScope(request.scope) ? request.scope : "one_call",
        value: decision.value,
        decidedAt: decision.decidedAt,
        ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
        expired: decision.value === "expired",
    };
}
//# sourceMappingURL=approval.js.map