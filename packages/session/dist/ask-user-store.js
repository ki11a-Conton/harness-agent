import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
import { SessionStoreError } from "./session-store.js";
const ASK_SCHEMA_VERSION = 1;
export class JSONLAskUserStore {
    file;
    loaded = false;
    asks = new Map();
    constructor(opts) {
        this.file = join(opts.dataDir, "ask-users.jsonl");
    }
    async create(request) {
        return withLock(this.lockKey(), async () => {
            await this.load();
            this.asks.set(request.id, request);
            await this.persist();
        });
    }
    async get(id) {
        await this.load();
        return this.asks.get(id);
    }
    async listPending(sessionId) {
        await this.load();
        return [...this.asks.values()].filter((a) => a.sessionId === sessionId && a.status === "pending");
    }
    async markAnswered(id, reply) {
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
    async markWithdrawn(id) {
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
    lockKey() {
        return `ask-users:${this.file}`;
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        this.asks.clear();
        let raw;
        try {
            raw = await readFile(this.file, "utf8");
        }
        catch {
            return; // no file yet — empty store
        }
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                continue;
            try {
                const record = JSON.parse(trimmed);
                if (record.schemaVersion === ASK_SCHEMA_VERSION && record.ask?.id !== undefined) {
                    this.asks.set(record.ask.id, record.ask);
                }
            }
            catch {
                // corrupt line: skip (fail-open read, matching inbox/memory stores)
            }
        }
    }
    async persist() {
        const body = [...this.asks.values()]
            .map((ask) => JSON.stringify({ schemaVersion: ASK_SCHEMA_VERSION, ask }))
            .join("\n");
        await atomicWriteFile(this.file, `${body}\n`);
    }
}
//# sourceMappingURL=ask-user-store.js.map