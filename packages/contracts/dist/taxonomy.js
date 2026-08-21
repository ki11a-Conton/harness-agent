import { RETRY_KIND_SPECS } from "./retry.js";
// ---------------------------------------------------------------------------
// ErrorCode → TerminationReason (denied family)
// ---------------------------------------------------------------------------
/**
 * Coupling from a denial-class ErrorCode to the bounded TerminationReason
 * (P2-39) that the same failure would surface as at the turn level. Authority
 * for the exact merge (a permission ask vs an approval denial vs a sandbox /
 * security gate) stays here in ONE place so the runtime and the event-derived
 * evaluation fallback agree.
 */
export const DENIED_TERMINATION = {
    PERMISSION_DENIED: "permission_denied",
    APPROVAL_DENIED: "permission_denied",
    SANDBOX_DENIED: "sandbox_denied",
    SANDBOX_FILESYSTEM_DENIED: "sandbox_denied",
    SANDBOX_PROCESS_DENIED: "sandbox_denied",
    SANDBOX_NETWORK_DENIED: "sandbox_denied",
    SECURITY_DENIED: "security_denied",
    INJECTION_DENIED: "security_denied",
    SECRET_REDACTED: "security_denied",
    WRITE_SAFETY_DENIED: "security_denied",
    MEMORY_DENIED: "security_denied",
    SKILL_DENIED: "security_denied",
    MCP_DENIED: "security_denied",
};
/** Total, fail-closed: any ErrorCode resolves to a TerminationReason. */
export function deniedTermination(code) {
    return DENIED_TERMINATION[code] ?? "security_denied";
}
// ---------------------------------------------------------------------------
// Typed guarded sets and predicates (no repeated string literals)
// ---------------------------------------------------------------------------
/** Permission/approval/sandbox denials — the set a tool orchestrator maps to a
 *  "denied" outcome status. Centralizes the former `code.startsWith("SANDBOX")`. */
const PERMISSION_OR_SANDBOX_DENIED = new Set([
    "PERMISSION_DENIED",
    "APPROVAL_DENIED",
    "SANDBOX_DENIED",
    "SANDBOX_FILESYSTEM_DENIED",
    "SANDBOX_PROCESS_DENIED",
    "SANDBOX_NETWORK_DENIED",
]);
/** Timeout-class errors (a single deliberated terminal classification). */
const TIMEOUT_ERRORS = new Set(["PROCESS_TIMEOUT"]);
/** User / caller-initiated cancellation. */
const CANCELLED_ERRORS = new Set(["USER_CANCELLED"]);
/** Internal / invariant-broken failures. */
const INTERNAL_ERRORS = new Set(["INTERNAL_ERROR"]);
/** Model-side failures. */
const MODEL_ERRORS = new Set(["MODEL_ERROR"]);
/** True when a code denotes a permission, approval, or sandbox denial. */
export function isPermissionOrSandboxDenied(code) {
    return PERMISSION_OR_SANDBOX_DENIED.has(code);
}
/** True for any error in the "denied" family (permission / sandbox / security). */
export function isDeniedErrorCode(code) {
    return code in DENIED_TERMINATION;
}
/** True for a timeout-class code. */
export function isTimeoutErrorCode(code) {
    return TIMEOUT_ERRORS.has(code);
}
/** True for a user/caller-initiated cancellation. */
export function isCancelledErrorCode(code) {
    return CANCELLED_ERRORS.has(code);
}
/** True for an internal / invariant-broken failure. */
export function isInternalErrorCode(code) {
    return INTERNAL_ERRORS.has(code);
}
/** True for a model-side failure. */
export function isModelErrorCode(code) {
    return MODEL_ERRORS.has(code);
}
// ---------------------------------------------------------------------------
// RetryKind → TerminationReason
// ---------------------------------------------------------------------------
/** The TerminationReason a retry kind surfaces when its budget is exhausted,
 *  read straight from the authoritative P2-40 governance table. */
export function retryKindTermination(kind) {
    return RETRY_KIND_SPECS[kind].terminationBehavior;
}
//# sourceMappingURL=taxonomy.js.map