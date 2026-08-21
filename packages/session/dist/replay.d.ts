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
export declare class SessionReplayer {
    private readonly events;
    constructor(deps: SessionReplayerDeps);
    replay(sessionId: SessionId): Promise<ReplayResult>;
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
export declare function compare(snapshot: Record<string, unknown> | undefined, replay: ReplayResult): CompareResult;
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
export declare function deriveRunMetrics(events: readonly AgentEvent[]): Promise<ReplayRunMetrics>;
//# sourceMappingURL=replay.d.ts.map