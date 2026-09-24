import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryEntry,
  MemoryId,
  MemoryScope,
  MemoryStore,
  MemoryType,
} from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import { atomicWriteFile, backupTree, withLock } from "@ar/store-integrity";
import { checkUnsafeMemory, scanMemoryEntries } from "./security-gate.js";

/** Single JSONL file holding every memory entry (MEMORY-001). */
export const MEMORY_FILE_NAME = "memories.jsonl";

/** Result of `backup()` for the JSONL backend. */
export interface MemoryBackupResult {
  path: string;
  files: number;
  bytes: number;
}

/** Read and parse every entry from a memories.jsonl file (used by the
 *  JSONL → SQLite migration). Missing file yields []. Corrupt lines are
 *  skipped (best-effort recovery), mirroring the store's read path. */
export async function readJsonlEntries(dataDir: string): Promise<MemoryEntry[]> {
  const path = join(dataDir, MEMORY_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeError(err, "ENOENT")) return [];
    throw new AgentError(
      errorInfo("INTERNAL_ERROR", `memory store read failed: ${path}`, {
        cause: err,
      }),
    );
  }
  return parseJsonlLines(raw);
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

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
  onSecurityDenied?: (event: { detection: "injection" | "secret"; reasons: string[]; content: string; source: string }) => void;
}

export class JsonlMemoryStore implements MemoryStore {
  private readonly dataDir: string;
  private readonly onSecurityDenied?: JsonlMemoryStoreOptions["onSecurityDenied"];

  constructor(opts: JsonlMemoryStoreOptions) {
    this.dataDir = opts.dataDir;
    this.onSecurityDenied = opts.onSecurityDenied;
  }

  private filePath(): string {
    return join(this.dataDir, MEMORY_FILE_NAME);
  }

