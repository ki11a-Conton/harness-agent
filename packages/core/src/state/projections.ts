// P26-7 — projections over the canonical journal.
//
// A projection is a REBUILDABLE VIEW of the journal + durable documents — it
// is NEVER an independent authority. Delete it, rebuild it, and the visible
// state must be identical. The canonical truth stays the event trail
// (semantic journal, P26-2) plus the durable SessionStore documents.

import type {
  AgentEvent,
  EventStore,
  ToolCallId,
  Message,
  Session,
  SessionId,
  SessionStatus,
  SessionStore,
  ToolExecutionRecord,
  Turn,
  TurnId,
  TurnStatus,
} from "@ar/contracts";
import { isSemanticJournalEvent } from "@ar/contracts";

export interface ProjectionDeps {
  store: SessionStore;
  events: EventStore;
}

/** SessionProjection — durable session + turn envelope summary. */
export interface SessionProjection {
  session: Session;
  turns: Turn[];
  messageCount: number;
  lastSequence: number;
}

/** TurnProjection — one turn's envelope: status, transcript size, tool calls. */
export interface TurnProjection {
  turnId: TurnId;
  status: TurnStatus;
  startedAt: number;
  completedAt?: number;
  messageCount: number;
  toolCallIds: string[];
}

/** TranscriptProjection — the session transcript + the semantic journal. */
export interface TranscriptProjection {
  messages: Message[];
  /** Only semantic journal records (P26-2) — observability deltas dropped. */
  semanticEvents: AgentEvent[];
}

/** ToolLedgerProjection — the executed-tool ledger rebuilt from the journal
 *  (intent → outcome), independent of the working-state copy. */
export interface ToolLedgerProjection {
  entries: ToolExecutionRecord[];
}

/** TraceProjection — the span tree from the event stream. */
export interface TraceProjection {
  events: AgentEvent[];
  /** Events without a parent span — the tree roots. */
  rootSpans: string[];
  /** parentSpanId → child span ids (child spans carry parentSpanId). */
  spanTree: ReadonlyMap<string, readonly string[]>;
}

export async function rebuildSessionProjection(
  deps: ProjectionDeps,
  sessionId: SessionId,
): Promise<SessionProjection> {
  const session = await deps.store.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`session ${sessionId} not found`);
  }
  const [turns, events, messages] = await Promise.all([
    deps.store.listTurns(sessionId),
    deps.events.list(sessionId),
    deps.store.listMessages(sessionId),
  ]);
  const lastSequence = events.length > 0 ? events[events.length - 1]!.sequence : -1;
  return { session, turns, messageCount: messages.length, lastSequence };
}

export async function rebuildTurnProjection(
  deps: ProjectionDeps,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<TurnProjection> {
  const [turn, messages, events] = await Promise.all([
    deps.store.getTurn(turnId),
    deps.store.listMessagesByTurn(sessionId, turnId),
    deps.events.list(sessionId),
  ]);
  if (turn === undefined) {
    throw new Error(`turn ${turnId} not found`);
  }
  const toolCallIds: string[] = [];
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.type !== "tool.requested" && event.type !== "tool.intent_persisted") continue;
    const id = event.payload.toolCallId;
    if (typeof id === "string" && !toolCallIds.includes(id)) toolCallIds.push(id);
  }
  return {
    turnId: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    ...(turn.completedAt !== undefined ? { completedAt: turn.completedAt } : {}),
    messageCount: messages.length,
    toolCallIds,
  };
}

export async function rebuildTranscriptProjection(
  deps: ProjectionDeps,
  sessionId: SessionId,
): Promise<TranscriptProjection> {
  const [messages, events] = await Promise.all([
    deps.store.listMessages(sessionId),
    deps.events.list(sessionId),
  ]);
  return {
    messages,
    semanticEvents: events.filter((e) => isSemanticJournalEvent(e.type)),
  };
}

/** Rebuild the executed-tool ledger from the journal state machine
 *  (P26-4): intent_persisted → outcome. Status is taken from the terminal
 *  outcome event when present, else "unknown" (crash window). */
export async function rebuildToolLedgerProjection(
  deps: ProjectionDeps,
  sessionId: SessionId,
): Promise<ToolLedgerProjection> {
  const events = await deps.events.list(sessionId);
  const byCall = new Map<string, ToolExecutionRecord>();
  for (const event of events) {
    const toolCallId = event.payload.toolCallId;
    if (typeof toolCallId !== "string") continue;
    if (event.type === "tool.intent_persisted") {
      byCall.set(toolCallId, {
        toolCallId: toolCallId as ToolCallId,
        tool: typeof event.payload.tool === "string" ? event.payload.tool : "unknown",
        argsHash: typeof event.payload.argsHash === "string" ? event.payload.argsHash : "",
        started: event.timestamp,
        completed: event.timestamp,
        // No terminal outcome yet (crash window) → "interrupted" (the ledger's
        // "started without terminal outcome" reconciliation state).
        status: "interrupted",
        sideEffect: event.payload.sideEffectScope !== "none",
      });
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      const existing = byCall.get(toolCallId);
      const status = event.type === "tool.completed" ? "success" : "failed";
      if (existing !== undefined) {
        existing.completed = event.timestamp;
        existing.status = status;
      } else {
        // Outcome without a captured intent (legacy logs): still journaled.
        byCall.set(toolCallId, {
          toolCallId: toolCallId as ToolCallId,
          tool: typeof event.payload.tool === "string" ? event.payload.tool : "unknown",
          argsHash: "",
          started: event.timestamp,
          completed: event.timestamp,
          status,
          sideEffect: true,
        });
      }
    }
  }
  return { entries: [...byCall.values()] };
}

export async function rebuildTraceProjection(
  deps: ProjectionDeps,
  sessionId: SessionId,
): Promise<TraceProjection> {
  const events = await deps.events.list(sessionId);
  const spanTree = new Map<string, string[]>();
  const rootSpans: string[] = [];
  for (const event of events) {
    const spanId = event.spanId;
    if (spanId === undefined) continue;
    if (event.parentSpanId !== undefined) {
      const siblings = spanTree.get(event.parentSpanId) ?? [];
      if (!siblings.includes(spanId)) siblings.push(spanId);
      spanTree.set(event.parentSpanId, siblings);
    } else {
      if (!rootSpans.includes(spanId)) rootSpans.push(spanId);
    }
  }
  return { events, rootSpans, spanTree };
}
