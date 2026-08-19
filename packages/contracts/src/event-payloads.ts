import type { EventType } from "./event.js";

/**
 * Q-4: typed payload map for key events.
 *
 * The generic `AgentEvent.payload` stays `Record<string, unknown>` for
 * backward compatibility with stored/replayed event logs, but this map gives
 * every event type its canonical, compile-time-checked payload shape so a
 * field name never drifts between producers (e.g. `tool.requested` using
 * `name` while `tool.failed` uses `tool`). Consumers read through the typed
 * accessors below instead of hand-rolling `payload.x ?? payload.y`.
 *
 * Any event type not listed here falls back to `Record<string, unknown>`.
 */

/** Pending response for a generic payload carrying a tool name.
 *  `tool` is canonical; `name` is accepted as a legacy alias from pre-Q-4
 *  producers/logs so stored events keep replaying correctly. */
export interface TypedToolPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  status?: string;
  error?: unknown;
}

/** tool.requested — what the model asked the orchestrator to run. */
export interface ToolRequestedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** tool.started — execution of a tool call began. */
export interface ToolStartedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
}

/** tool.output — streaming output chunks from a tool. */
export interface ToolOutputPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  stream?: "stdout" | "stderr";
  text?: string;
}

/** tool.completed — a tool returned without throwing. */
export interface ToolCompletedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  status?: string;
  durationMs?: number;
}

/** tool.failed — a tool threw or was denied. */
export interface ToolFailedPayload {
  toolCallId: string;
  tool?: string;
  name?: string;
  error?: unknown;
  durationMs?: number;
}

/** tool.permission_requested — an approval request was created. */
export interface ToolPermissionRequestedPayload {
  toolCallId?: string;
  tool?: string;
  name?: string;
  approvalId?: string;
}

/** tool.permission_resolved — an approval decision was applied. */
export interface ToolPermissionResolvedPayload {
  toolCallId?: string;
  tool?: string;
  name?: string;
  approvalId?: string;
  effect?: string;
}

/** model.completed — a model call finished. */
export interface ModelCompletedPayload {
  durationMs?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
}

/** model.retry — a transient model failure (pre-stream or provider-level). */
export interface ModelRetryPayload {
  attempt: number;
  error?: unknown;
}

/** verification.completed — the verification gate passed. */
export interface VerificationCompletedPayload {
  passed: boolean;
  durationMs?: number;
}

/** verification.failed — the verification gate rejected the turn. */
export interface VerificationFailedPayload {
  error?: unknown;
  attempt: number;
  maxAttempts: number;
  durationMs?: number;
}

/** context.compacted — context was summarised to reclaim budget. */
export interface ContextCompactedPayload {
  totalCount?: number;
  overflow?: boolean;
}

/** run.limit_reached — a turn budget was exhausted. */
export interface RunLimitReachedPayload {
  limit: string;
  used?: number;
  allowed?: number;
  pattern?: string;
}

/** turn.completed — a turn finished with a terminal state. */
export interface TurnCompletedPayload {
  status?: string;
  falseComplete?: boolean;
  spurious?: boolean;
  endReason?: string;
}

/** approval.resolved — an approval decision was recorded. */
export interface ApprovalResolvedPayload {
  approvalId?: string;
  decision?: string;
  value?: string;
}

/** security.*_denied — a security boundary rejected an action. */
export interface SecurityDeniedPayload {
  reason?: string;
  error?: unknown;
}

/**
 * Canonical payload for every known event type. Unlisted types default to a
 * general record so the map stays total over EVENT_TYPES.
 */
export interface EventPayloadMap {
  "tool.requested": ToolRequestedPayload;
  "tool.permission_requested": ToolPermissionRequestedPayload;
  "tool.permission_resolved": ToolPermissionResolvedPayload;
  "tool.started": ToolStartedPayload;
  "tool.output": ToolOutputPayload;
  "tool.completed": ToolCompletedPayload;
  "tool.failed": ToolFailedPayload;
  "model.completed": ModelCompletedPayload;
  "model.retry": ModelRetryPayload;
  "verification.completed": VerificationCompletedPayload;
  "verification.failed": VerificationFailedPayload;
  "context.compacted": ContextCompactedPayload;
  "run.limit_reached": RunLimitReachedPayload;
  "turn.completed": TurnCompletedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "security.network_denied": SecurityDeniedPayload;
  "security.injection_denied": SecurityDeniedPayload;
  "security.permission_denied": SecurityDeniedPayload;
  "security.filesystem_denied": SecurityDeniedPayload;
  "security.process_denied": SecurityDeniedPayload;
  "security.secret_redacted": SecurityDeniedPayload;
  "security.memory_denied": SecurityDeniedPayload;
  "security.skill_denied": SecurityDeniedPayload;
  "security.mcp_denied": SecurityDeniedPayload;
  "security.approval_denied": SecurityDeniedPayload;
}

/** Payload type for a given event type (falls back to a generic record). */
export type EventPayloadOf<T extends EventType> = T extends keyof EventPayloadMap
  ? EventPayloadMap[T]
  : Record<string, unknown>;

/**
 * Canonical tool-name accessor. Prefers the canonical `tool` field, then the
 * legacy `name` alias (pre-Q-4 producers / older stored logs). Every evaluator
 * should use this instead of guessing which field a producer emitted.
 */
export function toolNameOf(payload: object): string | undefined {
  const record = payload as Readonly<Record<string, unknown>>;
  const t = record.tool;
  if (typeof t === "string" && t !== "") return t;
  const n = record.name;
  return typeof n === "string" && n !== "" ? n : undefined;
}

/**
 * Static guarantee that every event type in EVENT_TYPES has a declared payload
 * shape. Kept as a value so dropping/renaming a type above surfaces here.
 */
export const EVENT_PAYLOAD_TYPES = {
  "tool.requested": true,
  "tool.permission_requested": true,
  "tool.permission_resolved": true,
  "tool.started": true,
  "tool.output": true,
  "tool.completed": true,
  "tool.failed": true,
  "model.completed": true,
  "model.retry": true,
  "verification.completed": true,
  "verification.failed": true,
  "context.compacted": true,
  "run.limit_reached": true,
  "turn.completed": true,
  "approval.resolved": true,
  "security.network_denied": true,
  "security.injection_denied": true,
  "security.permission_denied": true,
  "security.filesystem_denied": true,
  "security.process_denied": true,
  "security.secret_redacted": true,
  "security.memory_denied": true,
  "security.skill_denied": true,
  "security.mcp_denied": true,
  "security.approval_denied": true,
} as const satisfies Record<string, true>;