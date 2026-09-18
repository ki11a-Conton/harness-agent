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
import { join } from "node:path";

export const R97_LEDGER_SCHEMA = "e4-r97-budget-ledger-v1";

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
/** A lock older than this is STALE — its owner crashed mid-write. Generous
 *  relative to the microsecond-scale critical section. */
const LOCK_STALE_MS = 30_000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Derive the view from the raw file. Pure, so it can be asserted directly. */
export function viewOfR97Ledger(file: R97LedgerFile): R97LedgerView {
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
  const remaining = Math.max(0, file.campaignModelCalls - committed - outstanding - unknown);
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
  const entries: R97LedgerEntry[] = [];
  for (const [i, e] of (o["entries"] as unknown[]).entries()) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { ledger: null, issue: `ledger entries[${i}] is not an object` };
    }
    const r = e as Record<string, unknown>;
    if (typeof r["reservationId"] !== "string" || r["reservationId"] === "") {
      return { ledger: null, issue: `ledger entries[${i}].reservationId must be a non-empty string` };
    }
    if (typeof r["reserved"] !== "number" || !Number.isSafeInteger(r["reserved"]) || r["reserved"] < 0) {
      return { ledger: null, issue: `ledger entries[${i}].reserved must be a non-negative safe integer` };
    }
    if (!["reserved", "committed", "abandoned", "unknown"].includes(String(r["status"]))) {
      return { ledger: null, issue: `ledger entries[${i}].status is not a known status` };
    }
    entries.push({
      reservationId: r["reservationId"],
      arm: typeof r["arm"] === "string" ? r["arm"] : "",
      pid: typeof r["pid"] === "number" ? r["pid"] : -1,
      reservedAt: typeof r["reservedAt"] === "number" ? r["reservedAt"] : 0,
      reserved: r["reserved"],
      status: r["status"] as R97ReservationStatus,
      consumed: typeof r["consumed"] === "number" ? r["consumed"] : null,
      transportRetries: typeof r["transportRetries"] === "number" ? r["transportRetries"] : 0,
    });
  }
  return {
    ledger: { schemaVersion: R97_LEDGER_SCHEMA, planDigest: o["planDigest"], campaignModelCalls: grant, entries },
    issue: null,
  };
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

async function acquireLock(dir: string, timeoutMs: number): Promise<string> {
  const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(String(process.pid), "utf8");
      await fh.close();
      return lockPath;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      // A lock whose owner died is STALE. Reclaim it rather than deadlocking —
      // this is precisely the crash the ledger exists to survive.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // the holder released it; retry immediately
      }
      if (Date.now() >= deadline) {
        throw new Error(`E4-R97: could not acquire the budget ledger lock within ${timeoutMs}ms (${lockPath})`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * Open the campaign budget ledger, creating it on first use.
 *
 * A ledger already present but bound to a DIFFERENT plan digest is refused: the
 * budget belongs to one authorization, and silently adopting another plan's
 * consumption would either over-grant or under-grant.
 */
export async function openR97BudgetLedger(dir: string, opts: R97LedgerOpenOptions): Promise<R97BudgetLedger> {
  await mkdir(dir, { recursive: true });
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const isAlive = opts.isAlive ?? defaultIsAlive;

  /** Read the ledger, or a fresh empty one bound to THIS grant. */
  const read = async (): Promise<R97LedgerFile> =>
    (await readR97LedgerFile(dir)) ?? emptyLedger(opts.planDigest, opts.campaignModelCalls);
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
    const lockPath = await acquireLock(dir, lockTimeoutMs);
    try {
      const current = await read();
      const currentView = viewOfR97Ledger(current);
      const { next, result } = mutate(current, currentView);
      if (next !== null) await writeLedgerAtomic(dir, next);
      return result;
    } finally {
      await rm(lockPath, { force: true });
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
  const lockPath = await acquireLock(dir, lockTimeoutMs);
  try {
    const present = await readR97LedgerFile(dir);
    if (present !== null) {
      // A ledger bound to a different plan or a different grant is refused: the
      // budget belongs to one authorization, and silently adopting another's
      // consumption would either over-grant or under-grant.
      if (present.planDigest !== opts.planDigest) {
        throw new Error(
          `E4-R97: the budget ledger in ${dir} belongs to a different plan (${present.planDigest}) than this authorization (${opts.planDigest}) — refusing to share a budget across authorizations`,
        );
      }
      if (present.campaignModelCalls !== opts.campaignModelCalls) {
        throw new Error(
          `E4-R97: the budget ledger grants ${present.campaignModelCalls} calls but this authorization declares ${opts.campaignModelCalls} — a process must never re-grant itself a different allowance`,
        );
      }
    } else {
      // Persist the grant on FIRST open, so a later process always has a file to
      // compare against and cannot re-grant itself a different allowance.
      await writeLedgerAtomic(dir, emptyLedger(opts.planDigest, opts.campaignModelCalls));
    }
  } finally {
    await rm(lockPath, { force: true });
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
