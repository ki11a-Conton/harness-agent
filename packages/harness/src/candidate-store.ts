// P2-6: learning candidate store — durable queue of LearningCandidates
// produced by post-turn reflection (P2-5). Promotion is deliberately NOT
// automatic (plan.md P2-7): candidates accumulate here until an explicit
// `agent learn` command evaluates/promotes them. JSONL at
// <dataDir>/learning-candidates.jsonl, crash-safe via withLock + atomicWrite
// (same pattern as the ask-user/inbox/memory stores).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
import type { LearningCandidate } from "@ar/learning";

export interface JsonlCandidateStoreOptions {
  dataDir: string;
}

interface CandidateRecord {
  schemaVersion: number;
  candidate: LearningCandidate;
}

const CANDIDATE_SCHEMA_VERSION = 1;
export const CANDIDATES_FILE_NAME = "learning-candidates.jsonl";

/** Minimal surface the reflection runner / CLI promoter need. */
export interface LearningCandidateStore {
  list(): Promise<LearningCandidate[]>;
  get(id: string): Promise<LearningCandidate | undefined>;
  add(candidate: LearningCandidate): Promise<void>;
  update(candidate: LearningCandidate): Promise<void>;
  remove(id: string): Promise<void>;
}

export class JsonlCandidateStore implements LearningCandidateStore {
  private readonly file: string;
  private loaded = false;
  private loading: Promise<void> | undefined;
  private candidates = new Map<string, LearningCandidate>();

  constructor(opts: JsonlCandidateStoreOptions) {
    this.file = join(opts.dataDir, CANDIDATES_FILE_NAME);
  }

  async list(): Promise<LearningCandidate[]> {
    await this.load();
    return [...this.candidates.values()];
  }

  async get(id: string): Promise<LearningCandidate | undefined> {
    await this.load();
    return this.candidates.get(id);
  }

  async add(candidate: LearningCandidate): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      const next = new Map(this.candidates);
      next.set(candidate.id, candidate);
      // Publish only durable state; readers keep the previous snapshot while
      // persistence is pending or when it fails.
      await this.persist(next);
      this.candidates = next;
    });
  }

  async update(candidate: LearningCandidate): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      if (!this.candidates.has(candidate.id)) return; // nothing to update
      const next = new Map(this.candidates);
      next.set(candidate.id, candidate);
      await this.persist(next);
      this.candidates = next;
    });
  }

  async remove(id: string): Promise<void> {
    return withLock(this.lockKey(), async () => {
      await this.load();
      const next = new Map(this.candidates);
      next.delete(id);
      await this.persist(next);
      this.candidates = next;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    // Initial readers share one snapshot. A failed read stays retryable and
    // must not publish an empty cache that a later write could persist.
    if (!this.loading) this.loading = this.loadSnapshot();
    const loading = this.loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  private async loadSnapshot(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (err) {
      // P14-6: only the expected "first run / no file yet" ENOENT is silent —
      // any other read error is a real failure and propagates.
      if (isNodeError(err, "ENOENT")) {
        this.loaded = true;
        return;
      }
      throw err;
    }
    const next = new Map<string, LearningCandidate>();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const record = JSON.parse(trimmed) as CandidateRecord;
        if (record.schemaVersion !== CANDIDATE_SCHEMA_VERSION) continue;
        next.set(record.candidate.id, record.candidate);
      } catch (err) {
        // P14-6: a corrupt line must be observable (it is data-loss evidence),
        // then skipped so the rest of the queue still loads.
        process.stderr.write(`[degraded] candidate-store.corrupt-line: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    this.candidates = next;
    this.loaded = true;
  }

  private async persist(candidates: ReadonlyMap<string, LearningCandidate>): Promise<void> {
    const lines = [...candidates.values()].map(
      (candidate) =>
        JSON.stringify({ schemaVersion: CANDIDATE_SCHEMA_VERSION, candidate } satisfies CandidateRecord),
    );
    await atomicWriteFile(this.file, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  }

  private lockKey(): string {
    return `candidate-store:${this.file}`;
  }
}

/** P14-6: typed node error-code check (ENOENT is the expected first-run path). */
function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}
