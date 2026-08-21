import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
/**
 * P2-35 shared store-integrity primitives.
 *
 * Every persistent JSONL/JSON store in the mono-repo (session, event, memory,
 * inbox, checkpoint) composes these helpers so atomicity, durability, and
 * in-process concurrency are handled uniformly.
 *
 * Contract:
 * - Writes go to a temp file, are fsync'd, then atomically renamed into
 *   place (rename over an existing file is atomic on POSIX). This closes the
 *   "read old -> no file -> write" hole that plain `rm()`+`rename` leaves open.
 * - Append-only files are fsync'd after each append so a crash never loses an
 *   acknowledged line.
 * - Cross-process writes remain single-writer (documented per store); these
 *   helpers guarantee in-process mutual exclusion and crash safety.
 */
async function syncDir(dirPath) {
    // Directory fsync makes a rename/persist durable across power loss. It is
    // best-effort: some filesystems reject it (EINVAL/EPERM), and skipping it
    // only risks losing the rename itself, never corrupting file contents.
    try {
        const handle = await open(dirPath, "r");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch {
        /* best-effort */
    }
}
/**
 * Durably write `data` to `target`: temp file + fsync + atomic rename (+ fsync
 * parent dir). Guarantees the target is never observed half-written or missing.
 */
export async function atomicWriteFile(target, data) {
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(tmp, "w");
    try {
        await handle.writeFile(data);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(tmp, target);
    await syncDir(dir);
}
/**
 * Durably append a single line to an append-only file and fsync the handle, so
 * an acknowledged line survives a crash. Missing parent dir is created.
 */
export async function appendDurable(file, line) {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true });
    const handle = await open(file, "a");
    try {
        await handle.write(line);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
const locks = new Map();
/**
 * Per-key async mutex. Serializes read-modify-write / persist cycles with the
 * same `key` within this process, so concurrent `write()`/`update()`/`remove()`
 * calls cannot lose updates. Uses the last awaited tail so each invocation runs
 * strictly after the previous one for that key.
 */
export async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep the chain alive regardless of individual success/failure.
    const tail = run.then(() => undefined, () => undefined);
    locks.set(key, tail);
    return run;
}
/** Snap a moment-stable timestamp for backup directory naming. */
function backupStamp(now) {
    return [
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        String(now.getUTCDate()).padStart(2, "0"),
        "T",
        String(now.getUTCHours()).padStart(2, "0"),
        String(now.getUTCMinutes()).padStart(2, "0"),
        String(now.getUTCSeconds()).padStart(2, "0"),
        String(now.getUTCMilliseconds()).padStart(3, "0"),
    ].join("");
}
/**
 * Copy every file under `srcRoot` into `<srcRoot>/backups/<stamp>/`, skipping
 * temp files (`.tmp` / leading-dot scratch) and any existing `backups` dir so a
 * backup never recursively backs itself up. Each copied file is written
 * durably (temp + rename) so a backup is self-consistent per file. The caller
 * must bound the volume (session/event/memory stores are small).
 */
export async function backupTree(srcRoot, opts = {}) {
    const root = resolve(srcRoot);
    const stamp = backupStamp((opts.now?.() ?? new Date()));
    const destRoot = join(root, "backups", stamp);
    const seen = [];
    let bytes = 0;
    const copyDir = async (from, to) => {
        let entries;
        try {
            const listing = await readdir(from, { withFileTypes: true });
            entries = listing.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        }
        catch {
            return; // missing dir is fine
        }
        for (const entry of entries) {
            if (entry.name === "backups")
                continue;
            if (entry.name.endsWith(".tmp"))
                continue;
            if (entry.name.startsWith(".") && entry.name.endsWith(".tmp"))
                continue;
            const src = join(from, entry.name);
            const dst = join(to, entry.name);
            if (entry.isDirectory) {
                await copyDir(src, dst);
                continue;
            }
            const info = await stat(src);
            await atomicWriteFile(dst, await readFile(src));
            seen.push(relative(root, src));
            bytes += info.size;
        }
    };
    await mkdir(destRoot, { recursive: true });
    await copyDir(root, destRoot);
    await syncDir(root);
    // P0-2: expose the backup location with POSIX separators — it is a
    // record/reporting value, not a filesystem handle (Windows drive letters
    // are preserved).
    return { path: toPortablePath(destRoot), files: seen.length, bytes };
}
/** Normalize a reported path to `/` separators (Windows backslash → `/`). */
function toPortablePath(p) {
    return p.replace(/\\/g, "/");
}
/**
 * Strict JSONL parse used by verifyJsonlFile. Line records are expected to be
 * objects; any invalid JSON or non-object line throws with the line number so a
 * store can fail closed. `tolerant: true` skips bad lines (best-effort recovery)
 * — matches the memory/inbox read policy.
 */
export function parseJsonl(raw, opts = {}) {
    const records = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || line.trim() === "")
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed !== "object" || parsed === null) {
                throw new Error("record is not an object");
            }
            records.push(parsed);
        }
        catch (err) {
            if (opts.tolerant)
                continue;
            throw new Error(`corrupt JSONL line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return records;
}
/**
 * Manual integrity scan of an append-only JSONL file: strict parse (fail
 * closed). Used by stores wanting a cheap `verify()` without re-reading
 * semantics.
 */
export async function verifyJsonlFile(file) {
    const raw = await readFile(file, "utf8");
    return { records: parseJsonl(raw).length };
}
/** Structural record wrapper guard used by JSON stores. */
export function assertRecordVersion(record, expected, label) {
    if (typeof record !== "object" || record === null) {
        throw new Error(`${label}: record is not an object`);
    }
    const rec = record;
    if (rec.schemaVersion !== expected) {
        throw new Error(`${label}: unsupported schemaVersion ${String(rec.schemaVersion)}`);
    }
}
export { enforceArtifactRetention, archiveFile } from "./retention.js";
//# sourceMappingURL=index.js.map