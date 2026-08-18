import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, EventStore, SessionId } from "@ar/contracts";

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
  return events;
}

function recordLine(event: AgentEvent): string {
  const record: StoredRecord = { schemaVersion: SCHEMA_VERSION, event };
  return `${JSON.stringify(record)}\n`;
}

export class JSONLEventStore implements EventStore {
  private readonly dataDir: string;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(opts: { dataDir: string }) {
    this.dataDir = opts.dataDir;
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
    return parseEvents(content, path);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.appendChain.then(fn);
    this.appendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    return this.enqueue(async () => {
      const existing = await this.readEvents(event.sessionId);
      if (existing.some((e) => e.id === event.id)) {
        throw new Error(`duplicate event id: ${event.id}`);
      }
      const sequence =
        existing.length > 0 ? existing[existing.length - 1]!.sequence + 1 : 0;
      const stored: AgentEvent = { ...event, sequence };
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.filePath(event.sessionId), recordLine(stored), "utf8");
      return stored;
    });
  }

  async list(
    sessionId: SessionId,
    opts: { afterSequence?: number; limit?: number } = {},
  ): Promise<AgentEvent[]> {
    const events = await this.readEvents(sessionId);
    const afterSequence = opts.afterSequence ?? -1;
    const filtered = events.filter((e) => e.sequence > afterSequence);
    if (opts.limit === undefined) return filtered;
    return filtered.slice(0, opts.limit);
  }

  async *stream(
    sessionId: SessionId,
    opts: { afterSequence?: number } = {},
  ): AsyncIterable<AgentEvent> {
    const events = await this.readEvents(sessionId);
    const afterSequence = opts.afterSequence ?? -1;
    for (const event of events) {
      if (event.sequence > afterSequence) yield event;
    }
  }

  async nextSequence(sessionId: SessionId): Promise<number> {
    const events = await this.readEvents(sessionId);
    if (events.length === 0) return 0;
    return events[events.length - 1]!.sequence + 1;
  }
}