import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type {
  MemoryEntry,
  MemoryEvidence,
  MemoryId,
  MemoryScope,
  MemoryState,
  MemoryStore,
  MemoryType,
  MemoryUsefulness,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { checkUnsafeMemory, scanMemoryEntries } from "./security-gate.js";

/**
 * P0-3: SQLite + WAL backend for the contracts MemoryStore (memories.db in
 * dataDir, schema versioned via schema_migrations).
 *
 * - Single DatabaseSync connection (node:sqlite, synchronous API); every
 *   mutation runs inside an explicit transaction, so concurrent callers
 *   (even interleaved through Promise.all) serialize correctly and never
 *   lose updates.
 * - WAL journaling (PRAGMA journal_mode=WAL): readers never block writers
 *   and a crash cannot leave a torn write; the store file survives.
 * - remove() is a soft delete: the row stays, `deleted` flips to true and
 *   updatedAt bumps, so memory stays reviewable and recoverable (§67) —
 *   the same semantics as JsonlMemoryStore.
 * - The security gate (injection/secret rejection) is shared with the
 *   JSONL backend: identical behavior on every persistence path (§67).
 * - FTS5 full-text index over content for search; the plain LIKE fallback
 *   is kept so search still works if the FTS5 tokenizer rejects a query.
 */
export interface SqliteMemoryStoreOptions {
  /** Directory holding memories.db; created on first open. */
  dataDir: string;
  /** Optional callback fired when a write/update is denied (injection or secret). */
  onSecurityDenied?: (event: { detection: "injection" | "secret"; reasons: string[]; content: string; source: string }) => void;
  /** Optional pre-opened database (used by tests); otherwise dataDir/memories.db. */
  db?: DatabaseSync;
}

/** SQLite store file name (sibling to memories.jsonl). */
export const MEMORY_DB_FILE_NAME = "memories.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('explicit','episodic','procedural')),
  source_session TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN ('global','workspace','repository','agent','task-family','session')),
  importance REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  novelty REAL NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '{}',
  usefulness TEXT NOT NULL DEFAULT '{}',
  state TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories (deleted);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, id UNINDEXED
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/** Schema version 5: memories.state column (P2-4). */
export const MEMORY_SCHEMA_VERSION = 5;

/** Migration for databases created before v2: add the scope column. */
function ensureScopeColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "scope")) {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN ('global','workspace','repository','agent','task-family','session'));");
  }
}

/** Migration for databases created before v3: add the evidence column (P2-2). */
function ensureEvidenceColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "evidence")) {
    db.exec("ALTER TABLE memories ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}';");
  }
}

/** Migration for databases created before v4: add the usefulness column (P2-3). */
function ensureUsefulnessColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "usefulness")) {
    db.exec("ALTER TABLE memories ADD COLUMN usefulness TEXT NOT NULL DEFAULT '{}';");
  }
}

/** Migration for databases created before v5: add the state column (P2-4). */
function ensureStateColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "state")) {
    db.exec("ALTER TABLE memories ADD COLUMN state TEXT;");
  }
}

