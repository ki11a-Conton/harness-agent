/** Map a dimension to its event-stream type (§964 security event). */
export function securityEventType(dimension) {
    switch (dimension) {
        case "network":
            return "security.network_denied";
        case "filesystem":
            return "security.filesystem_denied";
        case "process":
            return "security.process_denied";
        case "permission":
            return "security.permission_denied";
        case "injection":
            return "security.injection_denied";
        case "secret":
            return "security.secret_redacted";
        case "memory":
            return "security.memory_denied";
        case "skill":
            return "security.skill_denied";
        case "mcp":
            return "security.mcp_denied";
        case "approval":
            return "security.approval_denied";
    }
}
/** Map a dimension to its default error code (§965 error code). */
export function securityErrorCode(dimension) {
    switch (dimension) {
        case "network":
            return "SANDBOX_NETWORK_DENIED";
        case "filesystem":
            return "SANDBOX_FILESYSTEM_DENIED";
        case "process":
            return "SANDBOX_PROCESS_DENIED";
        case "permission":
            return "PERMISSION_DENIED";
        case "injection":
            return "INJECTION_DENIED";
        case "secret":
            return "SECRET_REDACTED";
        case "memory":
            return "MEMORY_DENIED";
        case "skill":
            return "SKILL_DENIED";
        case "mcp":
            return "MCP_DENIED";
        case "approval":
            return "APPROVAL_DENIED";
    }
}
/** Normalize a denial to the uniform event payload (§958-962). Omitted
 *  optional fields stay absent so consumers can trust presence. */
export function denialPayload(denial) {
    return {
        reason: denial.reason,
        code: denial.code,
        source: denial.source,
        ...(denial.target !== undefined ? { target: denial.target } : {}),
        ...(denial.details !== undefined && denial.details.length > 0 ? { details: denial.details } : {}),
    };
}
/** Emit a normalized security denial onto the event stream. The event type and
 *  payload come from the dimension; sessionId/turnId ride the envelope. A
 *  throwing emit is intentionally surfaced (denials are audit-relevant); the
 *  caller may choose to swallow if the sink is best-effort. */
export async function emitSecurityDenial(sink, sessionId, denial, turnId) {
    await sink.emit(sessionId, securityEventType(denial.dimension), denialPayload(denial), turnId);
}
//# sourceMappingURL=denial.js.map