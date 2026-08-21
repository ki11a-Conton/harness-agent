import type { AgentId, SessionId, TurnId } from "@ar/contracts";
import { type ProgressSignal, type StallPattern, type ToolCallTrace } from "@ar/contracts";
/**
 * Agent phase state machine per AGENT_ARCHITECTURE_PLAN §25.
 *
 *   IDLE → THINKING → TOOL_PENDING → WAITING_PERMISSION → EXECUTING
 *   → OBSERVING → THINKING ...
 *   THINKING → COMPACTING → THINKING
 *   OBSERVING → RECOVERING → THINKING
 *   Terminals: COMPLETED | FAILED | CANCELLED
 */
export type AgentPhase = "idle" | "thinking" | "tool_pending" | "waiting_permission" | "executing" | "observing" | "compacting" | "recovering" | "waiting_user" | "waiting_approval" | "completed" | "failed" | "cancelled";
export declare class IllegalTransitionError extends Error {
    readonly from: AgentPhase;
    readonly to: AgentPhase;
    constructor(from: AgentPhase, to: AgentPhase);
}
export interface AgentStateSnapshot {
    sessionId: SessionId;
    turnId?: TurnId;
    agentId: AgentId;
    phase: AgentPhase;
    /** Turn-internal iteration count (model round-trips). */
    iteration: number;
    toolCallsExecuted: number;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
}
export declare class AgentState {
    readonly sessionId: SessionId;
    readonly agentId: AgentId;
    private phase;
    private turnId?;
    private iteration;
    private toolCallsExecuted;
    private readonly startedAt;
    private updatedAt;
    private completedAt?;
    private lastToolKey;
    private identicalToolStreak;
    private stallRecoveriesUsed;
    /** P2-41: rolling window of recent tool executions for pattern-based stall
     *  detection (bounded to STALL_WINDOW_SIZE). Populated by `recordToolCall`;
     *  `recordProgress`/`clearStallWindow` reset it when a progress signal lands. */
    private recentTraces;
    constructor(sessionId: SessionId, agentId: AgentId, now?: () => number);
    private readonly nowFn;
    getPhase(): AgentPhase;
    getTurnId(): TurnId | undefined;
    getIteration(): number;
    getToolCallsExecuted(): number;
    isTerminal(): boolean;
    transition(to: AgentPhase): void;
    /** Jump straight to a terminal state (used by cancel/fail from any live phase). */
    terminate(to: "completed" | "failed" | "cancelled"): void;
    beginTurn(turnId: TurnId): void;
    nextIteration(): void;
    countToolCall(): void;
    /**
     * Stall detection (plan.md Phase 2): track consecutive identical tool calls
     * (same name + same args, key-stable). Returns the current streak length —
     * the runtime terminates the turn when it reaches its budget.
     */
    noteToolCall(name: string, args: Record<string, unknown>): number;
    /**
     * Stall recovery (retry taxonomy kind "stallRecovery", Phase 11): a
     * per-turn budget of stall recoveries. The runtime resets the tool streak
     * and injects an observation message; the model gets one more chance to
     * change strategy before the stall budget terminates the turn.
     */
    useStallRecovery(maxRecoveries: number): boolean;
    /** Reset the identical-call streak after a stall recovery. */
    resetToolStreak(): void;
    /**
     * P2-41: record one executed tool call into the rolling stall window. The
     * result fingerprint is supplied by the runtime so an identical call with a
     * DIFFERENT result is progress, not a stall (avoids false positives).
     */
    recordToolCall(trace: ToolCallTrace): void;
    /**
     * P2-41: true when a prior trace in the window was the SAME call+args but
     * produced a DIFFERENT result fingerprint. That means observable feedback
     * moved (e.g. a verification now passes / returns new evidence) — concrete
     * progress that cancels any pending stall classification.
     */
    priorResultChanged(trace: ToolCallTrace): boolean;
    /**
     * P2-41: consult the pure pattern classifier over the current window. Returns
     * null when the window is unchanged/empty or shows no stall pattern. Callers
     * may filter by the exact pattern they care about (e.g. exclude identical_tool
     * so the legacy identical-streak gate owns that case).
     */
    stallPattern(): StallPattern | null;
    /**
     * P2-41: a progress signal landed (side effect / file diff / verification
     * improvement ...). A window with progress is never a stall — clear it so the
     * classifier starts fresh rather than counting past progress as stagnation.
     */
    recordProgress(signal: ProgressSignal): void;
    /** P2-41: force-clear the window (e.g. after a stall recovery). */
    clearStallWindow(): void;
    snapshot(): AgentStateSnapshot;
}
//# sourceMappingURL=agent-state.d.ts.map