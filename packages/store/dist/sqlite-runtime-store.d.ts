import { DatabaseSync } from "node:sqlite";
import type { AdmittedPrompt, AgentEvent, CheckpointStore, EventStore, InboxStore, Message, PromptId, Session, SessionId, SessionStore, Turn, TurnId } from "@ar/contracts";
import type { AskUserStore } from "@ar/contracts";
/**
 * P5-3: SQLiteRuntimeStore — one SQLite file (WAL) backing the five runtime
 * persistence contracts: SessionStore, EventStore, InboxStore, AskUserStore,
 * CheckpointStore. Approval mutable API / Artifact metadata stay on their own
 * adapters (plan §PHASE 5).
 *
 * - Single DatabaseSync connection per store instance (node:sqlite, sync API);
 *   every mutating method wraps its statements in a transaction so interleaved
 *   async callers serialize correctly.
 * - WAL journal mode: readers never block writers and a crash cannot leave a
 *   torn write.
 * - Event sequences are allocated in a `BEGIN IMMEDIATE` transaction reading
 *   `MAX(sequence)` for the session, with `UNIQUE(session_id, sequence)` as a
 *   hard backstop — a concurrent producer can never collide (P5-5).
 * - Structured rows keep query columns (id/session_id/status/sequence/…) while
 *   the full document is stored as JSON in a `doc` TEXT column, so adding a
 *   contract field never needs a migration.
 * - Memory keeps its own DB (different retention lifecycle; plan note).
 */
export interface SqliteRuntimeStoreOptions {
    /** Directory holding runtime.db; created on first open. Ignored when `db`
     *  is provided (tests / shared connections). */
    dataDir?: string;
    /** Optional pre-opened database (tests / shared connections). */
    db?: DatabaseSync;
}
export declare const RUNTIME_DB_FILE_NAME = "runtime.db";
export declare const RUNTIME_SCHEMA_VERSION = 1;
/** Adapter that implements the runtime store contracts on one DB. */
export declare class SqliteRuntimeStore implements SessionStore, EventStore, InboxStore {
    /** P5-3: AskUserStore via composition (listPending collides with InboxStore's). */
    readonly askUser: AskUserStore;
    /** P5-3: CheckpointStore via composition (list collides with EventStore's). */
    readonly checkpoints: CheckpointStore;
    private readonly db;
    private closed;
    constructor(opts: SqliteRuntimeStoreOptions);
    close(): void;
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
    append(event: AgentEvent): Promise<AgentEvent>;
    list(sessionId: SessionId, opts?: {
        afterSequence?: number;
        limit?: number;
    }): Promise<AgentEvent[]>;
    stream(sessionId: SessionId, opts?: {
        afterSequence?: number;
    }): AsyncIterable<AgentEvent>;
    nextSequence(sessionId: SessionId): Promise<number>;
    admit(prompt: AdmittedPrompt): Promise<void>;
    listPending(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    listAll(sessionId: SessionId): Promise<AdmittedPrompt[]>;
    private markInbox;
    markPromoted(id: PromptId): Promise<void>;
    markConsumed(id: PromptId): Promise<void>;
    private askUserCreate;
    private askUserGet;
    private askUserListPending;
    private askUserMarkAnswered;
    private askUserMarkWithdrawn;
    private checkpointSave;
    private checkpointLoadLatest;
    private checkpointList;
}
//# sourceMappingURL=sqlite-runtime-store.d.ts.map