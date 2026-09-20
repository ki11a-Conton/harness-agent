/**
 * E4-R97 — the campaign-wide model-call budget ledger.
 *
 * Plan §R97 怎么做 (line 216-217) requires the global budget to be shared
 * "跨两臂、跨进程、跨恢复" (across both arms, across processes, across recovery):
 * reserved BEFORE the call, consumed recorded after it, and consumption plus
 * unknown reservations preserved after a crash — never re-granted 320 calls to
 * each subprocess. Logical model calls and physical transport retries are
 * recorded separately, and the unknown bill is named rather than assumed to be
 * zero.
 *
 * This module is the ledger. It is deliberately file-backed with an exclusive
 * lock rather than in-memory, because an in-process counter cannot be shared by
 * the two arm subprocesses that plan §R97 line 216 describes.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

export const R97_LEDGER_SCHEMA = "e4-r97-budget-ledger-v1";

/**
 * Named failure codes. Plan §R98 怎么做 requires a resumed campaign whose durable
 * state is missing/corrupt/foreign to FAIL CLOSED rather than silently re-grant
 * the allowance, so the reason is a stable code a caller can assert on.
 */
export const R97_BUDGET_STATE_MISSING = "BUDGET_STATE_MISSING";
export const R97_BUDGET_STATE_CORRUPT = "BUDGET_STATE_CORRUPT";
export const R97_BUDGET_STATE_MISMATCH = "BUDGET_STATE_MISMATCH";
export const R97_LOCK_HELD = "BUDGET_LOCK_HELD";

/** The ledger file name inside the campaign output directory. */
export const R97_LEDGER_FILENAME = "budget-ledger.json";
/** The exclusive lock guarding one read-modify-write of the ledger. */
export const R97_LEDGER_LOCK_FILENAME = "budget-ledger.lock";

/** A reservation whose owning process is gone and which has no terminal record.
 *  Its `reserved` amount stays counted: a dispatched attempt may have been
 *  billed, so the allowance is NOT returned. */
export type R97ReservationStatus = "reserved" | "committed" | "abandoned" | "unknown";

export interface R97LedgerEntry {
  reservationId: string;
  /** Which arm asked. Free-form so a rehearsal can use its own names. */
  arm: string;
  /** Owning process id, so a dead owner's reservations can be found. */
  pid: number;
  reservedAt: number;
  /** Logical calls this reservation reserved BEFORE the call was made. */
  reserved: number;
  status: R97ReservationStatus;
  /** Logical calls actually consumed. `null` while outstanding or unknown. */
  consumed: number | null;
  /** Physical transport retries observed. Recorded separately from `consumed`. */
  transportRetries: number;
}

export interface R97LedgerFile {
  schemaVersion: string;
  /** Binds the ledger to ONE authorization: a different plan cannot reuse it. */
  planDigest: string;
  /** The frozen grant. Never increased by a later process. */
  campaignModelCalls: number;
  entries: R97LedgerEntry[];
}

export interface R97LedgerView {
  granted: number;
  /** Logical calls from terminal records. */
  committed: number;
  /** Logical calls reserved but not yet terminal. */
  outstanding: number;
  /** Logical calls whose outcome is unknown. Counted as consumed. */
  unknown: number;
  /** Logical calls still grantable. */
  remaining: number;
  /** Physical transport retries across all terminal records. */
  transportRetries: number;
}

export interface R97ReserveResult {
  ok: boolean;
  reservationId: string | null;
  reason: string;
  view: R97LedgerView;
}

/** Why a reservation was refused. Named so a caller can report the cause. */
export const R97_BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

export interface R97LedgerOpenOptions {
  planDigest: string;
  campaignModelCalls: number;
  /** Lock acquisition budget in ms. Default 10s. */
  lockTimeoutMs?: number;
  /** Injectable clock, so tests are not wall-clock dependent. */
  now?: () => number;
  /** Injectable liveness probe, so tests can simulate a dead owner. */
  isAlive?: (pid: number) => boolean;
}

