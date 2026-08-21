/**
 * P11-4: artifact retention — a production data dir must not grow forever.
 * `enforceArtifactRetention` deletes the OLDEST files beyond the cap (size or
 * count) within an artifact directory. Audit-required event logs are NOT in
 * scope here — they belong to P11-5 (archive, never silent delete).
 */
export interface ArtifactRetentionOptions {
    /** Maximum total bytes to keep. */
    maxBytes?: number;
    /** Maximum number of files to keep. */
    maxFiles?: number;
    /** Maximum age in ms; older files are deleted. */
    maxAgeMs?: number;
}
export interface ArtifactRetentionResult {
    scanned: number;
    deleted: number;
    bytesDeleted: number;
    remainingBytes: number;
}
/** Delete oldest-first until every cap holds. Files are treated as artifacts:
 *  any file under `dir` counts. Best-effort per file — one failure never
 *  aborts the sweep. */
export declare function enforceArtifactRetention(dir: string, options: ArtifactRetentionOptions): Promise<ArtifactRetentionResult>;
/**
 * P11-5: archive — move a session's artifact/event file OUT of the active
 * data dir into an archive directory, preserving the source byte-for-byte
 * (rename). Unlike deletion, the audit trail survives and can be restored by
 * renaming back. Returns the archived path.
 */
export declare function archiveFile(activeDir: string, fileName: string, archiveDir: string): Promise<string | undefined>;
//# sourceMappingURL=retention.d.ts.map