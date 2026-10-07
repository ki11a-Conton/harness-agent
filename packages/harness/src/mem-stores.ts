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
  private readonly snapshots = new Map<SessionId, Record<string, unknown>>();

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async getSession(id: SessionId): Promise<Session | undefined> {
    return this.sessions.get(id);
  }
  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async listSessions(opts: Parameters<SessionStore["listSessions"]>[0] = {}): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) =>
      (opts.parentId === undefined || s.parentId === opts.parentId) &&
      (opts.status === undefined || s.status === opts.status));
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
  async saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void> {
    this.snapshots.set(sessionId, structuredClone(snapshot));
  }
  async loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
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
  /** P26-1: store-owned atomic sequence allocation (fake: serialized by
   *  the single-threaded JS event loop, so no interleaving is possible). */
  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }
  /** P26-3: in-memory fake — honest level is memory. */
  get durabilityLevel(): "memory" {
    return "memory";
  }
  async flushThrough(_sessionId: string, _sequence: number): Promise<void> {}
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