function ensureSchemaVersion(db: DatabaseSync): void {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const applied = (row.v ?? 0);
  if (applied < 1) {
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, Date.now());
  }
  if (applied < MEMORY_SCHEMA_VERSION) {
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(MEMORY_SCHEMA_VERSION, Date.now());
  }
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly onSecurityDenied?: SqliteMemoryStoreOptions["onSecurityDenied"];
  private closed = false;

  constructor(opts: SqliteMemoryStoreOptions) {
    this.onSecurityDenied = opts.onSecurityDenied;
    if (opts.db !== undefined) {
      this.db = opts.db;
    } else {
      mkdirSync(opts.dataDir, { recursive: true });
      this.db = new DatabaseSync(join(opts.dataDir, MEMORY_DB_FILE_NAME));
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    ensureScopeColumn(this.db);
    ensureEvidenceColumn(this.db);
    ensureUsefulnessColumn(this.db);
    ensureStateColumn(this.db);
    ensureSchemaVersion(this.db);
  }

  get database(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Task B: scan all persisted entries for injection and secrets. */
  async scanForSecrets(): Promise<Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }>> {
    return scanMemoryEntries(await this.list({ deleted: true }));
  }

  private static unknownMemory(id: MemoryId, op: string): AgentError {
    return new AgentError(
      errorInfo("INTERNAL_ERROR", `cannot ${op} unknown memory ${id}`),
    );
  }

  private rejectUnsafe(content: string): void {
    const reason = checkUnsafeMemory(content, "sqlite-memory-store");
    if (reason !== null) {
      this.onSecurityDenied?.(reason.event);
      throw new AgentError(errorInfo("SECURITY_DENIED", `memory write blocked: ${reason.message}`));
    }
  }

  /** Upsert: replaces the row with the same id, otherwise inserts. */
  async write(entry: MemoryEntry): Promise<void> {
    this.rejectUnsafe(entry.content);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
      if (existing !== undefined) {
        this.db.prepare(
          "UPDATE memories SET content = ?, type = ?, source_session = ?, scope = ?, importance = ?, confidence = ?, novelty = ?, stability = ?, updated_at = ?, deleted = ?, evidence = ?, usefulness = ?, state = ? WHERE id = ?",
        ).run(entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.updatedAt, entry.deleted ? 1 : 0, entry.evidence !== undefined ? JSON.stringify(entry.evidence) : "{}", entry.usefulness !== undefined ? JSON.stringify(entry.usefulness) : "{}", entry.state !== undefined ? JSON.stringify(entry.state) : null, entry.id);
        this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(entry.id);
      } else {
        this.db.prepare(
          "INSERT INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted, evidence, usefulness, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(entry.id, entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.createdAt, entry.updatedAt, entry.deleted ? 1 : 0, entry.evidence !== undefined ? JSON.stringify(entry.evidence) : "{}", entry.usefulness !== undefined ? JSON.stringify(entry.usefulness) : "{}", entry.state !== undefined ? JSON.stringify(entry.state) : null);
      }
      this.db.prepare("INSERT INTO memories_fts (content, id) VALUES (?, ?)").run(entry.content, entry.id);
      this.db.exec("COMMIT;");
    } catch (cause) {
      this.db.exec("ROLLBACK;");
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `memory write failed: ${entry.id}`, { cause }),
      );
    }
  }

  async get(id: MemoryId): Promise<MemoryEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as SqliteRow | undefined;
    return row === undefined ? undefined : rowToEntry(row);
  }

  /**
   * Search entries by content. Uses the FTS5 index when the query tokenizes
   * cleanly; falls back to the LIKE/case-insensitive scan otherwise.
   * `opts.scope` filters by exact scope (hierarchy expansion is done by the
   * retrieval layer, P0-4).
   */
  async search(query: string, opts?: { type?: MemoryType; scope?: MemoryScope }): Promise<MemoryEntry[]> {
    const q = query.trim();
    if (q === "") return [];
    const params: SQLInputValue[] = [];
    let where = "m.deleted = 0";
    if (opts?.type !== undefined) {
      where += " AND m.type = ?";
      params.push(opts.type);
    }
    if (opts?.scope !== undefined) {
      where += " AND m.scope = ?";
      params.push(opts.scope);
    }
    let rows: SqliteRow[];
    try {
      const ftsQuery = q.split(/\s+/).filter((t) => t !== "").map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
      if (ftsQuery === "") throw new Error("empty fts query");
      rows = this.db.prepare(
        `SELECT m.*, bm25(memories_fts) AS score FROM memories_fts f JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? AND ${where} ORDER BY score`,
      ).all(ftsQuery, ...params) as unknown as SqliteRow[];
    } catch {
      rows = this.db.prepare(
        `SELECT m.*, 0 AS score FROM memories m WHERE ${where} AND LOWER(m.content) LIKE ?`,
      ).all(`%${q.toLowerCase()}%`, ...params) as unknown as SqliteRow[];
    }
    return rows.map(rowToEntry);
  }

  /** List all rows; soft-deleted rows are hidden unless opts.deleted is true. */
  async list(opts?: { deleted?: boolean; scope?: MemoryScope }): Promise<MemoryEntry[]> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts?.deleted === undefined || opts.deleted === false) {
      where.push("deleted = 0");
    }
    if (opts?.scope !== undefined) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    const rows = this.db.prepare(
      `SELECT * FROM memories${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`,
    ).all(...params) as unknown as SqliteRow[];
    return rows.map(rowToEntry);
  }

  /** Replaces an existing entry; unknown id fails explicitly. */
  async update(entry: MemoryEntry): Promise<void> {
    const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
    if (existing === undefined) {
      throw SqliteMemoryStore.unknownMemory(entry.id, "update");
    }
    await this.write(entry);
  }

  /** Soft delete: row stays, `deleted` flips to true, updatedAt bumps. */
  async remove(id: MemoryId): Promise<void> {
    const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
    if (existing === undefined) {
      throw SqliteMemoryStore.unknownMemory(id, "remove");
    }
    this.db.prepare("UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
}

interface SqliteRow {
  id: string;
  content: string;
  type: MemoryType;
  source_session: string;
  scope: MemoryScope;
  importance: number;
  confidence: number;
  novelty: number;
  stability: number;
  created_at: number;
  updated_at: number;
  deleted: number;
  evidence?: string;
  usefulness?: string;
  state?: string;
  score?: number;
}

/** Parse the evidence JSON column; corrupt/legacy/empty rows degrade to undefined. */
function evidenceOf(row: SqliteRow): MemoryEvidence | undefined {
  if (row.evidence === undefined || row.evidence === "" || row.evidence === "{}") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(row.evidence) as unknown;
    if (parsed !== null && typeof parsed === "object") return parsed as MemoryEvidence;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parse the usefulness JSON column; corrupt/legacy/empty rows degrade to undefined. */
function usefulnessOf(row: SqliteRow): MemoryUsefulness | undefined {
  if (row.usefulness === undefined || row.usefulness === "" || row.usefulness === "{}") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(row.usefulness) as unknown;
    if (parsed !== null && typeof parsed === "object") return parsed as MemoryUsefulness;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parse the state JSON column; absent/empty rows mean active. */
function stateOf(row: SqliteRow): MemoryState | undefined {
  if (row.state === undefined || row.state === "" || row.state === "null") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(row.state) as unknown;
    if (parsed !== null && typeof parsed === "object") return parsed as MemoryState;
    return undefined;
  } catch {
    return undefined;
  }
}

function rowToEntry(row: SqliteRow): MemoryEntry {
  const evidence = evidenceOf(row);
  const usefulness = usefulnessOf(row);
  const state = stateOf(row);
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    sourceSession: row.source_session,
    scope: row.scope,
    importance: row.importance,
    confidence: row.confidence,
    novelty: row.novelty,
    stability: row.stability,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(usefulness !== undefined ? { usefulness } : {}),
    ...(state !== undefined ? { state } : {}),
  } as MemoryEntry;
}

/**
 * Migrate an existing memories.jsonl into the SQLite store.
 *
 * - Idempotent: entries already present in the DB are skipped (same id),
 *   so a retry after an interrupted run does not duplicate or lose data.
 * - Crash-safe: all inserts run inside a single transaction.
 * - Non-destructive: the JSONL file is never deleted or modified; the
 *   caller decides when to remove it (and when a backup is safe).
 * - Dry-run: with dryRun=true no transaction is opened and nothing is
 *   written; the returned count is what would be inserted.
 * - Entries that fail the security gate (injection/secret) are reported
 *   and skipped, never silently written.
 */
export interface MigrateResult {
  /** Entries read from the JSONL file. */
  total: number;
  /** Entries inserted into SQLite (skipped ones were already present). */
  inserted: number;
  /** Entries skipped because they were already in the DB (idempotency). */
  skipped: number;
  /** Entries rejected by the security gate. */
  denied: Array<{ id: string; detection: "injection" | "secret"; reasons: string[] }>;
}

export async function migrateJsonlToSqlite(
  store: SqliteMemoryStore,
  entries: MemoryEntry[],
  opts?: { dryRun?: boolean },
): Promise<MigrateResult> {
  const result: MigrateResult = { total: entries.length, inserted: 0, skipped: 0, denied: [] };
  if (entries.length === 0) return result;

  const insert = store.database.prepare(
    "INSERT OR IGNORE INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const index = store.database.prepare("INSERT OR IGNORE INTO memories_fts (content, id) VALUES (?, ?)");
  const dryRun = opts?.dryRun === true;

  if (!dryRun) store.database.exec("BEGIN IMMEDIATE;");
  try {
    for (const entry of entries) {
      const reason = checkUnsafeMemory(entry.content, "sqlite-memory-store");
      if (reason !== null) {
        result.denied.push({ id: entry.id, detection: reason.event.detection, reasons: reason.event.reasons });
        continue;
      }
      if (!dryRun) {
        const r = insert.run(entry.id, entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.createdAt, entry.updatedAt, entry.deleted ? 1 : 0);
        if (r.changes === 1) {
          index.run(entry.content, entry.id);
          result.inserted += 1;
        } else {
          result.skipped += 1;
        }
      } else {
        const existing = store.database.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
        if (existing === undefined) result.inserted += 1;
        else result.skipped += 1;
      }
    }
    if (!dryRun) store.database.exec("COMMIT;");
  } catch (cause) {
    if (!dryRun) store.database.exec("ROLLBACK;");
    throw new AgentError(
      errorInfo("INTERNAL_ERROR", "memory migration failed", { cause }),
    );
  }
  return result;
}
