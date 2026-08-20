import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, EventStore, SessionId } from "@ar/contracts";
import { EVENT_ABI_VERSION } from "@ar/contracts";
import { appendDurable, backupTree } from "@ar/store-integrity";

const SCHEMA_VERSION = 1;

interface StoredRecord {
  schemaVersion: number;
  event: AgentEvent;
}

function assertPathSafe(sessionId: SessionId): void {
  if (
    sessionId.includes("..") ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    throw new Error(`unsafe session id for file path: ${sessionId}`);
  }
}

function parseRecord(raw: unknown, label: string): AgentEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`corrupt event file ${label}: record is not an object`);
  }
  const record = raw as Partial<StoredRecord>;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    typeof record.event !== "object" ||
    record.event === null
  ) {
    throw new Error(`corrupt event file ${label}: unsupported record shape`);
  }
  return record.event;
}

function parseEvents(content: string, path: string): AgentEvent[] {
  if (content.length === 0) return [];
  const events: AgentEvent[] = [];
  let previous = -1;
  for (const [index, line] of content.split("\n").entries()) {
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`corrupt event file ${path}: invalid json at line ${index + 1}`);
    }
    const event = parseRecord(raw, path);
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error(`corrupt event file ${path}: invalid sequence at line ${index + 1}`);
    }
    if (event.sequence <= previous) {
      throw new Error(
        `corrupt event file ${path}: sequence not strictly increasing at line ${index + 1}`,
      );
    }
    previous = event.sequence;
    events.push(event);
  }
  // P2-34: fail-closed on ABI version drift. An event whose schemaVersion is
  // missing (written by a pre-versioning build) or differs from the current
  // EVENT_ABI_VERSION is rejected loudly — resume/benchmark must never silently
  // misparse an incompatible event log. A migration must be written explicitly
  // before these can be read.
  for (const event of events) {
    if (event.schemaVersion !== EVENT_ABI_VERSION) {
      throw new Error(
        `unsupported event ABI version for ${path}: expected ${EVENT_ABI_VERSION}, got ${String(
          event.schemaVersion,
        )} — migrate the event log before reading`,
      );
    }
  }
  return events;
}

function recordLine(event: AgentEvent): string {
  const record: StoredRecord = { schemaVersion: SCHEMA_VERSION, event };
  return `${JSON.stringify(record)}\n`;
}

export class JSONLEventStore implements EventStore {
  private readonly dataDir: string;
  private appendChain: Promise<void> = Promise.resolve();
  // P5-2: per-session in-memory event cache. JSONL is a single-process store
  // (all appends are serialized through [[appendChain]]), so the cache turns
  // each append from "read the whole file + append" (O(n) per append, O(n²)
  // total) into "memory push + append one line" (O(1) per append). A new
  // process / store instance starts with an empty cache and re-reads from
  // disk on first touch — cross-process freshness is the SQLite store's job
  // (P5-3), not this store's.
  private readonly cache = new Map<SessionId, AgentEvent[]>();
  /** P5-1: observable read traffic — total JSONL lines parsed. Lets the perf
   *  test prove linear (not quadratic) append behaviour without wall-clock
   *  thresholds. */
  private linesReadTotal = 0;

  constructor(opts: { dataDir: string }) {
    this.dataDir = opts.dataDir;
  }

  /** P5-1: introspection for the performance test — how many JSONL lines were
   *  actually read off disk since construction. */
  debugStats(): { linesRead: number; cachedSessions: number } {
    return { linesRead: this.linesReadTotal, cachedSessions: this.cache.size };
  }

