import type { AgentId, EventId, SessionId, TurnId } from "./ids.js";
import type { ModelRef } from "./model.js";
import type { Message, UserMessage } from "./message.js";
import type { AgentErrorInfo } from "./errors.js";
import type { CompletionEvidence, FalseCompleteGrade, TerminationReason } from "./termination.js";

export type SessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface Session {
  id: SessionId;
  parentId?: SessionId;
  agentId: AgentId;
  model: ModelRef;
  /** Atomic model-selection commit and durable outbox. The policy snapshot is
   * immutable; only an explicitly recorded selection overrides its model.
   * initialModel anchors pre-provenance history across upgrades and switches. */
  modelSelection?: {
    version: 1;
    initialModel: ModelRef;
    model: ModelRef;
    eventId: EventId;
    timestamp: number;
  };
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export type TurnStatus = "running" | "waiting_for_user" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

/** First terminal commit and its event outbox share the same durable row.
 * Legacy turns have no outbox: their missing evidence must never be invented. */
export interface TerminalTurnOutcome {
  version: 1;
  eventId: EventId;
  timestamp: number;
  status: "completed" | "failed" | "cancelled";
  statusDetail: "completed" | "failed_no_effect" | "failed_with_effects" | "cancelled_no_effect" | "cancelled_with_effects" | "blocked";
  error?: AgentErrorInfo;
  terminationReason?: TerminationReason;
  grade?: FalseCompleteGrade;
  completionEvidence?: CompletionEvidence;
}

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  input: UserMessage;
  status: TurnStatus;
  startedAt: number;
  completedAt?: number;
  terminalOutcome?: TerminalTurnOutcome;
}

export interface SessionStore {
  createSession(session: Session): Promise<void>;
  getSession(id: SessionId): Promise<Session | undefined>;
  updateSession(session: Session): Promise<void>;
  listSessions(opts?: { parentId?: SessionId; status?: SessionStatus }): Promise<Session[]>;

  createTurn(turn: Turn): Promise<void>;
  getTurn(id: TurnId): Promise<Turn | undefined>;
  updateTurn(turn: Turn): Promise<void>;
  listTurns(sessionId: SessionId): Promise<Turn[]>;

  appendMessage(message: Message): Promise<void>;
  listMessages(sessionId: SessionId): Promise<Message[]>;
  listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]>;

  saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void>;
  loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined>;
}