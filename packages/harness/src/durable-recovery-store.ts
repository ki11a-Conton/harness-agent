/**
 * E4-08 — durable, restart-safe RecoveryStore for production.
 *
 * The actor's recovery algorithm (attempt / nextAttemptAt / lease / terminal
 * decision) is unchanged; this is the persistence backend that lets it survive
 * a real process restart and contend safely across processes/workers:
 *
 *   - one atomic JSON file per task (temp + fsync + rename via store-integrity);
 *   - optimistic concurrency: every accepted write bumps a `version`, and a
 *     write whose version does not match the stored record throws (CAS);
 *   - a cross-process advisory lock (open "wx" + PID + stale recovery) wraps
 *     each read-check-write so two processes cannot both win a lease;
 *   - unknown schema fails closed; a corrupt record is quarantined (moved
 *     aside, never silently zeroed) so attempts are never reset by damage;
 *   - `listDue` supports an external scheduler reconciling backoff after a
 *     restart without a live actor holding a timer.
 *
 * MemoryRecoveryStore remains for tests / explicit ephemeral mode only.
 */

import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, withLock } from "@ar/store-integrity";
import type { TurnId } from "@ar/contracts";
import type { RecoveryRecord, RecoveryStore } from "@ar/core";

export const DURABLE_RECOVERY_SCHEMA_VERSION = "1.0.0";

const RECOVERY_STATES = new Set<RecoveryRecord["state"]>([
  "PENDING", "RECOVERY_IN_PROGRESS", "RETRY_SCHEDULED", "RECOVERED", "EXHAUSTED", "TERMINAL_FAILED",
]);
const TERMINAL_STATES = new Set<RecoveryRecord["state"]>(["RECOVERED", "EXHAUSTED", "TERMINAL_FAILED"]);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const LOCK_STALE_MS = 10_000;

interface RecoveryEnvelope {
  schemaVersion: typeof DURABLE_RECOVERY_SCHEMA_VERSION;
  record: RecoveryRecord;
}

export class RecoveryStoreError extends Error {
  constructor(readonly code: "UNSAFE_ID" | "UNSUPPORTED_SCHEMA" | "CORRUPT_RECORD" | "CAS_CONFLICT" | "IO_ERROR", message: string) {
    super(message);
    this.name = "RecoveryStoreError";
  }
}

