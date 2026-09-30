/**
 * N3 (plan(20260930-061557).md §6) — the DURABLE TOOL-DISPATCH JOURNAL.
 *
 * WHY THIS EXISTS (defect F30-4)
 * ------------------------------
 * `scripts/e4/readiness-evidence-verify.mjs::bindRequestDispatchJournals` could
 * cross-bind the request/attempt journal against a tool-dispatch journal, but NO
 * PRODUCER in this repository ever wrote one: `r5-real-formal.mjs` only COPIES any
 * `dispatch*.json` it happens to find, so `budgetEvidenceReady` stayed NOT_PROVEN
 * with `DISPATCH_JOURNAL_MISSING` and — worse — the checker's own gaps were
 * unreachable: duplicate ids, a wrong arm, `outcome='banana'` and an empty
 * `reservations: []` were all accepted as MEASURED.
 *
 * This module is the PRODUCER half. It records, at the REAL dispatch point, the
 * facts the budget already acts on:
 *
 *   reserve_granted  — a durable `{ toolCalls: 1 }` reservation was taken. Written
 *                      BEFORE `reserve()` returns, so a crash after the tool body
 *                      started can never lose the acceptance fact.
 *   reserve_refused  — the cap or the campaign deadline refused the dispatch
 *                      BEFORE the tool body ran. Carries the stable reason.
 *   settled          — the ONE terminal outcome the orchestrator reported:
 *                      `dispatched` (body ran), `not_executed` (body never
 *                      started → released), `unknown` (effects unobserved →
 *                      charged at its upper bound and NEVER refunded).
 *
 * HONESTY RULES IT ENFORCES BY CONSTRUCTION
 * -----------------------------------------
 *   - The journal is APPEND-ONLY. `seq` starts at 1 and is contiguous, so a
 *     deleted/truncated/duplicated event is detectable by the reader.
 *   - It is written with the SAME durable protocol as the cost ledger: the same
 *     `withR97CampaignLock` critical section and an fsync-then-rename atomic
 *     replace, so a crash can never expose a half-written file and a second
 *     writer can never interleave.
 *   - A reservation whose settlement was never recorded stays a
 *     `reserve_granted` with no `settled` event. That is NOT "released": the
 *     reader must treat it as UNKNOWN with its upper bound retained.
 *   - The MODEL quota id and the TOOL dispatch id are DIFFERENT IDENTIFIERS in
 *     different namespaces. This journal never compares them for equality; a
 *     tool dispatch is linked to a model request through the parent
 *     request/attempt it names, which the verifier resolves against the
 *     request/attempt journal.
 *
 * OFFLINE: local file I/O only. Zero provider, zero network, zero cost.
 */

import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "./manifest.js";
import { withR97CampaignLock } from "./r97-budget-ledger.js";

/** The versioned schema tag of the tool-dispatch journal file. */
export const N3_DISPATCH_JOURNAL_SCHEMA = "e4-n3-tool-dispatch-journal-v1";

/**
 * The journal's file name. It deliberately matches the name
 * `readiness-evidence-verify.mjs::DISPATCH_JOURNAL_FILENAMES` looks for FIRST and
 * the `dispatch*.json` glob `r5-real-formal.mjs` already copies into a bundle —
 * so the transport into the evidence bundle needs no new mechanism.
 */
export const N3_DISPATCH_JOURNAL_FILENAME = "dispatch-journal.json";

/** The ONLY legal settlement outcomes (one REAL dispatch settles exactly once). */
export const DISPATCH_SETTLEMENTS = ["dispatched", "not_executed", "unknown"] as const;
export type DispatchSettlement = (typeof DISPATCH_SETTLEMENTS)[number];

/** The only legal reserve-refusal reasons the durable tool budget can produce. */
export const DISPATCH_REFUSAL_REASONS = ["TOOL_BUDGET_EXHAUSTED", "CAMPAIGN_DEADLINE_EXCEEDED"] as const;
export type DispatchRefusalReason = (typeof DISPATCH_REFUSAL_REASONS)[number];

