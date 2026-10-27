import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_INDEXED_SOURCE_BYTES = 24 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export class IndexedSourceError extends Error {
  constructor(readonly code: "SOURCE_TOO_LARGE" | "SOURCE_CHANGED", message: string) {
    super(message);
  }
}

export interface IndexedSourceReadOptions {
  encoding: "utf8";
  signal: AbortSignal;
  root: string;
  realRoot: string;
  maxBytes?: number;
}

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Bound actual bytes read, including files that grow after a caller's stat.
 * Never follow a selected file symlink; reject paths or identities that change
 * during the read. The workspace root itself may be a trusted alias. */
export async function readIndexedSource(path: string, options: IndexedSourceReadOptions): Promise<string> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? MAX_INDEXED_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_INDEXED_SOURCE_BYTES) throw new TypeError("invalid source byte limit");
  signal.throwIfAborted();
  const root = resolve(options.root), file = resolve(path), rel = relative(root, file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new IndexedSourceError("SOURCE_CHANGED", "source escaped the selected workspace");
  }
  const expected = resolve(options.realRoot, rel);
  if (!samePath(await realpath(file), expected)) throw new IndexedSourceError("SOURCE_CHANGED", "source path changed");
  signal.throwIfAborted();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(file, flags);
  try {
    const before = await handle.stat();
    signal.throwIfAborted();
    if (!before.isFile()) throw new IndexedSourceError("SOURCE_CHANGED", "source is not a regular file");
    if (before.size > maxBytes) throw new IndexedSourceError("SOURCE_TOO_LARGE", `source exceeds ${maxBytes} bytes`);
    let buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, before.size + 1)));
    let count = 0;
    while (true) {
      signal.throwIfAborted();
      if (count === buffer.length) {
        if (count > maxBytes) throw new IndexedSourceError("SOURCE_TOO_LARGE", `source exceeds ${maxBytes} bytes`);
        const expanded = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(buffer.length * 2, 1)));
        buffer.copy(expanded, 0, 0, count); buffer = expanded;
      }
      const { bytesRead } = await handle.read(buffer, count, Math.min(READ_CHUNK_BYTES, buffer.length - count), null);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > maxBytes) throw new IndexedSourceError("SOURCE_TOO_LARGE", `source exceeds ${maxBytes} bytes`);
    }
    const after = await handle.stat(), linked = await lstat(file);
    signal.throwIfAborted();
    if (linked.isSymbolicLink() || before.ino !== linked.ino || before.dev !== linked.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !samePath(await realpath(file), expected)) {
      throw new IndexedSourceError("SOURCE_CHANGED", "source changed during read");
    }
    signal.throwIfAborted();
    return buffer.subarray(0, count).toString(options.encoding);
  } finally {
    await handle.close();
  }
}
