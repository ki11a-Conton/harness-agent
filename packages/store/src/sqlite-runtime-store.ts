import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AdmittedPrompt,
  AgentEvent,
  AskUserRequest,
  AskUserReply,
  AskId,
  CheckpointData,
  CheckpointStore,
  DurabilityLevel,
  EventStore,
  InboxStore,
  Message,
  MessageId,
  PromptId,
  Session,
  SessionId,
  SessionStore,
  ToolOutcomeCommit,
  Turn,
  TurnId,
} from "@ar/contracts";
import { CHECKPOINT_SCHEMA_VERSION, EVENT_ABI_VERSION } from "@ar/contracts";
import type { AskUserStore } from "@ar/contracts";

/**
 * P38.3-1: inbox lineage errors raised by this store. The `@ar/store` package
 * deliberately does NOT depend on `@ar/session` (where SessionStoreError
 * lives), so inbox invariant violations surface as plain Error objects carrying
 * the same stable `code` ("PROMOTION_CONFLICT" / "CONSUME_NOT_PROMOTED") that
 * the session inbox stores use — fail-closed, typed enough to assert on.
 */
function inboxLineageError(code: "PROMOTION_CONFLICT" | "CONSUME_NOT_PROMOTED", message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

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

function docOf(value: unknown): string {
  return JSON.stringify(value);
}

function parseDoc<T>(raw: SQLInputValue | undefined, label: string): T {
  if (typeof raw !== "string") {
    throw new Error(`store: missing or corrupt ${label}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`store: corrupt ${label} (invalid JSON)`);
  }
}

/** Adapter that implements the runtime store contracts on one DB. */
// InboxStore and AskUserStore BOTH define `listPending(sessionId)` (with
// different row shapes) — a single class cannot implement two same-signature
// methods, so AskUserStore is exposed via composition under `.askUser` while
// the other four contracts are implemented directly.
export class SqliteRuntimeStore
  implements SessionStore, EventStore, InboxStore
{
  /** P5-3: AskUserStore via composition (listPending collides with InboxStore's). */
  readonly askUser: AskUserStore;
  /** P5-3: CheckpointStore via composition (list collides with EventStore's). */
  readonly checkpoints: CheckpointStore;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(opts: SqliteRuntimeStoreOptions) {
    if (opts.db !== undefined) {
      this.db = opts.db;
    } else if (opts.dataDir !== undefined) {
      mkdirSync(opts.dataDir, { recursive: true });
      this.db = new DatabaseSync(join(opts.dataDir, RUNTIME_DB_FILE_NAME));
    } else {
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

  close(): void {
    if (this.closed) return; // idempotent close (lifecycle + test finally)
    this.closed = true;
    // Switch to DELETE journal mode before closing to release -shm/-wal files
    // on Windows (otherwise EBUSY during temp directory cleanup).
    try {
      this.db.exec("PRAGMA journal_mode=DELETE;");
    } catch (err) {
      // P14-6: best-effort — may fail on a read-only or busy store, but the
      // failure is reported, never silent.
      process.stderr.write(`[degraded] sqlite-store.close-journal-mode: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    this.db.close();
  }

  // --- SessionStore --------------------------------------------------------

  async createSession(session: Session): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, parent_id, status, created_at, updated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.parentId ?? null,
        session.status,
        session.createdAt,
        session.updatedAt,
        docOf(session),
      );
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    const row = this.db.prepare("SELECT doc FROM sessions WHERE id = ?").get(id);
    return row === undefined ? undefined : parseDoc<Session>(row.doc, `session ${id}`);
  }

  async updateSession(session: Session): Promise<void> {
    this.db
      .prepare(
        "UPDATE sessions SET parent_id = ?, status = ?, updated_at = ?, doc = ? WHERE id = ?",
      )
      .run(session.parentId ?? null, session.status, session.updatedAt, docOf(session), session.id);
  }

  async listSessions(opts: { parentId?: SessionId; status?: Session["status"] } = {}): Promise<Session[]> {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
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
    return rows.map((row) => parseDoc<Session>(row.doc, "session"));
  }

  async createTurn(turn: Turn): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, status, started_at, doc) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(turn.id, turn.sessionId, turn.status, turn.startedAt, docOf(turn));
  }

  async getTurn(id: TurnId): Promise<Turn | undefined> {
    const row = this.db.prepare("SELECT doc FROM turns WHERE id = ?").get(id);
    return row === undefined ? undefined : parseDoc<Turn>(row.doc, `turn ${id}`);
  }

  async updateTurn(turn: Turn): Promise<void> {
    this.db
      .prepare("UPDATE turns SET session_id = ?, status = ?, started_at = ?, doc = ? WHERE id = ?")
      .run(turn.sessionId, turn.status, turn.startedAt, docOf(turn), turn.id);
  }

  async listTurns(sessionId: SessionId): Promise<Turn[]> {
    const rows = this.db
      .prepare("SELECT doc FROM turns WHERE session_id = ? ORDER BY started_at")
      .all(sessionId);
    return rows.map((row) => parseDoc<Turn>(row.doc, "turn"));
  }

  async appendMessage(message: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, turn_id, created_at, doc) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.sessionId, message.turnId ?? null, message.createdAt, docOf(message));
  }

  async listMessages(sessionId: SessionId): Promise<Message[]> {
    const rows = this.db
      .prepare("SELECT doc FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(sessionId);
    return rows.map((row) => parseDoc<Message>(row.doc, "message"));
  }

  async listMessagesByTurn(sessionId: SessionId, turnId: TurnId): Promise<Message[]> {
    const rows = this.db
      .prepare("SELECT doc FROM messages WHERE session_id = ? AND turn_id = ? ORDER BY created_at")
      .all(sessionId, turnId);
    return rows.map((row) => parseDoc<Message>(row.doc, "message"));
  }

  async saveStateSnapshot(sessionId: SessionId, snapshot: Record<string, unknown>): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO state_snapshots (session_id, doc) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET doc = excluded.doc",
      )
      .run(sessionId, docOf(snapshot));
  }

  async loadStateSnapshot(sessionId: SessionId): Promise<Record<string, unknown> | undefined> {
    const row = this.db.prepare("SELECT doc FROM state_snapshots WHERE session_id = ?").get(sessionId);
    return row === undefined ? undefined : parseDoc<Record<string, unknown>>(row.doc, `state snapshot ${sessionId}`);
  }

  // --- EventStore ----------------------------------------------------------

  async append(event: AgentEvent): Promise<AgentEvent> {
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
        .get(event.sessionId) as { seq: number | null };
      const sequence = (row.seq ?? -1) + 1;
      // Sequence is authoritative; ignore any caller-supplied value.
      const stored: AgentEvent = { ...event, sequence };
      this.db
        .prepare("INSERT INTO events (session_id, sequence, doc) VALUES (?, ?, ?)")
        .run(stored.sessionId, sequence, docOf(stored));
      this.db.exec("COMMIT");
      return stored;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
        throw new Error(`duplicate event id/sequence for ${event.id}`);
      }
      throw cause;
    }
  }

  /** P26-1: store-owned atomic sequence allocation — the caller never
   *  allocates; the placeholder sequence is overwritten by the store. */
  async appendNew(event: Omit<AgentEvent, "sequence">): Promise<AgentEvent> {
    return this.append({ ...event, sequence: -1 });
  }

  /** P26-6: atomic semantic-boundary capability — the transcript message, the
   *  outcome event AND the optional checkpoint commit in ONE transaction.
   *  Stores without this capability fall back to ordered writes + fences
   *  (P26-3); SQLite advertises it explicitly. */
  readonly atomicCommitSupported = true as const;

  async commitToolOutcome(commit: ToolOutcomeCommit): Promise<{ event: AgentEvent }> {
    const { toolMessage, outcomeEvent, checkpoint } = commit;
    if (!Number.isFinite(outcomeEvent.timestamp) || outcomeEvent.timestamp < 0) {
      throw new Error(`invalid event timestamp for ${outcomeEvent.id}: ${outcomeEvent.timestamp}`);
    }
    const sessionId = toolMessage.sessionId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. transcript message
      this.db
        .prepare(
          "INSERT INTO messages (id, session_id, turn_id, created_at, doc) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          toolMessage.id,
          toolMessage.sessionId,
          toolMessage.turnId ?? null,
          toolMessage.createdAt,
          docOf(toolMessage),
        );
      // 2. outcome event with a store-owned atomic sequence
      const dup = this.db
        .prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND json_extract(doc, '$.id') = ?")
        .get(sessionId, outcomeEvent.id);
      if (dup !== undefined) {
        throw new Error(`duplicate event id: ${outcomeEvent.id}`);
      }
      const row = this.db
        .prepare("SELECT MAX(sequence) AS seq FROM events WHERE session_id = ?")
        .get(sessionId) as { seq: number | null };
      const sequence = (row.seq ?? -1) + 1;
      const stored: AgentEvent = {
        ...outcomeEvent,
        sequence,
        schemaVersion: EVENT_ABI_VERSION,
      };
      this.db
        .prepare("INSERT INTO events (session_id, sequence, doc) VALUES (?, ?, ?)")
        .run(sessionId, sequence, docOf(stored));
      // 3. optional checkpoint in the SAME transaction
      if (checkpoint !== undefined) {
        this.db
          .prepare(
            "INSERT INTO checkpoints (checkpoint_id, session_id, created_at, doc) VALUES (?, ?, ?, ?)",
          )
          .run(
            checkpoint.checkpointId,
            checkpoint.sessionId,
            checkpoint.createdAt,
            docOf(checkpoint),
          );
      }
      this.db.exec("COMMIT");
      return { event: stored };
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /** P26-3: HONEST durability declaration. WAL + synchronous=NORMAL makes
   *  committed transactions survive a process crash (the frames live in the
   *  WAL in the OS page cache) but NOT an OS crash/power loss (frames may
   *  not be fsynced before checkpoint). We therefore claim "process", never
   *  "crash_safe" — the JSONL store is the crash_safe backend. */
  get durabilityLevel(): DurabilityLevel {
    return "process";
  }

  /** P26-3: fold the WAL into the main db so a subsequent process (or OS
   *  crash recovery) sees every committed event up to `sequence`. Idempotent;
   *  PASSIVE never blocks a concurrent writer. */
  async flushThrough(sessionId: SessionId, sequence: number): Promise<void> {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    const row = this.db
      .prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND sequence = ?")
      .get(sessionId, sequence);
    if (row === undefined && sequence !== Number.MAX_SAFE_INTEGER) {
      throw new Error(`flushThrough: event ${sequence} for ${sessionId} is not committed`);
    }
  }

  async list(
    sessionId: SessionId,
    opts: { afterSequence?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    const afterSequence = opts.afterSequence ?? -1;
    const rows =
      opts.limit === undefined
        ? this.db
            .prepare("SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
            .all(sessionId, afterSequence)
        : this.db
            .prepare(
              "SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            )
            .all(sessionId, afterSequence, opts.limit);
    return rows.map((row) => parseDoc<AgentEvent>(row.doc, "event"));
  }

  async *stream(
    sessionId: SessionId,
    opts: { afterSequence?: number } = {},
  ): AsyncIterable<AgentEvent> {
    const afterSequence = opts.afterSequence ?? -1;
    const rows = this.db
      .prepare("SELECT doc FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
      .all(sessionId, afterSequence);
    for (const row of rows) {
      yield parseDoc<AgentEvent>(row.doc, "event");
    }
  }

  async nextSequence(sessionId: SessionId): Promise<number> {
    const row = this.db
      .prepare("SELECT MAX(sequence) AS seq FROM events WHERE session_id = ?")
      .get(sessionId) as { seq: number | null };
    return (row.seq ?? -1) + 1;
  }

  // --- InboxStore ----------------------------------------------------------

  async admit(prompt: AdmittedPrompt): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO inbox (id, session_id, status, admitted_at, doc) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(prompt.id, prompt.sessionId, prompt.status, prompt.admittedAt, docOf(prompt));
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    const rows = this.db
      .prepare("SELECT doc FROM inbox WHERE session_id = ? AND status = 'pending' ORDER BY admitted_at")
      .all(sessionId);
    return rows.map((row) => parseDoc<AdmittedPrompt>(row.doc, "inbox prompt"));
  }

  /** P38.3-3 (INV-P38.3-003): recovery query — pending + promoted followups.
   *  Consumed prompts are excluded. */
  async listRecoverable(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    const rows = this.db
      .prepare(
        "SELECT doc FROM inbox WHERE session_id = ? AND status IN ('pending', 'promoted') ORDER BY admitted_at",
      )
      .all(sessionId);
    return rows.map((row) => parseDoc<AdmittedPrompt>(row.doc, "inbox prompt"));
  }

  async listAll(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    const rows = this.db
      .prepare("SELECT doc FROM inbox WHERE session_id = ? ORDER BY admitted_at")
      .all(sessionId);
    return rows.map((row) => parseDoc<AdmittedPrompt>(row.doc, "inbox prompt"));
  }

  private markInbox(id: PromptId, status: string): Promise<void> {
    const row = this.db.prepare("SELECT doc FROM inbox WHERE id = ?").get(id);
    if (row === undefined) return Promise.resolve();
    const prompt = parseDoc<AdmittedPrompt>(row.doc, "inbox prompt");
    const updated: AdmittedPrompt = {
      ...prompt,
      status: status as AdmittedPrompt["status"],
      ...(status === "promoted" ? { promotedAt: Date.now() } : {}),
      ...(status === "consumed" ? { consumedAt: Date.now() } : {}),
    };
    this.db.prepare("UPDATE inbox SET status = ?, doc = ? WHERE id = ?").run(status, docOf(updated), id);
    return Promise.resolve();
  }

  async bindPromotion(id: PromptId, turnId: TurnId): Promise<void> {
    const row = this.db.prepare("SELECT doc FROM inbox WHERE id = ?").get(id);
    if (row === undefined) return Promise.resolve();
    const prompt = parseDoc<AdmittedPrompt>(row.doc, "inbox prompt");
    if (prompt.promotedTurnId !== undefined && prompt.promotedTurnId !== turnId) {
      throw inboxLineageError(
        "PROMOTION_CONFLICT",
        `prompt ${id} already bound to turn ${prompt.promotedTurnId}; refusing lineage rewrite to ${turnId}`,
      );
    }
    const updated: AdmittedPrompt = {
      ...prompt,
      status: "promoted",
      promotedAt: Date.now(),
      promotedTurnId: turnId,
    };
    this.db.prepare("UPDATE inbox SET status = 'promoted', doc = ? WHERE id = ?").run(docOf(updated), id);
    return Promise.resolve();
  }

  async markPromoted(id: PromptId): Promise<void> {
    return this.markInbox(id, "promoted");
  }

  async markConsumed(id: PromptId): Promise<void> {
    const row = this.db.prepare("SELECT doc FROM inbox WHERE id = ?").get(id);
    if (row === undefined) return Promise.resolve();
    const prompt = parseDoc<AdmittedPrompt>(row.doc, "inbox prompt");
    if (prompt.status === "pending") {
      throw inboxLineageError(
        "CONSUME_NOT_PROMOTED",
        `prompt ${id} is pending and unbound; cannot consume before promotion`,
      );
    }
    const updated: AdmittedPrompt = {
      ...prompt,
      status: "consumed",
      consumedAt: Date.now(),
    };
    this.db.prepare("UPDATE inbox SET status = 'consumed', doc = ? WHERE id = ?").run(docOf(updated), id);
    return Promise.resolve();
  }

  // --- AskUserStore --------------------------------------------------------

  private async askUserCreate(request: AskUserRequest): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ask_user (id, session_id, status, created_at, doc) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(request.id, request.sessionId, request.status, request.createdAt, docOf(request));
  }

  private async askUserGet(id: AskId): Promise<AskUserRequest | undefined> {
    const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
    return row === undefined ? undefined : parseDoc<AskUserRequest>(row.doc, `ask ${id}`);
  }

  private async askUserListPending(sessionId: SessionId): Promise<AskUserRequest[]> {
    const rows = this.db
      .prepare(
        "SELECT doc FROM ask_user WHERE session_id = ? AND status = 'pending' ORDER BY created_at",
      )
      .all(sessionId);
    return rows.map((row) => parseDoc<AskUserRequest>(row.doc, "ask"));
  }

  private async askUserMarkAnswered(id: AskId, reply: AskUserReply): Promise<void> {
    const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
    if (row === undefined) return;
    const request = parseDoc<AskUserRequest>(row.doc, "ask");
    if (request.status !== "pending") return; // rejects/no-ops when not pending
    const updated: AskUserRequest = {
      ...request,
      status: "answered",
      answeredAt: Date.now(),
      answerText: reply.text,
    };
    this.db.prepare("UPDATE ask_user SET status = ?, doc = ? WHERE id = ?").run("answered", docOf(updated), id);
  }

  private async askUserMarkWithdrawn(id: AskId): Promise<void> {
    const row = this.db.prepare("SELECT doc FROM ask_user WHERE id = ?").get(id);
    if (row === undefined) return;
    const request = parseDoc<AskUserRequest>(row.doc, "ask");
    const updated: AskUserRequest = { ...request, status: "withdrawn" };
    this.db.prepare("UPDATE ask_user SET status = ?, doc = ? WHERE id = ?").run("withdrawn", docOf(updated), id);
  }

  // --- CheckpointStore -----------------------------------------------------

  private async checkpointSave(checkpoint: CheckpointData): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO checkpoints (checkpoint_id, session_id, created_at, doc) VALUES (?, ?, ?, ?)`,
      )
      .run(checkpoint.checkpointId, checkpoint.sessionId, checkpoint.createdAt, docOf(checkpoint));
  }

  private async checkpointLoadLatest(sessionId: SessionId): Promise<CheckpointData | undefined> {
    const row = this.db
      .prepare("SELECT doc FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId);
    if (row === undefined) return undefined;
    const checkpoint = parseDoc<CheckpointData>(row.doc, "checkpoint");
    if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return undefined;
    return checkpoint;
  }

  private async checkpointList(sessionId: SessionId): Promise<CheckpointData[]> {
    const rows = this.db
      .prepare("SELECT doc FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId);
    return rows
      .map((row) => parseDoc<CheckpointData>(row.doc, "checkpoint"))
      .filter((checkpoint) => checkpoint.schemaVersion === CHECKPOINT_SCHEMA_VERSION);
  }
}

