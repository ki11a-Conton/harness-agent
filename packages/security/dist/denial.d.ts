import type { ErrorCode, EventSink, EventType, SessionId, TurnId } from "@ar/contracts";
/**
 * P0-7: unified security-deny surface. Every security rejection in the system
 * (sandbox, permission, injection, secret, memory, skill, MCP, approval)
 * resolves to a single normalized record — dimension + error code + security
 * event type + source + reason + target (when applicable). Emitters build one
 * `SecurityDenial` and hand it to `emitSecurityDenial`; the event stream and
 * the error code therefore agree on what happened. A denial must NEVER be
 * stderr-only: it is written to the event stream via the EventSink.
 *
 * §958-978: structured reason / security event / error code / target / source
 * / sessionId / turnId / toolCallId. sessionId/turnId/toolCallId are carried
 * by the envelope (emit) and the tool-call context at the call site; the
 * denial record carries the fields that a subsystem knows unconditionally.
 */
export type SecurityDimension = "network" | "filesystem" | "process" | "permission" | "injection" | "secret" | "memory" | "skill" | "mcp" | "approval";
export interface SecurityDenial {
    dimension: SecurityDimension;
    /** Human-read / machine-postable reason (e.g. "path outside workspace"). */
    reason: string;
    /** Which subsystem surfaced the denial (e.g. "memory-store",
     *  "sandbox-filesystem", "mcp-adapter"). Consistent with §961 source. */
    source: string;
    /** Error code carried by the resulting AgentError (e.g. MEMORY_DENIED). */
    code: ErrorCode;
    /** The denied subject — a file path, tool name, command, URL, … */
    target?: string;
    /** Optional named sub-detections (e.g. injection reasons, secret kinds). */
    details?: string[];
}
/** Map a dimension to its event-stream type (§964 security event). */
export declare function securityEventType(dimension: SecurityDimension): EventType;
/** Map a dimension to its default error code (§965 error code). */
export declare function securityErrorCode(dimension: SecurityDimension): ErrorCode;
/** Normalize a denial to the uniform event payload (§958-962). Omitted
 *  optional fields stay absent so consumers can trust presence. */
export declare function denialPayload(denial: SecurityDenial): Record<string, unknown>;
/** Emit a normalized security denial onto the event stream. The event type and
 *  payload come from the dimension; sessionId/turnId ride the envelope. A
 *  throwing emit is intentionally surfaced (denials are audit-relevant); the
 *  caller may choose to swallow if the sink is best-effort. */
export declare function emitSecurityDenial(sink: EventSink, sessionId: SessionId, denial: SecurityDenial, turnId?: TurnId): Promise<void>;
//# sourceMappingURL=denial.d.ts.map