  /** P5-5 (JSONL side): drop the in-memory cache for a session so the next
   *  read re-syncs from disk (used by cross-instance tests). */
  clearCache(sessionId?: SessionId): void {
    if (sessionId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(sessionId);
  }

  private filePath(sessionId: SessionId): string {
    assertPathSafe(sessionId);
    return join(this.dataDir, `${sessionId}.jsonl`);
  }

  private async readEvents(sessionId: SessionId): Promise<AgentEvent[]> {
    const path = this.filePath(sessionId);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    // P5-1: count the parsed lines for the linearity proof.
    if (content.length > 0) {
      this.linesReadTotal += content.split("\n").length;
    }
    return parseEvents(content, path);
  }

  /** P5-2: cache-backed load — first touch reads the file once, later reads
   *  are O(1) memory hits (single-process store; see class docs). */
  private load(sessionId: SessionId): Promise<AgentEvent[]> {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.readEvents(sessionId).then((events) => {
      this.cache.set(sessionId, events);
      return events;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.appendChain.then(fn);
    this.appendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Append an event and assign its authoritative sequence.
   *
   * P2-33 determinism guarantees:
   * 1. Globally monotonic per session — the sequence is always derived from
   *    the last persisted event (last sequence + 1), never from a caller-supplied
   *    value. The store is the sole sequence authority: any `sequence` present on
   *    the incoming event is overwritten, so a parallel producer's stale or
   *    guessed sequence can never corrupt the total order.
   * 2. Ordered append — all appends are serialized through [[appendChain]], so
   *    parallel tool/subagent completions receive distinct, strictly increasing
   *    sequences in append order.
   * 3. Real timestamps — the caller's `timestamp` is preserved verbatim (it is
   *    the moment the completion actually happened, which may differ from append
   *    time). Replay reads the order from `sequence` only, never from wall-clock.
   *
   * A caller-supplied `timestamp` that is not a finite, non-negative number is
   * rejected so replay never has to cope with NaN/negative timestamps.
   */
  async append(event: AgentEvent): Promise<AgentEvent> {
    if (!Number.isFinite(event.timestamp) || event.timestamp < 0) {
      throw new Error(`invalid event timestamp for ${event.id}: ${event.timestamp}`);
    }
    // P2-34: a caller must not emit an event claiming a different ABI version
    // than this build understands — reject loudly instead of persisting events
    // that later readers (or replay/benchmark) cannot safely interpret.
    if (event.schemaVersion !== undefined && event.schemaVersion !== EVENT_ABI_VERSION) {
      throw new Error(
        `unsupported event ABI version for ${event.id}: ${event.schemaVersion} (expected ${EVENT_ABI_VERSION})`,
      );
    }
    return this.enqueue(async () => {
      const existing = await this.load(event.sessionId);
      if (existing.some((e) => e.id === event.id)) {
        throw new Error(`duplicate event id: ${event.id}`);
      }
      const sequence =
        existing.length > 0 ? existing[existing.length - 1]!.sequence + 1 : 0;
      // Sequence is authoritative here: ignore any caller-supplied value.
      // Stamp the ABI version so every persisted event is self-describing.
      // P2-35: durable append (write + fsync) so an acked event survives a crash.
      const stored: AgentEvent = { ...event, sequence, schemaVersion: EVENT_ABI_VERSION };
      await mkdir(this.dataDir, { recursive: true });
      await appendDurable(this.filePath(event.sessionId), `${recordLine(stored)}`);
      // P5-2: keep the in-memory cache in sync so the next append/list is O(1).
      existing.push(stored);
      return stored;
    });
  }

  async list(
    sessionId: SessionId,
    opts: { afterSequence?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    const events = await this.load(sessionId);
    const afterSequence = opts.afterSequence ?? -1;
    const filtered = events.filter((e) => e.sequence > afterSequence);
    if (opts.limit === undefined) return filtered;
    return filtered.slice(0, opts.limit);
  }

  async *stream(
    sessionId: SessionId,
    opts: { afterSequence?: number } = {},
  ): AsyncIterable<AgentEvent> {
    const events = await this.load(sessionId);
    const afterSequence = opts.afterSequence ?? -1;
    for (const event of events) {
      if (event.sequence > afterSequence) yield event;
    }
  }

  async nextSequence(sessionId: SessionId): Promise<number> {
    const events = await this.load(sessionId);
    if (events.length === 0) return 0;
    return events[events.length - 1]!.sequence + 1;
  }

  /**
   * P2-35 backup: copy the whole event store to `<dataDir>/backups/<stamp>/`,
   * excluding temp files and the `backups` directory itself.
   */
  async backup(opts: { now?: () => Date } = {}): Promise<{ path: string; files: number; bytes: number }> {
    await mkdir(this.dataDir, { recursive: true });
    return backupTree(this.dataDir, { now: opts.now });
  }
}