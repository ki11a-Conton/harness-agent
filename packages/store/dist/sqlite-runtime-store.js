import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHECKPOINT_SCHEMA_VERSION } from "@ar/contracts";
export const RUNTIME_DB_FILE_NAME = "runtime.db";
export const RUNTIME_SCHEMA_VERSION = 1;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns (session_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages (turn_id);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox (session_id);
CREATE TABLE IF NOT EXISTS ask_user (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ask_user_session ON ask_user (session_id);
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints (session_id);
CREATE TABLE IF NOT EXISTS state_snapshots (
  session_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
`;
function docOf(value) {
    return JSON.stringify(value);
}
function parseDoc(raw, label) {
    if (typeof raw !== "string") {
        throw new Error(`store: missing or corrupt ${label}`);
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`store: corrupt ${label} (invalid JSON)`);
    }
}
/** Adapter that implements the runtime store contracts on one DB. */
// InboxStore and AskUserStore BOTH define `listPending(sessionId)` (with
// different row shapes) — a single class cannot implement two same-signature
// methods, so AskUserStore is exposed via composition under `.askUser` while
// the other four contracts are implemented directly.
export class SqliteRuntimeStore {
    /** P5-3: AskUserStore via composition (listPending collides with InboxStore's). */
    askUser;
    /** P5-3: CheckpointStore via composition (list collides with EventStore's). */
    checkpoints;
    db;
    closed = false;
    constructor(opts) {
        if (opts.db !== undefined) {
            this.db = opts.db;
        }
        else if (opts.dataDir !== undefined) {
            mkdirSync(opts.dataDir, { recursive: true });
            this.db = new DatabaseSync(join(opts.dataDir, RUNTIME_DB_FILE_NAME));
        }
        else {
            throw new Error("SqliteRuntimeStore: one of `db` or `dataDir` is required");
        }
        this.db.exec("PRAGMA journal_mode=WAL;");
        this.db.exec("PRAGMA synchronous=NORMAL;");
        this.db.exec("PRAGMA busy_timeout=5000;");
        this.db.exec(SCHEMA_SQL);
        const row = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
        if (row === undefined) {
            this.db
                .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                .run(RUNTIME_SCHEMA_VERSION, Date.now());
        }
        this.askUser = {
            create: (request) => this.askUserCreate(request),
            get: (id) => this.askUserGet(id),
            listPending: (sessionId) => this.askUserListPending(sessionId),
            markAnswered: (id, reply) => this.askUserMarkAnswered(id, reply),
            markWithdrawn: (id) => this.askUserMarkWithdrawn(id),
        };
        this.checkpoints = {
            save: (checkpoint) => this.checkpointSave(checkpoint),
            loadLatest: (sessionId) => this.checkpointLoadLatest(sessionId),
            list: (sessionId) => this.checkpointList(sessionId),
        };
    }
    close() {
        if (this.closed)
            return; // idempotent close (lifecycle + test finally)
        this.closed = true;
        // Switch to DELETE journal mode before closing to release -shm/-wal files
        // on Windows (otherwise EBUSY during temp directory cleanup).
        try {
            this.db.exec("PRAGMA journal_mode=DELETE;");
        }
        catch {
            // best-effort: may fail on a read-only or busy store
        }
        this.db.close();
    }
    // --- SessionStore --------------------------------------------------------
    async createSession(session) {
        this.db
            .prepare(`INSERT INTO sessions (id, parent_id, status, created_at, updated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?)`)
            .run(session.id, session.parentId ?? null, session.status, session.createdAt, session.updatedAt, docOf(session));
    }
    async getSession(id) {
        const row = this.db.prepare("SELECT doc FROM sessions WHERE id = ?").get(id);
        return row === undefined ? undefined : parseDoc(row.doc, `session ${id}`);
    }
    async updateSession(session) {
        this.db
            .prepare("UPDATE sessions SET parent_id = ?, status = ?, updated_at = ?, doc = ? WHERE id = ?")
            .run(session.parentId ?? null, session.status, session.updatedAt, docOf(session), session.id);
    }
    async listSessions(opts = {}) {
        const where = [];
        const args = [];
        if (opts.parentId !== undefined) {
            where.push("parent_id = ?");
            args.push(opts.parentId);
        }
        if (opts.status !== undefined) {
            where.push("status = ?");
            args.push(opts.status);
        }
        const sql = `SELECT doc FROM sessions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
        const rows = this.db.prepare(sql).all(...args);
        return rows.map((row) => parseDoc(row.doc, "session"));
    }
    async createTurn(turn) {
        this.db
            .prepare(`INSERT INTO turns (id, session_id, status, started_at, doc) VALUES (?, ?, ?, ?, ?)`)
            .run(turn.id, turn.sessionId, turn.status, turn.startedAt, docOf(turn));
    }
    async getTurn(id) {
        const row = this.db.prepare("SELECT doc FROM turns WHERE id = ?").get(id);
        return row === undefined ? undefined : parseDoc(row.doc, `turn ${id}`);
    }
    async updateTurn(turn) {
        this.db
            .prepare("UPDATE turns SET session_id = ?, status = ?, started_at = ?, doc = ? WHERE id = ?")
            .run(turn.sessionId, turn.status, turn.startedAt, docOf(turn), turn.id);
    }
    async listTurns(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM turns WHERE session_id = ? ORDER BY started_at")
            .all(sessionId);
        return rows.map((row) => parseDoc(row.doc, "turn"));
    }
    async appendMessage(message) {
        this.db
            .prepare(`INSERT INTO messages (id, session_id, turn_id, created_at, doc) VALUES (?, ?, ?, ?, ?)`)
            .run(message.id, message.sessionId, message.turnId ?? null, message.createdAt, docOf(message));
    }
    async listMessages(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM messages WHERE session_id = ? ORDER BY created_at")
            .all(sessionId);
        return rows.map((row) => parseDoc(row.doc, "message"));
    }
    async listMessagesByTurn(sessionId, turnId) {
        const rows = this.db
            .prepare("SELECT doc FROM messages WHERE session_id = ? AND turn_id = ? ORDER BY created_at")
            .all(sessionId, turnId);
        return rows.map((row) => parseDoc(row.doc, "message"));
    }
    async saveStateSnapshot(sessionId, snapshot) {
        this.db
            .prepare("INSERT INTO state_snapshots (session_id, doc) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET doc = excluded.doc")
            .run(sessionId, docOf(snapshot));
    }
    async loadStateSnapshot(sessionId) {
        const row = this.db.prepare("SELECT doc FROM state_snapshots WHERE session_id = ?").get(sessionId);
        return row === undefined ? undefined : parseDoc(row.doc, `state snapshot ${sessionId}`);
    }
    // --- EventStore ----------------------------------------------------------
    async append(event) {
        if (!Number.isFinite(event.timestamp) || event.timestamp < 0) {
            throw new Error(`invalid event timestamp for ${event.id}: ${event.timestamp}`);
        }
        const tx = "BEGIN IMMEDIATE";
        this.db.exec(tx);
        try {
            // Id uniqueness (the JSONL store dedupes on event id; SQLite's natural
            // key is (session, sequence), so the id check is explicit).
            const dup = this.db
                .prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND json_extract(doc, '$.id') = ?")
                .get(event.sessionId, event.id);
            if (dup !== undefined) {
                throw new Error(`duplicate event id: ${event.id}`);
            }
            const row = this.db
                .prepare("SELECT MAX(sequence) AS seq FROM events WHERE session_id = ?")
                .get(event.sessionId);
            const sequence = (row.seq ?? -1) + 1;
            // Sequence is authoritative; ignore any caller-supplied value.
            const stored = { ...event, sequence };
            this.db
                .prepare("INSERT INTO events (session_id, sequence, doc) VALUES (?, ?, ?)")
                .run(stored.sessionId, sequence, docOf(stored));
            this.db.exec("COMMIT");
            return stored;
        }
        catch (cause) {
            this.db.exec("ROLLBACK");
            if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
                throw new Error(`duplicate event id/sequence for ${event.id}`);
            }
            throw cause;
        }
    }
    async list(sessionId, opts = {}) {
        const afterSequence = opts.afterSequence ?? -1;
        const rows = opts.limit === undefined
            ? this.db
                .prepare("SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
                .all(sessionId, afterSequence)
            : this.db
                .prepare("SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
                .all(sessionId, afterSequence, opts.limit);
        return rows.map((row) => parseDoc(row.doc, "event"));
    }
    async *stream(sessionId, opts = {}) {
        const afterSequence = opts.afterSequence ?? -1;
        const rows = this.db
            .prepare("SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
            .all(sessionId, afterSequence);
        for (const row of rows) {
            yield parseDoc(row.doc, "event");
        }
    }
    async nextSequence(sessionId) {
        const row = this.db
            .prepare("SELECT MAX(sequence) AS seq FROM events WHERE session_id = ?")
            .get(sessionId);
        return (row.seq ?? -1) + 1;
    }
    // --- InboxStore ----------------------------------------------------------
    async admit(prompt) {
        this.db
            .prepare(`INSERT INTO inbox (id, session_id, status, admitted_at, doc) VALUES (?, ?, ?, ?, ?)`)
            .run(prompt.id, prompt.sessionId, prompt.status, prompt.admittedAt, docOf(prompt));
    }
    async listPending(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM inbox WHERE session_id = ? AND status = 'pending' ORDER BY admitted_at")
            .all(sessionId);
        return rows.map((row) => parseDoc(row.doc, "inbox prompt"));
    }
    async listAll(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM inbox WHERE session_id = ? ORDER BY admitted_at")
            .all(sessionId);
        return rows.map((row) => parseDoc(row.doc, "inbox prompt"));
    }
    markInbox(id, status) {
        const row = this.db.prepare("SELECT doc FROM inbox WHERE id = ?").get(id);
        if (row === undefined)
            return Promise.resolve();
        const prompt = parseDoc(row.doc, "inbox prompt");
        const updated = {
            ...prompt,
            status: status,
            ...(status === "promoted" ? { promotedAt: Date.now() } : {}),
            ...(status === "consumed" ? { consumedAt: Date.now() } : {}),
        };
        this.db.prepare("UPDATE inbox SET status = ?, doc = ? WHERE id = ?").run(status, docOf(updated), id);
        return Promise.resolve();
    }
    async markPromoted(id) {
        return this.markInbox(id, "promoted");
    }
    async markConsumed(id) {
        return this.markInbox(id, "consumed");
    }
    // --- AskUserStore --------------------------------------------------------
    async askUserCreate(request) {
        this.db
            .prepare(`INSERT INTO ask_user (id, session_id, status, created_at, doc) VALUES (?, ?, ?, ?, ?)`)
            .run(request.id, request.sessionId, request.status, request.createdAt, docOf(request));
    }
    async askUserGet(id) {
        const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
        return row === undefined ? undefined : parseDoc(row.doc, `ask ${id}`);
    }
    async askUserListPending(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM ask_user WHERE session_id = ? AND status = 'pending' ORDER BY created_at")
            .all(sessionId);
        return rows.map((row) => parseDoc(row.doc, "ask"));
    }
    async askUserMarkAnswered(id, reply) {
        const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
        if (row === undefined)
            return;
        const request = parseDoc(row.doc, "ask");
        if (request.status !== "pending")
            return; // rejects/no-ops when not pending
        const updated = {
            ...request,
            status: "answered",
            answeredAt: Date.now(),
            answerText: reply.text,
        };
        this.db.prepare("UPDATE ask_user SET status = ?, doc = ? WHERE id = ?").run("answered", docOf(updated), id);
    }
    async askUserMarkWithdrawn(id) {
        const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
        if (row === undefined)
            return;
        const request = parseDoc(row.doc, "ask");
        const updated = { ...request, status: "withdrawn" };
        this.db.prepare("UPDATE ask_user SET status = ?, doc = ? WHERE id = ?").run("withdrawn", docOf(updated), id);
    }
    // --- CheckpointStore -----------------------------------------------------
    async checkpointSave(checkpoint) {
        this.db
            .prepare(`INSERT INTO checkpoints (checkpoint_id, session_id, created_at, doc) VALUES (?, ?, ?, ?)`)
            .run(checkpoint.checkpointId, checkpoint.sessionId, checkpoint.createdAt, docOf(checkpoint));
    }
    async checkpointLoadLatest(sessionId) {
        const row = this.db
            .prepare("SELECT doc FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
            .get(sessionId);
        if (row === undefined)
            return undefined;
        const checkpoint = parseDoc(row.doc, "checkpoint");
        if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
            return undefined;
        return checkpoint;
    }
    async checkpointList(sessionId) {
        const rows = this.db
            .prepare("SELECT doc FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC")
            .all(sessionId);
        return rows
            .map((row) => parseDoc(row.doc, "checkpoint"))
            .filter((checkpoint) => checkpoint.schemaVersion === CHECKPOINT_SCHEMA_VERSION);
    }
}
//# sourceMappingURL=sqlite-runtime-store.js.map