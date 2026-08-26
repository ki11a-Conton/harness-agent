import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdmittedPrompt,
  InboxStore,
  PromptId,
  PromptKind,
  SessionId,
  TurnId,
} from "@ar/contracts";
import { newPromptId, isNodeErrorCode } from "@ar/contracts";
import { atomicWriteFile, backupTree, withLock } from "@ar/store-integrity";
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

export class MemInboxStore implements InboxStore {
  prompts: AdmittedPrompt[] = [];
  private readonly maxPending: number;

  /** P15-3: bound the pending queue — overflow is a typed QUEUE_FULL reject,
   *  never an unbounded RAM growth nor a silent drop. */
  constructor(opts: { maxPending?: number } = {}) {
    this.maxPending = opts.maxPending ?? 1000;
  }

  async admit(prompt: AdmittedPrompt): Promise<void> {
    const pending = this.prompts.filter((p) => p.status === "pending");
    if (pending.length >= this.maxPending) {
      throw new SessionStoreError(
        "QUEUE_FULL",
        `inbox full: ${pending.length} pending prompts exceed maxPending ${this.maxPending}`,
      );
    }
    this.prompts.push(prompt);
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }

  /** P38.3-3 (INV-P38.3-003): recovery query — pending + promoted followups.
   *  Consumed prompts are excluded. */
  async listRecoverable(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    return this.prompts.filter(
      (p) => p.sessionId === sessionId && (p.status === "pending" || p.status === "promoted"),
    );
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

  /** P38.3-1 (INV-P38.3-001/002): durably bind the prompt to the turn created
   *  from it. Idempotent for the SAME TurnId; a DIFFERENT TurnId is a lineage
   *  rewrite and MUST fail closed with PROMOTION_CONFLICT. */
  async bindPromotion(id: PromptId, turnId: TurnId): Promise<void> {
    const prompt = this.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
    if (prompt.promotedTurnId !== undefined && prompt.promotedTurnId !== turnId) {
      throw new SessionStoreError(
        "PROMOTION_CONFLICT",
        `prompt ${id} already bound to turn ${prompt.promotedTurnId}; refusing lineage rewrite to ${turnId}`,
      );
    }
    prompt.status = "promoted";
    prompt.promotedAt = Date.now();
    prompt.promotedTurnId = turnId;
  }

  /** P38.3-1: consume only transitions an already-promoted prompt (promoted →
   *  consumed). Consuming a pending unbound prompt fails closed. */
  async markConsumed(id: PromptId): Promise<void> {
    const prompt = this.prompts.find((p) => p.id === id);
    if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
    if (prompt.status === "pending") {
      throw new SessionStoreError(
        "CONSUME_NOT_PROMOTED",
        `prompt ${id} is pending and unbound; cannot consume before promotion`,
      );
    }
    prompt.status = "consumed";
    prompt.consumedAt = Date.now();
  }
}

export interface JSONLInboxStoreOptions {
  dataDir: string;
  /** P15-3: bound on pending prompts; overflow rejects with QUEUE_FULL. */
  maxPending?: number;
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
  private readonly maxPending: number;
  private loaded = false;
  private prompts: AdmittedPrompt[] = [];

  constructor(opts: JSONLInboxStoreOptions) {
    this.file = join(opts.dataDir, "inbox.jsonl");
    this.maxPending = opts.maxPending ?? 1000;
  }

  async admit(prompt: AdmittedPrompt): Promise<void> {
    // P2-35: read-modify-persist serialized under a per-file lock.
    return withLock(this.lockKey(), async () => {
      await this.load();
      const pending = this.prompts.filter((p) => p.status === "pending");
      if (pending.length >= this.maxPending) {
        throw new SessionStoreError(
          "QUEUE_FULL",
          `inbox full: ${pending.length} pending prompts exceed maxPending ${this.maxPending}`,
        );
      }
      this.prompts.push(prompt);
      await this.persist();
    });
  }

  async listPending(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    await this.load();
    return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
  }

  /** P38.3-3 (INV-P38.3-003): recovery query — pending + promoted followups.
   *  Consumed prompts are excluded. */
  async listRecoverable(sessionId: SessionId): Promise<AdmittedPrompt[]> {
    await this.load();
    return this.prompts.filter(
      (p) => p.sessionId === sessionId && (p.status === "pending" || p.status === "promoted"),
    );
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

  /** P38.3-1 (INV-P38.3-001/002): durably bind the prompt to the turn created
   *  from it. Idempotent for the SAME TurnId; a DIFFERENT TurnId is a lineage
   *  rewrite and MUST fail closed with PROMOTION_CONFLICT. */
  async bindPromotion(id: PromptId, turnId: TurnId): Promise<void> {
    await this.update(id, (prompt) => {
      if (prompt.promotedTurnId !== undefined && prompt.promotedTurnId !== turnId) {
        throw new SessionStoreError(
          "PROMOTION_CONFLICT",
          `prompt ${id} already bound to turn ${prompt.promotedTurnId}; refusing lineage rewrite to ${turnId}`,
        );
      }
      prompt.status = "promoted";
      prompt.promotedAt = Date.now();
      prompt.promotedTurnId = turnId;
    });
  }

  /** P38.3-1: consume only transitions an already-promoted prompt (promoted →
   *  consumed). Consuming a pending unbound prompt fails closed. */
  async markConsumed(id: PromptId): Promise<void> {
    await this.update(id, (prompt) => {
      if (prompt.status === "pending") {
        throw new SessionStoreError(
          "CONSUME_NOT_PROMOTED",
          `prompt ${id} is pending and unbound; cannot consume before promotion`,
        );
      }
      prompt.status = "consumed";
      prompt.consumedAt = Date.now();
    });
  }

  private async update(id: PromptId, mutate: (prompt: AdmittedPrompt) => void): Promise<void> {
    // P2-35: serialized so concurrent promote/consume cannot lose mutations.
    return withLock(this.lockKey(), async () => {
      await this.load();
      const prompt = this.prompts.find((p) => p.id === id);
      if (prompt === undefined) throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
      mutate(prompt);
      await this.persist();
    });
  }

  private lockKey(): string {
    return `inbox:jsonl:${this.file}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.prompts = [];
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      // P14-6: first-run ENOENT is expected — other read failures propagate.
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
      return;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as PromptRecord;
        if (record.schemaVersion === INBOX_SCHEMA_VERSION) this.prompts.push(record.prompt);
      } catch (err) {
        // P14-6: corrupt line — skipped (documented policy) but reported, never
        // silent.
        process.stderr.write(`[degraded] inbox.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  private async persist(): Promise<void> {
    // P2-35: durable atomic write (temp + fsync + rename) via shared primitive.
    const body = this.prompts
      .map((prompt) => JSON.stringify({ schemaVersion: INBOX_SCHEMA_VERSION, prompt } satisfies PromptRecord))
      .join("\n");
    await atomicWriteFile(this.file, `${body}\n`);
  }

  /**
   * P2-35 backup: copy the inbox file to `<dataDir>/backups/<stamp>/`.
   */
  async backup(): Promise<{ path: string; files: number; bytes: number }> {
    return backupTree(join(this.file, ".."));
  }
}
