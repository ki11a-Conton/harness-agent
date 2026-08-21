import type { MemoryEntry, MemoryId, MemoryScope, MemoryStore, MemoryType } from "@ar/contracts";
/** Single JSONL file holding every memory entry (MEMORY-001). */
export declare const MEMORY_FILE_NAME = "memories.jsonl";
/** Result of `backup()` for the JSONL backend. */
export interface MemoryBackupResult {
    path: string;
    files: number;
    bytes: number;
}
/** Read and parse every entry from a memories.jsonl file (used by the
 *  JSONL → SQLite migration). Missing file yields []. Corrupt lines are
 *  skipped (best-effort recovery), mirroring the store's read path. */
export declare function readJsonlEntries(dataDir: string): Promise<MemoryEntry[]>;
/**
 * MEMORY-001: JSONL file backend for the contracts MemoryStore (dataDir/
 * memories.jsonl, one MemoryEntry per line, §66).
 *
 * - Mutations are atomic: the whole file is rewritten via a temp file +
 *   rename, so a crash never leaves a half-written line (§67 reviewable/
 *   deletable data must survive failures). Single-writer assumption, like
 *   the session and event stores.
 * - remove() is a soft delete: the line stays, `deleted` flips to true and
 *   updatedAt bumps, so memory stays reviewable and recoverable (§67).
 * - A corrupt line is skipped on read (best-effort recovery); it never
 *   fails the store wholesale. RAG/vector search is intentionally absent
 *   (§65: semantic retrieval is Phase 3 and not required for the runtime).
 */
export interface JsonlMemoryStoreOptions {
    /** Directory holding memories.jsonl; created on first write. */
    dataDir: string;
    /** Optional callback fired when a write/update is denied (injection or secret). */
    onSecurityDenied?: (event: {
        detection: "injection" | "secret";
        reasons: string[];
        content: string;
        source: string;
    }) => void;
}
export declare class JsonlMemoryStore implements MemoryStore {
    private readonly dataDir;
    private readonly onSecurityDenied?;
    constructor(opts: JsonlMemoryStoreOptions);
    private filePath;
    private readAll;
    /**
     * Atomic, durable rewrite of the whole file: temp file + fsync + rename in
     * the same dir via [[atomicWriteFile]] (P2-35). A crash never leaves a
     * half-written line, and an acked write survives power loss.
     */
    private rewrite;
    private lockKey;
    private static unknownMemory;
    /** Task B: scan all persisted entries for injection and secrets. */
    scanForSecrets(): Promise<Array<{
        entry: MemoryEntry;
        issues: {
            detection: "injection" | "secret";
            reasons: string[];
        }[];
    }>>;
    /** Upsert: replaces the entry with the same id, otherwise appends.
     *  P2-35: serialized under a per-store lock so concurrent writes cannot
     *  lose updates on the read-modify-write cycle. */
    write(entry: MemoryEntry): Promise<void>;
    /** Returns the entry even when soft-deleted (reviewability, §67). */
    get(id: MemoryId): Promise<MemoryEntry | undefined>;
    /**
     * Case-insensitive substring OR token matching (no vector retrieval, §65).
     * Matches when the lowercased query is a substring of the content, or when
     * every whitespace-separated query token appears as a whole word in it.
     * Soft-deleted entries never match. `opts.scope` filters by exact scope
     * (scope hierarchy expansion is done by the retrieval layer, P0-4).
     */
    search(query: string, opts?: {
        type?: MemoryType;
        scope?: MemoryScope;
    }): Promise<MemoryEntry[]>;
    /** Default excludes soft-deleted entries; `deleted: true` returns only those. */
    list(opts?: {
        deleted?: boolean;
        scope?: MemoryScope;
    }): Promise<MemoryEntry[]>;
    /** Replaces an existing entry; unknown id fails explicitly.
     *  P2-35: serialized under the same per-store lock as [[write]]. */
    update(entry: MemoryEntry): Promise<void>;
    /** Soft delete: flips deleted + bumps updatedAt, keeps the line (§67).
     *  P2-35: serialized under the same per-store lock as [[write]]. */
    remove(id: MemoryId): Promise<void>;
    /**
     * P2-35 backup: copy the whole JSONL store (plus any sibling store files) to
     * `<dataDir>/backups/<stamp>/`. Excludes temp/scratch files and does not
     * back up the `backups` directory itself.
     */
    backup(opts?: {
        now?: () => Date;
    }): Promise<MemoryBackupResult>;
}
//# sourceMappingURL=memory-store.d.ts.map