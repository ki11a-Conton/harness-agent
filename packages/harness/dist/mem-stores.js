/**
 * In-memory SessionStore/EventStore used by one-shot hosts (CLI without a
 * dataDir, benchmark runs). Owned by @ar/harness so every composition-root
 * host shares one implementation instead of hand-rolled fakes.
 */
export class MemSessionStore {
    sessions = new Map();
    turns = new Map();
    messages = [];
    async createSession(session) {
        this.sessions.set(session.id, session);
    }
    async getSession(id) {
        return this.sessions.get(id);
    }
    async updateSession(session) {
        this.sessions.set(session.id, session);
    }
    async listSessions() {
        return [...this.sessions.values()];
    }
    async createTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async getTurn(id) {
        return this.turns.get(id);
    }
    async updateTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async listTurns(sessionId) {
        return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
    }
    async appendMessage(message) {
        this.messages.push(message);
    }
    async listMessages(sessionId) {
        return this.messages.filter((m) => m.sessionId === sessionId);
    }
    async listMessagesByTurn(sessionId, turnId) {
        return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
    }
    async saveStateSnapshot(_sessionId, _snapshot) { }
    async loadStateSnapshot() {
        return undefined;
    }
}
export class MemEventStore {
    events = [];
    seq = 0;
    async nextSequence(_sessionId) {
        return this.seq + 1;
    }
    async append(event) {
        const seq = ++this.seq;
        const stored = { ...event, sequence: seq };
        this.events.push(stored);
        return stored;
    }
    async list(sessionId, opts) {
        let list = this.events.filter((e) => e.sessionId === sessionId);
        if (opts?.afterSequence !== undefined)
            list = list.filter((e) => e.sequence > opts.afterSequence);
        if (opts?.limit !== undefined)
            list = list.slice(0, opts.limit);
        return list;
    }
    async *stream(sessionId, opts) {
        for (const e of this.events) {
            if (e.sessionId !== sessionId)
                continue;
            if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence)
                continue;
            yield e;
        }
    }
}
//# sourceMappingURL=mem-stores.js.map