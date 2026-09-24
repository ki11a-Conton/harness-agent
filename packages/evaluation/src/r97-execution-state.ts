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
 *                           │                      ▲
 *                           └─(crash / dead owner)─┤
 *                                    │             │
 *                             outcome_unknown ─────┘
 *                              (recoverInFlight)  (operator reconcile)
 *
 * The only edge INTO `failed` from the quarantine is `reconcile`, and it is the
 * only edge out of it: `begin` refuses an `outcome_unknown` unit forever.
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
 *   - `outcome_unknown` is left `running`-adjacent on purpose: it is resolved by
 *     ONE explicit operator act, `reconcile` (plan §R98: "UNKNOWN 停止自动重发并
 *     保留占用额度，提供明确的单独 reconciliation 操作；不承诺跨网络
 *     exactly-once"). Nothing on the automatic path — not `begin`, not
 *     `recoverInFlight` — can move a unit out of the quarantine state.
 *
 * The store is a single JSON file written atomically (temp + rename), like the
 * budget ledger, because a partially written state file must never be readable
 * as a valid state.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isSafeEvidenceRelPath, type R97EvidenceLink } from "./r97-campaign-evidence.js";

export const R97_EXEC_SCHEMA = "e4-r97-execution-state-v1";
export const R97_EXEC_FILENAME = "execution-state.json";

export const R97_EXEC_STATE_MISMATCH = "EXEC_STATE_MISMATCH";
export const R97_EXEC_STATE_CORRUPT = "EXEC_STATE_CORRUPT";
export const R97_EXEC_INPUT_DRIFT = "EXEC_INPUT_DRIFT";
/** A reconciliation was attempted on a unit that is not `outcome_unknown`. */
export const R97_EXEC_NOT_RECONCILABLE = "EXEC_NOT_RECONCILABLE";
/**
 * An ESTABLISHED campaign's execution state is gone.
 *
 * MEASURED DEFECT (plan §0.2 N3, §0.3): "execution-state 的 read 在文件缺失时返回空
 * 状态" — so deleting `execution-state.json` made the next run see "nothing has
 * ever run" and re-execute every unit. The probe measured exactly that:
 * "仅删除 execution-state.json | 同计划再运行新增 2 次，累计 committed 从 2 变 4."
 *
 * A campaign that has run work is ESTABLISHED (its budget ledger exists in the
 * same directory), so a missing state file is a LOSS and fails closed rather
 * than re-granting every unit.
 */
export const R97_EXEC_STATE_MISSING = "EXEC_STATE_MISSING";
/** Another attempt already owns this unit and has not finished. */
export const R97_EXEC_BUSY = "EXEC_BUSY";
/** A terminal write from an attempt that is no longer the unit's live attempt. */
export const R97_EXEC_ATTEMPT_STALE = "EXEC_ATTEMPT_STALE";

/**
 * How an open is allowed to treat durable state.
 *
 *  - `"first-run"` — the caller is STARTING a campaign: it may CREATE the file.
 *  - `"resume"` — the caller is RECOVERING one: the file MUST exist, and a
 *    missing one is `R97_EXEC_STATE_MISSING`.
 *  - `"auto"` (default) — fails closed by INFERRING from the campaign directory.
 *    If the campaign's budget ledger is present, this is an established campaign
 *    and the open behaves exactly like `"resume"` (a missing state file is a
 *    LOSS, never a blank slate). If no ledger is present, nothing has been
 *    established here and the open may create the state.
 *
 * The LEDGER is the inference signal because it is the campaign's own durable
 * marker and lives in the same directory (the driver passes one `ledgerDir` for
 * both). That is what makes "delete the state file" a refusal while a genuine
 * first run — which has no ledger yet — still works.
 */
export type R97ExecOpenMode = "first-run" | "resume" | "auto";

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

/**
 * One ATTEMPT at a unit, kept as an audit record.
 *
 * WHY THIS EXISTS (plan §T2 怎么做 7): "保留旧 attempt 的审计记录。不要用新 attempt
 * 覆盖唯一一条记录后丢掉旧 reservation；可以扩展现有 journal，不要求新增数据库."
 *
 * The previous record was a single mutable row, so a reconciled retry OVERWROTE
 * the crashed attempt — losing which reservation may already have been billed.
 * The unit record now keeps every attempt, and the top-level fields mirror the
 * LATEST one so existing readers keep working.
 */
export interface R97UnitAttempt {
  attemptId: string;
  /** The budget reservation that paid for THIS attempt. */
  reservationId: string;
  /** Digest of the inputs used for this attempt. */
  inputDigest: string;
  status: R97UnitStatus;
  startedAt: number;
  endedAt: number | null;
  resultHash: string | null;
  /** Owning process, so a dead owner's attempt can be found. */
  ownerPid: number;
  /** Owning host, so a foreign owner is never mistaken for a dead one. */
  ownerHost: string;
  detail: string | null;
  /**
   * The evidence THIS attempt produced, when it reached a terminal state.
   *
   * Kept per-attempt (not only on the record) so an OLD attempt's report stays
   * attributable after a reconciliation and a retry. Plan §T3 怎么做 5:
   * "并发 attempt 和 repetition 使用不同路径，避免旧报告冒充新执行产物."
   */
  evidence?: R97EvidenceLink | null;
}

