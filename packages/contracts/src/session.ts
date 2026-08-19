import type { AgentId, SessionId, TurnId } from "./ids.js";
import type { ModelRef } from "./model.js";
import type { Message, UserMessage } from "./message.js";

export type SessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface Session {
  id: SessionId;
  parentId?: SessionId;
  agentId: AgentId;
  model: ModelRef;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export type TurnStatus = "running" | "waiting_for_user" | "completed" | "failed" | "cancelled";

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  input: UserMessage;
  status: TurnStatus;
  startedAt: number;
  completedAt?: number;
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