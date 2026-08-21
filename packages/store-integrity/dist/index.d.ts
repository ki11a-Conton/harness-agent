/**
 * Durably write `data` to `target`: temp file + fsync + atomic rename (+ fsync
 * parent dir). Guarantees the target is never observed half-written or missing.
 */
export declare function atomicWriteFile(target: string, data: string | Uint8Array): Promise<void>;
/**
 * Durably append a single line to an append-only file and fsync the handle, so
 * an acknowledged line survives a crash. Missing parent dir is created.
 */
export declare function appendDurable(file: string, line: string): Promise<void>;
/**
 * Per-key async mutex. Serializes read-modify-write / persist cycles with the
 * same `key` within this process, so concurrent `write()`/`update()`/`remove()`
 * calls cannot lose updates. Uses the last awaited tail so each invocation runs
 * strictly after the previous one for that key.
 */
export declare function withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
export interface BackupResult {
    /** Where the backup was written. */
    path: string;
    /** Number of files copied. */
    files: number;
    /** Total bytes copied. */
    bytes: number;
}
/**
 * Copy every file under `srcRoot` into `<srcRoot>/backups/<stamp>/`, skipping
 * temp files (`.tmp` / leading-dot scratch) and any existing `backups` dir so a
 * backup never recursively backs itself up. Each copied file is written
 * durably (temp + rename) so a backup is self-consistent per file. The caller
 * must bound the volume (session/event/memory stores are small).
 */
export declare function backupTree(srcRoot: string, opts?: {
    now?: () => Date;
}): Promise<BackupResult>;
/**
 * Strict JSONL parse used by verifyJsonlFile. Line records are expected to be
 * objects; any invalid JSON or non-object line throws with the line number so a
 * store can fail closed. `tolerant: true` skips bad lines (best-effort recovery)
 * — matches the memory/inbox read policy.
 */
export declare function parseJsonl(raw: string, opts?: {
    tolerant?: boolean;
}): unknown[];
/**
 * Manual integrity scan of an append-only JSONL file: strict parse (fail
 * closed). Used by stores wanting a cheap `verify()` without re-reading
 * semantics.
 */
export declare function verifyJsonlFile(file: string): Promise<{
    records: number;
}>;
/** Structural record wrapper guard used by JSON stores. */
export declare function assertRecordVersion(record: unknown, expected: number, label: string): asserts record is Record<string, unknown>;
export { enforceArtifactRetention, archiveFile } from "./retention.js";
export type { ArtifactRetentionOptions, ArtifactRetentionResult } from "./retention.js";
//# sourceMappingURL=index.d.ts.map