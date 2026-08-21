// P2-6: learning candidate store — durable queue of LearningCandidates
// produced by post-turn reflection (P2-5). Promotion is deliberately NOT
// automatic (plan.md P2-7): candidates accumulate here until an explicit
// `agent learn` command evaluates/promotes them. JSONL at
// <dataDir>/learning-candidates.jsonl, crash-safe via withLock + atomicWrite
// (same pattern as the ask-user/inbox/memory stores).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
const CANDIDATE_SCHEMA_VERSION = 1;
export const CANDIDATES_FILE_NAME = "learning-candidates.jsonl";
export class JsonlCandidateStore {
    file;
    loaded = false;
    candidates = new Map();
    constructor(opts) {
        this.file = join(opts.dataDir, CANDIDATES_FILE_NAME);
    }
    async list() {
        await this.load();
        return [...this.candidates.values()];
    }
    async get(id) {
        await this.load();
        return this.candidates.get(id);
    }
    async add(candidate) {
        return withLock(this.lockKey(), async () => {
            await this.load();
            this.candidates.set(candidate.id, candidate);
            await this.persist();
        });
    }
    async update(candidate) {
        return withLock(this.lockKey(), async () => {
            await this.load();
            if (!this.candidates.has(candidate.id))
                return; // nothing to update
            this.candidates.set(candidate.id, candidate);
            await this.persist();
        });
    }
    async remove(id) {
        return withLock(this.lockKey(), async () => {
            await this.load();
            this.candidates.delete(id);
            await this.persist();
        });
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        let content;
        try {
            content = await readFile(this.file, "utf8");
        }
        catch {
            return; // no file yet → empty queue
        }
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "")
                continue;
            try {
                const record = JSON.parse(trimmed);
                if (record.schemaVersion !== CANDIDATE_SCHEMA_VERSION)
                    continue;
                this.candidates.set(record.candidate.id, record.candidate);
            }
            catch {
                // corrupt line: skip (same policy as inbox/memory stores)
            }
        }
    }
    async persist() {
        const lines = [...this.candidates.values()].map((candidate) => JSON.stringify({ schemaVersion: CANDIDATE_SCHEMA_VERSION, candidate }));
        await atomicWriteFile(this.file, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    }
    lockKey() {
        return `candidate-store:${this.file}`;
    }
}
//# sourceMappingURL=candidate-store.js.map