export interface R97UnitRecord extends R97UnitKey {
  schemaVersion: string;
  /** Bound to the authorization this work belongs to. */
  planDigest: string;
  status: R97UnitStatus;
  /** Stable id for the CURRENT attempt, so a late writer cannot overwrite a newer one. */
  attemptId: string;
  /** Digest of the inputs actually used (case content + build identity). */
  inputDigest: string;
  /** The budget reservation that paid for the CURRENT attempt. */
  reservationId: string;
  /** Set for terminal states: the digest of the stored result. */
  resultHash: string | null;
  startedAt: number;
  endedAt: number | null;
  detail: string | null;
  /** Owning process id for the CURRENT attempt. */
  ownerPid: number;
  /** Owning host for the CURRENT attempt. */
  ownerHost: string;
  /** EVERY attempt at this unit, oldest first — the audit trail. */
  attempts: R97UnitAttempt[];
  /**
   * True ONLY on a record produced by `reconcile({action:"retry"})`.
   *
   * This is a dedicated field rather than a `detail` prefix on purpose: the
   * "a terminal unit is skipped, not restarted" rule must stay a simple status
   * check for every OTHER reader, and an operator decision to re-open a
   * possibly-billed attempt deserves to be a typed fact rather than something
   * recovered by string matching. A record without it is never re-begun.
   */
  reconciledForRetry?: boolean;
  /**
   * The EVIDENCE this terminal record's verdict rests on (plan §T3 怎么做 4).
   *
   * A terminal record without it asserts a result nobody can re-derive: the
   * previous worker deleted the arm's only report in `finally`, so a resume
   * could only trust a `status` string (finding N5). `path` is
   * campaign-relative and `sha256` is over the bytes on disk, so deleting or
   * editing either the file or this link is DETECTABLE — which is the whole
   * point of storing it here rather than only inside the evidence file.
   */
  evidence?: R97EvidenceLink | null;
}

export interface R97ExecutionStateFile {
  schemaVersion: string;
  experimentId: string;
  planDigest: string;
  records: R97UnitRecord[];
}

/** One operator decision about an ambiguous (`outcome_unknown`) outcome. */
export interface R97ReconcileDecision {
  /** `retry` re-opens the unit for a NEW attempt; `accept-as-failed` closes it
   *  as a failure. There is deliberately no "mark completed" action: nothing on
   *  this path can invent a result that was never observed. */
  action: "retry" | "accept-as-failed";
  /** Required for `accept-as-failed`; optional evidence for `retry`. */
  resultHash?: string;
  /** Human-readable justification, acknowledged into the record's `detail`. */
  detail?: string;
  now?: number;
}

/** Default `detail` for `action: "retry"`. Exported so the driver, the report
 *  and the tests all quote the SAME sentence instead of re-inventing one. */
export const R97_RECONCILE_RETRY_DETAIL = "reconciled: operator authorised a retry after outcome_unknown";

