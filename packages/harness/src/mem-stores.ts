import type {
  AgentEvent,
  EventStore,
  Message,
  Session,
  SessionId,
  SessionStore,
  Turn,
  TurnId,
} from "@ar/contracts";

/**
 * In-memory SessionStore/EventStore used by one-shot hosts (CLI without a
 * dataDir, benchmark runs). Owned by @ar/harness so every composition-root
 * host shares one implementation instead of hand-rolled fakes.
 */

export class MemSessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  messages: Message[] = [];

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }
  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }
  async createTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }
  async getTurn(id: TurnId): Promise<Turn | undefined> {
    return this.turns.get(id);
  }
  async updateTurn(turn: Turn): Promise<void> {
    this.turns.set(turn.id, turn);
  }
  async listTurns(sessionId: SessionId): Promise<Turn[]> {
    return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
  }
  async appendMessage(message: Message): Promise<void> {
    this.messages.push(message);
  }
  async listMessages(sessionId: SessionId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId);
  }
  async listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]> {
    return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
  }
  async saveStateSnapshot(_sessionId: SessionId, _snapshot: Record<string, unknown>): Promise<void> {}
  async loadStateSnapshot(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}

export class MemEventStore implements EventStore {
  events: AgentEvent[] = [];
  private seq = 0;

  async nextSequence(_sessionId: SessionId): Promise<number> {
    return this.seq + 1;
  }
  async append(event: AgentEvent): Promise<AgentEvent> {
    const seq = ++this.seq;
    const stored = { ...event, sequence: seq };
    this.events.push(stored);
    return stored;
  }
  async list(sessionId: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]> {
    let list = this.events.filter((e) => e.sessionId === sessionId);
    if (opts?.afterSequence !== undefined) list = list.filter((e) => e.sequence > opts.afterSequence!);
    if (opts?.limit !== undefined) list = list.slice(0, opts.limit);
    return list;
  }
  async *stream(sessionId: SessionId, opts?: { afterSequence?: number }): AsyncIterable<AgentEvent> {
    for (const e of this.events) {
      if (e.sessionId !== sessionId) continue;
      if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence) continue;
      yield e;
    }
  }
}