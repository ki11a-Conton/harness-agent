import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskId, AskUserReply, AskUserRequest, AskUserStore, SessionId } from "@ar/contracts";
import { isNodeErrorCode } from "@ar/contracts";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
import { SessionStoreError } from "./session-store.js";

/**
 * P1-4: JSONL ask-user store — durable, crash-safe pending questions.
 * One AskUserRequest per line at <dataDir>/ask-users.jsonl. Corrupt lines are
 * skipped (same policy as the inbox / memory stores).
 */
export interface JSONLAskUserStoreOptions {
  dataDir: string;
  /** P15-3: bound on pending asks; overflow rejects with QUEUE_FULL. */
  maxPending?: number;
}

interface AskRecord {
  schemaVersion: number;
  ask: AskUserRequest;
}

const ASK_SCHEMA_VERSION = 1;

export class JSONLAskUserStore implements AskUserStore {
  private readonly file: string;
  private readonly maxPending: number;
  private loaded = false;
  private asks = new Map<AskId, AskUserRequest>();

  constructor(opts: JSONLAskUserStoreOptions) {
    this.file = join(opts.dataDir, "ask-users.jsonl");
    this.maxPending = opts.maxPending ?? 1000;
  }

  async create(request: AskUserRequest): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      const pending = [...this.asks.values()].filter((a) => a.status === "pending");
      if (pending.length >= this.maxPending) {
        throw new SessionStoreError(
          "QUEUE_FULL",
          `ask-user queue full: ${pending.length} pending asks exceed maxPending ${this.maxPending}`,
        );
      }
      this.asks.set(request.id, request);
      await this.persist();
    });
  }

  async get(id: AskId): Promise<AskUserRequest | undefined> {
    await this.load();
    return this.asks.get(id);
  }

  async listPending(sessionId: SessionId): Promise<AskUserRequest[]> {
    await this.load();
    return [...this.asks.values()].filter(
      (a) => a.sessionId === sessionId && a.status === "pending",
    );
  }

  async markAnswered(id: AskId, reply: AskUserReply): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      const ask = this.asks.get(id);
      if (ask === undefined) {
        throw new SessionStoreError("UNKNOWN_ASK", `unknown ask ${id}`);
      }
      if (ask.status !== "pending") {
        throw new SessionStoreError("ASK_NOT_PENDING", `ask ${id} is not pending (${ask.status})`);
      }
      ask.status = "answered";
      ask.answeredAt = reply.answeredAt;
      ask.answerText = reply.text;
      await this.persist();
    });
  }

  async markWithdrawn(id: AskId): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      const ask = this.asks.get(id);
      if (ask === undefined) {
        throw new SessionStoreError("UNKNOWN_ASK", `unknown ask ${id}`);
      }
      ask.status = "withdrawn";
      await this.persist();
    });
  }

  private lockKey(): string {
    return `ask-users:${this.file}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.asks.clear();
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      // P14-6: first-run ENOENT is expected — other read failures propagate.
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const record = JSON.parse(trimmed) as AskRecord;
        if (record.schemaVersion === ASK_SCHEMA_VERSION && record.ask?.id !== undefined) {
          this.asks.set(record.ask.id, record.ask);
        }
      } catch (err) {
        // P14-6: corrupt line — fail-open read (matching inbox/memory stores)
        // but reported, never silent.
        process.stderr.write(`[degraded] ask-user-store.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  private async persist(): Promise<void> {
    const body = [...this.asks.values()]
      .map((ask) => JSON.stringify({ schemaVersion: ASK_SCHEMA_VERSION, ask } satisfies AskRecord))
      .join("\n");
    await atomicWriteFile(this.file, `${body}\n`);
  }
}