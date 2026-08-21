import { type CheckpointData, type CheckpointStore, type SessionId } from "@ar/contracts";
/**
 * P1-3 Durable Checkpoint Store.
 *
 * Layout under dataDir (mirrors the session/event store conventions):
 *   checkpoints/<sessionId>/
 *     <checkpointId>.json     one self-contained checkpoint record
 *     latest.json             pointer to the most recent VALID checkpoint
 *
 * Integrity rules:
 * - Every written record is verified by reading it back before it can become
 *   the latest pointer, so a torn or bad write never displaces the last good
 *   checkpoint ("bad checkpoint must not overwrite the last good one").
 * - `loadLatest` trusts `latest.json` only after a full validation
 *   (JSON shape + schemaVersion + checksum); on any failure it falls back to
 *   scanning the session directory for the newest VALID checkpoint.
 * - `list` returns only valid checkpoints, newest first; corrupted files are
 *   skipped, not thrown.
 * - Single-writer assumption: one process writes a given session (same
 *   contract as JSONLSessionStore).
 */
export type CheckpointStoreErrorCode = "UNSAFE_ID" | "CORRUPT_RECORD" | "UNSUPPORTED_SCHEMA" | "IO_ERROR";
export declare class CheckpointStoreError extends Error {
    readonly code: CheckpointStoreErrorCode;
    constructor(code: CheckpointStoreErrorCode, message: string);
}
export interface DurableCheckpointStoreOptions {
    dataDir: string;
}
export declare class DurableCheckpointStore implements CheckpointStore {
    private readonly root;
    constructor(opts: DurableCheckpointStoreOptions);
    private sessionDir;
    private checkpointFile;
    private latestFile;
    private readValidated;
    private writeAtomic;
    save(checkpoint: CheckpointData): Promise<void>;
    loadLatest(sessionId: SessionId): Promise<CheckpointData | undefined>;
    list(sessionId: SessionId): Promise<CheckpointData[]>;
}
//# sourceMappingURL=checkpoint-store.d.ts.map