export interface R97BudgetLedger {
  readonly dir: string;
  readonly planDigest: string;
  view(): Promise<R97LedgerView>;
  reserve(arm: string, count: number): Promise<R97ReserveResult>;
  commit(reservationId: string, consumed: number, transportRetries?: number): Promise<R97LedgerView>;
  /** Return a reservation made for an attempt that PROVABLY never dispatched.
   *  Only legal while the reservation is still outstanding. */
  abandon(reservationId: string): Promise<R97LedgerView>;
  /** Mark outstanding reservations whose owner is gone as `unknown`. Their
   *  allowance is NOT returned. Returns how many were reclassified. */
  recover(): Promise<{ unknown: number; view: R97LedgerView }>;
  read(): Promise<R97LedgerFile>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 5;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Derive the view from the raw file. Pure, so it can be asserted directly.
 *
 *  `clamp` (default true) floors `remaining` at 0 for DISPLAY of a well-formed
 *  ledger. The parser calls it with `clamp: false` so an over-consumed file is
 *  DETECTED (remaining < 0) instead of being silently clamped into validity —
 *  plan §R98 怎么做: "任何计算结果违反 0 <= remaining <= granted 必须拒绝，不能靠
 *  clamp 掩盖错误." */
export function viewOfR97Ledger(file: R97LedgerFile, opts: { clamp?: boolean } = {}): R97LedgerView {
  let committed = 0;
  let outstanding = 0;
  let unknown = 0;
  let transportRetries = 0;
  for (const e of file.entries) {
    transportRetries += e.transportRetries;
    if (e.status === "committed") {
      // A committed record reports what was ACTUALLY consumed. A caller that
      // consumed less than it reserved returns the difference implicitly.
      committed += e.consumed ?? e.reserved;
    } else if (e.status === "unknown") {
      // Unknown counts as consumed at the RESERVED amount: the request may have
      // been sent, so the allowance must not silently reappear.
      unknown += e.reserved;
    } else if (e.status === "reserved") {
      outstanding += e.reserved;
    }
    // `abandoned` is the only status that returns allowance, and only because
    // the attempt provably never dispatched.
  }
  const raw = file.campaignModelCalls - committed - outstanding - unknown;
  const remaining = opts.clamp === false ? raw : Math.max(0, raw);
  return {
    granted: file.campaignModelCalls,
    committed,
    outstanding,
    unknown,
    remaining,
    transportRetries,
  };
}

function emptyLedger(planDigest: string, campaignModelCalls: number): R97LedgerFile {
  return { schemaVersion: R97_LEDGER_SCHEMA, planDigest, campaignModelCalls, entries: [] };
}

/**
 * Parse a ledger file. Fails CLOSED: a corrupt or foreign ledger is refused
 * rather than treated as an empty one, because "I cannot read the budget" must
 * never become "the budget is full again".
 *
 * Plan §R98 怎么做 requires STRICT validation of every counter and of the
 * (status, consumed) combination, because the previous version accepted
 * `consumed: -100` and derived `remaining: 103` from a grant of 3 — a hostile
 * (or merely buggy) file could INCREASE the allowance. Every rejection names
 * the offending field.
 */
export function parseR97Ledger(raw: unknown): { ledger: R97LedgerFile | null; issue: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ledger: null, issue: "ledger is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== R97_LEDGER_SCHEMA) {
    return { ledger: null, issue: `ledger schemaVersion must be ${R97_LEDGER_SCHEMA}` };
  }
  if (typeof o["planDigest"] !== "string" || o["planDigest"] === "") {
    return { ledger: null, issue: "ledger planDigest must be a non-empty string" };
  }
  const grant = o["campaignModelCalls"];
  if (typeof grant !== "number" || !Number.isSafeInteger(grant) || grant < 0) {
    return { ledger: null, issue: "ledger campaignModelCalls must be a non-negative safe integer" };
  }
  if (!Array.isArray(o["entries"])) return { ledger: null, issue: "ledger entries must be an array" };

