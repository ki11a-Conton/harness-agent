/**
 * E4-R98 — durable case×arm×repetition execution state.
 *
 * Plan §R98 做什么 item 4: "为 case×arm×repetition 增加持久化执行记录，并与
 * model-call reservation 建立关联."
 *
 * The budget ledger answers "how many calls may still be made". It deliberately
 * does NOT answer "which case units are already finished", and the measured
 * defect (plan §0.1 F2) was exactly that gap: a second run of the same plan
 * committed another 16 calls because nothing recorded that the 16 units were
 * done.
 *
 * This module is that record. It is a small, explicit state machine per unit:
 *
 *     pending ──begin──> running ──complete──> completed
 *                           │      └─fail────> failed
 *                           └─(crash / dead owner)─> outcome_unknown
 *
 * Contract points that matter for correctness:
 *
 *   - `begin` is persisted BEFORE the caller is allowed to dispatch a request,
 *     so a crash between "request sent" and "result stored" leaves a durable
 *     `running` record rather than no trace at all.
 *   - `completed`/`failed` are TERMINAL and carry the result hash. A resume
 *     skips them.
 *   - `running` whose owner is gone becomes `outcome_unknown`: it is neither
 *     skipped as success nor automatically re-run (plan §R98: "UNKNOWN 停止自动
 *     重发并保留占用额度，提供明确的单独 reconciliation 操作").
 *   - A terminal unit whose INPUT DIGEST changed is drift, not a cache hit: the
 *     store refuses to begin it again (plan §R98: "已完成结果 hash 或身份错则
 *     停止，不直接重跑").
 *
 * The store is a single JSON file written atomically (temp + rename), like the
 * budget ledger, because a partially written state file must never be readable
 * as a valid state.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const R97_EXEC_SCHEMA = "e4-r97-execution-state-v1";
export const R97_EXEC_FILENAME = "execution-state.json";

export const R97_EXEC_STATE_MISMATCH = "EXEC_STATE_MISMATCH";
export const R97_EXEC_STATE_CORRUPT = "EXEC_STATE_CORRUPT";
export const R97_EXEC_INPUT_DRIFT = "EXEC_INPUT_DRIFT";

/** Terminal states are `completed` and `failed`. `outcome_unknown` is a
 *  quarantine state: not terminal for skipping, and never auto-retried. */
export type R97UnitStatus = "pending" | "running" | "completed" | "failed" | "outcome_unknown";

/** The identity of one unit of work in the campaign matrix. */
export interface R97UnitKey {
  experimentId: string;
  caseId: string;
  suite: string;
  arm: string;
  repetition: number;
}

export interface R97UnitRecord extends R97UnitKey {
  schemaVersion: string;
  /** Bound to the authorization this work belongs to. */
  planDigest: string;
  status: R97UnitStatus;
  /** Stable id for THIS attempt, so a late writer cannot overwrite a newer one. */
  attemptId: string;
  /** Digest of the inputs actually used (case content + build identity). */
  inputDigest: string;
  /** The budget reservation that paid for this unit. */
  reservationId: string;
  /** Set for terminal states: the digest of the stored result. */
  resultHash: string | null;
  startedAt: number;
  endedAt: number | null;
  detail: string | null;
}

export interface R97ExecutionStateFile {
  schemaVersion: string;
  experimentId: string;
  planDigest: string;
  records: R97UnitRecord[];
}

export interface R97ExecutionState {
  readonly dir: string;
  /** Stable string identity for a unit, used as the map key. */
  isDone(key: R97UnitKey): Promise<boolean>;
  statusOf(key: R97UnitKey): Promise<R97UnitStatus | null>;
  recordFor(key: R97UnitKey): Promise<R97UnitRecord | null>;
  /** A unit that must NOT be automatically retried (crashed mid-flight). */
  mustNotRetry(key: R97UnitKey): Promise<boolean>;
  /** Persist `running` BEFORE the request is dispatched. Returns the attemptId. */
  begin(key: R97UnitKey, opts: { reservationId: string; inputDigest: string; now?: number }): Promise<string>;
  complete(attemptId: string, opts: { resultHash: string; detail?: string; now?: number }): Promise<void>;
  fail(attemptId: string, opts: { resultHash: string; detail?: string; now?: number }): Promise<void>;
  /** Reclassify every in-flight unit as `outcome_unknown` (a crashed process
   *  cannot still be running once a NEW process holds the store). */
  recoverInFlight(): Promise<{ unknown: number }>;
  records(): Promise<R97UnitRecord[]>;
}

