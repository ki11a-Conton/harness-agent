import { randomUUID } from "node:crypto";
import { atomicReplace } from "@ar/store-integrity";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { feedbackHistorySchema, type FeedbackHistory } from "./feedback-records.js";

/** Host presentation/admission facts. Runtime snapshots never live in this file. */
export interface SessionMetadata {
  revision: number;
  title?: string;
  requests: Record<string, PromptReceipt>;
  answers: Record<string, AnswerContinuation>;
  /** Local human feedback audit; excluded from Runtime/model conversation. */
  feedback?: FeedbackHistory;
  /** UI text keyed by the SHA-256 of immutable model input, including on forks. */
  displayTexts?: Record<string, string>;
}
export interface PromptReceipt {
  fingerprint: string;
  text: string;
  mode: "queue" | "steer";
  startedAt: number;
  beforePromptIds: string[];
  status: "admitting" | "accepted";
  promptId?: string;
}
export interface AnswerContinuation {
  turnId: string;
  status: "claimed" | "started" | "settled";
  afterSequence: number;
}
interface Document { version: 1; sessions: Record<string, SessionMetadata> }

const stores = new Map<string, SessionMetadataStore>();
const emptySession = (): SessionMetadata => ({ revision: 0, requests: {}, answers: {} });

/** One serialized writer per host file; independent namespaces never overwrite each other. */
export function createSessionMetadataStore(dataDir?: string): SessionMetadataStore {
  const key = dataDir === undefined ? undefined : join(resolve(dataDir), "deepseek", "session-metadata.json");
  if (key === undefined) return new SessionMetadataStore();
  let store = stores.get(key);
  if (store === undefined) { store = new SessionMetadataStore(key); stores.set(key, store); }
  return store;
}

export class SessionMetadataStore {
  private chain: Promise<void> = Promise.resolve();
  private memory: Document = { version: 1, sessions: {} };
  constructor(readonly path?: string) {}

  async drain(): Promise<void> { await this.chain; }

  async read(sessionId: string): Promise<SessionMetadata> {
    await this.chain;
    const document = await this.load();
    return structuredClone(document.sessions[sessionId] ?? emptySession());
  }

  /** Caller executes this mutation inside the host's controlled metadata tool. */
  async update(sessionId: string, mutate: (current: SessionMetadata) => void, expectedRevision?: number): Promise<SessionMetadata> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(done => { release = done; });
    await previous;
    try {
      const document = await this.load();
      const current = structuredClone(document.sessions[sessionId] ?? emptySession());
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw Object.assign(new Error("Session metadata revision changed"), { code: "session/metadata-conflict" });
      }
      mutate(current);
      current.revision += 1;
      document.sessions[sessionId] = current;
      await this.save(document);
      return structuredClone(current);
    } finally { release(); }
  }

  private async load(): Promise<Document> {
    if (this.path === undefined) return structuredClone(this.memory);
    try {
      if ((await lstat(dirname(this.path))).isSymbolicLink()) throw new Error("Session metadata directory is a symlink");
      if ((await lstat(this.path)).isSymbolicLink()) throw new Error("Session metadata file is a symlink");
      const file = await open(this.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      let raw: unknown;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Session metadata is not a bounded regular file");
        raw = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
      if (!record(raw) || raw.version !== 1 || !record(raw.sessions)) throw new Error("Invalid session metadata document");
      for (const value of Object.values(raw.sessions)) {
        if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
          || (value.title !== undefined && typeof value.title !== "string") || !record(value.requests) || !record(value.answers)) {
          throw new Error("Invalid session metadata row");
        }
        for (const receipt of Object.values(value.requests)) {
          if (!record(receipt) || typeof receipt.fingerprint !== "string" || typeof receipt.text !== "string"
            || (receipt.mode !== "queue" && receipt.mode !== "steer") || !Number.isFinite(receipt.startedAt)
            || !Array.isArray(receipt.beforePromptIds) || receipt.beforePromptIds.some(id => typeof id !== "string")
            || (receipt.status !== "admitting" && receipt.status !== "accepted")
            || (receipt.promptId !== undefined && typeof receipt.promptId !== "string")) throw new Error("Invalid prompt receipt");
        }
        for (const answer of Object.values(value.answers)) {
          if (!record(answer) || typeof answer.turnId !== "string" || !Number.isSafeInteger(answer.afterSequence)
            || !["claimed", "started", "settled"].includes(String(answer.status))) throw new Error("Invalid answer continuation");
        }
        if (value.feedback !== undefined && !feedbackHistorySchema.safeParse(value.feedback).success) throw new Error("Invalid feedback history");
        if (value.displayTexts !== undefined && (!record(value.displayTexts) || Object.entries(value.displayTexts).some(([hash, text]) =>
          !/^[a-f0-9]{64}$/.test(hash) || typeof text !== "string" || text.length > 64000))) throw new Error("Invalid session display text");
      }
      return raw as unknown as Document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      throw error;
    }
  }

  private async save(document: Document): Promise<void> {
    const encoded = JSON.stringify(document);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error("Session metadata exceeds its bounded storage policy");
    if (this.path === undefined) { this.memory = structuredClone(document); return; }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Session metadata directory is a symlink");
    try { if ((await lstat(this.path)).isSymbolicLink()) throw new Error("Session metadata file is a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
      await atomicReplace(temporary, this.path);
      // Windows does not permit opening a directory; file contents still have a durable fence.
      if (process.platform !== "win32") {
        const dir = await open(directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
