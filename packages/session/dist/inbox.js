import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newPromptId } from "@ar/contracts";
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
    store;
    constructor(store) {
        this.store = store;
    }
    /** Admit user input; the runtime drains `steer` prompts, the host drains
     *  `followup` prompts to start new turns. */
    async admit(sessionId, text, kind = "followup", now = Date.now) {
        const prompt = {
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
    async listPending(sessionId) {
        return this.store.listPending(sessionId);
    }
    /** Next follow-up prompt for the outer loop, or undefined when the queue is
     *  empty. Promoted so a crashed host does not re-start the same turn. */
    async nextFollowup(sessionId) {
        const pending = await this.store.listPending(sessionId);
        const followup = pending.find((p) => p.kind === "followup");
        if (followup === undefined)
            return undefined;
        await this.store.markPromoted(followup.id);
        return followup;
    }
    /** Mark a prompt consumed (its message was appended to the session). */
    async consume(id) {
        await this.store.markConsumed(id);
    }
}
/** In-memory inbox (tests, one-shot hosts). */
export class MemInboxStore {
    prompts = [];
    async admit(prompt) {
        this.prompts.push(prompt);
    }
    async listPending(sessionId) {
        return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
    }
    async listAll(sessionId) {
        return this.prompts.filter((p) => p.sessionId === sessionId);
    }
    async markPromoted(id) {
        const prompt = this.prompts.find((p) => p.id === id);
        if (prompt === undefined)
            throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
        prompt.status = "promoted";
        prompt.promotedAt = Date.now();
    }
    async markConsumed(id) {
        const prompt = this.prompts.find((p) => p.id === id);
        if (prompt === undefined)
            throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
        prompt.status = "consumed";
        prompt.consumedAt = Date.now();
    }
}
const INBOX_SCHEMA_VERSION = 1;
/** JSONL inbox: one AdmittedPrompt per line at <dataDir>/inbox.jsonl.
 *  Corrupt lines are skipped (same policy as the memory store). */
export class JSONLInboxStore {
    file;
    loaded = false;
    prompts = [];
    constructor(opts) {
        this.file = join(opts.dataDir, "inbox.jsonl");
    }
    async admit(prompt) {
        // P2-35: read-modify-persist serialized under a per-file lock.
        return withLock(this.lockKey(), async () => {
            await this.load();
            this.prompts.push(prompt);
            await this.persist();
        });
    }
    async listPending(sessionId) {
        await this.load();
        return this.prompts.filter((p) => p.sessionId === sessionId && p.status === "pending");
    }
    async listAll(sessionId) {
        await this.load();
        return this.prompts.filter((p) => p.sessionId === sessionId);
    }
    async markPromoted(id) {
        await this.update(id, (prompt) => {
            prompt.status = "promoted";
            prompt.promotedAt = Date.now();
        });
    }
    async markConsumed(id) {
        await this.update(id, (prompt) => {
            prompt.status = "consumed";
            prompt.consumedAt = Date.now();
        });
    }
    async update(id, mutate) {
        // P2-35: serialized so concurrent promote/consume cannot lose mutations.
        return withLock(this.lockKey(), async () => {
            await this.load();
            const prompt = this.prompts.find((p) => p.id === id);
            if (prompt === undefined)
                throw new SessionStoreError("UNKNOWN_PROMPT", `unknown prompt ${id}`);
            mutate(prompt);
            await this.persist();
        });
    }
    lockKey() {
        return `inbox:jsonl:${this.file}`;
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        this.prompts = [];
        let raw;
        try {
            raw = await readFile(this.file, "utf8");
        }
        catch {
            return; // first run: no file yet
        }
        for (const line of raw.split("\n")) {
            if (line.trim() === "")
                continue;
            try {
                const record = JSON.parse(line);
                if (record.schemaVersion === INBOX_SCHEMA_VERSION)
                    this.prompts.push(record.prompt);
            }
            catch {
                // corrupt line: skip (documented policy)
            }
        }
    }
    async persist() {
        // P2-35: durable atomic write (temp + fsync + rename) via shared primitive.
        const body = this.prompts
            .map((prompt) => JSON.stringify({ schemaVersion: INBOX_SCHEMA_VERSION, prompt }))
            .join("\n");
        await atomicWriteFile(this.file, `${body}\n`);
    }
    /**
     * P2-35 backup: copy the inbox file to `<dataDir>/backups/<stamp>/`.
     */
    async backup() {
        return backupTree(join(this.file, ".."));
    }
}
//# sourceMappingURL=inbox.js.map