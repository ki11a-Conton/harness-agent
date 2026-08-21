import type { AgentEvent, EventStore, Message, Session, SessionId, SessionStore, Turn, TurnId } from "@ar/contracts";
/** In-memory stores for core tests (Fake infrastructure per plan §97). */
export declare class MemorySessionStore implements SessionStore {
    sessions: Map<string, Session>;
    turns: Map<string, Turn>;
    messages: Message[];
    snapshots: Map<string, Record<string, unknown>>;
    createSession(session: Session): Promise<void>;
    getSession(id: SessionId): Promise<Session | undefined>;
    updateSession(session: Session): Promise<void>;
    listSessions(): Promise<Session[]>;
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
export declare class MemoryEventStore implements EventStore {
    events: AgentEvent[];
    private seq;
    nextSequence(_sessionId: SessionId): Promise<number>;
    append(event: AgentEvent): Promise<AgentEvent>;
    list(sessionId: SessionId, opts?: {
        afterSequence?: number;
        limit?: number;
    }): Promise<AgentEvent[]>;
    stream(sessionId: SessionId, opts?: {
        afterSequence?: number;
    }): AsyncIterable<AgentEvent>;
}
//# sourceMappingURL=fakes.d.ts.map