export declare const ERROR_CODES: readonly ["MODEL_ERROR", "TOOL_SCHEMA_ERROR", "PERMISSION_DENIED", "APPROVAL_DENIED", "SANDBOX_DENIED", "SANDBOX_FILESYSTEM_DENIED", "SANDBOX_PROCESS_DENIED", "SANDBOX_NETWORK_DENIED", "SECURITY_DENIED", "INJECTION_DENIED", "SECRET_REDACTED", "WRITE_SAFETY_DENIED", "MEMORY_DENIED", "SKILL_DENIED", "MCP_DENIED", "PROCESS_ERROR", "PROCESS_TIMEOUT", "NETWORK_ERROR", "CONTEXT_OVERFLOW", "VERIFICATION_FAILED", "RESOURCE_LIMIT", "RESUME_FAILED", "USER_CANCELLED", "INTERNAL_ERROR"];
export type ErrorCode = (typeof ERROR_CODES)[number];
/** P1-18: structured provider failure classification (observability + policy). */
export type ProviderFailureKind = "rate_limit" | "server_error" | "timeout" | "network" | "http" | "protocol";
export interface AgentErrorInfo {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    safeToRetry: boolean;
    evidence?: string;
    cause?: unknown;
    /** P1-18: provider-side failure detail (status, Retry-After, class). */
    provider?: {
        kind: ProviderFailureKind;
        status?: number;
        retryAfterMs?: number;
    };
}
export declare const ERROR_DEFAULT_MESSAGES: Record<ErrorCode, string>;
/** Default retry policy for each failure class. Auto-retry is unsafe by default. */
export declare const ERROR_RETRY_DEFAULTS: Record<ErrorCode, {
    retryable: boolean;
    safeToRetry: boolean;
}>;
export declare function errorInfo(code: ErrorCode, message?: string, overrides?: Partial<Pick<AgentErrorInfo, "retryable" | "safeToRetry" | "evidence" | "cause" | "provider">>): AgentErrorInfo;
/** Canonical error class shared by all packages. */
export declare class AgentError extends Error {
    readonly info: AgentErrorInfo;
    constructor(info: AgentErrorInfo);
}
//# sourceMappingURL=errors.d.ts.map