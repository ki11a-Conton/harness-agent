import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskId, AskUserReply, AskUserRequest, AskUserStore, SessionId } from "@ar/contracts";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
import { SessionStoreError } from "./session-store.js";

/**
 * P1-4: JSONL ask-user store — durable, crash-safe pending questions.
 * One AskUserRequest per line at <dataDir>/ask-users.jsonl. Corrupt lines are
 * skipped (same policy as the inbox / memory stores).
 */
export interface JSONLAskUserStoreOptions {
  dataDir: string;
}

interface AskRecord {
  schemaVersion: number;
  ask: AskUserRequest;
}

const ASK_SCHEMA_VERSION = 1;

export class JSONLAskUserStore implements AskUserStore {
  private readonly file: string;
  private loaded = false;
  private asks = new Map<AskId, AskUserRequest>();

  constructor(opts: JSONLAskUserStoreOptions) {
    this.file = join(opts.dataDir, "ask-users.jsonl");
  }

  async create(request: AskUserRequest): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
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
    } catch {
      return; // no file yet — empty store
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const record = JSON.parse(trimmed) as AskRecord;
        if (record.schemaVersion === ASK_SCHEMA_VERSION && record.ask?.id !== undefined) {
          this.asks.set(record.ask.id, record.ask);
        }
      } catch {
        // corrupt line: skip (fail-open read, matching inbox/memory stores)
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