  /** A counter must be a non-negative safe integer. */
  const counter = (value: unknown, field: string): string | null =>
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      ? `ledger ${field} must be a non-negative safe integer (got ${String(value)})`
      : null;

  const entries: R97LedgerEntry[] = [];
  const seenIds = new Set<string>();
  for (const [i, e] of (o["entries"] as unknown[]).entries()) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { ledger: null, issue: `ledger entries[${i}] is not an object` };
    }
    const r = e as Record<string, unknown>;
    const where = `entries[${i}]`;

    if (typeof r["reservationId"] !== "string" || r["reservationId"] === "") {
      return { ledger: null, issue: `ledger ${where}.reservationId must be a non-empty string` };
    }
    // Duplicate ids would make commit/abandon ambiguous and let one reservation
    // be settled twice.
    if (seenIds.has(r["reservationId"])) {
      return { ledger: null, issue: `ledger ${where}.reservationId "${r["reservationId"]}" is duplicated` };
    }
    seenIds.add(r["reservationId"]);

    const reservedIssue = counter(r["reserved"], `${where}.reserved`);
    if (reservedIssue !== null) return { ledger: null, issue: reservedIssue };
    const reserved = r["reserved"] as number;

    if (typeof r["arm"] !== "string") {
      return { ledger: null, issue: `ledger ${where}.arm must be a string` };
    }

    const status = String(r["status"]);
    if (!["reserved", "committed", "abandoned", "unknown"].includes(status)) {
      return { ledger: null, issue: `ledger ${where}.status is not a known status` };
    }

    // `pid` must be a safe integer when present. -1 was the old "unknown"
    // sentinel; keep accepting it, but reject nonsense like NaN/strings.
    const pid = r["pid"];
    if (pid !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid))) {
      return { ledger: null, issue: `ledger ${where}.pid must be a safe integer` };
    }
    const reservedAt = r["reservedAt"];
    if (reservedAt !== undefined && (typeof reservedAt !== "number" || !Number.isFinite(reservedAt) || reservedAt < 0)) {
      return { ledger: null, issue: `ledger ${where}.reservedAt must be a non-negative finite number` };
    }

    // transportRetries is a physical-attempt counter: never negative, never
    // fractional, and cumulative overflow of the total is checked below.
    const retriesIssue = counter(r["transportRetries"] ?? 0, `${where}.transportRetries`);
    if (retriesIssue !== null) return { ledger: null, issue: retriesIssue };
    const transportRetries = (r["transportRetries"] ?? 0) as number;

    // (status, consumed) must be one of the four legal combinations. Every
    // other pairing is a file that cannot be trusted to describe the budget.
    const consumedRaw = r["consumed"];
    let consumed: number | null;
    if (status === "reserved") {
      if (consumedRaw !== null && consumedRaw !== undefined) {
        return { ledger: null, issue: `ledger ${where} is "reserved" but carries a consumed count` };
      }
      consumed = null;
    } else if (status === "unknown") {
      if (consumedRaw !== null && consumedRaw !== undefined) {
        return { ledger: null, issue: `ledger ${where} is "unknown" but carries a consumed count` };
      }
      consumed = null;
    } else if (status === "committed") {
      const consumedIssue = counter(consumedRaw, `${where}.consumed`);
      if (consumedIssue !== null) return { ledger: null, issue: consumedIssue };
      consumed = consumedRaw as number;
      if (consumed > reserved) {
        return {
          ledger: null,
          issue: `ledger ${where} is "committed" with consumed ${consumed} > reserved ${reserved}`,
        };
      }
    } else {
      // abandoned: only a provably-undispatched attempt, so consumption is 0.
      if (consumedRaw !== 0) {
        return { ledger: null, issue: `ledger ${where} is "abandoned" but consumed is ${String(consumedRaw)} (must be 0)` };
      }
      consumed = 0;
    }

    entries.push({
      reservationId: r["reservationId"],
      arm: r["arm"],
      pid: typeof pid === "number" ? pid : -1,
      reservedAt: typeof reservedAt === "number" ? reservedAt : 0,
      reserved,
      status: status as R97ReservationStatus,
      consumed,
      transportRetries,
    });
  }

  const parsed: R97LedgerFile = {
    schemaVersion: R97_LEDGER_SCHEMA,
    planDigest: o["planDigest"],
    campaignModelCalls: grant,
    entries,
  };

  // The derived view is the thing that actually authorizes spending, so the
  // invariant is checked HERE rather than by clamping in viewOfR97Ledger: a
  // file whose entries exceed the grant is refused, never "limited" to zero
  // remaining and then treated as valid for a later top-up.
  const projected = viewOfR97Ledger(parsed, { clamp: false });
  if (projected.remaining < 0) {
    return {
      ledger: null,
      issue: `ledger consumption (${projected.committed + projected.outstanding + projected.unknown}) exceeds the grant ${grant} — a damaged ledger may never be clamped into validity`,
    };
  }

  return { ledger: parsed, issue: null };
}