  private async readAll(): Promise<MemoryEntry[]> {
    const path = this.filePath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `memory store read failed: ${path}`, {
          cause: err,
        }),
      );
    }
    return parseJsonlLines(raw);
  }

  /**
   * Atomic, durable rewrite of the whole file: temp file + fsync + rename in
   * the same dir via [[atomicWriteFile]] (P2-35). A crash never leaves a
   * half-written line, and an acked write survives power loss.
   */
  private async rewrite(entries: MemoryEntry[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = this.filePath();
    const body = entries
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const content = entries.length === 0 ? "" : `${body}\n`;
    try {
      await atomicWriteFile(target, content);
    } catch (cause) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `memory store write failed: ${target}`, {
          cause,
        }),
      );
    }
  }

  private lockKey(): string {
    return `memory:jsonl:${this.dataDir}`;
  }

  private static unknownMemory(id: MemoryId, op: string): AgentError {
    return new AgentError(
      errorInfo("INTERNAL_ERROR", `cannot ${op} unknown memory ${id}`),
    );
  }

  /** Task B: scan all persisted entries for injection and secrets. */
  async scanForSecrets(): Promise<Array<{ entry: MemoryEntry; issues: { detection: "injection" | "secret"; reasons: string[] }[] }>> {
    return scanMemoryEntries(await this.readAll());
  }

  /** Upsert: replaces the entry with the same id, otherwise appends.
   *  P2-35: serialized under a per-store lock so concurrent writes cannot
   *  lose updates on the read-modify-write cycle. */
  async write(entry: MemoryEntry): Promise<void> {
    const reason = checkUnsafeMemory(entry.content, "memory-store");
    if (reason !== null) {
      this.onSecurityDenied?.(reason.event);
      throw new AgentError(errorInfo("SECURITY_DENIED", `memory write blocked: ${reason.message}`));
    }
    await withLock(this.lockKey(), async () => {
      const all = await this.readAll();
      const index = all.findIndex((e) => e.id === entry.id);
      if (index >= 0) all[index] = entry;
      else all.push(entry);
      await this.rewrite(all);
    });
  }

  /** Returns the entry even when soft-deleted (reviewability, §67). */
  async get(id: MemoryId): Promise<MemoryEntry | undefined> {
    const all = await this.readAll();
    return all.find((e) => e.id === id);
  }

  /**
   * Case-insensitive substring OR token matching (no vector retrieval, §65).
   * Matches when the lowercased query is a substring of the content, or when
   * every whitespace-separated query token appears as a whole word in it.
   * Soft-deleted entries never match. `opts.scope` filters by exact scope
   * (scope hierarchy expansion is done by the retrieval layer, P0-4).
   */
  async search(
    query: string,
    opts: { type?: MemoryType; scope?: MemoryScope } = {},
  ): Promise<MemoryEntry[]> {
    const all = await this.readAll();
    return all.filter(
      (e) =>
        !e.deleted &&
        (opts.type === undefined || e.type === opts.type) &&
        (opts.scope === undefined || e.scope === opts.scope) &&
        matches(query, e.content),
    );
  }

  /** Default excludes soft-deleted entries; `deleted: true` returns only those. */
  async list(opts: { deleted?: boolean; scope?: MemoryScope } = {}): Promise<MemoryEntry[]> {
    const all = await this.readAll();
    return all.filter(
      (e) =>
        (opts.deleted === true ? e.deleted : !e.deleted) &&
        (opts.scope === undefined || e.scope === opts.scope),
    );
  }

  /** Replaces an existing entry; unknown id fails explicitly.
   *  P2-35: serialized under the same per-store lock as [[write]]. */
  async update(entry: MemoryEntry): Promise<void> {
    const reason = checkUnsafeMemory(entry.content, "memory-store");
    if (reason !== null) {
      this.onSecurityDenied?.(reason.event);
      throw new AgentError(errorInfo("SECURITY_DENIED", `memory update blocked: ${reason.message}`));
    }
    await withLock(this.lockKey(), async () => {
      const all = await this.readAll();
      const index = all.findIndex((e) => e.id === entry.id);
      if (index < 0) throw JsonlMemoryStore.unknownMemory(entry.id, "update");
      all[index] = entry;
      await this.rewrite(all);
    });
  }

  /** Soft delete: flips deleted + bumps updatedAt, keeps the line (§67).
   *  P2-35: serialized under the same per-store lock as [[write]]. */
  async remove(id: MemoryId): Promise<void> {
    await withLock(this.lockKey(), async () => {
      const all = await this.readAll();
      const index = all.findIndex((e) => e.id === id);
      if (index < 0) throw JsonlMemoryStore.unknownMemory(id, "remove");
      const entry = all[index]!;
      all[index] = { ...entry, deleted: true, updatedAt: Date.now() };
      await this.rewrite(all);
    });
  }

  /**
   * P2-35 backup: copy the whole JSONL store (plus any sibling store files) to
   * `<dataDir>/backups/<stamp>/`. Excludes temp/scratch files and does not
   * back up the `backups` directory itself.
   */
  async backup(opts: { now?: () => Date } = {}): Promise<MemoryBackupResult> {
    const result = await backupTree(this.dataDir, { now: opts.now });
    return { path: result.path, files: result.files, bytes: result.bytes };
  }
}

function parseJsonlLines(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (typeof rec !== "object" || rec === null) continue;
      const entry = rec as Partial<MemoryEntry>;
      if (typeof entry.id !== "string" || typeof entry.content !== "string") {
        continue;
      }
      // Legacy rows (pre-P0-4) have no scope: default to the narrowest,
      // safest scope so they never leak into other sessions' retrieval.
      entries.push({
        ...(entry as MemoryEntry),
        scope: entry.scope ?? "session",
      });
    } catch (err) {
      // P14-6: corrupt line — skipped so the rest still loads, but reported
      // (it is data-loss evidence), never silent.
      process.stderr.write(`[degraded] memory-store.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return entries;
}

function matches(query: string, content: string): boolean {
  const q = query.toLowerCase();
  if (q === "") return false;
  const c = content.toLowerCase();
  if (c.includes(q)) return true;
  const qTokens = q.split(/\s+/).filter((t) => t !== "");
  const cTokens = new Set(
    c.split(/[^a-z0-9]+/).filter((t) => t !== ""),
  );
  return qTokens.every((token) => cTokens.has(token));
}