export interface R97ExecutionState {
  readonly dir: string;
  /** Stable string identity for a unit, used as the map key. */
  isDone(key: R97UnitKey): Promise<boolean>;
  statusOf(key: R97UnitKey): Promise<R97UnitStatus | null>;
  recordFor(key: R97UnitKey): Promise<R97UnitRecord | null>;
  /** A unit that must NOT be automatically retried (crashed mid-flight). */
  mustNotRetry(key: R97UnitKey): Promise<boolean>;
  /** Persist `running` BEFORE the request is dispatched. Returns the attemptId.
   *
   *  REFUSES a second begin while another attempt still owns the unit
   *  (`R97_EXEC_BUSY`), so two processes cannot both dispatch the same unit. */
  begin(key: R97UnitKey, opts: { reservationId: string; inputDigest: string; now?: number }): Promise<string>;
  complete(
    attemptId: string,
    opts: { resultHash: string; detail?: string; now?: number; evidence?: R97EvidenceLink },
  ): Promise<void>;
  fail(
    attemptId: string,
    opts: { resultHash: string; detail?: string; now?: number; evidence?: R97EvidenceLink },
  ): Promise<void>;
  /** Reclassify in-flight units whose owner is provably GONE as `outcome_unknown`.
   *
   *  A LIVE owner is left alone (plan §T2 怎么做 5: "recover 先验证 owner。活 owner 是
   *  BUSY"), and an owner on ANOTHER HOST is conservatively left alone rather
   *  than assumed dead ("跨主机无法判断时保守停止，不能把'不知道'视为死亡"). */
  recoverInFlight(opts?: { isAlive?: (pid: number) => boolean; host?: string }): Promise<{ unknown: number; foreign: number }>;
  /**
   * The EXPLICIT reconciliation act for an `outcome_unknown` unit (plan §R98:
   * "提供明确的单独 reconciliation 操作").
   *
   * It applies to that state and to no other. Retrying or closing an ambiguous
   * outcome is an operator decision about money that may already have been
   * spent, so it must never happen as a side effect of `begin`, of recovery, or
   * of a plain terminal-state write. Returns the reconciled record.
   */
  reconcile(key: R97UnitKey, decision: R97ReconcileDecision): Promise<R97UnitRecord>;
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
  const seenAttempts = new Set<string>();
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
    // Plan §T2 怎么做 8: "parser 严格检查每条记录的 experimentId/planDigest 与 header 一致."
    // A record from another campaign inside this store is either a copy/paste
    // error or a forgery; either way it must not be usable as a skip.
    if (e["experimentId"] !== o["experimentId"]) {
      return {
        state: null,
        issue: `execution state records[${i}].experimentId is ${JSON.stringify(e["experimentId"])} but the store belongs to ${JSON.stringify(o["experimentId"])}`,
      };
    }
    const recordPlan: unknown = e["planDigest"] ?? o["planDigest"];
    if (recordPlan !== o["planDigest"]) {
      return {
        state: null,
        issue: `execution state records[${i}].planDigest is ${JSON.stringify(recordPlan)} but the store belongs to ${JSON.stringify(o["planDigest"])}`,
      };
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
    // Plan §T2 怎么做 8: "不能把缺 startedAt 静默变成 0." A timestamp that is
    // absent or not a number is structural damage, because every ordering and
    // staleness decision in this store reads it.
    if (typeof e["startedAt"] !== "number" || !Number.isFinite(e["startedAt"])) {
      return { state: null, issue: `execution state records[${i}].startedAt must be a finite number` };
    }
    const endedAt = e["endedAt"];
    if (endedAt !== null && endedAt !== undefined && (typeof endedAt !== "number" || !Number.isFinite(endedAt))) {
      return { state: null, issue: `execution state records[${i}].endedAt must be null or a finite number` };
    }
    // A terminal record must be CLOSED: an open interval cannot describe a
    // finished attempt.
    if ((status === "completed" || status === "failed") && (endedAt === null || endedAt === undefined)) {
      return { state: null, issue: `execution state records[${i}] is ${status} without an endedAt` };
    }
    // Owner evidence. It is what makes "is the owner still alive?" answerable,
    // so a record that cannot answer it is refused rather than assumed dead.
    const ownerPid = e["ownerPid"];
    if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid)) {
      return { state: null, issue: `execution state records[${i}].ownerPid must be a safe integer` };
    }
    const ownerHost = e["ownerHost"];
    if (typeof ownerHost !== "string" || ownerHost === "") {
      return { state: null, issue: `execution state records[${i}].ownerHost must be a non-empty string` };
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
    // Attempt ids must be globally unique: `complete`/`fail` address a record BY
    // attempt id, so a duplicate would let one unit's terminal write land on
    // another unit's record.
    const attemptId = e["attemptId"] as string;
    if (seenAttempts.has(attemptId)) {
      return { state: null, issue: `execution state records[${i}].attemptId "${attemptId}" is duplicated across records` };
    }
    seenAttempts.add(attemptId);

    // ---- The attempts journal. --------------------------------------------
    // A record written before the journal existed is ACCEPTED and synthesised
    // from its own current fields, so an upgrade does not invalidate a live
    // campaign's state. Every record this store WRITES carries a real one.
    const rawAttempts = Array.isArray(e["attempts"]) ? e["attempts"] : null;
    let attempts: R97UnitAttempt[];
    if (rawAttempts === null) {
      attempts = [
        {
          attemptId,
          reservationId: e["reservationId"] as string,
          inputDigest: e["inputDigest"] as string,
          status,
          startedAt: e["startedAt"] as number,
          endedAt: typeof endedAt === "number" ? endedAt : null,
          resultHash: str(resultHash) ? resultHash : null,
          ownerPid,
          ownerHost,
          detail: typeof e["detail"] === "string" ? e["detail"] : null,
        },
      ];
    } else {
      attempts = [];
      const seenLocalAttempts = new Set<string>();
      for (const [j, a] of rawAttempts.entries()) {
        if (typeof a !== "object" || a === null || Array.isArray(a)) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}] is not an object` };
        }
        const at = a as Record<string, unknown>;
        for (const field of ["attemptId", "reservationId", "inputDigest"] as const) {
          if (!str(at[field])) {
            return { state: null, issue: `execution state records[${i}].attempts[${j}].${field} must be a non-empty string` };
          }
        }
        const aAttemptId = at["attemptId"] as string;
        if (seenLocalAttempts.has(aAttemptId)) {
          return { state: null, issue: `execution state records[${i}] duplicates attempt ${aAttemptId} in its journal` };
        }
        seenLocalAttempts.add(aAttemptId);
        if (!validStatus.includes(String(at["status"]))) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].status is not a known status` };
        }
        const aStatus = String(at["status"]) as R97UnitStatus;
        if (typeof at["startedAt"] !== "number" || !Number.isFinite(at["startedAt"])) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].startedAt must be a finite number` };
        }
        const aEnded = at["endedAt"];
        if (aEnded !== null && aEnded !== undefined && (typeof aEnded !== "number" || !Number.isFinite(aEnded))) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].endedAt must be null or a finite number` };
        }
        const aHash = at["resultHash"];
        if (aHash !== null && aHash !== undefined && !str(aHash)) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].resultHash must be null or a non-empty string` };
        }
        if ((aStatus === "completed" || aStatus === "failed") && !str(aHash)) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}] is ${aStatus} without a resultHash` };
        }
        if (typeof at["ownerPid"] !== "number" || !Number.isSafeInteger(at["ownerPid"])) {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].ownerPid must be a safe integer` };
        }
        if (typeof at["ownerHost"] !== "string" || at["ownerHost"] === "") {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].ownerHost must be a non-empty string` };
        }
        // The attempt's own evidence link, validated by the same rule as the
        // record-level one — a journal entry is what a later reader uses to
        // attribute an OLD attempt's report, so a malformed link here is damage.
        const aEvidence = at["evidence"];
        let parsedAttemptEvidence: R97EvidenceLink | null | undefined;
        if (aEvidence === undefined || aEvidence === null) {
          parsedAttemptEvidence = aEvidence === null ? null : undefined;
        } else if (typeof aEvidence === "object" && !Array.isArray(aEvidence)) {
          const link = aEvidence as Record<string, unknown>;
          if (!str(link["path"]) || !str(link["sha256"]) || !/^[0-9a-f]{64}$/.test(link["sha256"] as string)) {
            return { state: null, issue: `execution state records[${i}].attempts[${j}].evidence must name a path and a sha256` };
          }
          if (!isSafeEvidenceRelPath(link["path"] as string)) {
            return {
              state: null,
              issue: `execution state records[${i}].attempts[${j}].evidence.path ${JSON.stringify(link["path"])} is not a legal campaign-relative evidence path`,
            };
          }
          parsedAttemptEvidence = { path: link["path"] as string, sha256: link["sha256"] as string };
        } else {
          return { state: null, issue: `execution state records[${i}].attempts[${j}].evidence must be null or an object` };
        }
        attempts.push({
          attemptId: aAttemptId,
          reservationId: at["reservationId"] as string,
          inputDigest: at["inputDigest"] as string,
          status: aStatus,
          startedAt: at["startedAt"] as number,
          endedAt: typeof aEnded === "number" ? aEnded : null,
          resultHash: str(aHash) ? aHash : null,
          ownerPid: at["ownerPid"] as number,
          ownerHost: at["ownerHost"] as string,
          detail: typeof at["detail"] === "string" ? at["detail"] : null,
          ...(parsedAttemptEvidence === undefined ? {} : { evidence: parsedAttemptEvidence }),
        });
      }
      // The CURRENT attempt must be the LAST entry of the journal: the
      // top-level fields identify the live attempt, and a mismatch means the
      // record was assembled by hand.
      //
      // The reservation and input digest MUST agree, because they are the
      // identity of the work the attempt did. The STATUS may legitimately
      // differ: a reconciled unit's top level carries the operator's decision
      // (`failed`) while the attempt itself still records what actually
      // happened (`outcome_unknown` — the crash). Collapsing those two would
      // erase the very distinction reconciliation exists to preserve.
      const last = attempts[attempts.length - 1];
      if (last === undefined || last.attemptId !== attemptId) {
        return {
          state: null,
          issue: `execution state records[${i}] current attemptId ${attemptId} is not the last entry of its attempts journal`,
        };
      }
      if (last.reservationId !== e["reservationId"] || last.inputDigest !== e["inputDigest"]) {
        return {
          state: null,
          issue: `execution state records[${i}] current attempt ${attemptId} disagrees with its own journal entry on reservationId/inputDigest`,
        };
      }
    }
    for (const a of attempts) {
      if (seenAttempts.has(a.attemptId) && a.attemptId !== attemptId) {
        return { state: null, issue: `execution state records[${i}] reuses attempt id ${a.attemptId} from another record` };
      }
    }

    // ---- The evidence link (plan §T3 怎么做 4). ---------------------------
    //
    // The link is validated STRICTLY WHEN PRESENT: a malformed path or a hash
    // that is not a sha256 is structural damage, because the link is what a
    // resume re-checks to detect a deleted or edited report.
    //
    // Its PRESENCE is not required here, and that is deliberate rather than
    // lenient. This store is shared by BOTH execution modes: the "provider"
    // rehearsal path drives a fake provider and produces no arm report, so a
    // terminal record there legitimately has nothing to link. Requiring a link
    // in the store would either break that path or force it to fabricate one.
    // The requirement therefore lives where the mode IS known — the driver's
    // resume, which refuses an unlinked terminal record in arm-worker mode.
    const rawEvidence = e["evidence"];
    let parsedEvidence: R97EvidenceLink | null | undefined;
    if (rawEvidence === undefined || rawEvidence === null) {
      parsedEvidence = rawEvidence === null ? null : undefined;
    } else if (typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
      const link = rawEvidence as Record<string, unknown>;
      if (!str(link["path"])) {
        return { state: null, issue: `execution state records[${i}].evidence.path must be a non-empty string` };
      }
      if (!str(link["sha256"]) || !/^[0-9a-f]{64}$/.test(link["sha256"] as string)) {
        return { state: null, issue: `execution state records[${i}].evidence.sha256 must be a sha256 hex digest` };
      }
      if (!isSafeEvidenceRelPath(link["path"] as string)) {
        return {
          state: null,
          issue: `execution state records[${i}].evidence.path ${JSON.stringify(link["path"])} is not a legal campaign-relative evidence path`,
        };
      }
      parsedEvidence = { path: link["path"] as string, sha256: link["sha256"] as string };
    } else {
      return { state: null, issue: `execution state records[${i}].evidence must be null or an object` };
    }

    records.push({
      schemaVersion: R97_EXEC_SCHEMA,
      experimentId: e["experimentId"] as string,
      caseId: e["caseId"] as string,
      suite: e["suite"] as string,
      arm: e["arm"] as string,
      repetition: e["repetition"] as number,
      planDigest: recordPlan as string,
      status,
      attemptId,
      inputDigest: e["inputDigest"] as string,
      reservationId: e["reservationId"] as string,
      resultHash: str(resultHash) ? resultHash : null,
      startedAt: e["startedAt"] as number,
      endedAt: typeof endedAt === "number" ? endedAt : null,
      detail: typeof e["detail"] === "string" ? e["detail"] : null,
      ownerPid,
      ownerHost,
      attempts,
      // Strictly boolean: any other JSON value (including the string "true") is
      // treated as absent, so only a record THIS store wrote can re-open a
      // terminal unit.
      ...(e["reconciledForRetry"] === true ? { reconciledForRetry: true } : {}),
      ...(parsedEvidence === undefined ? {} : { evidence: parsedEvidence }),
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
  opts: { experimentId: string; planDigest: string; now?: () => number; mode?: R97ExecOpenMode },
): Promise<R97ExecutionState> {
  await mkdir(dir, { recursive: true });
  const now = opts.now ?? (() => Date.now());
  const mode: R97ExecOpenMode = opts.mode ?? "auto";

  /**
   * Whether this directory holds an ESTABLISHED campaign.
   *
   * The signal is the campaign's own budget ledger in the SAME directory (the
   * driver passes one directory for both). A ledger proves work was authorized
   * and possibly done here, so a missing execution state is a LOSS — the
   * measured defect N3 was that a missing file read as an empty state, so
   * deleting it re-ran (and re-billed) every unit.
   *
   * The import is deferred to break the module cycle: the ledger does not know
   * about the execution state, and this is the only direction that needs it.
   */
  const campaignIsEstablished = async (): Promise<boolean> => {
    try {
      const { readR97LedgerFile } = await import("./r97-budget-ledger.js");
      return (await readR97LedgerFile(dir)) !== null;
    } catch {
      // A DAMAGED ledger is still evidence that a campaign was established here.
      return true;
    }
  };

  /**
   * ---- E4-R98-B (T2): EVERY read-modify-write runs UNDER THE CAMPAIGN LOCK ---
   *
   * MEASURED DEFECT, reproduced by the Lead with a real two-process file-barrier
   * probe against the unfixed store:
   *   - two processes calling `begin` on the SAME unit key: BOTH returned OK
   *     (exactly one must win), and the file ended with a single record — the
   *     loser's reservation and owner were overwritten;
   *   - two processes calling `begin` on DIFFERENT unit keys: only ONE record
   *     survived, because the write replaces the whole `records` array from a
   *     snapshot taken before the other process wrote (last-writer-wins).
   *
   * `writeStateAtomic` was never the problem: temp-file-then-rename makes a
   * single WRITE atomic. What was missing is MUTUAL EXCLUSION across the
   * read→mutate→write SEQUENCE, which is precisely what plan §T2 怎么做 3 asks
   * for ("仅靠写临时文件再 rename 不能防两个 writer 互相覆盖").
   *
   * `mutate` therefore receives the state read INSIDE the lock and returns the
   * next state; the write happens before the lock is released. Holding the lock
   * across the whole sequence — rather than locking the read and the write
   * separately — is the point: two separate acquisitions still allow the
   * interleaving that produced the lost update.
   *
   * The lock is the budget ledger's own `withR97CampaignLock`; no second lock
   * implementation is introduced. The import is deferred for the same reason the
   * established-campaign probe defers it (module cycle).
   *
   * LOCK ORDER: the state lock is taken and released without ever calling into
   * the ledger's own locked operations while holding it, so the two locks are
   * never held simultaneously and cannot invert.
   */
  const withLockedState = async <T>(mutate: (current: R97ExecutionStateFile) => Promise<{ next: R97ExecutionStateFile | null; result: T }>): Promise<T> => {
    const { withR97CampaignLock } = await import("./r97-budget-ledger.js");
    return withR97CampaignLock(dir, async () => {
      const current = await read();
      const { next, result } = await mutate(current);
      if (next !== null) await writeStateAtomic(dir, next);
      return result;
    });
  };

  const resolvedMode: "first-run" | "resume" =
    mode === "resume" ? "resume" : mode === "first-run" ? "first-run" : (await campaignIsEstablished()) ? "resume" : "first-run";

  const read = async (): Promise<R97ExecutionStateFile> => {
    const present = await readR97ExecutionStateFile(dir);
    if (present === null) {
      // FAIL CLOSED. A resume — explicit or inferred from an established
      // campaign — must never read a lost state file as "nothing has run".
      if (resolvedMode === "resume") {
        throw new Error(
          `E4-R97: ${R97_EXEC_STATE_MISSING}: this campaign is established in ${dir} but its execution state is gone — refusing to treat a lost record of completed units as "nothing has run"; restore ${R97_EXEC_FILENAME}, or start a new authorization`,
        );
      }
      return emptyState(opts.experimentId, opts.planDigest);
    }
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
  //
  // This is a read-modify-write like every other, so it runs UNDER THE LOCK. The
  // unfixed version read `null` and wrote an empty state unlocked: two processes
  // opening the same fresh campaign could both observe "no file" and both write,
  // which is the same lost-update shape as the ledger's bootstrap race (see
  // `openR97BudgetLedger`'s comment on that).
  {
    const { withR97CampaignLock } = await import("./r97-budget-ledger.js");
    await withR97CampaignLock(dir, async () => {
      const present = await readR97ExecutionStateFile(dir);
      if (present === null) {
        if (resolvedMode === "resume") {
          throw new Error(
            `E4-R97: ${R97_EXEC_STATE_MISSING}: this campaign is established in ${dir} but its execution state is gone — refusing to treat a lost record of completed units as "nothing has run"; restore ${R97_EXEC_FILENAME}, or start a new authorization`,
          );
        }
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
    });
  }

  const findRecord = async (key: R97UnitKey): Promise<R97UnitRecord | null> => {
    const state = await read();
    const wanted = unitKeyOf(key);
    return state.records.find((r) => unitKeyOf(r) === wanted) ?? null;
  };

  /**
   * Apply ONE read-modify-write to the record for `key`, atomically.
   *
   * `mutate` receives the state and the CURRENT record (both read under the lock)
   * and returns the record to store (or `null` to leave the file untouched). The
   * lookup, the decision and the write therefore happen as one critical section,
   * which is what makes `begin`'s "only one owner" check meaningful across
   * processes. The old shape — `findRecord()` outside, `writeRecord()` inside —
   * let two processes both observe "not running" and both write.
   */
  const mutateRecord = async <T>(
    key: R97UnitKey,
    mutate: (current: R97ExecutionStateFile, existing: R97UnitRecord | null) => { next: R97UnitRecord | null; result: T },
  ): Promise<T> =>
    withLockedState(async (current) => {
      const wanted = unitKeyOf(key);
      const existing = current.records.find((r) => unitKeyOf(r) === wanted) ?? null;
      const { next, result } = mutate(current, existing);
      if (next === null) return { next: null, result };
      const records = current.records.map((r) => (unitKeyOf(r) === wanted ? next : r));
      if (!current.records.some((r) => unitKeyOf(r) === wanted)) records.push(next);
      return { next: { ...current, records }, result };
    });

  const writeRecord = async (record: R97UnitRecord): Promise<void> => {
    const state = await read();
    const wanted = unitKeyOf(record);
    const records = state.records.map((r) => (unitKeyOf(r) === wanted ? record : r));
    if (!state.records.some((r) => unitKeyOf(r) === wanted)) records.push(record);
    await writeStateAtomic(dir, { ...state, records });
  };

  /** Replace one record by its unit key, leaving every other record untouched. */
  const replaceRecordIn = (state: R97ExecutionStateFile, record: R97UnitRecord): R97ExecutionStateFile => {
    const wanted = unitKeyOf(record);
    const records = state.records.map((r) => (unitKeyOf(r) === wanted ? record : r));
    if (!state.records.some((r) => unitKeyOf(r) === wanted)) records.push(record);
    return { ...state, records };
  };

  const byAttempt = async (attemptId: string): Promise<R97UnitRecord> => {
    const state = await read();
    const record = state.records.find((r) => r.attemptId === attemptId);
    if (record !== undefined) return record;
    // Not the CURRENT attempt of any unit — but it may still be a SUPERSEDED
    // attempt preserved in a journal. That is a staleness error, not a
    // missing-record error, and the caller must be told which one it is.
    const superseded = state.records.find((r) => r.attempts.some((a) => a.attemptId === attemptId));
    if (superseded !== undefined) {
      throw new Error(
        `E4-R97: ${R97_EXEC_ATTEMPT_STALE}: attempt ${attemptId} has been superseded by ${superseded.attemptId} — a stale attempt may not write a terminal record`,
      );
    }
    throw new Error(`E4-R97: no execution unit for attempt ${attemptId}`);
  };

  /**
   * Is this record's unit DONE for the purposes of a resume skip?
   *
   * Plan §T2 怎么做 10 / finding N4: a skip must not rest on the status field
   * alone. A `failed` record that an operator reconciled for a RETRY is NOT
   * done — the whole point of the reconciliation is that the dispatcher picks the
   * unit up again, and the previous version left `isDone === true` forever, so
   * "reconcile(retry) 后 isDone=true 导致 driver 永远跳过" (§0.3).
   */
  const doneOf = (r: R97UnitRecord | null): boolean => {
    if (r === null) return false;
    if (r.status === "completed") return true;
    if (r.status === "failed") {
      // An operator authorised a NEW attempt: the unit is pending again until
      // that attempt reaches its own terminal state.
      return r.reconciledForRetry !== true;
    }
    return false;
  };

  /** Build the attempt-journal entry for the record's CURRENT attempt. */
  const currentAttemptOf = (r: R97UnitRecord): R97UnitAttempt => ({
    attemptId: r.attemptId,
    reservationId: r.reservationId,
    inputDigest: r.inputDigest,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    resultHash: r.resultHash,
    ownerPid: r.ownerPid,
    ownerHost: r.ownerHost,
    detail: r.detail,
    // The evidence travels with the attempt, so a retry does not orphan the
    // report the PREVIOUS attempt produced.
    ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
  });

  /**
   * Replace the LAST entry of the attempts journal with the record's current
   * state, so the journal always ends at the live attempt and the top-level
   * fields mirror it.
   */
  const withSyncedAttempts = (r: R97UnitRecord): R97UnitRecord => {
    const attempts = [...r.attempts];
    const last = attempts[attempts.length - 1];
    if (last === undefined || last.attemptId !== r.attemptId) {
      // Should be impossible for a record this store wrote; keep the invariant
      // rather than trusting it.
      attempts.push(currentAttemptOf(r));
    } else {
      attempts[attempts.length - 1] = currentAttemptOf(r);
    }
    return { ...r, attempts };
  };

  return {
    dir,

    async isDone(key) {
      return doneOf(await findRecord(key));
    },
    async statusOf(key) {
      return (await findRecord(key))?.status ?? null;
    },
    recordFor: findRecord,
    async mustNotRetry(key) {
      return (await findRecord(key))?.status === "outcome_unknown";
    },

    async begin(key, opts2) {
      // ---- THE WHOLE CHECK-AND-WRITE IS ONE CRITICAL SECTION (T2 怎么做 3) ----
      //
      // Reading the existing record, deciding whether the unit is startable, and
      // writing the `running` record happen under ONE acquisition of the campaign
      // lock. Splitting them — as the unfixed store did — is what let two
      // processes both see "not running" and both dispatch the same unit.
      return mutateRecord(key, (state, existing) => {
      if (existing !== null) {
        if (existing.status === "running") {
          // ONE OWNER AT A TIME (plan §T2 怎么做 4: "running 状态拒绝第二次 begin").
          // Two processes racing the same unit both observed "not running" in the
          // old store, so both dispatched it — one unit, two bills.
          throw new Error(
            `E4-R97: ${R97_EXEC_BUSY}: unit ${unitKeyOf(key)} is already running as attempt ${existing.attemptId} (owner pid ${existing.ownerPid} on ${existing.ownerHost}) — a unit has one owner at a time`,
          );
        }
        if (existing.status === "completed" || existing.status === "failed") {
          // A terminal unit is skipped EXCEPT when an operator explicitly
          // reconciled it for a retry. `reconcile({action:"retry"})` types the
          // unit `failed` on purpose — the attempt may already have been billed —
          // but stamps an `R97_RECONCILE_RETRY_DETAIL` detail and marks the
          // record as plainly overridable, so the NEXT attempt is permitted.
          //
          // The override is deliberately narrow. It requires BOTH a `failed`
          // status (a reconciled unit is never `completed`) AND the explicit
          // `reconciledForRetry` marker, so nothing else — not a `fail()`
          // call, not a record hand-written into the JSON, not identity drift —
          // can reopen a terminal unit. In particular the input-digest drift
          // check below still applies to it: a crashed unit must be re-run on
          // the SAME inputs, or it is drift rather than a retry.
          if (existing.status === "failed" && existing.reconciledForRetry === true) {
            if (existing.inputDigest !== opts2.inputDigest) {
              throw new Error(
                `E4-R97: ${R97_EXEC_INPUT_DRIFT}: reconciled unit ${unitKeyOf(key)} was quarantined with input digest ${existing.inputDigest} but is being retried with ${opts2.inputDigest}`,
              );
            }
          } else {
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
        }
        if (existing.status === "outcome_unknown") {
          // Explicit reconciliation only: never silently re-dispatched.
          throw new Error(
            `E4-R97: unit ${unitKeyOf(key)} is outcome_unknown — it requires an explicit reconciliation decision before it may run again`,
          );
        }
      }
      const startedAt = opts2.now ?? now();
      const attemptId = `a-${startedAt}-${process.pid}-${Math.abs(hashString(unitKeyOf(key)))}-${(existing?.attempts.length ?? 0) + 1}`;
      const attempt: R97UnitAttempt = {
        attemptId,
        reservationId: opts2.reservationId,
        inputDigest: opts2.inputDigest,
        status: "running",
        startedAt,
        endedAt: null,
        resultHash: null,
        ownerPid: process.pid,
        ownerHost: hostname(),
        detail: null,
      };
      const record: R97UnitRecord = {
        schemaVersion: R97_EXEC_SCHEMA,
        ...key,
        planDigest: opts.planDigest,
        status: "running",
        attemptId,
        inputDigest: opts2.inputDigest,
        reservationId: opts2.reservationId,
        resultHash: null,
        startedAt,
        endedAt: null,
        detail: null,
        ownerPid: process.pid,
        ownerHost: hostname(),
        // The PREVIOUS attempts are carried forward, never discarded: the old
        // reservation may already have been billed (plan §T2 怎么做 7).
        attempts: [...(existing?.attempts ?? []), attempt],
        // A NEW attempt clears the retry marker: it is no longer awaiting a
        // retry, it IS the retry.
      };
      return { next: record, result: attemptId };
      });
    },

    async complete(attemptId, opts2) {
      // The terminal write is a read-modify-write like any other: the record is
      // re-read and the staleness/status checks re-applied INSIDE the lock, so a
      // concurrent `begin` (a retry) cannot slip between the check and the write
      // and have its new attempt overwritten by this one's terminal record.
      return withLockedState(async (current) => {
        const record = current.records.find((r) => r.attemptId === attemptId) ?? (await byAttempt(attemptId));
        // A terminal write is only legal from the unit's CURRENT attempt. A stale
        // attempt (superseded by a reconciliation and a new begin) must not be
        // able to write a result over the live one.
        if (record.attemptId !== attemptId) {
          throw new Error(
            `E4-R97: ${R97_EXEC_ATTEMPT_STALE}: attempt ${attemptId} has been superseded by ${record.attemptId} — a stale attempt may not write a terminal record`,
          );
        }
        if (record.status !== "running") {
          throw new Error(`E4-R97: attempt ${attemptId} is ${record.status} — only a running unit can be completed`);
        }
        if (opts2.resultHash === "") throw new Error("E4-R97: a completed unit requires a non-empty result hash");
        const endedAt = opts2.now ?? now();
        const next = withSyncedAttempts({
          ...record,
          status: "completed" as const,
          resultHash: opts2.resultHash,
          detail: opts2.detail ?? null,
          endedAt,
          ...(opts2.evidence === undefined ? {} : { evidence: opts2.evidence }),
        });
        return { next: replaceRecordIn(current, next), result: undefined };
      });
    },

    async fail(attemptId, opts2) {
      return withLockedState(async (current) => {
        const record = current.records.find((r) => r.attemptId === attemptId) ?? (await byAttempt(attemptId));
        if (record.attemptId !== attemptId) {
          throw new Error(
            `E4-R97: ${R97_EXEC_ATTEMPT_STALE}: attempt ${attemptId} has been superseded by ${record.attemptId} — a stale attempt may not write a terminal record`,
          );
        }
        if (record.status !== "running") {
          throw new Error(`E4-R97: attempt ${attemptId} is ${record.status} — only a running unit can be failed`);
        }
        if (opts2.resultHash === "") throw new Error("E4-R97: a failed unit requires a non-empty result hash");
        const endedAt = opts2.now ?? now();
        const next = withSyncedAttempts({
          ...record,
          status: "failed" as const,
          resultHash: opts2.resultHash,
          detail: opts2.detail ?? null,
          endedAt,
          ...(opts2.evidence === undefined ? {} : { evidence: opts2.evidence }),
        });
        return { next: replaceRecordIn(current, next), result: undefined };
      });
    },

    async recoverInFlight(opts2 = {}) {
      const isAlive = opts2.isAlive ?? defaultIsAlive;
      const localHost = opts2.host ?? hostname();
      // Recovery is a read-modify-write over EVERY record, so it runs under the
      // same lock: without it, a recovery scanning the file while another process
      // begins a unit would rewrite the whole `records` array from its stale
      // snapshot and drop that new record.
      return withLockedState(async (state) => {
        let unknown = 0;
        let foreign = 0;
        const records = state.records.map((r) => {
          if (r.status !== "running") return r;
          // AN OWNER ON ANOTHER HOST CANNOT BE JUDGED. Plan §T2 怎么做 5: "跨主机无法
          // 判断时保守停止，不能把'不知道'视为死亡." A pid is only meaningful on the
          // machine that issued it, so a foreign owner is left RUNNING and reported
          // separately — never quarantined on a guess.
          if (r.ownerHost !== localHost) {
            foreign += 1;
            return r;
          }
          // A LIVE owner is BUSY, not crashed. The old recovery quarantined every
          // running record unconditionally, so a second process stole a live
          // process's unit (§0.3: "当前活进程的 running 被 recover 改成 unknown").
          if (isAlive(r.ownerPid)) return r;
          unknown += 1;
          // The allowance stays consumed and the unit is quarantined: a dispatched
          // attempt may have been billed, and only an operator decision resolves it.
          const endedAt = r.endedAt ?? now();
          return withSyncedAttempts({
            ...r,
            status: "outcome_unknown" as const,
            endedAt,
          });
        });
        return { next: unknown > 0 ? { ...state, records } : null, result: { unknown, foreign } };
      });
    },

    async reconcile(key, decision) {
      const wanted = unitKeyOf(key);
      // The read, the status guard and the mutation are ONE critical section: a
      // concurrent `begin` must not be able to change the record between the
      // "is it outcome_unknown?" check and the write.
      return withLockedState(async (state) => {
      const record = state.records.find((r) => unitKeyOf(r) === wanted) ?? null;
      if (record === null) {
        throw new Error(
          `E4-R97: ${R97_EXEC_NOT_RECONCILABLE}: unit ${wanted} has no execution record — reconciliation resolves an ambiguous outcome and cannot create one`,
        );
      }
      // The single guard that makes this operation "explicit and separate":
      // only an `outcome_unknown` unit is ambiguous. A `running` unit has a live
      // owner that may still write, a terminal unit already has a decision, and
      // a `pending` unit simply has not run — none of them is an operator
      // question, so none of them may be edited through this door.
      if (record.status !== "outcome_unknown") {
        throw new Error(
          `E4-R97: ${R97_EXEC_NOT_RECONCILABLE}: unit ${wanted} is ${record.status}, not outcome_unknown — reconciliation applies only to an outcome_unknown unit`,
        );
      }
      // Both actions land on `failed`, and deliberately so: `failed` is the one
      // terminal status that records WHY the unit stopped. For `retry` this
      // keeps the evidence that an attempt may have been billed while still
      // typing the unit as done-with-this-attempt, so `begin()` is allowed again
      // on the NEXT attempt.
      const supplied = decision.resultHash ?? "";
      if (decision.action === "accept-as-failed" && supplied === "") {
        // Matches the invariant `parseR97ExecutionState` enforces: a terminal
        // record without a result hash cannot substantiate a resume skip.
        throw new Error(
          `E4-R97: accept-as-failed for unit ${wanted} requires an explicit resultHash — a terminal record must carry the hash of the result it is asserting`,
        );
      }
      if (decision.action === "retry" && decision.resultHash !== undefined && supplied === "") {
        throw new Error(`E4-R97: an empty resultHash is not a decision about unit ${wanted} — omit it or supply the observed hash`);
      }

      // `detail` NEVER loses the fact that a reconciliation happened, even when
      // the operator supplies their own words, because the next reader's first
      // question about a `failed` unit is "did this fail by itself?".
      const detail =
        decision.action === "retry"
          ? `${R97_RECONCILE_RETRY_DETAIL}${decision.detail === undefined ? "" : ` — ${summarizeForDetail(decision.detail)}`}`
          : `reconciled: operator accepted the outcome as failed${decision.detail === undefined ? "" : ` — ${summarizeForDetail(decision.detail)}`}`;
      const resultHash =
        supplied !== "" ? supplied : reconciliationResultHash(key, decision, record.startedAt);

      // The record is MUTATED in place, never deleted and never re-appended: the
      // tombstone this reconciliation leaves is what proves an attempt happened.
      //
      // The ATTEMPTS journal is deliberately NOT rewritten here. Reconciliation
      // is a decision about the UNIT, not about what the attempt did: the
      // attempt still crashed (`outcome_unknown`), and the unit now carries the
      // operator's verdict (`failed`) on top of it. Overwriting the journal
      // entry would destroy the evidence that the outcome was ever unknown —
      // and with it the reason the reservation may have been billed. The journal
      // is preserved so that fact stays auditable (plan §T2 怎么做 7).
      const reconciled: R97UnitRecord = {
        ...record,
        status: "failed",
        resultHash,
        endedAt: record.endedAt ?? decision.now ?? now(),
        detail,
        // Only `retry` opens the door for `begin`. `accept-as-failed` leaves the
        // marker absent, so the unit stays skipped for the rest of the campaign.
        ...(decision.action === "retry" ? { reconciledForRetry: true } : {}),
      };
      return { next: replaceRecordIn(state, reconciled), result: reconciled };
      });
    },

    async records() {
      return (await read()).records;
    },
  };
}

/** Process-liveness probe: `EPERM` means the process exists but is not ours. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Truncate a long operator/error message so `detail` stays one readable line.
 *  The FULL text still reaches `resultHash` through the digest below, so
 *  truncation loses presentation, never evidence. */
function summarizeForDetail(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

/**
 * The result hash of a RECONCILED unit.
 *
 * Plan §R98 says an unknown outcome is NOT promised to be exactly-once, so a
 * reconciled record may not claim a result it never observed. It must still
 * carry a NON-EMPTY hash, because the parser requires every terminal record to
 * substantiate itself, and an empty string would make `completed`/`failed`
 * indistinguishable from "no result at all". The digest therefore commits to
 * the reconciliation FACTS (unit identity, action, operator detail, supplied
 * hash. It also absorbs the `startedAt` of the attempt being resolved, so a
 * later decision about a later crash yields a different hash instead of two
 * silently identical markers.
 */
function reconciliationResultHash(
  key: R97UnitKey,
  decision: R97ReconcileDecision,
  attemptStartedAt: number,
): string {
  const supplied = decision.resultHash ?? "";
  const detail = decision.detail ?? "";
  const material = `reconciled|${decision.action}|${unitKeyOf(key)}|${supplied}|${detail}|${attemptStartedAt}`;
  // `node:crypto` is imported statically, like the budget ledger does, so the
  // digest itself is a real sha256 rather than a second home-grown hash.
  return `reconciled-${decision.action}-${createHash("sha256").update(material).digest("hex")}`;
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