/** Canonical key string. Exported so callers and tests agree on identity. */
export function unitKeyOf(key: R97UnitKey): string {
  return `${key.experimentId}|${key.caseId}|${key.suite}|${key.arm}|${key.repetition}`;
}

function emptyState(experimentId: string, planDigest: string): R97ExecutionStateFile {
  return { schemaVersion: R97_EXEC_SCHEMA, experimentId, planDigest, records: [] };
}

/** Parse a state file. Fails CLOSED: damaging the file must never look like
 *  "nothing has been executed yet", which would re-run (and re-bill) the whole
 *  campaign. */
export function parseR97ExecutionState(raw: unknown): { state: R97ExecutionStateFile | null; issue: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { state: null, issue: "execution state is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== R97_EXEC_SCHEMA) {
    return { state: null, issue: `execution state schemaVersion must be ${R97_EXEC_SCHEMA}` };
  }
  if (typeof o["experimentId"] !== "string" || o["experimentId"] === "") {
    return { state: null, issue: "execution state experimentId must be a non-empty string" };
  }
  if (typeof o["planDigest"] !== "string" || o["planDigest"] === "") {
    return { state: null, issue: "execution state planDigest must be a non-empty string" };
  }
  if (!Array.isArray(o["records"])) return { state: null, issue: "execution state records must be an array" };

  const records: R97UnitRecord[] = [];
  const seen = new Set<string>();
  const validStatus = ["pending", "running", "completed", "failed", "outcome_unknown"];
  for (const [i, r] of (o["records"] as unknown[]).entries()) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      return { state: null, issue: `execution state records[${i}] is not an object` };
    }
    const e = r as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === "string" && v !== "";
    for (const field of ["experimentId", "caseId", "suite", "arm", "attemptId", "inputDigest", "reservationId"] as const) {
      if (!str(e[field])) return { state: null, issue: `execution state records[${i}].${field} must be a non-empty string` };
    }
    if (typeof e["repetition"] !== "number" || !Number.isSafeInteger(e["repetition"]) || e["repetition"] < 1) {
      return { state: null, issue: `execution state records[${i}].repetition must be a positive safe integer` };
    }
    if (!validStatus.includes(String(e["status"]))) {
      return { state: null, issue: `execution state records[${i}].status is not a known status` };
    }
    const status = String(e["status"]) as R97UnitStatus;
    const resultHash = e["resultHash"];
    if (resultHash !== null && !str(resultHash)) {
      return { state: null, issue: `execution state records[${i}].resultHash must be null or a non-empty string` };
    }
    // A terminal record MUST carry a result hash: without it the record cannot
    // substantiate that a result exists, so it cannot justify a resume skip.
    if ((status === "completed" || status === "failed") && !str(resultHash)) {
      return { state: null, issue: `execution state records[${i}] is ${status} without a resultHash` };
    }
    const key = unitKeyOf({
      experimentId: e["experimentId"] as string,
      caseId: e["caseId"] as string,
      suite: e["suite"] as string,
      arm: e["arm"] as string,
      repetition: e["repetition"] as number,
    });
    if (seen.has(key)) return { state: null, issue: `execution state records[${i}] duplicates unit ${key}` };
    seen.add(key);

    records.push({
      schemaVersion: R97_EXEC_SCHEMA,
      experimentId: e["experimentId"] as string,
      caseId: e["caseId"] as string,
      suite: e["suite"] as string,
      arm: e["arm"] as string,
      repetition: e["repetition"] as number,
      planDigest: typeof e["planDigest"] === "string" ? e["planDigest"] : o["planDigest"],
      status,
      attemptId: e["attemptId"] as string,
      inputDigest: e["inputDigest"] as string,
      reservationId: e["reservationId"] as string,
      resultHash: str(resultHash) ? resultHash : null,
      startedAt: typeof e["startedAt"] === "number" ? e["startedAt"] : 0,
      endedAt: typeof e["endedAt"] === "number" ? e["endedAt"] : null,
      detail: typeof e["detail"] === "string" ? e["detail"] : null,
    });
  }
  return { state: { schemaVersion: R97_EXEC_SCHEMA, experimentId: o["experimentId"], planDigest: o["planDigest"], records }, issue: null };
}

