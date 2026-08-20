import type { EventId, SessionId, TurnId } from "./ids.js";

export const EVENT_TYPES = [
  "session.created",
  "session.resumed",
  "session.forked",
"turn.started",
"turn.completed",
"turn.failed",
"turn.cancelled",
"policy.changed_on_resume",
  "model.started",
  "model.delta",
  "model.completed",
  "model.failed",
  "model.retry",
  "retry.provider",
  "retry.stallRecovery",
  "retry.reconciliation",
  "retry.mcpReconnect",
  "tool.requested",
  "tool.permission_requested",
  "tool.permission_resolved",
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
  "tools.selected",
  "command.discovered",
  "context.built",
  "context.compacted",
  "context.candidate",
  "context.selected",
  "context.dropped",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "verification.started",
  "verification.step_started",
  "verification.step_completed",
  "verification.completed",
  "verification.failed",
  "memory.candidate",
  "memory.persisted",
  "memory.retrieved",
  "reflection.completed",
  "skill.discovered",
  "skill.loaded",
  "skill.updated",
  "instruction.discovered",
  "approval.created",
  "approval.resolved",
  "ask.user_asked",
  "ask.user_replied",
  "ask.turn_waiting",
  "human.approval",
  "human.correction",
  "human.message",
  "human.cancel",
  "human.override",
  "run.limit_reached",
  "checkpoint.created",
  "checkpoint.failed",
  "security.network_denied",
  "security.injection_denied",
  "security.permission_denied",
  "security.filesystem_denied",
  "security.process_denied",
  "security.secret_redacted",
  "security.memory_denied",
  "security.skill_denied",
  "security.mcp_denied",
  "security.approval_denied",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Event ABI version (P2-34). Bumped only when the serialized shape or payload
 * semantics of any `AgentEvent` change in a non-backward-compatible way.
 *
 * - The store stamps `schemaVersion: EVENT_ABI_VERSION` on every event it
 *   persists, so each stored event is self-describing.
 * - On read/replay, any event whose `schemaVersion` is missing or differs is
 *   rejected loudly (fail-closed) instead of being silently misparsed —
 *   resume/benchmark of old event logs must never guess at an incompatible format.
 * - A future migration (v2, ...) must add an explicit migration map here
 *   rather than loosening the read check.
 */
export const EVENT_ABI_VERSION = 1;

export interface AgentEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  sequence: number;
  timestamp: number;
  /** P9-2: trace span identifiers — the producing unit (model call, tool
   *  call, verification run) and its parent. Not required for any consumer;
   *  replay/explain use them to reconstruct the tree without OTel. */
  spanId?: string;
  parentSpanId?: string;
  /**
   * Event ABI version (P2-34). Optional on the producer side — the store stamps
   * the current `EVENT_ABI_VERSION` on persist and rejects a supplied value that
   * differs from the current version.
   */
  schemaVersion?: number;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface EventStore {
  append(event: AgentEvent): Promise<AgentEvent>;
  list(sessionId: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]>;
  stream(sessionId: SessionId, opts?: { afterSequence?: number }): AsyncIterable<AgentEvent>;
  nextSequence(sessionId: SessionId): Promise<number>;
}

/** Event emission surface used by subsystems (e.g. the orchestrator). */
export interface EventSink {
  emit(
    sessionId: SessionId,
    type: EventType,
    payload: Record<string, unknown>,
    turnId?: TurnId,
  ): Promise<void>;
}