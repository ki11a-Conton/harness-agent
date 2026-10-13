import { atomicReplace } from "@ar/store-integrity";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { decodeScheduleRecord } from "./schedule-pure/domain.js";
import type { ScheduleRecord, ScheduleDeliveryRecord } from "./schedule-pure/types.js";

export interface ScheduleTask {
  sessionId: string;
  record: ScheduleRecord;
  status: "active" | "inactive";
  deliveries: ScheduleDeliveryRecord[];
  pruned?: true;
  claim?: { requestId: string; scheduledAt: string; prompt: string; nextScheduledAt?: string };
  failure?: string;
}
export interface ScheduleDocument { version: 1; tasks: Record<string, ScheduleTask> }
const owners = new Map<string, ActivityStore>();
export function activityStore(path: string): ActivityStore {
  let owner = owners.get(path);
  if (owner === undefined) { owner = new ActivityStore(path); owners.set(path, owner); }
  return owner;
}

/** All methods are called inside a controlled host tool; one file has one writer. */
export class ActivityStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async read(): Promise<ScheduleDocument> { await this.chain; return this.load(); }
  async update<T>(change: (document: ScheduleDocument) => T): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(done => { release = done; });
    await previous;
    try { const document = await this.load(); const result = change(document); await this.save(document); return structuredClone(result); }
    finally { release(); }
  }
  private async load(): Promise<ScheduleDocument> {
    let value: unknown;
    try {
      const parent = dirname(this.path);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Task directory is a symlink");
      const expected = join(await realpath(parent), basename(this.path));
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid task state file");
      const file = await open(this.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const opened = await file.stat();
        const actual = await realpath(this.path);
        const samePath = process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > 16 * 1024 * 1024 || !samePath) throw new Error("Invalid opened task state file");
        // A local writer can grow a regular file after stat. Bound the bytes
        // read from the same descriptor rather than reopening by pathname.
        const chunks: Buffer[] = []; let bytes = 0;
        while (bytes <= 16 * 1024 * 1024) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, 16 * 1024 * 1024 + 1 - bytes));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          bytes += bytesRead; chunks.push(buffer.subarray(0, bytesRead));
        }
        if (bytes > 16 * 1024 * 1024) throw new Error("Task state exceeds its durable byte budget");
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: {} }; throw error; }
    if (!record(value) || value.version !== 1 || !record(value.tasks) || Object.keys(value.tasks).length > 1000) throw new Error("Invalid task state document");
    for (const [id, task] of Object.entries(value.tasks)) {
      if (!record(task) || typeof task.sessionId !== "string" || task.sessionId.length === 0
        || (task.status !== "active" && task.status !== "inactive") || !Array.isArray(task.deliveries) || task.deliveries.length > 1000
        || (task.failure !== undefined && typeof task.failure !== "string") || (task.pruned !== undefined && task.pruned !== true)) throw new Error("Invalid task state row");
      if (decodeScheduleRecord(task.record).id !== id) throw new Error("Task key does not match its record");
      for (const receipt of task.deliveries) {
        if (!record(receipt) || typeof receipt.messageId !== "string" || receipt.messageId.length === 0
          || !instant(receipt.scheduledAt) || !instant(receipt.deliveredAt) || (receipt.prompt !== undefined && typeof receipt.prompt !== "string")) throw new Error("Invalid task delivery receipt");
      }
      if (task.claim !== undefined && (!record(task.claim) || typeof task.claim.requestId !== "string" || task.claim.requestId.length === 0
        || !instant(task.claim.scheduledAt) || typeof task.claim.prompt !== "string"
        || (task.claim.nextScheduledAt !== undefined && !instant(task.claim.nextScheduledAt)))) throw new Error("Invalid task dispatch claim");
    }
    return value as unknown as ScheduleDocument;
  }
  private async save(document: ScheduleDocument): Promise<void> {
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Task state exceeds its durable byte budget");
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink()) throw new Error("Task directory is a symlink");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      await atomicReplace(temporary, this.path);
      if (process.platform !== "win32") {
        const directory = await open(parent, "r"); try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function instant(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