/** Read a ledger without creating one. `null` = the file does not exist. */
export async function readR97LedgerFile(dir: string): Promise<R97LedgerFile | null> {
  let text: string;
  try {
    text = await readFile(join(dir, R97_LEDGER_FILENAME), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("E4-R97: the budget ledger is not valid JSON — refusing to treat an unreadable budget as an empty one");
  }
  const { ledger, issue } = parseR97Ledger(raw);
  if (ledger === null) throw new Error(`E4-R97: refusing to use a damaged budget ledger: ${String(issue)}`);
  return ledger;
}

/** The view of a campaign's budget as a FRESH process would see it. */
export async function readR97BudgetView(dir: string): Promise<R97LedgerView | null> {
  const file = await readR97LedgerFile(dir);
  return file === null ? null : viewOfR97Ledger(file);
}

/** Atomically replace the ledger: write a temp file, then rename over it. */
async function writeLedgerAtomic(dir: string, ledger: R97LedgerFile): Promise<void> {
  const tmp = join(dir, `${R97_LEDGER_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, join(dir, R97_LEDGER_FILENAME));
}

/** The on-disk lock record. The OWNER TOKEN is what makes release safe: a
 *  process may only delete a lock it still owns, so a slow owner's `finally`
 *  can never remove a lock another process has since acquired. */
interface R97LockRecord {
  token: string;
  pid: number;
  host: string;
  acquiredAt: number;
}

function newLockToken(): string {
  return randomBytes(16).toString("hex");
}

/** Parse a lock file. Unreadable/legacy content is treated as an UNKNOWN owner
 *  (conservatively occupied), never as a free lock. */
function parseLockRecord(text: string): R97LockRecord | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o["token"] !== "string" || o["token"] === "") return null;
    if (typeof o["pid"] !== "number" || !Number.isSafeInteger(o["pid"])) return null;
    return {
      token: o["token"],
      pid: o["pid"],
      host: typeof o["host"] === "string" ? o["host"] : "",
      acquiredAt: typeof o["acquiredAt"] === "number" ? o["acquiredAt"] : 0,
    };
  } catch {
    // Legacy/plain-text locks (`<pid>`) are still honoured as an owner hint so
    // an upgraded binary cannot steal a lock written by the previous version.
    const legacy = Number(text.trim());
    if (Number.isSafeInteger(legacy) && legacy > 0) {
      return { token: "", pid: legacy, host: "", acquiredAt: 0 };
    }
    return null;
  }
}

/**
 * Acquire the exclusive lock.
 *
 * Plan §R98 怎么做: "锁采用 owner token + 进程存活判断；年龄只能作为检查线索。活
 * owner 超时返回占用错误，不能删锁。"
 *
 * Measured defect this closes: the previous version reclaimed ANY lock whose
 * mtime was older than 30s, so a live process that had been holding the lock
 * for 60s had it deleted under it and two writers could interleave. Age is now
 * only a HINT used to decide whether to bother reading the owner record; the
 * decision to take over is based on the owner being provably dead.
 *
 * Returns the token, so the caller can release only its own lock.
 */
async function acquireLock(
  dir: string,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  now: () => number,
): Promise<{ lockPath: string; token: string }> {
  const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
  const deadline = now() + timeoutMs;
  for (;;) {
    const token = newLockToken();
    try {
      const fh = await open(lockPath, "wx");
      try {
        const record: R97LockRecord = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: now(),
        };
        await fh.writeFile(JSON.stringify(record), "utf8");
      } finally {
        await fh.close();
      }
      return { lockPath, token };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }

    // The lock exists. Decide whether its owner is still alive.
    let holder: R97LockRecord | null = null;
    let age = 0;
    try {
      const [text, st] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
      holder = parseLockRecord(text);
      age = Math.max(0, now() - st.mtimeMs);
    } catch {
      // The holder released it between our open() and this read: retry at once.
      continue;
    }

    // A record with an unparseable owner is conservatively OCCUPIED: we cannot
    // prove the writer is gone, and stealing a live lock is the worse error.
    const ownerGone = holder !== null && holder.token !== "" && !isAlive(holder.pid);
    if (ownerGone) {
      // Provably dead owner — the crash this ledger exists to survive. Age is
      // deliberately NOT required: a fast crash must not deadlock the campaign.
      await rm(lockPath, { force: true });
      continue;
    }

    if (now() >= deadline) {
      const who = holder === null ? "an unreadable owner" : `pid ${holder.pid}`;
      throw new Error(
        `E4-R97: ${R97_LOCK_HELD}: could not acquire the budget ledger lock within ${timeoutMs}ms (${lockPath}) — it is held by ${who} (age ${age}ms)`,
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/** Release the lock ONLY if we still own it. A stale owner whose lock was taken
 *  over must never delete the new owner's lock. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const text = await readFile(lockPath, "utf8");
    const holder = parseLockRecord(text);
    if (holder === null || holder.token !== token) return; // no longer ours
  } catch {
    return; // already gone
  }
  await rm(lockPath, { force: true });
}

/**
 * Open the campaign budget ledger, creating it on first use.
 *
 * A ledger already present but bound to a DIFFERENT plan digest is refused: the
 * budget belongs to one authorization, and silently adopting another plan's
 * consumption would either over-grant or under-grant.
 *
 * Plan §R98 怎么做 draws the line between FIRST CREATION and RESUME: the
 * `read() ?? emptyLedger()` fallback is only legal while establishing a new
 * campaign. Once this handle has OBSERVED durable state, that state vanishing,
 * corrupting, or being swapped for another plan's must fail closed with
 * BUDGET_STATE_MISSING / CORRUPT / MISMATCH — never re-grant the allowance.
 */
export async function openR97BudgetLedger(dir: string, opts: R97LedgerOpenOptions): Promise<R97BudgetLedger> {
  await mkdir(dir, { recursive: true });
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const isAlive = opts.isAlive ?? defaultIsAlive;

  /** True once this handle has seen the ledger on disk. After that, a missing
   *  file is a MISSING STATE, not a fresh campaign. */
  let established = false;

  /** Read the ledger. First creation may substitute an empty one; a resume may
   *  NOT — it fails closed with a named code. */
  const read = async (): Promise<R97LedgerFile> => {
    let present: R97LedgerFile | null;
    try {
      present = await readR97LedgerFile(dir);
    } catch (err) {
      // Damage detected by the reader (bad JSON / schema / invariant).
      const message = err instanceof Error ? err.message : String(err);
      if (established) {
        throw new Error(`E4-R97: ${R97_BUDGET_STATE_CORRUPT}: ${message}`);
      }
      throw err;
    }
    if (present === null) {
      if (established) {
        throw new Error(
          `E4-R97: ${R97_BUDGET_STATE_MISSING}: the budget ledger for this campaign no longer exists in ${dir} — refusing to treat a lost budget as a fresh full allowance`,
        );
      }
      return emptyLedger(opts.planDigest, opts.campaignModelCalls);
    }
    // Every read re-validates the identity, not just the first open: a file
    // swapped mid-campaign must not be adopted.
    if (present.planDigest !== opts.planDigest) {
      throw new Error(
        `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} belongs to a different plan (${present.planDigest}) than this authorization (${opts.planDigest})`,
      );
    }
    if (present.campaignModelCalls !== opts.campaignModelCalls) {
      throw new Error(
        `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger grants ${present.campaignModelCalls} calls but this authorization declares ${opts.campaignModelCalls}`,
      );
    }
    established = true;
    return present;
  };
  const view = async (): Promise<R97LedgerView> => viewOfR97Ledger(await read());

  /**
   * One locked read-modify-write. `mutate` returns the next entries plus a
   * result; `next: null` means "do not persist" (a pure refusal).
   *
   * `next` is an explicit field rather than an optional `ledger` key so the
   * return type stays a single shape — an optional key makes the two branches a
   * discriminated union TypeScript cannot narrow through a generic.
   */
  const withLedger = async <T>(
    mutate: (current: R97LedgerFile, currentView: R97LedgerView) => { next: R97LedgerFile | null; result: T },
  ): Promise<T> => {
    const { lockPath, token } = await acquireLock(dir, lockTimeoutMs, isAlive, now);
    try {
      const current = await read();
      const currentView = viewOfR97Ledger(current);
      const { next, result } = mutate(current, currentView);
      if (next !== null) await writeLedgerAtomic(dir, next);
      return result;
    } finally {
      await releaseLock(lockPath, token);
    }
  };

  // ---- Bootstrap and validate the grant UNDER THE LOCK ---------------------
  //
  // This MUST be a locked read-modify-write. Doing it unlocked is a genuine
  // lost-update race: two processes opening the same campaign simultaneously
  // both observe "no ledger", and the second one's write of an EMPTY ledger
  // erases the first one's reservation. MEASURED before the fix: the
  // two-process contention test passed alone and failed roughly one run in six
  // when the suite ran in sequence, because both racers saw a missing file and
  // both were then granted the last call.
  //
  // The `null`-vs-present distinction comes from `readR97LedgerFile` directly,
  // NOT from `read()`: `read()` substitutes an empty ledger for a missing file,
  // so a missing file and a legitimately-empty one are indistinguishable there.
  {
    const { lockPath, token } = await acquireLock(dir, lockTimeoutMs, isAlive, now);
    try {
      const present = await readR97LedgerFile(dir);
      if (present !== null) {
        // A ledger bound to a different plan or a different grant is refused: the
        // budget belongs to one authorization, and silently adopting another's
        // consumption would either over-grant or under-grant.
        if (present.planDigest !== opts.planDigest) {
          throw new Error(
            `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger in ${dir} belongs to a different plan (${present.planDigest}) than this authorization (${opts.planDigest}) — refusing to share a budget across authorizations`,
          );
        }
        if (present.campaignModelCalls !== opts.campaignModelCalls) {
          throw new Error(
            `E4-R97: ${R97_BUDGET_STATE_MISMATCH}: the budget ledger grants ${present.campaignModelCalls} calls but this authorization declares ${opts.campaignModelCalls} — a process must never re-grant itself a different allowance`,
          );
        }
      } else {
        // Persist the grant on FIRST open, so a later process always has a file to
        // compare against and cannot re-grant itself a different allowance.
        await writeLedgerAtomic(dir, emptyLedger(opts.planDigest, opts.campaignModelCalls));
      }
    } finally {
      await releaseLock(lockPath, token);
    }
  }

  return {
    dir,
    planDigest: opts.planDigest,
    read,
    view,

    async reserve(arm: string, count: number): Promise<R97ReserveResult> {
      if (!Number.isSafeInteger(count) || count <= 0) {
        return {
          ok: false,
          reservationId: null,
          reason: `reservation count must be a positive safe integer (got ${String(count)})`,
          view: await view(),
        };
      }
      return withLedger<R97ReserveResult>((ledger, currentView) => {
        if (count > currentView.remaining) {
          return {
            next: null,
            result: {
              ok: false,
              reservationId: null,
              reason: `${R97_BUDGET_EXHAUSTED}: ${count} logical call(s) requested but only ${currentView.remaining} of ${currentView.granted} remain (committed ${currentView.committed}, outstanding ${currentView.outstanding}, unknown ${currentView.unknown})`,
              view: currentView,
            },
          };
        }
        const reservationId = `r-${now()}-${process.pid}-${ledger.entries.length}`;
        const entry: R97LedgerEntry = {
          reservationId,
          arm,
          pid: process.pid,
          reservedAt: now(),
          reserved: count,
          status: "reserved",
          consumed: null,
          transportRetries: 0,
        };
        const next: R97LedgerFile = { ...ledger, entries: [...ledger.entries, entry] };
        return {
          next,
          result: { ok: true, reservationId, reason: "", view: viewOfR97Ledger(next) },
        };
      });
    },

    async commit(reservationId: string, consumed: number, transportRetries = 0): Promise<R97LedgerView> {
      if (!Number.isSafeInteger(consumed) || consumed < 0) {
        throw new Error(`E4-R97: a commit must report a non-negative safe integer of consumed calls (got ${String(consumed)})`);
      }
      // transportRetries counts PHYSICAL attempts. A negative or fractional
      // count is not a measurement, and letting it through would corrupt the
      // separately-reported retry total.
      if (!Number.isSafeInteger(transportRetries) || transportRetries < 0) {
        throw new Error(
          `E4-R97: a commit must report a non-negative safe integer of transport retries (got ${String(transportRetries)})`,
        );
      }
      return withLedger((ledger) => {
        const i = ledger.entries.findIndex((e) => e.reservationId === reservationId);
        if (i < 0) throw new Error(`E4-R97: no reservation ${reservationId} to commit`);
        const entry = ledger.entries[i]!;
        if (entry.status !== "reserved") {
          throw new Error(`E4-R97: reservation ${reservationId} is already ${entry.status} — a terminal reservation cannot be committed twice`);
        }
        // Consuming MORE than reserved is refused: the caller must reserve the
        // full amount up front, because a post-hoc overrun cannot be undone.
        if (consumed > entry.reserved) {
          throw new Error(
            `E4-R97: reservation ${reservationId} reserved ${entry.reserved} call(s) but reports ${consumed} consumed — the budget must be reserved BEFORE the call, so an overrun is a caller defect`,
          );
        }
        const entries = [...ledger.entries];
        entries[i] = { ...entry, status: "committed", consumed, transportRetries };
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: viewOfR97Ledger(next) };
      });
    },

    async abandon(reservationId: string): Promise<R97LedgerView> {
      return withLedger((ledger) => {
        const i = ledger.entries.findIndex((e) => e.reservationId === reservationId);
        if (i < 0) throw new Error(`E4-R97: no reservation ${reservationId} to abandon`);
        const entry = ledger.entries[i]!;
        if (entry.status !== "reserved") {
          throw new Error(`E4-R97: reservation ${reservationId} is already ${entry.status} — only an outstanding reservation can be abandoned`);
        }
        const entries = [...ledger.entries];
        entries[i] = { ...entry, status: "abandoned", consumed: 0 };
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: viewOfR97Ledger(next) };
      });
    },

    async recover(): Promise<{ unknown: number; view: R97LedgerView }> {
      return withLedger((ledger) => {
        let unknown = 0;
        const entries = ledger.entries.map((e) => {
          if (e.status !== "reserved") return e;
          if (isAlive(e.pid)) return e; // still in flight in another live process
          unknown += 1;
          // The allowance is NOT returned: a dispatched attempt may have been
          // billed, and only a human decision may resolve it.
          return { ...e, status: "unknown" as const, consumed: null };
        });
        const next: R97LedgerFile = { ...ledger, entries };
        return { next, result: { unknown, view: viewOfR97Ledger(next) } };
      });
    },
  };
}
