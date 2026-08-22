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

/** P18-2: rough advertisement-token estimate for one spec (chars / 4 ≈
 *  tokens). Prices the MODEL ADVERTISEMENT cost; monotone in schema size,
 *  no tokenizer needed. Lives in contracts so both the tools package (schema
 *  advert policy) and the core runtime (tools.selected telemetry) consume the
 *  SAME estimate. */
export function estimateSpecTokens(spec: ToolSpec): number {
  return Math.ceil(JSON.stringify(spec.inputSchema).length / 4);
}

export function estimateSpecsTokens(specs: readonly ToolSpec[]): number {
  let total = 0;
  for (const spec of specs) total += estimateSpecTokens(spec);
  return total;
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
 *  concurrency planning (plan.md Phase 3.2/3.3).
 *
 *  P18-1: LEGACY ADAPTER TYPE. `ToolSemantics` is the ONLY execution-policy
 *  source; `ToolCapability` exists solely as a derived projection for
 *  backwards-compatible callers and must NEVER act as a second decision
 *  source. The only way to build one is `toToolCapability()` from a
 *  ToolSemantics — nothing may derive a ToolCapability from raw metadata. */
export interface ToolCapability {
  retry: ToolRetryPolicy;
  concurrencySafe: boolean;
}

/** P18-1: THE single projection ToolSemantics → ToolCapability. Every legacy
 *  consumer must go through this function so the two views can never drift;
 *  the runtime itself decides on ToolSemantics fields directly. */
export function toToolCapability(semantics: ToolSemantics): ToolCapability {
  return {
    retry: semantics.retrySafety,
    concurrencySafe: semantics.concurrencySafety,
  };
}

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
  /** Where side effects land; "none" means no external side effects, "unknown"
   *  means the tool's effect is not declared (treat as side-effecting). */
  sideEffectScope: "none" | "filesystem" | "process" | "network" | "global" | "unknown";
  /** True when an in-flight call can be aborted cleanly. */
  cancellable: boolean;
  /** True when the tool must go through explicit human approval. */
  requiresApproval: boolean;
  /** Network exposure of the tool; "unknown" means not declared. */
  networkBehavior: "none" | "outbound" | "unknown";
  /** Sensitivity of the tool's output for redaction/retention. */
  outputSensitivity: "low" | "medium" | "high";
}

/**
 * P18-6: resource conflict keys for concurrency. Two tool calls with the
 * SAME key mutate the same resource and must never run in parallel, even if
 * both are otherwise `concurrencySafe`. Keys are produced per CALL by
 * `resourceConflictOf` (args-derived) — the static `ToolSemantics` cannot
 * express an instance-specific target.
 *
 * Canonical key forms (stable strings, never the raw args):
 *   - `file:<canonical-path>`   — a file mutation (canonical path)
 *   - `store:<session-id>`      — a store/session mutation
 *   - `global`                  — the whole-world lock (never parallel)
 */
export type ResourceConflictKey = string;

/** P18-6: canonical conflict key for a file mutation (resolve the path to its
 *  canonical form BEFORE calling this — the key must be a canonical path). */
export function fileConflictKey(canonicalPath: string): ResourceConflictKey {
  return `file:${canonicalPath}`;
}

/** P18-6: canonical conflict key for a store/session mutation. */
export function storeConflictKey(sessionId: string): ResourceConflictKey {
  return `store:${sessionId}`;
}

/** P18-6: the global lock — no tool holding it may run in parallel with any
 *  other. */
export const GLOBAL_CONFLICT_KEY: ResourceConflictKey = "global";

/** P18-6: does a call already admitted to the batch conflict with a new one?
 *  `undefined` keys never conflict (unknown target → conservative callers
 *  keep such tools serial via concurrencySafety instead). */
export function resourceConflicts(
  admitted: readonly { conflictKey?: ResourceConflictKey }[],
  candidate: { conflictKey?: ResourceConflictKey },
): boolean {
  if (candidate.conflictKey === undefined) return false;
  if (candidate.conflictKey === GLOBAL_CONFLICT_KEY) return true;
  return admitted.some((a) => a.conflictKey === candidate.conflictKey);
}

/**
 * Fail-closed semantics for unknown tools (plan.md P0-8): the runtime cannot
 * prove a tool has no side effects, so it must assume effects — never
 * auto-retried, never run in parallel, checkpointed as a side effect, surfaced
 * for reconciliation on crash resume, and gated behind approval by default.
 * Compare: DEFAULT_TOOL_CAPABILITY is the narrower retry/concurrency view;
 * this is the full execution-semantics view.
 */
export const DEFAULT_TOOL_SEMANTICS: ToolSemantics = {
  readOnly: false,
  idempotent: false,
  retrySafety: "unknown",
  concurrencySafety: false,
  sideEffectScope: "unknown",
  cancellable: false,
  requiresApproval: true,
  networkBehavior: "unknown",
  outputSensitivity: "high",
};

/** Legacy default view — the projection of DEFAULT_TOOL_SEMANTICS. Defined
 *  after the semantics constant (TDZ-safe): it is PURELY a derived view and
 *  must never be treated as an independent configuration. */
export const DEFAULT_TOOL_CAPABILITY: ToolCapability = toToolCapability(DEFAULT_TOOL_SEMANTICS);

/** P0-8: does this tool's semantics allow treating it as side-effect-free?
 *  "unknown" returns true (may have a side effect) — fail-closed. */
export function mayHaveSideEffect(semantics: ToolSemantics): boolean {
  return semantics.sideEffectScope !== "none";
}

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

/**
 * Streaming chunk emitted by tools as they run. P18-5: stdout/stderr chunks
 * become `tool.output` events and a `progress` chunk becomes a separate
 * `tool.progress` event — progress is NEVER a terminal result and never
 * counts as completion in the durable ledger (only `tool.completed`/`tool.failed`
 * settle a call).
 */
export interface ToolStreamEvent {
  stream: "stdout" | "stderr" | "progress";
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

/** P23-4 — a tool call whose tool binding was ALREADY resolved by the frozen
 *  step router. The orchestrator validates/executes against the frozen
 *  definition — never the mutable global catalog. */
export interface BoundToolCallRequest extends ToolCallRequest {
  readonly binding: import("./step-context.js").FrozenToolBinding;
  /** P26-4: frozen step-world identity carried into the intent journal so a
   *  crash-recovery can attribute an intent to the exact step + router that
   *  produced it. Optional for legacy callers; production AgentRuntime fills
   *  all three. */
  readonly stepId?: string;
  readonly routerFingerprint?: string;
  readonly toolBindingFingerprint?: string;
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
  "PERSISTENCE_ERROR",
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
  /** P23-4: execute against a FROZEN step binding (the exact definition the
   *  model saw), not the current global registry. Production AgentRuntime
   *  calls this; plain execute() stays for legacy/external callers. */
  executeBound(
    request: BoundToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult<unknown>>;
}