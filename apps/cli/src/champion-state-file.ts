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

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { createInitialChampionState, migrateChampionValidity, type ChampionState } from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";

export const CHAMPION_STATE_PATH = join("docs", "evolution", "champion-state.json");

/** Canonical digest of a champion state (content-addressed CAS token). */
export function championStateDigest(state: ChampionState): string {
  const { applied: _, ...rest } = state;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
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
 * E2-07 atomic write: persists `state` IF AND ONLY IF the file currently
 * equals `expectedDigest` (the digest of the state the caller read). Returns
 * the recorded digest on success, or { stale: true } when the file moved
 * (concurrent promote / external edit). Write is atomic (temp + rename).
 */
export async function writeChampionStateFileCas(
  state: ChampionState,
  expectedDigest: string,
  pathOverride?: string,
): Promise<{ ok: true; digest: string } | { ok: false; stale: true }> {
  const path = pathOverride ?? CHAMPION_STATE_PATH;
  const current = await readChampionStateFile(path);
  const currentDigest = current instanceof Error
    ? (await readChampionStateFile(path)).toString()
    : championStateDigest(current);
  if (currentDigest !== expectedDigest) {
    return { ok: false, stale: true };
  }
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify({ ...state, applied: true }, null, 2)}\n`;
  const tmp = join(dirname(path), `.champion-state.tmp-${randomUUID()}`);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, path);
  return { ok: true, digest: championStateDigest(state) };
}

/** Persist a champion state (only reachable via the explicit promote command).
 *  Non-CAS variant kept for legacy callers (quarantine already ran) and tests. */
export async function writeChampionStateFile(state: ChampionState, pathOverride?: string): Promise<void> {
  const path = pathOverride ?? CHAMPION_STATE_PATH;
  await mkdir(dirname(path), { recursive: true });
  // Persisted state is always the active Champion (apply step).
  await writeFile(path, `${JSON.stringify({ ...state, applied: true }, null, 2)}\n`, "utf8");
}
