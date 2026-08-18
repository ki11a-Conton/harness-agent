import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdmittedPrompt,
  InboxStore,
  PromptId,
  PromptKind,
  SessionId,
} from "@ar/contracts";
import { newPromptId } from "@ar/contracts";
import { SessionStoreError } from "./session-store.js";

/**
 * Session inbox (plan.md Phase 1 Issue 3 / Phase 5.3).
 *
 * User input arriving while a turn is running is ADMITTED first, then routed:
 * steer → injected into the running turn at the next safe boundary; followup
 * → queued for a new turn after the current one ends. The two kinds never
 * share one queue.
 */
export class SessionInbox {
  constructor(private readonly store: InboxStore) {}

  /** Admit user input; the runtime drains `steer` prompts, the host drains
   *  `followup` prompts to start new turns. */
  async admit(
    sessionId: SessionId,
    text: string,
    kind: PromptKind = "followup",
    now: () => number = Date.now,
  ): Promise<AdmittedPrompt> {
    const prompt: AdmittedPrompt = {
      id: newPromptId(),
      sessionId,
      text,
      kind,
      status: "pending",
      admittedAt: now(),
    };
    await this.store.admit(prompt);
    return prompt;
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.store.listPending(sessionId);
  }

  /** Next follow-up prompt for the outer loop, or undefined when the queue is
   *  empty. Promoted so a crashed host does not re-start the same turn. */
  async nextFollowup(sessionId: SessionId): Promise<AdmittedPrompt | undefined> {
    const pending = await this.store.listPending(sessionId);
    const followup = pending.find((p) => p.kind === "followup");
    if (followup === undefined) return undefined;
    await this.store.markPromoted(followup.id);
    return followup;
  }

  /** Mark a prompt consumed (its message was appended to the session). */
  async consume(id: PromptId): Promise<void> {
    await this.store.markConsumed(id);
  }
}

/** In-memory inbox (tests, one-shot hosts). */
export class MemInboxStore implements InboxStore {
  prompts: AdmittedPrompt[] = [];

  async admit(prompt: AdmittedPrompt): Promise<void> {
    this.prompts.push(prompt);
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }

  async listAll(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter((p) => p.sessionId === sessionId);
  }

  async markPromoted(id: PromptId): Promise<void> {
    const prompt = this.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
    prompt.status = "promoted";
    prompt.promotedAt = Date.now();
  }

  async markConsumed(id: PromptId): Promise<void> {
    const prompt = this.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
    prompt.status = "consumed";
    prompt.consumedAt = Date.now();
  }
}

export interface JSONLInboxStoreOptions {
  dataDir: string;
}

interface PromptRecord {
  schemaVersion: number;
  prompt: AdmittedPrompt;
}

const INBOX_SCHEMA_VERSION = 1;

/** JSONL inbox: one AdmittedPrompt per line at <dataDir>/inbox.jsonl.
 *  Corrupt lines are skipped (same policy as the memory store). */
export class JSONLInboxStore implements InboxStore {
  private readonly file: string;
  private loaded = false;
  private prompts: AdmittedPrompt[] = [];

  constructor(opts: JSONLInboxStoreOptions) {
    this.file = join(opts.dataDir, "inbox.jsonl");
  }

  async admit(prompt: AdmittedPrompt): Promise<void> {
    await this.load();
    this.prompts.push(prompt);
    await this.persist();
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    await this.load();
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }

  async listAll(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    await this.load();
    return this.prompts.filter((p) => p.sessionId === sessionId);
  }

  async markPromoted(id: PromptId): Promise<void> {
    await this.update(id, (prompt) => {
      prompt.status = "promoted";
      prompt.promotedAt = Date.now();
    });
  }

  async markConsumed(id: PromptId): Promise<void> {
    await this.update(id, (prompt) => {
      prompt.status = "consumed";
      prompt.consumedAt = Date.now();
    });
  }

  private async update(id: PromptId, mutate: (prompt: AdmittedPrompt) => void): Promise<void> {
    await this.load();
    const prompt = this.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
    mutate(prompt);
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.prompts = [];
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return; // first run: no file yet
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as PromptRecord;
        if (record.schemaVersion === INBOX_SCHEMA_VERSION) this.prompts.push(record.prompt);
      } catch {
        // corrupt line: skip (documented policy)
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body = this.prompts
      .map((prompt) => JSON.stringify({ schemaVersion: INBOX_SCHEMA_VERSION, prompt } satisfies PromptRecord))
      .join("\n");
    await writeFile(tmp, `${body}\n`, "utf8");
    await rename(tmp, this.file);
  }
}
