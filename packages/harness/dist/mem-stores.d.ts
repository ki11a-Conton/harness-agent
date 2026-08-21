import type { AgentEvent, EventStore, Message, Session, SessionId, SessionStore, Turn, TurnId } from "@ar/contracts";
/**
 * In-memory SessionStore/EventStore used by one-shot hosts (CLI without a
 * dataDir, benchmark runs). Owned by @ar/harness so every composition-root
 * host shares one implementation instead of hand-rolled fakes.
 */
export declare class MemSessionStore implements SessionStore {
    sessions: Map<string, Session>;
    turns: Map<string, Turn>;
    messages: Message[];
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
    saveStateSnapshot(_sessionId: SessionId, _snapshot: Record<string, unknown>): Promise<void>;
    loadStateSnapshot(): Promise<Record<string, unknown> | undefined>;
}
export declare class MemEventStore implements EventStore {
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
//# sourceMappingURL=mem-stores.d.ts.map