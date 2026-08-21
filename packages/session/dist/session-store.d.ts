import type { Message, Session, SessionId, SessionStore, Turn, TurnId } from "@ar/contracts";
/**
 * JSONL session store (SESSION-001).
 *
 * Layout under dataDir (deterministic paths, no index file needed):
 *   sessions/<sessionId>.json        session record      { schemaVersion, session }
 *   turns/<turnId>.json              turn record         { schemaVersion, turn }
 *   messages/<sessionId>.jsonl       append-only JSONL   { schemaVersion, message } per line
 *   state/<sessionId>.json           state snapshot      { schemaVersion, snapshot }
 *   archive/<sessionId>/             archived session (session.json, messages.jsonl,
 *                                    state.json, turns/<turnId>.json)
 *
 * All records are wrapped in { schemaVersion: 1 }. Reads reject records with an
 * unsupported schemaVersion (CORRUPT_RECORD). Writes are atomic (tmp file +
 * rename). Single-writer assumption: this store is meant for one process.
 */
export declare const SCHEMA_VERSION: 1;
export type SessionStoreErrorCode = "UNSAFE_ID" | "UNKNOWN_SESSION" | "UNKNOWN_TURN" | "UNKNOWN_PROMPT" | "UNKNOWN_ASK" | "ASK_NOT_PENDING" | "CORRUPT_RECORD" | "IO_ERROR" | "UNSUPPORTED";
export declare class SessionStoreError extends Error {
    readonly code: SessionStoreErrorCode;
    constructor(code: SessionStoreErrorCode, message: string);
}
export interface JSONLSessionStoreOptions {
    dataDir: string;
}
export declare class JSONLSessionStore implements SessionStore {
    private readonly dataDir;
    private readonly sessionsDir;
    private readonly turnsDir;
    private readonly messagesDir;
    private readonly stateDir;
    private readonly archiveDir;
    constructor(opts: JSONLSessionStoreOptions);
    private sessionFile;
    private turnFile;
    private messageFile;
    private stateFile;
    private ensureDirs;
    private readJson;
    private writeJsonAtomic;
    private appendJsonLine;
    private moveIfExists;
    private readSessionDoc;
    private readMessages;
    createSession(session: Session): Promise<void>;
    getSession(id: SessionId): Promise<Session | undefined>;
    updateSession(session: Session): Promise<void>;
    listSessions(opts?: {
        parentId?: SessionId;
        status?: Session["status"];
    }): Promise<Session[]>;
    createTurn(turn: Turn): Promise<void>;
    getTurn(id: TurnId): Promise<Turn | undefined>;
    updateTurn(turn: Turn): Promise<void>;
    listTurns(sessionId: SessionId): Promise<Turn[]>;
    appendMessage(message: Message): Promise<void>;
    listMessages(sessionId: SessionId): Promise<Message[]>;
    listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]>;
    saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void>;
    loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined>;
    /**
     * Move every on-disk artifact of a session into dataDir/archive/<sessionId>.
     * Returns the archive directory path. After archiving, getSession/getTurn/
     * listTurns for that session return nothing (fail-closed).
     */
    archiveSession(id: SessionId): Promise<{
        archivedPath: string;
    }>;
    /**
     * P2-35 backup: copy the whole session store (sessions/turns/messages/state
     * and their archives) to `<dataDir>/backups/<stamp>/`, excluding temp files
     * and the `backups` directory itself. Use it before destructive ops or as a
     * scheduled integrity checkpoint.
     */
    backup(opts?: {
        now?: () => Date;
    }): Promise<{
        path: string;
        files: number;
        bytes: number;
    }>;
}
//# sourceMappingURL=session-store.d.ts.map