import type { AgentEvent, EventStore, SessionId, TurnId } from "@ar/contracts";

export type ReplayTurnStatus = "completed" | "failed" | "cancelled" | "running" | "unknown";

export interface TurnReplay {
  turnId: TurnId;
  status: ReplayTurnStatus;
  toolCalls: number;
  firstEventAt: number;
  lastEventAt: number;
}

/**
 * Message-level summary recovered from the event log (REPLAY-001).
 * Derived from tool.output (kind "output") and tool.failed (kind "error") events.
 */
export interface ReplayMessage {
  turnId?: TurnId;
  kind: "output" | "error";
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  error?: unknown;
  timestamp: number;
}

export interface ReplayResult {
  sessionId: SessionId;
  turns: TurnReplay[];
  events: number;
  messages: ReplayMessage[];
  /** Orphan tool calls (plan.md Phase 5.4): a tool that STARTED but never
   *  completed/failed — the process died mid-execution. Marked
   *  interrupted/unknown_effect; never re-executed by default. */
  orphans: OrphanToolCall[];
}

export interface OrphanToolCall {
  turnId: TurnId;
  toolCallId: string;
  toolName?: string;
  startedAt: number;
  lastEventAt: number;
}

export interface SessionReplayerDeps {
  events: EventStore;
}

export interface CompareResult {
  ok: boolean;
  issues: string[];
}

export interface TurnSnapshotRecord {
  id?: string;
  turnId?: string;
  status?: string;
}

/**
 * Reconstruct per-turn state from the event log. Depends only on the EventStore
 * contract, so any concrete event store (JSONL, memory, ...) can be injected.
 */
export class SessionReplayer {
  private readonly events: EventStore;

  constructor(deps: SessionReplayerDeps) {
    this.events = deps.events;
  }

  async replay(sessionId: SessionId): Promise<ReplayResult> {
    const all = await this.events.list(sessionId, {});
    // EventStores should return append order, but sort defensively so the
    // "last event wins" state machine is deterministic regardless of list order.
    const ordered = [...all].sort((a, b) => a.sequence - b.sequence);

    const byTurn = new Map<TurnId, AgentEvent[]>();
    for (const ev of ordered) {
      if (ev.turnId === undefined) continue;
      const bucket = byTurn.get(ev.turnId);
      if (bucket === undefined) {
        byTurn.set(ev.turnId, [ev]);
      } else {
        bucket.push(ev);
      }
    }

    const turns: TurnReplay[] = [];
    for (const [turnId, evs] of byTurn) {
      const toolCallIds = new Set<string>();
      for (const ev of evs) {
        if (ev.type === "tool.requested" || ev.type === "tool.started") {
          const key = typeof ev.payload.toolCallId === "string" ? ev.payload.toolCallId : ev.id;
          toolCallIds.add(key);
        }
      }
      const timestamps = evs.map((e) => e.timestamp);
      turns.push({
        turnId,
        status: deriveTurnStatus(evs),
        toolCalls: toolCallIds.size,
        firstEventAt: Math.min(...timestamps),
        lastEventAt: Math.max(...timestamps),
      });
    }
    turns.sort((a, b) => a.firstEventAt - b.firstEventAt);

    const messages: ReplayMessage[] = [];
    for (const ev of ordered) {
      const toolName = typeof ev.payload.tool === "string" ? ev.payload.tool : typeof ev.payload.name === "string" ? ev.payload.name : undefined;
      if (ev.type === "tool.output") {
        messages.push({
          ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
          kind: "output",
          ...(typeof ev.payload.toolCallId === "string" ? { toolCallId: ev.payload.toolCallId } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          // orchestrator emits { stream, text } (onOutput passthrough); the
          // older assumed shape was { output }. Accept both.
          ...(ev.payload.text !== undefined ? { output: ev.payload.text } : ev.payload.output !== undefined ? { output: ev.payload.output } : {}),
          timestamp: ev.timestamp,
        });
      } else if (ev.type === "tool.failed") {
        messages.push({
          ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
          kind: "error",
          ...(typeof ev.payload.toolCallId === "string" ? { toolCallId: ev.payload.toolCallId } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          ...(ev.payload.error !== undefined ? { error: ev.payload.error } : {}),
          timestamp: ev.timestamp,
        });
      }
    }

    // Orphan detection: tool.started (or the runtime's tool.requested) with no
    // terminal tool.completed/tool.failed for the same toolCallId = the
    // process died mid-execution. Marked interrupted/unknown_effect — the
    // recovery layer must NOT re-execute it by default (plan.md Phase 5.4).
    const orphans: OrphanToolCall[] = [];
    const terminalCalls = new Set<string>();
    for (const ev of ordered) {
      if (ev.type === "tool.completed" || ev.type === "tool.failed") {
        const key = typeof ev.payload.toolCallId === "string" ? ev.payload.toolCallId : ev.id;
        terminalCalls.add(key);
      }
    }
    for (const ev of ordered) {
      if (ev.type !== "tool.started") continue;
      const key = typeof ev.payload.toolCallId === "string" ? ev.payload.toolCallId : ev.id;
      if (terminalCalls.has(key)) continue;
      if (ev.turnId === undefined) continue;
      const toolName =
        typeof ev.payload.tool === "string"
          ? ev.payload.tool
          : typeof ev.payload.name === "string"
            ? ev.payload.name
            : undefined;
      orphans.push({
        turnId: ev.turnId,
        toolCallId: key,
        ...(toolName !== undefined ? { toolName } : {}),
        startedAt: ev.timestamp,
        lastEventAt: ev.timestamp,
      });
    }

    return { sessionId, turns, events: all.length, messages, orphans };
  }
}

/** Per-turn state machine: the last lifecycle event (by sequence) wins. */
function deriveTurnStatus(evs: AgentEvent[]): ReplayTurnStatus {
  let status: ReplayTurnStatus = "unknown";
  for (const ev of evs) {
    switch (ev.type) {
      case "turn.started":
        status = "running";
        break;
      case "turn.completed":
        status = "completed";
        break;
      case "turn.failed":
        status = "failed";
        break;
      case "turn.cancelled":
        status = "cancelled";
        break;
      default:
        break;
    }
  }
  return status;
}

/**
 * State-consistency check (architecture plan §110): the SessionStore's saved
 * snapshot and the event-derived replay must not conflict.
 *
 * Fail-closed: a missing snapshot is itself an issue. Asserts turn-count
 * agreement (snapshot .turns[] or .turnCount); per-turn status comparison is
 * intentionally not strict, since snapshot statuses may legitimately lag or
 * precede the event log.
 */
export function compare(
  snapshot: Record<string, unknown> | undefined,
  replay: ReplayResult,
): CompareResult {
  const issues: string[] = [];
  if (snapshot === undefined) {
    issues.push(
      `no state snapshot for session ${replay.sessionId}: fail-closed, event-derived state unverified`,
    );
    return { ok: false, issues };
  }
  const rawTurns = snapshot.turns;
  let snapshotCount: number | undefined;
  if (Array.isArray(rawTurns)) {
    snapshotCount = rawTurns.length;
  } else if (typeof snapshot.turnCount === "number") {
    snapshotCount = snapshot.turnCount;
  }
  if (snapshotCount === undefined) {
    issues.push(
      `snapshot for session ${replay.sessionId} has no turn data (expected .turns[] or .turnCount)`,
    );
  } else if (snapshotCount !== replay.turns.length) {
    issues.push(
      `turn count mismatch for session ${replay.sessionId}: snapshot ${snapshotCount} vs replay ${replay.turns.length}`,
    );
  }
  return { ok: issues.length === 0, issues };
}