/** Read the state file without creating one. `null` = the file does not exist. */
export async function readR97ExecutionStateFile(dir: string): Promise<R97ExecutionStateFile | null> {
  let text: string;
  try {
    text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`E4-R97: ${R97_EXEC_STATE_CORRUPT}: the execution state is not valid JSON`);
  }
  const { state, issue } = parseR97ExecutionState(raw);
  if (state === null) throw new Error(`E4-R97: ${R97_EXEC_STATE_CORRUPT}: ${String(issue)}`);
  return state;
}

async function writeStateAtomic(dir: string, state: R97ExecutionStateFile): Promise<void> {
  const tmp = join(dir, `${R97_EXEC_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, join(dir, R97_EXEC_FILENAME));
}

/**
 * Open (and on first use create) the execution state for one experiment.
 *
 * The store is bound to BOTH the experiment id and the plan digest, and both are
 * re-validated on every read: a store swapped for another campaign's must not be
 * adopted, or a resume would silently "skip" units this authorization never ran.
 */
export async function openR97ExecutionState(
  dir: string,
  opts: { experimentId: string; planDigest: string; now?: () => number },
): Promise<R97ExecutionState> {
  await mkdir(dir, { recursive: true });
  const now = opts.now ?? (() => Date.now());

  const read = async (): Promise<R97ExecutionStateFile> => {
    const present = await readR97ExecutionStateFile(dir);
    if (present === null) return emptyState(opts.experimentId, opts.planDigest);
    if (present.experimentId !== opts.experimentId) {
      throw new Error(
        `E4-R97: ${R97_EXEC_STATE_MISMATCH}: the execution state in ${dir} belongs to a different experiment (${present.experimentId}) than this run (${opts.experimentId})`,
      );
    }
    if (present.planDigest !== opts.planDigest) {
      throw new Error(
        `E4-R97: ${R97_EXEC_STATE_MISMATCH}: the execution state in ${dir} belongs to a different plan (${present.planDigest}) than this authorization (${opts.planDigest})`,
      );
    }
    return present;
  };

  // Persist the identity on first open, so a later process always has something
  // to compare against. An EXISTING store is validated here as well as on every
  // read: opening a store that belongs to another experiment/plan must fail
  // immediately, not at the first isDone() call.
  {
    const present = await readR97ExecutionStateFile(dir);
    if (present === null) {
      await writeStateAtomic(dir, emptyState(opts.experimentId, opts.planDigest));
    } else {
      if (present.experimentId !== opts.experimentId) {
        throw new Error(
          `E4-R97: ${R97_EXEC_STATE_MISMATCH}: the execution state in ${dir} belongs to a different experiment (${present.experimentId}) than this run (${opts.experimentId})`,
        );
      }
      if (present.planDigest !== opts.planDigest) {
        throw new Error(
          `E4-R97: ${R97_EXEC_STATE_MISMATCH}: the execution state in ${dir} belongs to a different plan (${present.planDigest}) than this authorization (${opts.planDigest})`,
        );
      }
    }
  }

  const findRecord = async (key: R97UnitKey): Promise<R97UnitRecord | null> => {
    const state = await read();
    const wanted = unitKeyOf(key);
    return state.records.find((r) => unitKeyOf(r) === wanted) ?? null;
  };

  const writeRecord = async (record: R97UnitRecord): Promise<void> => {
    const state = await read();
    const wanted = unitKeyOf(record);
    const records = state.records.map((r) => (unitKeyOf(r) === wanted ? record : r));
    if (!state.records.some((r) => unitKeyOf(r) === wanted)) records.push(record);
    await writeStateAtomic(dir, { ...state, records });
  };

  const byAttempt = async (attemptId: string): Promise<R97UnitRecord> => {
    const state = await read();
    const record = state.records.find((r) => r.attemptId === attemptId);
    if (record === undefined) throw new Error(`E4-R97: no execution unit for attempt ${attemptId}`);
    return record;
  };

  return {
    dir,

    async isDone(key) {
      const r = await findRecord(key);
      return r !== null && (r.status === "completed" || r.status === "failed");
    },
    async statusOf(key) {
      return (await findRecord(key))?.status ?? null;
    },
    recordFor: findRecord,
    async mustNotRetry(key) {
      return (await findRecord(key))?.status === "outcome_unknown";
    },

    async begin(key, opts2) {
      const existing = await findRecord(key);
      if (existing !== null) {
        if (existing.status === "completed" || existing.status === "failed") {
          // A finished unit is only skipped when its INPUTS are identical. A
          // changed input digest is drift, and re-running it under the old
          // result would attribute the old result to new inputs.
          if (existing.inputDigest !== opts2.inputDigest) {
            throw new Error(
              `E4-R97: ${R97_EXEC_INPUT_DRIFT}: unit ${unitKeyOf(key)} already finished with input digest ${existing.inputDigest} but is being started with ${opts2.inputDigest}`,
            );
          }
          throw new Error(
            `E4-R97: unit ${unitKeyOf(key)} is already ${existing.status} — a terminal unit is skipped, not restarted`,
          );
        }
        if (existing.status === "outcome_unknown") {
          // Explicit reconciliation only: never silently re-dispatched.
          throw new Error(
            `E4-R97: unit ${unitKeyOf(key)} is outcome_unknown — it requires an explicit reconciliation decision before it may run again`,
          );
        }
      }
      const attemptId = `a-${now()}-${process.pid}-${Math.abs(hashString(unitKeyOf(key)))}`;
      const record: R97UnitRecord = {
        schemaVersion: R97_EXEC_SCHEMA,
        ...key,
        planDigest: opts.planDigest,
        status: "running",
        attemptId,
        inputDigest: opts2.inputDigest,
        reservationId: opts2.reservationId,
        resultHash: null,
        startedAt: opts2.now ?? now(),
        endedAt: null,
        detail: null,
      };
      await writeRecord(record);
      return attemptId;
    },

    async complete(attemptId, opts2) {
      const record = await byAttempt(attemptId);
      if (record.status !== "running") {
        throw new Error(`E4-R97: attempt ${attemptId} is ${record.status} — only a running unit can be completed`);
      }
      if (opts2.resultHash === "") throw new Error("E4-R97: a completed unit requires a non-empty result hash");
      await writeRecord({
        ...record,
        status: "completed",
        resultHash: opts2.resultHash,
        detail: opts2.detail ?? null,
        endedAt: opts2.now ?? now(),
      });
    },

    async fail(attemptId, opts2) {
      const record = await byAttempt(attemptId);
      if (record.status !== "running") {
        throw new Error(`E4-R97: attempt ${attemptId} is ${record.status} — only a running unit can be failed`);
      }
      if (opts2.resultHash === "") throw new Error("E4-R97: a failed unit requires a non-empty result hash");
      await writeRecord({
        ...record,
        status: "failed",
        resultHash: opts2.resultHash,
        detail: opts2.detail ?? null,
        endedAt: opts2.now ?? now(),
      });
    },

    async recoverInFlight() {
      const state = await read();
      let unknown = 0;
      const records = state.records.map((r) => {
        if (r.status !== "running") return r;
        unknown += 1;
        // The allowance stays consumed and the unit is quarantined: a dispatched
        // attempt may have been billed, and only an operator decision resolves it.
        return { ...r, status: "outcome_unknown" as const, endedAt: r.endedAt ?? now() };
      });
      if (unknown > 0) await writeStateAtomic(dir, { ...state, records });
      return { unknown };
    },

    async records() {
      return (await read()).records;
    },
  };
}

/** Small deterministic string hash, used only to make attempt ids readable.
 *  Not a security primitive. */
function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}