/** The three event kinds. Each kind carries exactly the fields it can prove. */
export const DISPATCH_EVENT_TYPES = ["reserve_granted", "reserve_refused", "settled"] as const;
export type DispatchEventType = (typeof DISPATCH_EVENT_TYPES)[number];

/** The arm-run scope every event of one arm run shares (`CostJournalScope`'s arm half). */
export interface ToolDispatchArmRunScope {
  armRunId: string;
  arm: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  /**
   * The schedule's order index, when the executing driver knows it. `null` means
   * "this producer could not prove it" — never a substituted 0.
   */
  orderIndex: number | null;
  campaignDigest: string | null;
}

/** ONE append-only journal event, as stored. */
export interface ToolDispatchJournalEvent {
  /** 1-based, contiguous, unique across the whole file. */
  seq: number;
  type: DispatchEventType;
  atMs: number;
  armRunId: string;
  arm: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  orderIndex: number | null;
  campaignDigest: string | null;
  /**
   * The TOOL-side reservation id the ARG RUN's worker sees on the wire
   * (`<armRunId>:tool:<n>`). It is NOT a model quota id.
   */
  toolReservationId: string | null;
  /**
   * The DURABLE cost-budget reservation that holds the `{ toolCalls: 1 }` bound
   * for this dispatch. A THIRD identifier, distinct from both the tool
   * reservation id and any model reservation id.
   */
  dispatchId: string | null;
  /** The model's own tool-call id from the response that asked for the dispatch. */
  toolCallId: string | null;
  tool: string | null;
  sessionId: string | null;
  turnId: string | null;
  readOnly: boolean | null;
  sideEffectScope: string | null;
  /** The model request that produced this tool call, or `null` when unprovable. */
  parentRequestId: string | null;
  /** The parent attempt; `null` when the producer cannot prove which one. */
  parentAttemptId: number | null;
  refusalReason: DispatchRefusalReason | null;
  settlement: DispatchSettlement | null;
}

/** Per-arm-run COVERAGE: proof that the producing execution really observed it. */
export interface ToolDispatchArmRunCoverage {
  armRunId: string;
  arm: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  orderIndex: number | null;
  openedAtMs: number;
  /** Set once the arm run's worker has terminated. `null` = still open. */
  closedAtMs: number | null;
  /** Reserve frames this arm run actually took (granted + refused). */
  reserveFrames: number;
  settleFrames: number;
}

export interface ToolDispatchJournalFile {
  schemaVersion: string;
  campaignDigest: string | null;
  /**
   * The AUTHORITATIVE event count. `events.length` must equal it — a file whose
   * tail was truncated (or a summary padded after the fact) is refused rather
   * than silently completed from this number.
   */
  eventCount: number;
  events: ToolDispatchJournalEvent[];
  coverage: { armRuns: ToolDispatchArmRunCoverage[] };
}

/** The identity fields EVERY event shares, so no event is unattributed. */
export type ToolDispatchEventInput = Omit<ToolDispatchJournalEvent, "seq" | "atMs">;

export interface ToolDispatchJournalOptions {
  /** Root campaign identity, when the producer knows it at open time. */
  campaignDigest?: string | null;
  now?: () => number;
}

/** What one `reserve()` call can prove about its own dispatch. */
export interface ToolDispatchDispatchContext {
  /**
   * The TOOL-side reservation id minted by the executing driver. Absent when the
   * caller has none (the direct-host path) — then the event records `null` and a
   * reader must refuse it rather than invent one.
   */
  toolReservationId?: string | null;
  /** The schedule order index, when the driver knows it. */
  orderIndex?: number | null;
  /** The model request that declared the tool call, or null when unprovable. */
  parentRequestId?: string | null;
  /** The parent attempt, or null when unprovable. */
  parentAttemptId?: number | null;
}

