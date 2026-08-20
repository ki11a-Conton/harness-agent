import type { AgentEvent, EventStore, SessionId, TurnId } from "@ar/contracts";
import { toolNameOf as toolNameOfPayload } from "@ar/contracts";

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
    // P2-33: track the turn's earliest sequence so turn ordering is a total
    // deterministic order even when two turns share the same wall-clock
    // firstEventAt (parallel tool/subagent completions can land in the same ms).
    // Replay must NOT depend on wall-clock tie-break.
    const turnFirstSeq = new Map<TurnId, number>();
    for (const [turnId, evs] of byTurn) {
      const toolCallIds = new Set<string>();
      for (const ev of evs) {
        if (ev.type === "tool.requested" || ev.type === "tool.started") {
          const key = typeof ev.payload.toolCallId === "string" ? ev.payload.toolCallId : ev.id;
          toolCallIds.add(key);
        }
      }
      const timestamps = evs.map((e) => e.timestamp);
      // evs are pushed in `ordered` (sequence) order, so the first element is
      // the earliest-sequence event of this turn.
      turnFirstSeq.set(turnId, evs[0]!.sequence);
      turns.push({
        turnId,
        status: deriveTurnStatus(evs),
        toolCalls: toolCallIds.size,
        firstEventAt: Math.min(...timestamps),
        lastEventAt: Math.max(...timestamps),
      });
    }
    // Deterministic total order: primary by first real timestamp, then by
    // earliest sequence (append order), then by turnId lexically. Never falls
    // back to map-insertion or engine-stable-sort behavior for equal timestamps.
    turns.sort((a, b) => {
      if (a.firstEventAt !== b.firstEventAt) {
        return a.firstEventAt - b.firstEventAt;
      }
      const sa = turnFirstSeq.get(a.turnId)!;
      const sb = turnFirstSeq.get(b.turnId)!;
      if (sa !== sb) return sa - sb;
      if (a.turnId < b.turnId) return -1;
      if (a.turnId > b.turnId) return 1;
      return 0;
    });

    const messages: ReplayMessage[] = [];
    for (const ev of ordered) {
      const toolName = toolNameOfPayload(ev.payload);
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

// ---- P9-4: offline trace replay V2 — derive metrics/judgement from the
// event stream WITHOUT re-invoking the model. The event log is the single
// source; every figure below is a pure fold over emitted facts. ----------

export interface ReplayRunMetrics {
  sessionId: SessionId;
  turns: number;
  modelCalls: number;
  /** Sum of input+output tokens reported by model.completed usage snapshots. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Total wall-clock across model calls (durationMs on model.completed). */
  modelTimeMs: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  compactions: number;
  verificationSteps: number;
  verificationPassed: number;
  securityDenials: number;
  /** False-complete grade of the LAST terminal turn (P8-3). */
  completionGrade?: import("@ar/contracts").FalseCompleteGrade;
}

/** Fold the event stream of one session into run metrics. Pure — no model,
 *  no store writes; safe for any historical trace. */
export async function deriveRunMetrics(
  events: readonly AgentEvent[],
): Promise<ReplayRunMetrics> {
  let turns = 0;
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelTimeMs = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let retries = 0;
  let compactions = 0;
  let verificationSteps = 0;
  let verificationPassed = 0;
  let securityDenials = 0;
  let lastTerminal: { reason?: string } | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        turns += 1;
        break;
      case "turn.completed": {
        const reason = (event.payload as { terminationReason?: string }).terminationReason;
        lastTerminal = { reason };
        break;
      }
      case "model.started":
        modelCalls += 1;
        break;
      case "model.completed": {
        const usage = (event.payload as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
        if (usage?.inputTokens !== undefined) inputTokens += usage.inputTokens;
        if (usage?.outputTokens !== undefined) outputTokens += usage.outputTokens;
        const durationMs = (event.payload as { durationMs?: number }).durationMs;
        if (durationMs !== undefined) modelTimeMs += durationMs;
        break;
      }
      case "model.retry":
        retries += 1;
        break;
      case "tool.requested":
        toolCalls += 1;
        break;
      case "tool.failed":
        toolFailures += 1;
        break;
      case "context.compacted":
        compactions += 1;
        break;
      case "verification.step_started":
        verificationSteps += 1;
        break;
      case "verification.step_completed": {
        if ((event.payload as { passed?: boolean }).passed === true) verificationPassed += 1;
        break;
      }
      default:
        if (event.type.startsWith("security.")) securityDenials += 1;
    }
  }

  let completionGrade: import("@ar/contracts").FalseCompleteGrade | undefined;
  if (lastTerminal?.reason !== undefined) {
    const { gradeCompletion } = await import("@ar/contracts");
    completionGrade = gradeCompletion(lastTerminal.reason as import("@ar/contracts").TerminationReason, {
      passedSteps: verificationPassed,
      totalSteps: verificationSteps,
    });
  }

  return {
    sessionId: events[0]?.sessionId ?? ("" as SessionId),
    turns,
    modelCalls,
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    modelTimeMs,
    toolCalls,
    toolFailures,
    retries,
    compactions,
    verificationSteps,
    verificationPassed,
    securityDenials,
    ...(completionGrade !== undefined ? { completionGrade } : {}),
  };
}
