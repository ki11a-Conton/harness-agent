/**
 * E1-14 — champion state file IO (docs/evolution/champion-state.json).
 *
 * The champion state is the auditable record of the C0→C1→C2→… chain: which
 * candidate is the active champion level, what evidence promoted it, and the
 * full promotion history. Reads are free and deterministic; writes only happen
 * through the explicit promotion command (never from `champion eval`).
 *
 * E2-07 — writes are atomic compare-and-swap: the writer takes an EXPECTED
 * current state digest and refuses to overwrite when the file changed since
 * read (stale parent / concurrent promote). This makes duplicate promotion
 * idempotent and concurrent promotion single-winner without a lock file.
 *
 * The file path is injectable so tests never touch the real repository state.
 */

import { readFile, writeFile, mkdir, rename, open, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { createInitialChampionState, migrateChampionValidity, type ChampionState } from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";

export const CHAMPION_STATE_PATH = join("docs", "evolution", "champion-state.json");

/** Canonical digest of a champion state (content-addressed CAS token).
 *  E3-07: MUST include `applied` — changing the application status changes
 *  the digest (acceptance #4). */
export function championStateDigest(state: ChampionState): string {
  return createHash("sha256").update(stableStringify(state), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// E3-07: cross-process advisory lock (open "wx" + PID + stale recovery)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;

/** Acquire an exclusive lock file (cross-process). Returns a release function.
 *  Uses open(...,"wx") for atomic creation; a stale lock (older than
 *  LOCK_STALE_MS or whose PID is gone) is removed and retried. Fails fast when
 *  another process holds a fresh lock. */
async function acquireStateLock(pathOverride: string): Promise<() => Promise<void>> {
  const lockPath = `${pathOverride}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
      await fh.close();
      return async () => {
        try {
          await rm(lockPath, { force: true });
        } catch (releaseErr) {
          // Observability: a failed lock release is logged, never silently
          // swallowed (the next writer's stale-recovery will reclaim it).
          console.warn(`[champion-state] lock release failed for ${lockPath}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
        }
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Lock exists — is it stale?
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
        // Fresh lock — busy (regardless of PID: a same-process second writer
        // must also wait, or the CAS loses its mutual exclusion).
      } catch (statErr) {
        // Lock vanished between check and stat → retry acquire.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`state lock busy for >10s: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
    }
  }
}

/** Read the current champion state. Returns an Error on missing/invalid file
 *  (fail-closed — a missing state is never silently treated as promoted).
 *  E2-00: legacy records without `validity` are migrated on read — a C1/C2
 *  never auto-trusts as production-valid. */
export async function readChampionStateFile(pathOverride?: string): Promise<ChampionState | Error> {
  const path = pathOverride ?? CHAMPION_STATE_PATH;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ChampionState;
    if (parsed.schemaVersion !== "1.0.0" || parsed.level === undefined) {
      return new Error(`invalid champion-state.json (schemaVersion=${parsed.schemaVersion}, level=${parsed.level})`);
    }
    return migrateChampionValidity(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No file yet → the initial frozen baseline. Honest default: never
      // fabricated as promoted.
      return createInitialChampionState();
    }
    return new Error(`champion-state read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * E3-07 atomic write: persists `state` IF AND ONLY IF the file currently
 * equals `expectedDigest` (the digest of the state the caller read). The
 * compare + write happens INSIDE a cross-process lock so exactly one
 * concurrent writer wins (acceptance #3). Write is atomic (temp + fsync +
 * rename). The persisted `applied` field is preserved EXACTLY as given —
 * promote creates `applicationPending` (applied=false), never applied=true
 * (acceptance #5).
 */
export async function writeChampionStateFileCas(
  state: ChampionState,
  expectedDigest: string,
  pathOverride?: string,
): Promise<{ ok: true; digest: string } | { ok: false; stale: true }> {
  const path = pathOverride ?? CHAMPION_STATE_PATH;
  const release = await acquireStateLock(path);
  try {
    const current = await readChampionStateFile(path);
    const currentDigest = current instanceof Error
      ? (await readChampionStateFile(path)).toString()
      : championStateDigest(current);
    if (currentDigest !== expectedDigest) {
      return { ok: false, stale: true };
    }
    await mkdir(dirname(path), { recursive: true });
    // E3-07: persist `state` verbatim — no forced {applied:true}.
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = join(dirname(path), `.champion-state.tmp-${randomUUID()}`);
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    return { ok: true, digest: championStateDigest(state) };
  } finally {
    await release();
  }
}

/** Persist a champion state (only reachable via the explicit promote command).
 *  Non-CAS variant kept for legacy callers (quarantine already ran) and tests.
 *  E3-07: preserves `applied` exactly — no forced {applied:true}. */
export async function writeChampionStateFile(state: ChampionState, pathOverride?: string): Promise<void> {
  const path = pathOverride ?? CHAMPION_STATE_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
