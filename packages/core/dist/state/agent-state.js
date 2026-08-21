import { STALL_WINDOW_SIZE, detectStallPattern, stableStringify, } from "@ar/contracts";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Allowed transitions; a transition from a terminal phase is never allowed. */
const TRANSITIONS = {
    idle: ["thinking"],
    thinking: ["tool_pending", "compacting", "observing", "waiting_user", "waiting_approval", "completed", "failed", "cancelled"],
    tool_pending: ["waiting_permission", "executing", "observing", "waiting_approval", "cancelled"],
    waiting_permission: ["executing", "observing", "cancelled"],
    executing: ["observing", "cancelled", "failed"],
    observing: ["thinking", "recovering", "waiting_user", "cancelled", "failed"],
    compacting: ["thinking", "failed", "cancelled"],
    recovering: ["thinking", "failed", "cancelled"],
    // P2-43: waiting_user is a PAUSED, resumable phase — the turn asked the user
    // for critical input. It is not a terminal: resume returns to thinking; the
    // host/human may also cancel from here.
    waiting_user: ["thinking", "cancelled"],
    // P1-1: waiting_approval is a PAUSED, resumable phase — the turn is waiting
    // for a human to approve or deny a tool call. Resume returns to thinking.
    waiting_approval: ["thinking", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
};
export class IllegalTransitionError extends Error {
    from;
    to;
    constructor(from, to) {
        super(`Illegal agent phase transition: ${from} -> ${to}`);
        this.from = from;
        this.to = to;
    }
}
export class AgentState {
    sessionId;
    agentId;
    phase;
    turnId;
    iteration = 0;
    toolCallsExecuted = 0;
    startedAt;
    updatedAt;
    completedAt;
    lastToolKey;
    identicalToolStreak = 0;
    stallRecoveriesUsed = 0;
    /** P2-41: rolling window of recent tool executions for pattern-based stall
     *  detection (bounded to STALL_WINDOW_SIZE). Populated by `recordToolCall`;
     *  `recordProgress`/`clearStallWindow` reset it when a progress signal lands. */
    recentTraces = [];
    constructor(sessionId, agentId, now = Date.now) {
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.phase = "idle";
        this.startedAt = now();
        this.updatedAt = this.startedAt;
        this.nowFn = now;
    }
    nowFn;
    getPhase() {
        return this.phase;
    }
    getTurnId() {
        return this.turnId;
    }
    getIteration() {
        return this.iteration;
    }
    getToolCallsExecuted() {
        return this.toolCallsExecuted;
    }
    isTerminal() {
        return TERMINAL.has(this.phase);
    }
    transition(to) {
        if (TERMINAL.has(this.phase)) {
            throw new IllegalTransitionError(this.phase, to);
        }
        const allowed = TRANSITIONS[this.phase];
        if (!allowed.includes(to)) {
            throw new IllegalTransitionError(this.phase, to);
        }
        if (this.phase === "idle" && to === "thinking") {
            // nothing extra
        }
        this.phase = to;
        if (TERMINAL.has(to)) {
            this.completedAt = this.nowFn();
        }
        this.updatedAt = this.nowFn();
    }
    /** Jump straight to a terminal state (used by cancel/fail from any live phase). */
    terminate(to) {
        if (TERMINAL.has(this.phase)) {
            throw new IllegalTransitionError(this.phase, to);
        }
        this.phase = to;
        this.completedAt = this.nowFn();
        this.updatedAt = this.nowFn();
    }
    beginTurn(turnId) {
        if (this.phase !== "idle" && !TERMINAL.has(this.phase)) {
            throw new IllegalTransitionError(this.phase, "thinking");
        }
        this.turnId = turnId;
        this.iteration = 0;
        this.stallRecoveriesUsed = 0;
        this.phase = "thinking";
        this.updatedAt = this.nowFn();
    }
    nextIteration() {
        this.iteration += 1;
    }
    countToolCall() {
        this.toolCallsExecuted += 1;
    }
    /**
     * Stall detection (plan.md Phase 2): track consecutive identical tool calls
     * (same name + same args, key-stable). Returns the current streak length —
     * the runtime terminates the turn when it reaches its budget.
     */
    noteToolCall(name, args) {
        const key = `${name}:${stableStringify(args)}`;
        this.identicalToolStreak = key === this.lastToolKey ? this.identicalToolStreak + 1 : 1;
        this.lastToolKey = key;
        return this.identicalToolStreak;
    }
    /**
     * Stall recovery (retry taxonomy kind "stallRecovery", Phase 11): a
     * per-turn budget of stall recoveries. The runtime resets the tool streak
     * and injects an observation message; the model gets one more chance to
     * change strategy before the stall budget terminates the turn.
     */
    useStallRecovery(maxRecoveries) {
        if (this.stallRecoveriesUsed >= maxRecoveries)
            return false;
        this.stallRecoveriesUsed += 1;
        return true;
    }
    /** Reset the identical-call streak after a stall recovery. */
    resetToolStreak() {
        this.identicalToolStreak = 0;
        this.lastToolKey = undefined;
    }
    /**
     * P2-41: record one executed tool call into the rolling stall window. The
     * result fingerprint is supplied by the runtime so an identical call with a
     * DIFFERENT result is progress, not a stall (avoids false positives).
     */
    recordToolCall(trace) {
        this.recentTraces.push(trace);
        if (this.recentTraces.length > STALL_WINDOW_SIZE) {
            this.recentTraces.shift();
        }
    }
    /**
     * P2-41: true when a prior trace in the window was the SAME call+args but
     * produced a DIFFERENT result fingerprint. That means observable feedback
     * moved (e.g. a verification now passes / returns new evidence) — concrete
     * progress that cancels any pending stall classification.
     */
    priorResultChanged(trace) {
        if (trace.resultFingerprint === undefined)
            return false;
        for (const prior of this.recentTraces) {
            if (prior.name === trace.name &&
                prior.argsKey === trace.argsKey &&
                prior.resultFingerprint !== undefined &&
                prior.resultFingerprint !== trace.resultFingerprint) {
                return true;
            }
        }
        return false;
    }
    /**
     * P2-41: consult the pure pattern classifier over the current window. Returns
     * null when the window is unchanged/empty or shows no stall pattern. Callers
     * may filter by the exact pattern they care about (e.g. exclude identical_tool
     * so the legacy identical-streak gate owns that case).
     */
    stallPattern() {
        return detectStallPattern(this.recentTraces);
    }
    /**
     * P2-41: a progress signal landed (side effect / file diff / verification
     * improvement ...). A window with progress is never a stall — clear it so the
     * classifier starts fresh rather than counting past progress as stagnation.
     */
    recordProgress(signal) {
        this.recentTraces = [];
        void signal; // the signal is logged upstream; the window clearing is what matters
    }
    /** P2-41: force-clear the window (e.g. after a stall recovery). */
    clearStallWindow() {
        this.recentTraces = [];
    }
    snapshot() {
        return {
            sessionId: this.sessionId,
            turnId: this.turnId,
            agentId: this.agentId,
            phase: this.phase,
            iteration: this.iteration,
            toolCallsExecuted: this.toolCallsExecuted,
            startedAt: this.startedAt,
            updatedAt: this.updatedAt,
            ...(this.completedAt !== undefined ? { completedAt: this.completedAt } : {}),
        };
    }
}
//# sourceMappingURL=agent-state.js.map