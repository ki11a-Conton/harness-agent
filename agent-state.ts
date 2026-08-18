import type { AgentId, SessionId, TurnId } from "@ar/contracts";

/**
 * Agent phase state machine per AGENT_ARCHITECTURE_PLAN §25.
 *
 *   IDLE → THINKING → TOOL_PENDING → WAITING_PERMISSION → EXECUTING
 *   → OBSERVING → THINKING ...
 *   THINKING → COMPACTING → THINKING
 *   OBSERVING → RECOVERING → THINKING
 *   Terminals: COMPLETED | FAILED | CANCELLED
 */
export type AgentPhase =
  | "idle"
  | "thinking"
  | "tool_pending"
  | "waiting_permission"
  | "executing"
  | "observing"
  | "compacting"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL: ReadonlySet<AgentPhase> = new Set(["completed", "failed", "cancelled"]);

/** Allowed transitions; a transition from a terminal phase is never allowed. */
const TRANSITIONS: Readonly<Record<AgentPhase, readonly AgentPhase[]>> = {
  idle: ["thinking"],
  thinking: ["tool_pending", "compacting", "observing", "completed", "failed", "cancelled"],
  tool_pending: ["waiting_permission", "executing", "observing", "cancelled"],
  waiting_permission: ["executing", "observing", "cancelled"],
  executing: ["observing", "cancelled", "failed"],
  observing: ["thinking", "recovering", "cancelled", "failed"],
  compacting: ["thinking", "failed", "cancelled"],
  recovering: ["thinking", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  readonly from: AgentPhase;
  readonly to: AgentPhase;

  constructor(from: AgentPhase, to: AgentPhase) {
    super(`Illegal agent phase transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

/** Deterministic key for (name, args): stable JSON with sorted keys. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

export class AgentState {
  private phase: AgentPhase;
  private turnId?: TurnId;
  private iteration = 0;
  private toolCallsExecuted = 0;
  private readonly startedAt: number;
  private updatedAt: number;
  private completedAt?: number;
  private lastToolKey: string | undefined;
  private identicalToolStreak = 0;
  private stallRecoveriesUsed = 0;

  constructor(
    readonly sessionId: SessionId,
    readonly agentId: AgentId,
  ) {
    this.phase = "idle";
    this.startedAt = Date.now();
    this.updatedAt = this.startedAt;
  }

  getPhase(): AgentPhase {
    return this.phase;
  }

  getTurnId(): TurnId | undefined {
    return this.turnId;
  }

  getIteration(): number {
    return this.iteration;
  }

  getToolCallsExecuted(): number {
    return this.toolCallsExecuted;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this.phase);
  }

  transition(to: AgentPhase): void {
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
      this.completedAt = Date.now();
    }
    this.updatedAt = Date.now();
  }

  /** Jump straight to a terminal state (used by cancel/fail from any live phase). */
  terminate(to: "completed" | "failed" | "cancelled"): void {
    if (TERMINAL.has(this.phase)) {
      throw new IllegalTransitionError(this.phase, to);
    }
    this.phase = to;
    this.completedAt = Date.now();
    this.updatedAt = Date.now();
  }

  beginTurn(turnId: TurnId): void {
    if (this.phase !== "idle" && !TERMINAL.has(this.phase)) {
      throw new IllegalTransitionError(this.phase, "thinking");
    }
    this.turnId = turnId;
    this.iteration = 0;
    this.stallRecoveriesUsed = 0;
    this.phase = "thinking";
    this.updatedAt = Date.now();
  }

  nextIteration(): void {
    this.iteration += 1;
  }

  countToolCall(): void {
    this.toolCallsExecuted += 1;
  }

  /**
   * Stall detection (plan.md Phase 2): track consecutive identical tool calls
   * (same name + same args, key-stable). Returns the current streak length —
   * the runtime terminates the turn when it reaches its budget.
   */
  noteToolCall(name: string, args: Record<string, unknown>): number {
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
  useStallRecovery(maxRecoveries: number): boolean {
    if (this.stallRecoveriesUsed >= maxRecoveries) return false;
    this.stallRecoveriesUsed += 1;
    return true;
  }

  /** Reset the identical-call streak after a stall recovery. */
  resetToolStreak(): void {
    this.identicalToolStreak = 0;
    this.lastToolKey = undefined;
  }

  snapshot(): AgentStateSnapshot {
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