function assertSafeId(id: string): void {
  if (id.length === 0 || !SAFE_ID.test(id)) {
    throw new RecoveryStoreError("UNSAFE_ID", `unsafe task id ${JSON.stringify(id)}`);
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

/** P14-6: best-effort cleanup failures are reported on the degraded channel,
 *  never silently swallowed. */
function degraded(context: string, err: unknown): void {
  process.stderr.write(`[degraded] durable-recovery-store.${context}: ${err instanceof Error ? err.message : String(err)}\n`);
}

async function ignoreButReport(promise: Promise<unknown>, context: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    degraded(context, err);
  }
}

function validateRecord(record: unknown, file: string): RecoveryRecord {
  if (typeof record !== "object" || record === null) {
    throw new RecoveryStoreError("CORRUPT_RECORD", `${file}: record is not an object`);
  }
  const r = record as Record<string, unknown>;
  if (typeof r.taskId !== "string" || typeof r.state !== "string" || !RECOVERY_STATES.has(r.state as RecoveryRecord["state"])) {
    throw new RecoveryStoreError("UNSUPPORTED_SCHEMA", `${file}: unknown recovery record schema (taskId/state)`);
  }
  if (typeof r.attempt !== "number" || typeof r.maxRecoveryAttempts !== "number" || typeof r.nextAttemptAt !== "number") {
    throw new RecoveryStoreError("UNSUPPORTED_SCHEMA", `${file}: recovery record numeric fields missing/invalid`);
  }
  if (typeof r.promptId !== "string") {
    throw new RecoveryStoreError("UNSUPPORTED_SCHEMA", `${file}: recovery record promptId missing`);
  }
  if (r.version !== undefined && typeof r.version !== "number") {
    throw new RecoveryStoreError("UNSUPPORTED_SCHEMA", `${file}: recovery record version must be a number`);
  }
  return record as RecoveryRecord;
}

export interface DurableRecoveryStoreOptions {
  dataDir: string;
  /** Injectable clock for lease staleness (defaults to Date.now). */
  now?: () => number;
}

export class DurableRecoveryStore implements RecoveryStore {
  private readonly root: string;
  private readonly now: () => number;
  /** E4-R06 (F15): a per-instance nonce so each lock acquisition is a distinct
   *  OWNER TOKEN, even across two clients in one process (tests) or a PID
   *  reuse after a crash. Release only removes the token it wrote. */
  private readonly lockNonce: string;

  constructor(opts: DurableRecoveryStoreOptions) {
    this.root = join(resolve(opts.dataDir), "recovery");
    this.now = opts.now ?? Date.now;
    this.lockNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private file(taskId: string): string {
    return join(this.root, `${taskId}.json`);
  }

  /** E4-R06 (F14): the persistent quarantine markers for a task (files named
   *  `<task>.json.corrupt-*`). Their mere existence means the record is corrupt
   *  and must NOT be auto-recreated. */
  private async corruptMarkers(taskId: string): Promise<string[]> {
    try {
      const entries = await readdir(this.root);
      const prefix = `${taskId}.json.corrupt-`;
      return entries.filter((e) => e.startsWith(prefix)).map((e) => join(this.root, e));
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw new RecoveryStoreError("IO_ERROR", `corrupt-marker scan failed for ${taskId}: ${String(err)}`);
    }
  }

  private async hasCorruptMarker(taskId: string): Promise<boolean> {
    return (await this.corruptMarkers(taskId)).length > 0;
  }

  private async readEnvelope(taskId: string): Promise<RecoveryEnvelope | undefined> {
    const file = this.file(taskId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) {
        // E4-R06 (F14): a quarantined corrupt file leaves a PERSISTENT marker.
        // A second / post-restart read must still see the corrupt state —
        // ENOENT alone would let the actor create a fresh attempt=0 record,
        // resetting attempts by damage. Only an explicit maintenance delete
        // clears the marker.
        for (const marker of await this.corruptMarkers(taskId)) {
          if (marker !== null) {
            throw new RecoveryStoreError("CORRUPT_RECORD", `${file}: persistent corrupt marker ${marker} — record remains corrupt; attempts NOT reset (explicit maintenance delete required)`);
          }
        }
        return undefined;
      }
      throw new RecoveryStoreError("IO_ERROR", `read failed for ${file}: ${String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt: quarantine (move aside) so it is never silently treated as
      // absent (which would reset attempts). Report, do not zero.
      const quarantined = `${file}.corrupt-${this.now()}`;
      await ignoreButReport(rename(file, quarantined), "quarantine-corrupt");
      throw new RecoveryStoreError("CORRUPT_RECORD", `${file}: unparseable JSON (quarantined to ${quarantined}); attempts NOT reset`);
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { schemaVersion?: unknown }).schemaVersion !== DURABLE_RECOVERY_SCHEMA_VERSION) {
      throw new RecoveryStoreError("UNSUPPORTED_SCHEMA", `${file}: unsupported recovery envelope schemaVersion`);
    }
    const env = parsed as RecoveryEnvelope;
    validateRecord(env.record, file);
    return env;
  }

  async getRecord(taskId: TurnId): Promise<RecoveryRecord | undefined> {
    assertSafeId(taskId);
    return withLock(`recovery:${taskId}`, async () => {
      const env = await this.readEnvelope(taskId);
      return env?.record;
    });
  }

  async putRecord(record: RecoveryRecord): Promise<RecoveryRecord> {
    assertSafeId(record.taskId);
    return withLock(`recovery:${record.taskId}`, async () => {
      const file = this.file(record.taskId);
      const lockFile = `${file}.lock`;
      await mkdir(this.root, { recursive: true });
      const release = await this.acquireFileLock(lockFile);
      try {
        const current = await this.readEnvelope(record.taskId);
        const currentVersion = current?.record.version ?? 0;
        // E4-R06 (F14): a corrupt marker is NOT bypassed by a fresh write — the
        // actor cannot silently reset a damaged record to attempt=0. Clearing
        // the damage is an explicit maintenance action (deleteRecord).
        if (record.version === undefined && await this.hasCorruptMarker(record.taskId)) {
          throw new RecoveryStoreError("CORRUPT_RECORD", `recovery ${record.taskId}: corrupt quarantine marker present — fresh write refused (attempts NOT reset; explicit maintenance delete required)`);
        }
        // CAS: a fresh (versionless) write requires no stored record; an update
        // must match the stored version exactly.
        if (record.version === undefined) {
          if (current !== undefined) {
            throw new RecoveryStoreError("CAS_CONFLICT", `recovery ${record.taskId}: fresh write but a record exists (version ${currentVersion})`);
          }
        } else if (record.version !== currentVersion) {
          throw new RecoveryStoreError("CAS_CONFLICT", `recovery ${record.taskId}: expected version ${record.version}, stored ${currentVersion}`);
        }
        const next: RecoveryRecord = { ...record, version: currentVersion + 1 };
        const env: RecoveryEnvelope = { schemaVersion: DURABLE_RECOVERY_SCHEMA_VERSION, record: next };
        await atomicWriteFile(file, JSON.stringify(env, null, 2));
        // Verify-by-read: only a record that reads back valid is acknowledged.
        const verified = await this.readEnvelope(record.taskId);
        if (verified?.record.version !== next.version || verified?.record.state !== next.state) {
          throw new RecoveryStoreError("CORRUPT_RECORD", `recovery ${record.taskId} did not validate on read-back`);
        }
        return verified!.record;
      } finally {
        await release();
      }
    });
  }

  async deleteRecord(taskId: TurnId): Promise<void> {
    assertSafeId(taskId);
    return withLock(`recovery:${taskId}`, async () => {
      try {
        await unlink(this.file(taskId));
      } catch (err) {
        if (!isNodeError(err, "ENOENT")) throw new RecoveryStoreError("IO_ERROR", `delete failed for ${taskId}: ${String(err)}`);
      }
      // E4-R06 (F14): delete IS the explicit maintenance action that clears the
      // persistent corrupt markers; everything else refuses to remove them.
      for (const marker of await this.corruptMarkers(taskId)) {
        try {
          await unlink(marker);
        } catch (err) {
          if (!isNodeError(err, "ENOENT")) degraded(`delete marker ${marker}`, err);
        }
      }
    });
  }

  /** E4-08: tasks whose retry is due at `now` and not yet terminal, soonest
   *  first, capped at `limit`. Used by a production scheduler to re-drive
   *  backoff after a restart with no live actor. */
  async listDue(now: number, limit: number): Promise<RecoveryRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return [];
      throw new RecoveryStoreError("IO_ERROR", `list failed: ${String(err)}`);
    }
    const due: RecoveryRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const taskId = entry.slice(0, -".json".length);
      let env: RecoveryEnvelope | undefined;
      try {
        env = await this.readEnvelope(taskId);
      } catch (err) {
        // A corrupt/quarantined record is skipped (never auto-reset), but the
        // skip is reported — silent omission would hide durable damage.
        degraded(`listDue skipping ${taskId}`, err);
        continue;
      }
      if (env === undefined) continue;
      const r = env.record;
      if (TERMINAL_STATES.has(r.state)) continue;
      if (r.nextAttemptAt > now) continue;
      due.push(r);
    }
    due.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    return due.slice(0, Math.max(0, limit));
  }

  /**
   * Cross-process advisory lock: atomic create with "wx"; the lock file holds
   * an OWNER TOKEN (`<pid> <per-store-nonce>`). E4-R06 (F15):
   *   - a lock is only stolen when it is older than LOCK_STALE_MS AND its
   *     recorded owner PID is no longer alive — a live writer that simply runs
   *     longer than 10s is never robbed;
   *   - release only unlinks if the lock file STILL carries THIS owner's token;
   *     an old owner's finally can never delete a newer owner's lock.
   * Returns a release function. Fails fast when a fresh lock is held elsewhere.
   */
  private async acquireFileLock(lockFile: string): Promise<() => Promise<void>> {
    const myToken = `${process.pid} ${this.lockNonce}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(lockFile, "wx");
        await handle.writeFile(myToken);
        await handle.close();
        return async () => {
          // Fencing: only the CURRENT owner may unlink. If the file no longer
          // carries our token, someone else owns it — never delete their lock.
          try {
            const text = await readFile(lockFile, "utf8");
            if (text.trim() === myToken) {
              await unlink(lockFile);
            } else {
              degraded(`release-lock (ownership changed, not deleting ${lockFile})`, new Error(`lock token ${JSON.stringify(text.trim())} != mine`));
            }
          } catch (err) {
            if (!isNodeError(err, "ENOENT")) degraded("release-lock", err);
          }
        };
      } catch (err) {
        if (!isNodeError(err, "EEXIST")) throw new RecoveryStoreError("IO_ERROR", `lock create failed: ${String(err)}`);
        // Steal ONLY if older than the stale floor AND the owner is dead.
        let steal = false;
        try {
          const s = await stat(lockFile);
          const text = await readFile(lockFile, "utf8").catch(() => "");
          const ownerPid = Number.parseInt(text.trim().split(" ")[0] ?? "", 10);
          const ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0 && processExists(ownerPid);
          if (this.now() - s.mtimeMs >= LOCK_STALE_MS && !ownerAlive) steal = true;
        } catch (statErr) {
          // Cannot stat/read the lock (vanished or unreadable): report and treat
          // as stealable so a flaky FS does not deadlock, but never silently.
          degraded("stat-lock (treating as stale)", statErr);
          steal = true;
        }
        if (steal) {
          await ignoreButReport(unlink(lockFile), "remove-stale-lock");
          continue;
        }
        throw new RecoveryStoreError("IO_ERROR", `recovery lock held by another ${LOCK_STALE_MS}ms-fresh live process: ${lockFile}`);
      }
    }
    throw new RecoveryStoreError("IO_ERROR", `could not acquire recovery lock: ${lockFile}`);
  }
}

/** True when the process (by pid) exists right now. Node's kill(pid, 0) is a
 *  cross-platform liveness probe (SIGTERM-less on Windows). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
