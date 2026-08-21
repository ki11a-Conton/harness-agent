import type { SqliteRuntimeStore } from "./sqlite-runtime-store.js";
/**
 * P5-4: JSONL → SQLite migration for the runtime stores.
 *
 * - Dry-run: pass `dryRun: true` to count + validate without writing.
 * - Idempotent: existing rows (same primary key) are skipped, so re-running
 *   never duplicates and a partially-failed run can be resumed.
 * - Checksum/count: the report carries every counter; callers compare them to
 *   the source layout for the migration gate.
 * - Source preserved: the JSONL files are never touched (read-only pass).
 */
export interface JsonlSourceLayout {
    /** JSONLSessionStore dataDir (sessions/ turns/ messages/ state/). */
    sessionDataDir: string;
    /** JSONLEventStore dataDir (<sessionId>.jsonl files). */
    eventDataDir: string;
}
export interface MigrationCounts {
    sessions: number;
    turns: number;
    messages: number;
    states: number;
    events: number;
}
export interface MigrationReport extends MigrationCounts {
    dryRun: boolean;
    /** True when every source file parsed cleanly (no corrupt record). */
    allSourcesClean: boolean;
}
/**
 * Migrate a JSONL source layout into a SqliteRuntimeStore. When `dryRun` is
 * true the target is never written (pass a store you can discard, or rely on
 * the target being created lazily — events/sessions are only inserted when
 * not dry-running).
 */
export declare function migrateJsonlToSqlite(input: {
    source: JsonlSourceLayout;
    target: SqliteRuntimeStore;
    dryRun?: boolean;
}): Promise<MigrationReport>;
//# sourceMappingURL=migrate.d.ts.map