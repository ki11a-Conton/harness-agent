/** Exhaustive list of the bounded taxonomy, for runtime validation of
 *  externally-supplied reasons (e.g. benchmark case data). `satisfies`
 *  keeps this in lock-step with the union: adding a reason to the union
 *  without adding it here is a compile error. */
export const TERMINATION_REASONS = [
    "verified_complete",
    "model_stopped",
    "verification_failed",
    "model_error",
    "provider_error",
    "tool_error",
    "sandbox_denied",
    "permission_denied",
    "security_denied",
    "context_limit",
    "tool_limit",
    "time_limit",
    "agent_limit",
    "cancelled",
    "resume_ambiguous",
];
export function isTerminationReason(value) {
    return typeof value === "string" && TERMINATION_REASONS.includes(value);
}
/**
 * P2-39 — stable mapping from a `run.limit_reached` limit identifier to the
 * bounded TerminationReason used as the turn's terminal reason. Kept in ONE
 * place so the runtime (which knows the actual terminal reason) and the
 * event-derived evaluation fallback (which only sees the limit event) agree.
 */
export const LIMIT_TERMINATION_REASON = {
    maxTokens: "context_limit",
    maxDurationMs: "time_limit",
    maxToolCalls: "tool_limit",
    maxRepeatedToolCalls: "tool_limit",
    maxIterationsPerTurn: "agent_limit",
    maxVerificationFailures: "verification_failed",
    maxRetries: "model_error",
};
export function gradeCompletion(reason, evidence) {
    switch (reason) {
        case "verified_complete":
            return "verified_complete";
        case "verification_failed":
            return "verification_failed";
        case "model_stopped":
            if (evidence !== undefined && evidence.totalSteps > 0) {
                return evidence.passedSteps >= evidence.totalSteps
                    ? "verified_complete"
                    : "verified_partial";
            }
            return "unverified_complete";
        default:
            // failure/cancelled/limit reasons are not "complete" at all.
            return "unverified_complete";
    }
}
//# sourceMappingURL=termination.js.map