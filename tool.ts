import type { ZodType } from "zod";
import type { AgentErrorInfo, ErrorCode } from "./errors.js";
import type { AgentId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { PermissionPolicy } from "./permission.js";
import type { SandboxPolicy } from "./sandbox.js";
import type { Evidence } from "./verification.js";

export interface ToolCall {
  id: ToolCallId;
  name: string;
  args: Record<string, unknown>;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolRisk = "readonly" | "side_effect" | "elevated" | "critical";

/**
 * Auto-retry classification for the recovery engine (plan.md Phase 3.6):
 * - "safe"    → idempotent read-only; the runtime MAY auto-retry on
 *               failure/timeout (bounded by RecoveryPolicy).
 * - "unknown" → side effects unknown (exec, network); the runtime must NOT
 *               auto-retry — a lost result could have already happened.
 * - "none"    → non-idempotent write (write_file/edit_file); never retry.
 */
export type ToolRetryPolicy = "safe" | "unknown" | "none";

/** Narrow capability projection the runtime consumes for retry gating and
 *  concurrency planning (plan.md Phase 3.2/3.3). */
export interface ToolCapability {
  retry: ToolRetryPolicy;
  concurrencySafe: boolean;
}

export const DEFAULT_TOOL_CAPABILITY: ToolCapability = {
  retry: "unknown",
  concurrencySafe: false,
};

/**
 * P1-11: structured tool execution semantics. One field per runtime decision
 * the runtime makes about a tool (retry, parallel, checkpoint, resume,
 * approval, sandbox, output handling) — the replacement for name-based
 * hardcodes (e.g. SIDE_EFFECT_TOOLS) and scattered boolean capability flags.
 */
export interface ToolSemantics {
  /** True when the tool never mutates external state. */
  readOnly: boolean;
  /** True when executing with the same args twice has no duplicate effect. */
  idempotent: boolean;
  /** Auto-retry classification (reuses ToolRetryPolicy). */
  retrySafety: ToolRetryPolicy;
  /** True when concurrent execution of this tool is safe. */
  concurrencySafety: boolean;
  /** Where side effects land; "none" means no external side effects. */
  sideEffectScope: "none" | "filesystem" | "process" | "network" | "global";
  /** True when an in-flight call can be aborted cleanly. */
  cancellable: boolean;
  /** True when the tool must go through explicit human approval. */
  requiresApproval: boolean;
  /** Network exposure of the tool. */
  networkBehavior: "none" | "outbound";
  /** Sensitivity of the tool's output for redaction/retention. */
  outputSensitivity: "low" | "medium" | "high";
}

/** Conservative semantics for unknown tools: no side effects assumed, not
 *  auto-retried, serialized. */
export const DEFAULT_TOOL_SEMANTICS: ToolSemantics = {
  readOnly: false,
  idempotent: false,
  retrySafety: "unknown",
  concurrencySafety: false,
  sideEffectScope: "none",
  cancellable: true,
  requiresApproval: false,
  networkBehavior: "none",
  outputSensitivity: "medium",
};

/** Derives full semantics from the legacy metadata/risk fields, so existing
 *  ToolDefinitions migrate without changes (P1-11 step 1 — no scatter, no
 *  name matching). */
export function toToolSemantics(metadata: ToolMetadata, risk?: ToolRisk): ToolSemantics {
  let sideEffectScope: ToolSemantics["sideEffectScope"] = "none";
  if (metadata.sideEffect) {
    sideEffectScope = metadata.process
      ? "process"
      : metadata.filesystem
        ? "filesystem"
        : metadata.network
          ? "network"
          : "global";
  }
  return {
    readOnly: !metadata.sideEffect,
    idempotent: metadata.retry === "safe",
    retrySafety: metadata.retry ?? DEFAULT_TOOL_SEMANTICS.retrySafety,
    concurrencySafety: metadata.concurrencySafe ?? DEFAULT_TOOL_SEMANTICS.concurrencySafety,
    sideEffectScope,
    cancellable: true,
    requiresApproval: risk === "elevated" || risk === "critical",
    networkBehavior: metadata.network ? "outbound" : "none",
    outputSensitivity: "medium",
  };
}

export interface ToolMetadata {
  name: string;
  version: string;
  sideEffect: boolean;
  network: boolean;
  filesystem: boolean;
  process: boolean;
  interactive: boolean;
  /** Auto-retry classification (plan.md Phase 3.6). Default "unknown". */
  retry?: ToolRetryPolicy;
  /** True when concurrent execution is safe (read-only, stateless, no shared
   *  mutable state). Default false. */
  concurrencySafe?: boolean;
}

export interface ToolError extends AgentErrorInfo {}

export interface ToolResult<T = unknown> {
  status: "success" | "failed" | "denied" | "cancelled" | "timeout";
  output?: T;
  error?: ToolError;
  evidence?: Evidence[];
  metadata?: Record<string, unknown>;
}

/** Streaming chunk emitted by tools (e.g. process stdout/stderr) as tool.output events. */
export interface ToolStreamEvent {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ToolExecutionContext {
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  cwd: string;
  signal: AbortSignal;
  /** Agent permission policy the orchestrator must evaluate against. */
  permissions: PermissionPolicy;
  /** Sandbox policy the orchestrator must enforce. */
  sandboxPolicy: SandboxPolicy;
  /** Streaming output channel — the orchestrator turns chunks into tool.output events. */
  onOutput?: (event: ToolStreamEvent) => void;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  risk: ToolRisk;
  metadata: ToolMetadata;

  execute(input: I, context: ToolExecutionContext): Promise<ToolResult<O>>;
}

export interface ToolCallRequest {
  id: ToolCallId;
  sessionId: SessionId;
  turnId?: TurnId;
  agentId: AgentId;
  call: ToolCall;
}

export type ToolResultStatus = ToolResult["status"];

export const TOOL_ERROR_CODES = [
  "TOOL_SCHEMA_ERROR",
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "SANDBOX_DENIED",
  "PROCESS_ERROR",
  "PROCESS_TIMEOUT",
  "NETWORK_ERROR",
  "RESOURCE_LIMIT",
  "USER_CANCELLED",
  "INTERNAL_ERROR",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number] & ErrorCode;

/** Orchestrator pipeline: resolve → validate → normalize → risk → permission
 *  → approval → sandbox → execute → limits → evidence → events → normalize. */
export interface ToolOrchestrator {
  execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult<unknown>>;
}