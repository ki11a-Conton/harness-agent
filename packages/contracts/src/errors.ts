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
  "PERSISTENCE_ERROR",
  "RESUME_FAILED",
  "USER_CANCELLED",
  "SESSION_BUSY",
  "TOOL_COLLISION",
  "TOOL_NOT_IN_STEP",
  "CONFIG_DRIFT_REJECTED",
  "INTERNAL_ERROR",
  // P37-1: an operation that requires a live turn (e.g. steer) has none.
  "NO_ACTIVE_TURN",
  // P37-2: a load was cancelled by unload/close while in flight.
  "LOAD_CANCELLED",
  // P37-4: the transport closed before the terminal turn event arrived.
  "STREAM_TERMINATED_BEFORE_TURN_END",
  // P37-5: the SDK event buffer exceeded its configured bound.
  "STREAM_BUFFER_OVERFLOW",
  // P38.1-2: a followup could not be promoted to a running turn; the durable
  // input remains recoverable but the current caller must settle terminally.
  "FOLLOWUP_PROMOTION_FAILED",
  // P38.1-2: the session actor was closed while a queued followup caller was
  // still waiting for promotion.
  "ACTOR_CLOSED",
  // E1-02: an exec/tool cwd (or path) resolves outside the session workspace —
  // workspace containment violation with a stable, auditable reason code.
  "WORKSPACE_POLICY",
] as const;

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
  provider?: { kind: ProviderFailureKind; status?: number; retryAfterMs?: number };
}

export const ERROR_DEFAULT_MESSAGES: Record<ErrorCode, string> = {
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
  PERSISTENCE_ERROR: "Durable intent/state persistence failed",
  RESUME_FAILED: "Session resume failed",
  USER_CANCELLED: "Cancelled by user",
  SESSION_BUSY: "Session already has an active turn",
  TOOL_COLLISION: "Two tool sources produce the same model-visible name",
  TOOL_NOT_IN_STEP: "Tool is not present in the step frozen tool router",
  CONFIG_DRIFT_REJECTED: "Session config drift rejected (restart required or frozen key changed)",
  INTERNAL_ERROR: "Internal error",
  NO_ACTIVE_TURN: "No active turn for this operation",
  LOAD_CANCELLED: "Session load was cancelled",
  STREAM_TERMINATED_BEFORE_TURN_END: "Stream ended before the turn did",
  STREAM_BUFFER_OVERFLOW: "Event stream buffer overflow",
  FOLLOWUP_PROMOTION_FAILED: "Followup could not be promoted to a running turn",
  ACTOR_CLOSED: "Session actor closed before followup promotion",
  WORKSPACE_POLICY: "Path resolves outside the session workspace",
};

/** Default retry policy for each failure class. Auto-retry is unsafe by default. */
export const ERROR_RETRY_DEFAULTS: Record<ErrorCode, { retryable: boolean; safeToRetry: boolean }> = {
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
  PERSISTENCE_ERROR: { retryable: false, safeToRetry: false },
  RESUME_FAILED: { retryable: false, safeToRetry: false },
  USER_CANCELLED: { retryable: false, safeToRetry: false },
  SESSION_BUSY: { retryable: false, safeToRetry: false },
  TOOL_COLLISION: { retryable: false, safeToRetry: false },
  TOOL_NOT_IN_STEP: { retryable: false, safeToRetry: false },
  CONFIG_DRIFT_REJECTED: { retryable: false, safeToRetry: false },
  INTERNAL_ERROR: { retryable: false, safeToRetry: false },
  NO_ACTIVE_TURN: { retryable: false, safeToRetry: false },
  LOAD_CANCELLED: { retryable: false, safeToRetry: false },
  STREAM_TERMINATED_BEFORE_TURN_END: { retryable: true, safeToRetry: false },
  STREAM_BUFFER_OVERFLOW: { retryable: true, safeToRetry: false },
  FOLLOWUP_PROMOTION_FAILED: { retryable: true, safeToRetry: true },
  ACTOR_CLOSED: { retryable: false, safeToRetry: false },
  WORKSPACE_POLICY: { retryable: false, safeToRetry: false },
};

export function errorInfo(
  code: ErrorCode,
  message?: string,
  overrides?: Partial<Pick<AgentErrorInfo, "retryable" | "safeToRetry" | "evidence" | "cause" | "provider">>,
): AgentErrorInfo {
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
  readonly info: AgentErrorInfo;

  constructor(info: AgentErrorInfo) {
    super(info.message);
    this.name = "AgentError";
    this.info = info;
  }
}