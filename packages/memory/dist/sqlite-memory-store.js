import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentError, errorInfo } from "@ar/contracts";
import { checkUnsafeMemory, scanMemoryEntries } from "./security-gate.js";
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
function ensureScopeColumn(db) {
    const cols = db.prepare("PRAGMA table_info(memories)").all();
    if (!cols.some((c) => c.name === "scope")) {
        db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN ('global','workspace','repository','agent','task-family','session'));");
    }
}
/** Migration for databases created before v3: add the evidence column (P2-2). */
function ensureEvidenceColumn(db) {
    const cols = db.prepare("PRAGMA table_info(memories)").all();
    if (!cols.some((c) => c.name === "evidence")) {
        db.exec("ALTER TABLE memories ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}';");
    }
}
/** Migration for databases created before v4: add the usefulness column (P2-3). */
function ensureUsefulnessColumn(db) {
    const cols = db.prepare("PRAGMA table_info(memories)").all();
    if (!cols.some((c) => c.name === "usefulness")) {
        db.exec("ALTER TABLE memories ADD COLUMN usefulness TEXT NOT NULL DEFAULT '{}';");
    }
}
/** Migration for databases created before v5: add the state column (P2-4). */
function ensureStateColumn(db) {
    const cols = db.prepare("PRAGMA table_info(memories)").all();
    if (!cols.some((c) => c.name === "state")) {
        db.exec("ALTER TABLE memories ADD COLUMN state TEXT;");
    }
}
function ensureSchemaVersion(db) {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    const applied = (row.v ?? 0);
    if (applied < 1) {
        db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, Date.now());
    }
    if (applied < MEMORY_SCHEMA_VERSION) {
        db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(MEMORY_SCHEMA_VERSION, Date.now());
    }
}
export class SqliteMemoryStore {
    db;
    onSecurityDenied;
    closed = false;
    constructor(opts) {
        this.onSecurityDenied = opts.onSecurityDenied;
        if (opts.db !== undefined) {
            this.db = opts.db;
        }
        else {
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
    get database() {
        return this.db;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.db.close();
    }
    /** Task B: scan all persisted entries for injection and secrets. */
    async scanForSecrets() {
        return scanMemoryEntries(await this.list({ deleted: true }));
    }
    static unknownMemory(id, op) {
        return new AgentError(errorInfo("INTERNAL_ERROR", `cannot ${op} unknown memory ${id}`));
    }
    rejectUnsafe(content) {
        const reason = checkUnsafeMemory(content, "sqlite-memory-store");
        if (reason !== null) {
            this.onSecurityDenied?.(reason.event);
            throw new AgentError(errorInfo("SECURITY_DENIED", `memory write blocked: ${reason.message}`));
        }
    }
    /** Upsert: replaces the row with the same id, otherwise inserts. */
    async write(entry) {
        this.rejectUnsafe(entry.content);
        this.db.exec("BEGIN IMMEDIATE;");
        try {
            const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
            if (existing !== undefined) {
                this.db.prepare("UPDATE memories SET content = ?, type = ?, source_session = ?, scope = ?, importance = ?, confidence = ?, novelty = ?, stability = ?, updated_at = ?, deleted = ?, evidence = ?, usefulness = ?, state = ? WHERE id = ?").run(entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.updatedAt, entry.deleted ? 1 : 0, entry.evidence !== undefined ? JSON.stringify(entry.evidence) : "{}", entry.usefulness !== undefined ? JSON.stringify(entry.usefulness) : "{}", entry.state !== undefined ? JSON.stringify(entry.state) : null, entry.id);
                this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(entry.id);
            }
            else {
                this.db.prepare("INSERT INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted, evidence, usefulness, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(entry.id, entry.content, entry.type, entry.sourceSession, entry.scope, entry.importance, entry.confidence, entry.novelty, entry.stability, entry.createdAt, entry.updatedAt, entry.deleted ? 1 : 0, entry.evidence !== undefined ? JSON.stringify(entry.evidence) : "{}", entry.usefulness !== undefined ? JSON.stringify(entry.usefulness) : "{}", entry.state !== undefined ? JSON.stringify(entry.state) : null);
            }
            this.db.prepare("INSERT INTO memories_fts (content, id) VALUES (?, ?)").run(entry.content, entry.id);
            this.db.exec("COMMIT;");
        }
        catch (cause) {
            this.db.exec("ROLLBACK;");
            throw new AgentError(errorInfo("INTERNAL_ERROR", `memory write failed: ${entry.id}`, { cause }));
        }
    }
    async get(id) {
        const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
        return row === undefined ? undefined : rowToEntry(row);
    }
    /**
     * Search entries by content. Uses the FTS5 index when the query tokenizes
     * cleanly; falls back to the LIKE/case-insensitive scan otherwise.
     * `opts.scope` filters by exact scope (hierarchy expansion is done by the
     * retrieval layer, P0-4).
     */
    async search(query, opts) {
        const q = query.trim();
        if (q === "")
            return [];
        const params = [];
        let where = "m.deleted = 0";
        if (opts?.type !== undefined) {
            where += " AND m.type = ?";
            params.push(opts.type);
        }
        if (opts?.scope !== undefined) {
            where += " AND m.scope = ?";
            params.push(opts.scope);
        }
        let rows;
        try {
            const ftsQuery = q.split(/\s+/).filter((t) => t !== "").map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
            if (ftsQuery === "")
                throw new Error("empty fts query");
            rows = this.db.prepare(`SELECT m.*, bm25(memories_fts) AS score FROM memories_fts f JOIN memories m ON m.id = f.id WHERE memories_fts MATCH ? AND ${where} ORDER BY score`).all(ftsQuery, ...params);
        }
        catch {
            rows = this.db.prepare(`SELECT m.*, 0 AS score FROM memories m WHERE ${where} AND LOWER(m.content) LIKE ?`).all(`%${q.toLowerCase()}%`, ...params);
        }
        return rows.map(rowToEntry);
    }
    /** List all rows; soft-deleted rows are hidden unless opts.deleted is true. */
    async list(opts) {
        const where = [];
        const params = [];
        if (opts?.deleted === undefined || opts.deleted === false) {
            where.push("deleted = 0");
        }
        if (opts?.scope !== undefined) {
            where.push("scope = ?");
            params.push(opts.scope);
        }
        const rows = this.db.prepare(`SELECT * FROM memories${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`).all(...params);
        return rows.map(rowToEntry);
    }
    /** Replaces an existing entry; unknown id fails explicitly. */
    async update(entry) {
        const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
        if (existing === undefined) {
            throw SqliteMemoryStore.unknownMemory(entry.id, "update");
        }
        await this.write(entry);
    }
    /** Soft delete: row stays, `deleted` flips to true, updatedAt bumps. */
    async remove(id) {
        const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
        if (existing === undefined) {
            throw SqliteMemoryStore.unknownMemory(id, "remove");
        }
        this.db.prepare("UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
    }
}
/** Parse the evidence JSON column; corrupt/legacy/empty rows degrade to undefined. */
function evidenceOf(row) {
    if (row.evidence === undefined || row.evidence === "" || row.evidence === "{}") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(row.evidence);
        if (parsed !== null && typeof parsed === "object")
            return parsed;
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** Parse the usefulness JSON column; corrupt/legacy/empty rows degrade to undefined. */
function usefulnessOf(row) {
    if (row.usefulness === undefined || row.usefulness === "" || row.usefulness === "{}") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(row.usefulness);
        if (parsed !== null && typeof parsed === "object")
            return parsed;
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** Parse the state JSON column; absent/empty rows mean active. */
function stateOf(row) {
    if (row.state === undefined || row.state === "" || row.state === "null") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(row.state);
        if (parsed !== null && typeof parsed === "object")
            return parsed;
        return undefined;
    }
    catch {
        return undefined;
    }
}
function rowToEntry(row) {
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
    };
}
export async function migrateJsonlToSqlite(store, entries, opts) {
    const result = { total: entries.length, inserted: 0, skipped: 0, denied: [] };
    if (entries.length === 0)
        return result;
    const insert = store.database.prepare("INSERT OR IGNORE INTO memories (id, content, type, source_session, scope, importance, confidence, novelty, stability, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const index = store.database.prepare("INSERT OR IGNORE INTO memories_fts (content, id) VALUES (?, ?)");
    const dryRun = opts?.dryRun === true;
    if (!dryRun)
        store.database.exec("BEGIN IMMEDIATE;");
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
                }
                else {
                    result.skipped += 1;
                }
            }
            else {
                const existing = store.database.prepare("SELECT id FROM memories WHERE id = ?").get(entry.id);
                if (existing === undefined)
                    result.inserted += 1;
                else
                    result.skipped += 1;
            }
        }
        if (!dryRun)
            store.database.exec("COMMIT;");
    }
    catch (cause) {
        if (!dryRun)
            store.database.exec("ROLLBACK;");
        throw new AgentError(errorInfo("INTERNAL_ERROR", "memory migration failed", { cause }));
    }
    return result;
}
//# sourceMappingURL=sqlite-memory-store.js.map