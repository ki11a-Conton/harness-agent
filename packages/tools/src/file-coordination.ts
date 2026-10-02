import { createHash } from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import { canonicalizePath } from "@ar/security";

/** Cooperation between file tools and transactions in this process only.
 * A mutex and a pre-write digest are not an atomic CAS against other processes.
 * Policy enforcement remains in the orchestrator, before acquiring this lock. */
interface Waiter {
  grant: () => void;
  cancel: () => void;
}
interface LockEntry { waiters: Waiter[] }
const locks = new Map<string, LockEntry>();

export class FileOperationCancelled extends Error {
  constructor() { super("file operation cancelled"); this.name = "FileOperationCancelled"; }
}

export function throwIfFileCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FileOperationCancelled();
}

function fileKeys(path: string): string[] {
  const canonical = canonicalizePath(path, { cwd: process.cwd() });
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const keys = [`path:${key}`];
  try {
    const stat = statSync(canonical, { bigint: true });
    // Keep the path key across creates/replacements, and share an additional
    // identity key for existing hard links. Some filesystems expose ino=0;
    // those retain canonical-path coordination only.
    if (stat.isFile() && stat.ino !== 0n) keys.push(`inode:${stat.dev}:${stat.ino}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  return keys;
}

function acquire(key: string, signal?: AbortSignal): Promise<() => void> {
  throwIfFileCancelled(signal);
  let entry = locks.get(key);
  if (!entry) {
    entry = { waiters: [] };
    locks.set(key, entry);
    return Promise.resolve(releaser(key, entry));
  }
  const queuedEntry = entry;
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", waiter.cancel);
        resolve(releaser(key, queuedEntry));
      },
      cancel: () => {
        const index = queuedEntry.waiters.indexOf(waiter);
        if (index >= 0) queuedEntry.waiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.cancel);
        reject(new FileOperationCancelled());
      },
    };
    queuedEntry.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.cancel, { once: true });
    if (signal?.aborted) waiter.cancel();
  });
}

function releaser(key: string, entry: LockEntry): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = entry.waiters.shift();
    if (next) next.grant();
    else locks.delete(key);
  };
}

/** Sorted, deduplicated acquisition also lets transactions hold their batch
 * through apply and failure rollback without deadlocking another batch. */
export async function withFileLocks<T>(
  paths: readonly string[], signal: AbortSignal | undefined, operation: () => Promise<T>,
): Promise<T> {
  throwIfFileCancelled(signal);
  for (;;) {
    const keys = [...new Set(paths.flatMap(fileKeys))].sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of keys) releases.push(await acquire(key, signal));
      throwIfFileCancelled(signal);
      // A preceding cooperating transaction may have atomically replaced the
      // inode while this caller waited. Release and reacquire its current keys
      // before doing any I/O in the operation; never use the obsolete inode.
      const current = [...new Set(paths.flatMap(fileKeys))].sort();
      if (keys.length === current.length && keys.every((key, index) => key === current[index])) {
        return await operation();
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

export function withFileLock<T>(path: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  return withFileLocks([path], signal, operation);
}

/** Internal diagnostic for testing that holders/cancelled waiters leave no entries. */
export function fileLockEntryCount(): number { return locks.size; }

export function fileSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FileVersionConflict extends Error {
  constructor(path: string) {
    super(`file version changed or is missing: ${path}; read the file again before editing`);
    this.name = "FileVersionConflict";
  }
}

export function assertFileVersion(bytes: Uint8Array, expectedSha256: string | undefined, path: string): void {
  if (expectedSha256 !== undefined && fileSha256(bytes) !== expectedSha256.toLowerCase()) {
    throw new FileVersionConflict(path);
  }
}

export async function checkFileVersion(path: string, expectedSha256: string): Promise<void> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(path); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") throw new FileVersionConflict(path);
    throw err;
  }
  assertFileVersion(bytes, expectedSha256, path);
}

/** Buffer's permissive decoder would replace invalid bytes during a small edit. */
export function decodeEditableUtf8(bytes: Buffer): string {
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("edit_file requires valid UTF-8 bytes");
  return content;
}
