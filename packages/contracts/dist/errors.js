export const ERROR_CODES = [
    "MODEL_ERROR",
    "TOOL_SCHEMA_ERROR",
    "PERMISSION_DENIED",
    "APPROVAL_DENIED",
    "SANDBOX_DENIED",
    "SANDBOX_FILESYSTEM_DENIED",
    "SANDBOX_PROCESS_DENIED",
    "SANDBOX_NETWORK_DENIED",
    "SECURITY_DENIED",
    "INJECTION_DENIED",
    "SECRET_REDACTED",
    "WRITE_SAFETY_DENIED",
    "MEMORY_DENIED",
    "SKILL_DENIED",
    "MCP_DENIED",
    "PROCESS_ERROR",
    "PROCESS_TIMEOUT",
    "NETWORK_ERROR",
    "CONTEXT_OVERFLOW",
    "VERIFICATION_FAILED",
    "RESOURCE_LIMIT",
    "RESUME_FAILED",
    "USER_CANCELLED",
    "INTERNAL_ERROR",
];
export const ERROR_DEFAULT_MESSAGES = {
    MODEL_ERROR: "Model provider failed",
    TOOL_SCHEMA_ERROR: "Tool input failed schema validation",
    PERMISSION_DENIED: "Action denied by permission policy",
    APPROVAL_DENIED: "Approval was denied",
    SANDBOX_DENIED: "Action denied by sandbox policy",
    SANDBOX_FILESYSTEM_DENIED: "Action denied by sandbox filesystem policy",
    SANDBOX_PROCESS_DENIED: "Action denied by sandbox process policy",
    SANDBOX_NETWORK_DENIED: "Action denied by sandbox network policy",
    SECURITY_DENIED: "Action denied by security policy",
    INJECTION_DENIED: "Prompt injection blocked",
    SECRET_REDACTED: "Sensitive secret redacted",
    WRITE_SAFETY_DENIED: "Write blocked by write-safety guard",
    MEMORY_DENIED: "Memory write/update denied by security policy",
    SKILL_DENIED: "Skill blocked by security policy",
    MCP_DENIED: "MCP tool blocked by security policy",
    PROCESS_ERROR: "Process failed",
    PROCESS_TIMEOUT: "Process timed out",
    NETWORK_ERROR: "Network request failed",
    CONTEXT_OVERFLOW: "Context budget exceeded",
    VERIFICATION_FAILED: "Verification failed",
    RESOURCE_LIMIT: "Resource limit exceeded",
    RESUME_FAILED: "Session resume failed",
    USER_CANCELLED: "Cancelled by user",
    INTERNAL_ERROR: "Internal error",
};
/** Default retry policy for each failure class. Auto-retry is unsafe by default. */
export const ERROR_RETRY_DEFAULTS = {
    MODEL_ERROR: { retryable: true, safeToRetry: true },
    TOOL_SCHEMA_ERROR: { retryable: false, safeToRetry: false },
    PERMISSION_DENIED: { retryable: false, safeToRetry: false },
    APPROVAL_DENIED: { retryable: false, safeToRetry: false },
    SANDBOX_DENIED: { retryable: false, safeToRetry: false },
    SANDBOX_FILESYSTEM_DENIED: { retryable: false, safeToRetry: false },
    SANDBOX_PROCESS_DENIED: { retryable: false, safeToRetry: false },
    SANDBOX_NETWORK_DENIED: { retryable: false, safeToRetry: false },
    SECURITY_DENIED: { retryable: false, safeToRetry: false },
    INJECTION_DENIED: { retryable: false, safeToRetry: false },
    SECRET_REDACTED: { retryable: false, safeToRetry: false },
    WRITE_SAFETY_DENIED: { retryable: false, safeToRetry: false },
    MEMORY_DENIED: { retryable: false, safeToRetry: false },
    SKILL_DENIED: { retryable: false, safeToRetry: false },
    MCP_DENIED: { retryable: false, safeToRetry: false },
    PROCESS_ERROR: { retryable: true, safeToRetry: false },
    PROCESS_TIMEOUT: { retryable: true, safeToRetry: false },
    NETWORK_ERROR: { retryable: true, safeToRetry: true },
    CONTEXT_OVERFLOW: { retryable: true, safeToRetry: true },
    VERIFICATION_FAILED: { retryable: false, safeToRetry: false },
    RESOURCE_LIMIT: { retryable: false, safeToRetry: false },
    RESUME_FAILED: { retryable: false, safeToRetry: false },
    USER_CANCELLED: { retryable: false, safeToRetry: false },
    INTERNAL_ERROR: { retryable: false, safeToRetry: false },
};
export function errorInfo(code, message, overrides) {
    const defaults = ERROR_RETRY_DEFAULTS[code];
    return {
        code,
        message: message ?? ERROR_DEFAULT_MESSAGES[code],
        retryable: overrides?.retryable ?? defaults.retryable,
        safeToRetry: overrides?.safeToRetry ?? defaults.safeToRetry,
        ...(overrides?.evidence !== undefined ? { evidence: overrides.evidence } : {}),
        ...(overrides?.cause !== undefined ? { cause: overrides.cause } : {}),
        ...(overrides?.provider !== undefined ? { provider: overrides.provider } : {}),
    };
}
/** Canonical error class shared by all packages. */
export class AgentError extends Error {
    info;
    constructor(info) {
        super(info.message);
        this.name = "AgentError";
        this.info = info;
    }
}
//# sourceMappingURL=errors.js.map