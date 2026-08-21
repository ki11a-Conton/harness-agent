/** Exhaustive list of the closed taxonomy, kept in lock-step with the union by
 *  `satisfies`. Adding a reason without extending the array is a compile error. */
export const ASK_REASONS = [
    "missing_critical_input",
    "ambiguous_goal",
    "unresolvable_context",
    "choice_required",
];
export function isAskReason(value) {
    return typeof value === "string" && ASK_REASONS.includes(value);
}
/** Default pure implementation of the boundary contracts. */
export const defaultAskUserLifecycle = {
    isPending: (request) => request.status === "pending",
    isAnswered: (request) => request.status === "answered",
    hasPending: (sessionId, turnId) => (pending) => pending.sessionId === sessionId &&
        pending.turnId === turnId &&
        pending.status === "pending",
    resumePrompt: (reply) => ({
        content: `[user reply to your question]\n${reply.text}`,
        askId: reply.requestId,
    }),
    fingerprint: (request) => `${request.sessionId}/${request.turnId ?? "-"}/${request.id}`,
};
//# sourceMappingURL=ask-user.js.map