import type { EventId, SessionId, TurnId } from "./ids.js";
import { newEventId } from "./ids.js";

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
  "mcp.connect_failed",
  "recovery.decided",
  "protocol.repaired",
  "protocol.repair_failed",
  "tool.requested",
  "tool.permission_requested",
  "tool.permission_resolved",
  "tool.intent_persisted",
  "tool.started",
  "tool.output",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "tools.selected",
  "command.discovered",
  "context.built",
  "context.compacted",
  "context.protected_facts_violation",
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
  "runtime.degraded",
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
  "security.capability_denied",
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
  /**
   * P26-1: append WITHOUT a caller-allocated sequence. The store is the sole
   * sequence authority: it stamps `sequence` atomically at the store boundary
   * (serialized per session) and returns the stored event. Production writers
   * MUST use this — never `nextSequence` + `append` (a non-atomic pair that a
   * concurrent writer can interleave). `nextSequence` remains only for
   * read-side/back-compat callers.
   */
  appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent>;
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

/**
 * Adapt an {@link EventStore} to the {@link EventSink} shape so a runtime seam
 * (e.g. the session actor's optional `emit`) can write terminal events through
 * the same durable store the runtime uses.
 *
 * P38.1-12/13: when a starting turn reservation is revoked before promotion the
 * runtime is uninvolved, so its normal terminal event is never produced. Hosts
 * wire this adapter (backed by their EventStore) into the actor seam to keep
 * the event stream complete.
 */
export function eventSinkFromStore(
  store: EventStore,
  now: () => number = () => Date.now(),
): EventSink {
  return {
    async emit(sessionId, type, payload, turnId) {
      // P26-1: store-owned atomic sequence allocation (appendNew).
      await store.appendNew({
        id: newEventId(),
        sessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        timestamp: now(),
        type,
        payload,
      });
    },
  };
}

/**
 * P26-2 — semantic durability journal events. The event trail IS the
 * canonical semantic journal: no second competing log is created. These kinds
 * are the semantic durability records a crash/recovery pipeline may rebuild
 * from; everything else is an observability-only delta (streaming chunks,
 * retries, security denials, progress, ...) and may be dropped/compacted
 * without losing the recoverable truth.
 *
 * Mapping (plan §P26-2 examples → existing EventType):
 *   turn.input_committed    → turn.started (input committed with the turn)
 *   tool.execution_started  → tool.started
 *   tool.outcome_committed  → tool.completed / tool.failed
 *   checkpoint.committed    → checkpoint.created
 */
export const SEMANTIC_JOURNAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  // session lifecycle
  "session.created",
  "session.resumed",
  "session.forked",
  // turn lifecycle (the turn's input is committed with turn.started)
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  // model sampling start (a step's world was frozen)
  "model.started",
  // side-effect lifecycle (P26-4 state machine)
  "tool.intent_persisted",
  "tool.permission_requested",
  "tool.permission_resolved",
  "tool.started",
  "tool.completed",
  "tool.failed",
  // checkpoint / approval / ask gates
  "checkpoint.created",
  "approval.created",
  "approval.resolved",
  "ask.user_asked",
  "ask.user_replied",
  // delegation + verification lifecycle
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "verification.started",
  "verification.completed",
  "verification.failed",
  // context compaction rewrites the recoverable working state
  "context.compacted",
]);

/** P26-2 — true when `type` is a semantic journal record (durable truth),
 *  false for observability-only deltas. */
export function isSemanticJournalEvent(type: EventType): boolean {
  return SEMANTIC_JOURNAL_EVENTS.has(type);
}

/**
 * P26-3 — honest durability declaration. Never over-claimed:
 *  "memory"     — data lost on process exit (in-memory fakes).
 *  "process"    — survives process crashes (OS page cache survives).
 *  "crash_safe" — survives OS crash / power loss (fsync or equivalent).
 */
export type DurabilityLevel = "memory" | "process" | "crash_safe";

/**
 * P26-3 — a durability fence: a point in the stream up to which the store
 * guarantees every event is durably settled at its declared level. Used at
 * turn/checkpoint boundaries so an acked event cannot be lost on crash.
 */
export interface DurabilityFenceStore {
  readonly durabilityLevel: DurabilityLevel;
  /** Ensure every event up to (and including) `sequence` for the session is
   *  durably settled. Idempotent. Pass Number.MAX_SAFE_INTEGER to flush the
   *  whole session. */
  flushThrough(sessionId: SessionId, sequence: number): Promise<void>;
}