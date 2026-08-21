import { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, MemoryId, MemoryScope, MemoryStore, MemoryType } from "@ar/contracts";
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
    onSecurityDenied?: (event: {
        detection: "injection" | "secret";
        reasons: string[];
        content: string;
        source: string;
    }) => void;
    /** Optional pre-opened database (used by tests); otherwise dataDir/memories.db. */
    db?: DatabaseSync;
}
/** SQLite store file name (sibling to memories.jsonl). */
export declare const MEMORY_DB_FILE_NAME = "memories.db";
/** Schema version 5: memories.state column (P2-4). */
export declare const MEMORY_SCHEMA_VERSION = 5;
export declare class SqliteMemoryStore implements MemoryStore {
    private readonly db;
    private readonly onSecurityDenied?;
    private closed;
    constructor(opts: SqliteMemoryStoreOptions);
    get database(): DatabaseSync;
    close(): void;
    /** Task B: scan all persisted entries for injection and secrets. */
    scanForSecrets(): Promise<Array<{
        entry: MemoryEntry;
        issues: {
            detection: "injection" | "secret";
            reasons: string[];
        }[];
    }>>;
    private static unknownMemory;
    private rejectUnsafe;
    /** Upsert: replaces the row with the same id, otherwise inserts. */
    write(entry: MemoryEntry): Promise<void>;
    get(id: MemoryId): Promise<MemoryEntry | undefined>;
    /**
     * Search entries by content. Uses the FTS5 index when the query tokenizes
     * cleanly; falls back to the LIKE/case-insensitive scan otherwise.
     * `opts.scope` filters by exact scope (hierarchy expansion is done by the
     * retrieval layer, P0-4).
     */
    search(query: string, opts?: {
        type?: MemoryType;
        scope?: MemoryScope;
    }): Promise<MemoryEntry[]>;
    /** List all rows; soft-deleted rows are hidden unless opts.deleted is true. */
    list(opts?: {
        deleted?: boolean;
        scope?: MemoryScope;
    }): Promise<MemoryEntry[]>;
    /** Replaces an existing entry; unknown id fails explicitly. */
    update(entry: MemoryEntry): Promise<void>;
    /** Soft delete: row stays, `deleted` flips to true, updatedAt bumps. */
    remove(id: MemoryId): Promise<void>;
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
    denied: Array<{
        id: string;
        detection: "injection" | "secret";
        reasons: string[];
    }>;
}
export declare function migrateJsonlToSqlite(store: SqliteMemoryStore, entries: MemoryEntry[], opts?: {
    dryRun?: boolean;
}): Promise<MigrateResult>;
//# sourceMappingURL=sqlite-memory-store.d.ts.map