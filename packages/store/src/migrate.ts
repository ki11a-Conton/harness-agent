import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, Message, Session, Turn } from "@ar/contracts";
import { EVENT_ABI_VERSION } from "@ar/contracts";
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

const SESSION_SCHEMA_VERSION = 1;

interface WrappedRecord {
  schemaVersion: number;
  session?: Session;
  turn?: Turn;
  message?: Message;
}

function parseRecord<T>(raw: unknown, label: string): T {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`migrate: corrupt ${label}: not an object`);
  }
  if ((raw as { schemaVersion?: unknown }).schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new Error(`migrate: corrupt ${label}: unsupported wrapper schemaVersion`);
  }
  return raw as T;
}

function isDocument(raw: unknown): raw is { id: string } {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    && typeof (raw as { id?: unknown }).id === "string" && (raw as { id: string }).id.length > 0;
}

function migrationEvent(raw: unknown): AgentEvent {
  if (!isDocument(raw)) throw new Error("migrate: invalid event payload");
  const event = raw as AgentEvent;
  // An explicit migration upgrades supported pre-ABI documents, whereas an
  // unknown declared ABI cannot be interpreted safely in either run mode.
  if (event.schemaVersion !== undefined && event.schemaVersion !== EVENT_ABI_VERSION) throw new Error("migrate: unsupported event ABI");
  if (typeof event.sessionId !== "string" || !event.sessionId || typeof event.type !== "string"
      || !Number.isFinite(event.timestamp) || event.timestamp < 0
      || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error("migrate: invalid event payload");
  }
  return event;
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`migrate: cannot list ${dir}: ${String(err)}`);
  }
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    return parseRecord<T>(JSON.parse(raw), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`migrate: cannot read ${file}: ${String(err)}`);
  }
}

/**
 * Migrate a JSONL source layout into a SqliteRuntimeStore. When `dryRun` is
 * true the target is never written (pass a store you can discard, or rely on
 * the target being created lazily — events/sessions are only inserted when
 * not dry-running).
 */
export async function migrateJsonlToSqlite(input: {
  source: JsonlSourceLayout;
  target: SqliteRuntimeStore;
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const { source, target, dryRun } = input;
  const counts: MigrationCounts = { sessions: 0, turns: 0, messages: 0, states: 0, events: 0 };
  let allSourcesClean = true;

  // --- sessions ------------------------------------------------------------
  for (const file of await readDirSafe(join(source.sessionDataDir, "sessions"))) {
    if (!file.endsWith(".json")) continue;
    const rec = await readJsonFile<WrappedRecord>(join(source.sessionDataDir, "sessions", file));
    if (rec === undefined || !isDocument(rec.session)) {
      allSourcesClean = false;
      continue;
    }
    counts.sessions += 1;
    if (!dryRun && (await target.getSession(rec.session.id)) === undefined) {
      await target.createSession(rec.session);
    }
  }

  // --- turns ---------------------------------------------------------------
  for (const file of await readDirSafe(join(source.sessionDataDir, "turns"))) {
    if (!file.endsWith(".json")) continue;
    const rec = await readJsonFile<WrappedRecord>(join(source.sessionDataDir, "turns", file));
    if (rec === undefined || !isDocument(rec.turn)) {
      allSourcesClean = false;
      continue;
    }
    counts.turns += 1;
    if (!dryRun && (await target.getTurn(rec.turn.id)) === undefined) {
      await target.createTurn(rec.turn);
    }
  }

  // --- messages ------------------------------------------------------------
  for (const file of await readDirSafe(join(source.sessionDataDir, "messages"))) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(/\.jsonl$/, "");
    let raw: string;
    try {
      raw = await readFile(join(source.sessionDataDir, "messages", file), "utf8");
    } catch {
      allSourcesClean = false;
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let rec: WrappedRecord;
      try {
        rec = parseRecord<WrappedRecord>(JSON.parse(line), "message line");
      } catch {
        allSourcesClean = false;
        continue;
      }
      if (!isDocument(rec.message)) {
        allSourcesClean = false;
        continue;
      }
      counts.messages += 1;
      if (!dryRun) {
        const existing = await target.listMessages(sessionId as never);
        if (!existing.some((m) => m.id === rec.message!.id)) {
          await target.appendMessage(rec.message);
        }
      }
    }
  }

  // --- state snapshots -----------------------------------------------------
  for (const file of await readDirSafe(join(source.sessionDataDir, "state"))) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.replace(/\.json$/, "");
    const rec = await readJsonFile<Record<string, unknown>>(join(source.sessionDataDir, "state", file));
    if (rec === undefined) {
      allSourcesClean = false;
      continue;
    }
    counts.states += 1;
    if (!dryRun && (await target.loadStateSnapshot(sessionId as never)) === undefined) {
      const { schemaVersion: _ignored, ...snapshot } = rec;
      await target.saveStateSnapshot(sessionId as never, snapshot as Record<string, unknown>);
    }
  }

  // --- events (order per file preserves sequence order) ---------------------
  for (const file of await readDirSafe(source.eventDataDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(/\.jsonl$/, "");
    let raw: string;
    try {
      raw = await readFile(join(source.eventDataDir, file), "utf8");
    } catch {
      allSourcesClean = false;
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let event: AgentEvent;
      try {
        const rec = parseRecord<{ schemaVersion?: number; event?: AgentEvent }>(JSON.parse(line), "event line");
        event = migrationEvent(rec.event);
      } catch {
        allSourcesClean = false;
        continue;
      }
      counts.events += 1;
      if (!dryRun) {
        try {
          await target.append({ ...event, sessionId: sessionId as never });
        } catch (err) {
          // Only a known duplicate is an idempotent no-op. Storage/ABI failures
          // must abort, never produce allSourcesClean=true for an unwritten row.
          if (!(err instanceof Error) || !/^duplicate event id(?:\/sequence)?:/.test(err.message)) throw err;
        }
      }
    }
  }

  return { ...counts, dryRun: dryRun ?? false, allSourcesClean };
}
