import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * P11-4: artifact retention — a production data dir must not grow forever.
 * `enforceArtifactRetention` deletes the OLDEST files beyond the cap (size or
 * count) within an artifact directory. Audit-required event logs are NOT in
 * scope here — they belong to P11-5 (archive, never silent delete).
 */

export interface ArtifactRetentionOptions {
  /** Maximum total bytes to keep. */
  maxBytes?: number;
  /** Maximum number of files to keep. */
  maxFiles?: number;
  /** Maximum age in ms; older files are deleted. */
  maxAgeMs?: number;
}

export interface ArtifactRetentionResult {
  scanned: number;
  deleted: number;
  bytesDeleted: number;
  remainingBytes: number;
}

/** Delete oldest-first until every cap holds. Files are treated as artifacts:
 *  any file under `dir` counts. Best-effort per file — one failure never
 *  aborts the sweep. */
export async function enforceArtifactRetention(
  dir: string,
  options: ArtifactRetentionOptions,
): Promise<ArtifactRetentionResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { scanned: 0, deleted: 0, bytesDeleted: 0, remainingBytes: 0 };
  }
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const st = await stat(join(dir, entry.name));
      files.push({ path: join(dir, entry.name), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat: skip
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  let total = files.reduce((s, f) => s + f.size, 0);
  let deleted = 0;
  let bytesDeleted = 0;
  const now = Date.now();

  // Oldest-first greedy: while ANY cap is violated, delete the oldest file.
  for (const file of files) {
    const tooOld = options.maxAgeMs !== undefined && now - file.mtimeMs > options.maxAgeMs;
    const bytesOver = options.maxBytes !== undefined && total > options.maxBytes;
    const countOver = options.maxFiles !== undefined && files.length - deleted > options.maxFiles;
    if (!tooOld && !bytesOver && !countOver) break;
    try {
      await rm(file.path, { force: true });
      deleted += 1;
      bytesDeleted += file.size;
      total -= file.size;
    } catch {
      // best effort — one failure never aborts the sweep
    }
  }

  return { scanned: files.length, deleted, bytesDeleted, remainingBytes: total };
}

/**
 * P11-5: archive — move a session's artifact/event file OUT of the active
 * data dir into an archive directory, preserving the source byte-for-byte
 * (rename). Unlike deletion, the audit trail survives and can be restored by
 * renaming back. Returns the archived path.
 */
export async function archiveFile(
  activeDir: string,
  fileName: string,
  archiveDir: string,
): Promise<string | undefined> {
  const source = join(activeDir, fileName);
  try {
    await stat(source);
  } catch {
    return undefined; // nothing to archive
  }
  await mkdir(archiveDir, { recursive: true });
  const target = join(archiveDir, fileName);
  try {
    await rename(source, target);
  } catch {
    // cross-device rename: copy fallback not implemented — keep source intact
    return undefined;
  }
  return target;
}