/** Atomically replace `path` with `value` (fsync, then rename over). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const data = `${stableStringify(value)}\n`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch (cleanupError) {
      // A failed cleanup must not mask the rename failure; the original error is
      // rethrown below and the leftover temp file is inert.
      console.warn(`[degraded] dispatch-journal.temp-cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw err;
  }
}

/**
 * The DURABLE, append-only tool-dispatch journal for ONE campaign directory.
 *
 * Every mutation re-reads the file inside the campaign lock and rewrites it
 * atomically, so:
 *   - a second writer (another arm run, another process) cannot interleave;
 *   - a crash exposes either the previous or the next complete file, never a
 *     partial one;
 *   - `seq` is derived from the file that is really on disk, not from an
 *     in-memory counter that a restart would reset.
 */
export class ToolDispatchJournal {
  /** Serializes this handle's own writes; the cross-process lock does the rest. */
  private chain: Promise<unknown> = Promise.resolve();
  private cached: ToolDispatchJournalFile;

  private constructor(
    private readonly dir: string,
    private readonly path: string,
    private readonly clock: () => number,
    file: ToolDispatchJournalFile,
  ) {
    this.cached = file;
  }

  /**
   * Open (or create) the journal in `dir`.
   *
   * A present-but-unreadable journal is a REFUSAL, never a fresh start: treating
   * a corrupt dispatch journal as "no dispatch happened" is exactly the defect
   * this file exists to make impossible.
   */
  static async open(dir: string, opts: ToolDispatchJournalOptions = {}): Promise<ToolDispatchJournal> {
    const clock = opts.now ?? (() => Date.now());
    const path = join(dir, N3_DISPATCH_JOURNAL_FILENAME);
    const empty: ToolDispatchJournalFile = {
      schemaVersion: N3_DISPATCH_JOURNAL_SCHEMA,
      campaignDigest: opts.campaignDigest ?? null,
      eventCount: 0,
      events: [],
      coverage: { armRuns: [] },
    };
    return withR97CampaignLock(dir, async () => {
      let raw: string | null = null;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `tool-dispatch journal could not be read in ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (raw === null) return new ToolDispatchJournal(dir, path, clock, empty);
      let parsed: ToolDispatchJournalFile;
      try {
        parsed = JSON.parse(raw) as ToolDispatchJournalFile;
      } catch {
        throw new Error(
          `tool-dispatch journal in ${dir} is not valid JSON — refusing to treat a corrupt dispatch journal as a campaign that dispatched nothing`,
        );
      }
      if (parsed.schemaVersion !== N3_DISPATCH_JOURNAL_SCHEMA) {
        throw new Error(`tool-dispatch journal schema ${String(parsed.schemaVersion)} is not ${N3_DISPATCH_JOURNAL_SCHEMA}`);
      }
      const events = Array.isArray(parsed.events) ? parsed.events : null;
      if (events === null) {
        throw new Error("tool-dispatch journal carries no events array — refusing to adopt it");
      }
      // The count is a CONTRACT, not a hint: a file whose tail was lost must be
      // refused here rather than silently continued from the surviving prefix.
      if (parsed.eventCount !== events.length) {
        throw new Error(
          `tool-dispatch journal is TRUNCATED: it declares eventCount=${String(parsed.eventCount)} but carries ${events.length} event(s)`,
        );
      }
      if (events.some((e, i) => e?.seq !== i + 1)) {
        throw new Error("tool-dispatch journal events are not a contiguous 1..N sequence — refusing to append to a spliced journal");
      }
      if (opts.campaignDigest !== undefined && opts.campaignDigest !== null && parsed.campaignDigest !== null && parsed.campaignDigest !== opts.campaignDigest) {
        throw new Error(
          `tool-dispatch journal belongs to campaign ${String(parsed.campaignDigest)} but this campaign is ${String(opts.campaignDigest)} — refusing a cross-campaign append`,
        );
      }
      const adopted: ToolDispatchJournalFile = {
        ...parsed,
        campaignDigest: parsed.campaignDigest ?? opts.campaignDigest ?? null,
        coverage: { armRuns: Array.isArray(parsed.coverage?.armRuns) ? parsed.coverage.armRuns : [] },
      };
      return new ToolDispatchJournal(dir, path, clock, adopted);
    });
  }

  /** The journal as last read/written (a copy; callers cannot mutate it). */
  read(): ToolDispatchJournalFile {
    return structuredClone(this.cached);
  }

  /** Serialize local mutations so two awaited writes cannot race on `seq`. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Append ONE event under the campaign lock, deriving `seq` from the bytes on
   * disk. Returns the event as written.
   *
   * The per-arm-run COVERAGE counters are bumped HERE, from the event that was
   * really appended — they are a derived fact, never something a caller asserts.
   * That is what lets the verifier refuse a summary that claims frames the file
   * does not contain (a truncated journal).
   */
  async append(input: ToolDispatchEventInput): Promise<ToolDispatchJournalEvent> {
    return this.queue(async () =>
      withR97CampaignLock(this.dir, async () => {
        const file = await this.reload();
        const event: ToolDispatchJournalEvent = { seq: file.events.length + 1, atMs: this.clock(), ...input };
        file.events.push(event);
        file.eventCount = file.events.length;
        if (file.campaignDigest === null && input.campaignDigest !== null) file.campaignDigest = input.campaignDigest;
        const covered = file.coverage.armRuns.find((a) => a.armRunId === input.armRunId);
        if (covered !== undefined) {
          if (input.type === "reserve_granted" || input.type === "reserve_refused") covered.reserveFrames += 1;
          else covered.settleFrames += 1;
        }
        await writeJsonAtomic(this.path, file);
        this.cached = file;
        return event;
      }),
    );
  }

  /**
   * Record that the producing execution OBSERVED this arm run. This is the
   * coverage proof: a truly zero-tool arm run still carries one of these, so
   * "no tool ran" is a fact the execution exported rather than the absence of a
   * file that a reader might supply by hand.
   */
  async beginArmRun(scope: ToolDispatchArmRunScope): Promise<void> {
    await this.queue(async () =>
      withR97CampaignLock(this.dir, async () => {
        const file = await this.reload();
        const existing = file.coverage.armRuns.find((a) => a.armRunId === scope.armRunId);
        if (existing !== undefined) {
          throw new Error(
            `tool-dispatch journal already covers arm run ${scope.armRunId} — refusing to re-open the SAME arm run (a retry must be a new arm run id, not a second cover story)`,
          );
        }
        file.coverage.armRuns.push({
          armRunId: scope.armRunId,
          arm: scope.arm,
          caseId: scope.caseId,
          repetition: scope.repetition,
          orderIndex: scope.orderIndex,
          openedAtMs: this.clock(),
          closedAtMs: null,
          reserveFrames: 0,
          settleFrames: 0,
        });
        if (file.campaignDigest === null && scope.campaignDigest !== null) file.campaignDigest = scope.campaignDigest;
        await writeJsonAtomic(this.path, file);
        this.cached = file;
      }),
    );
  }

  /** Close an arm run's coverage. Idempotent: a second close is a no-op. */
  async closeArmRun(armRunId: string): Promise<void> {
    await this.queue(async () =>
      withR97CampaignLock(this.dir, async () => {
        const file = await this.reload();
        const entry = file.coverage.armRuns.find((a) => a.armRunId === armRunId);
        if (entry === undefined || entry.closedAtMs !== null) return;
        entry.closedAtMs = this.clock();
        await writeJsonAtomic(this.path, file);
        this.cached = file;
      }),
    );
  }

  /** Re-read the file under the held lock, so `seq` follows the disk. */
  private async reload(): Promise<ToolDispatchJournalFile> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === null) return this.cached;
    const parsed = JSON.parse(raw) as ToolDispatchJournalFile;
    if (parsed.schemaVersion !== N3_DISPATCH_JOURNAL_SCHEMA) {
      throw new Error(`tool-dispatch journal schema ${String(parsed.schemaVersion)} is not ${N3_DISPATCH_JOURNAL_SCHEMA}`);
    }
    if (parsed.eventCount !== (parsed.events ?? []).length) {
      throw new Error("tool-dispatch journal became TRUNCATED between reads — refusing to append to a lossy journal");
    }
    return { ...parsed, coverage: { armRuns: Array.isArray(parsed.coverage?.armRuns) ? parsed.coverage.armRuns : [] } };
  }
}
