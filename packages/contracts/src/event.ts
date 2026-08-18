import type { EventId, SessionId, TurnId } from "./ids.js";

export const EVENT_TYPES = [
  "session.created",
  "session.resumed",
  "session.forked",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "model.started",
  "model.delta",
  "model.completed",
  "model.failed",
  "model.retry",
  "retry.provider",
  "retry.stallRecovery",
  "tool.requested",
  "tool.permission_requested",
  "tool.permission_resolved",
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
  "context.built",
  "context.compacted",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "verification.started",
  "verification.completed",
  "verification.failed",
  "memory.candidate",
  "memory.persisted",
  "skill.discovered",
  "skill.loaded",
  "skill.updated",
  "instruction.discovered",
  "approval.created",
  "approval.resolved",
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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AgentEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  sequence: number;
  timestamp: number;
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