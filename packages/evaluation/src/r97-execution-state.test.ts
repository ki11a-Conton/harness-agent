/**
 * E4-R98 — the durable case×arm×repetition execution state.
 *
 * Plan §R98 做什么 item 4: "为 case×arm×repetition 增加持久化执行记录，并与
 * model-call reservation 建立关联."
 *
 * Plan §R98 怎么做: "给案例定义小型状态机：pending → running →
 * completed/failed，崩溃遗留 running → outcome_unknown … 先持久化
 * running/reservation，再允许请求发出；结果与 completed 关联后才允许 resume
 * skip。已完成结果 hash 或身份错则停止，不直接重跑。"
 *
 * Plan §R98 line 125 — "UNKNOWN 停止自动重发并保留占用额度，提供明确的单独
 * reconciliation 操作；不承诺跨网络 exactly-once" — is the clause S4 below
 * covers: leaving `outcome_unknown` recoverable is only safe if the ONE way out
 * of it is an explicit, auditable operator decision.
 *
 * MEASURED defect this closes (plan §0.1 F2): the driver had only a call budget
 * and no completed-unit set, so a second run of the SAME plan added another 16
 * calls (16 + 16 = 32 committed) instead of skipping the completed cases.
 *
 * Every test drives the real store against a real temp directory. No provider is
 * constructed and no network call is made anywhere in this file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openR97ExecutionState,
  R97_EXEC_FILENAME,
  R97_EXEC_SCHEMA,
  unitKeyOf,
  type R97UnitKey,
} from "./r97-execution-state.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-exec-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const PLAN = "a".repeat(64);
const OTHER_PLAN = "b".repeat(64);
const EXPERIMENT = "exp-1";

const key = (caseId: string, arm: "baseline" | "candidate" = "baseline"): R97UnitKey => ({
  experimentId: EXPERIMENT,
  caseId,
  suite: "regression",
  arm,
  repetition: 1,
});

describe("E4-R98 S1: the unit state machine is durable and resume-safe", () => {
  it("a unit is NOT done before it starts, and IS done after it completes", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-03-add-import");
    expect(await s.isDone(k)).toBe(false);

    const attempt = await s.begin(k, { reservationId: "r-1", inputDigest: "in-1" });
    // `running` is persisted BEFORE the request is allowed (plan §R98).
    expect(await s.isDone(k)).toBe(false);
    expect((await s.statusOf(k))).toBe("running");

    await s.complete(attempt, { resultHash: "hash-1" });
    expect(await s.isDone(k)).toBe(true);
    expect((await s.statusOf(k))).toBe("completed");
  });

  it("a FAILED unit is terminal and is not retried automatically either", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-14-stack");
    const attempt = await s.begin(k, { reservationId: "r-2", inputDigest: "in-2" });
    await s.fail(attempt, { resultHash: "hash-2", detail: "verification_failed" });
    expect(await s.isDone(k)).toBe(true);
    expect(await s.statusOf(k)).toBe("failed");
  });

  it("a crash leaves `running`, which recovery turns into outcome_unknown — never auto-retried", async () => {
    const dir = await tempDir();
    const first = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-16-cicd-step");
    await first.begin(k, { reservationId: "r-3", inputDigest: "in-3" });

    // A NEW process opens the same directory (the crashed owner is gone).
    const resumed = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const recovered = await resumed.recoverInFlight({ isAlive: () => false });
    expect(recovered.unknown).toBe(1);
    expect(await resumed.statusOf(k)).toBe("outcome_unknown");
    // An unknown unit is NOT skippable-as-success and NOT silently re-runnable.
    expect(await resumed.isDone(k)).toBe(false);
    expect(await resumed.mustNotRetry(k)).toBe(true);
  });

  it("a completed unit survives a restart with its result hash", async () => {
    const dir = await tempDir();
    const a = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-06-json-parse-test", "candidate");
    const attempt = await a.begin(k, { reservationId: "r-4", inputDigest: "in-4" });
    await a.complete(attempt, { resultHash: "hash-4" });

    const b = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    expect(await b.isDone(k)).toBe(true);
    expect((await b.recordFor(k))?.resultHash).toBe("hash-4");
  });

  it("records the reservation id, so a unit is tied to its budget reservation", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("stress-many-artifacts");
    const attempt = await s.begin(k, { reservationId: "reservation-xyz", inputDigest: "in-5" });
    await s.complete(attempt, { resultHash: "hash-5" });
    expect((await s.recordFor(k))?.reservationId).toBe("reservation-xyz");
  });

  it("keys distinguish case, arm and repetition", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const b = key("reg-17-gcd", "baseline");
    const c = key("reg-17-gcd", "candidate");
    const rep2: R97UnitKey = { ...b, repetition: 2 };
    expect(unitKeyOf(b)).not.toBe(unitKeyOf(c));
    expect(unitKeyOf(b)).not.toBe(unitKeyOf(rep2));

    const attempt = await s.begin(b, { reservationId: "r-6", inputDigest: "in-6" });
    await s.complete(attempt, { resultHash: "h" });
    expect(await s.isDone(b)).toBe(true);
    expect(await s.isDone(c)).toBe(false);
    expect(await s.isDone(rep2)).toBe(false);
  });
});

describe("E4-R98 S2: the execution state fails closed on identity drift", () => {
  it("refuses a store bound to a different plan digest", async () => {
    const dir = await tempDir();
    await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await expect(openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: OTHER_PLAN })).rejects.toThrow(
      /MISMATCH|different plan/i,
    );
  });

  it("refuses a store bound to a different experiment id", async () => {
    const dir = await tempDir();
    await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await expect(openR97ExecutionState(dir, { experimentId: "exp-2", planDigest: PLAN })).rejects.toThrow(
      /MISMATCH|different experiment/i,
    );
  });

  it("stops when a COMPLETED unit's input digest no longer matches", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-24-error-handling");
    const attempt = await s.begin(k, { reservationId: "r-7", inputDigest: "in-before" });
    await s.complete(attempt, { resultHash: "h-before" });
    // The case content changed under the same key.
    await expect(s.begin(k, { reservationId: "r-8", inputDigest: "in-after" })).rejects.toThrow(
      /INPUT_DRIFT|input digest|already (completed|terminal)/i,
    );
  });

  it("refuses a corrupted store rather than treating it as empty", async () => {
    const dir = await tempDir();
    await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await writeFile(join(dir, R97_EXEC_FILENAME), "{ not json", "utf8");
    await expect(openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN })).rejects.toThrow(
      /CORRUPT|not valid JSON|damaged/i,
    );
  });

  it("writes a schema-tagged, non-secret store", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const k = key("reg-03-add-import");
    const attempt = await s.begin(k, { reservationId: "r-9", inputDigest: "in-9" });
    await s.complete(attempt, { resultHash: "h-9" });
    const raw = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    expect(raw).toContain(R97_EXEC_SCHEMA);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]|Bearer |api[_-]?key/i);
    expect(raw).not.toContain(dir);
  });
});

describe("E4-R98 S3: the full 8×2 matrix resumes with zero new work", () => {
  it("a second pass over the same matrix finds every unit done", async () => {
    const dir = await tempDir();
    const cases = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    const arms: Array<"baseline" | "candidate"> = ["baseline", "candidate"];

    const first = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    for (const arm of arms) {
      for (const c of cases) {
        const k = key(c, arm);
        const attempt = await first.begin(k, { reservationId: `r-${arm}-${c}`, inputDigest: `in-${c}` });
        await first.complete(attempt, { resultHash: `h-${arm}-${c}` });
      }
    }

    // A fresh process (the resume) must find 16/16 done and start NOTHING.
    const resumed = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    let pending = 0;
    for (const arm of arms) {
      for (const c of cases) {
        if (!(await resumed.isDone(key(c, arm)))) pending += 1;
      }
    }
    expect(pending).toBe(0);
    expect((await resumed.records()).length).toBe(16);
  });

  it("a partially completed matrix resumes only the MISSING units", async () => {
    const dir = await tempDir();
    const first = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    for (const c of ["c1", "c2", "c3"]) {
      const k = key(c);
      const attempt = await first.begin(k, { reservationId: `r-${c}`, inputDigest: `in-${c}` });
      await first.complete(attempt, { resultHash: `h-${c}` });
    }
    const resumed = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    expect(await resumed.isDone(key("c1"))).toBe(true);
    expect(await resumed.isDone(key("c4"))).toBe(false);
  });
});

describe("E4-R98 S4: reconciliation of outcome_unknown is explicit and never silent", () => {
  /** Drive a unit into `outcome_unknown` the only way it can happen: a process
   *  that persisted `running` and then died, observed by a NEW store handle. */
  async function quarantined(dir: string, k: R97UnitKey): Promise<void> {
    const first = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await first.begin(k, { reservationId: "r-crash", inputDigest: "in-crash" });
    const resumed = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    // The owner is PROVABLY GONE. Recovery no longer quarantines every `running`
    // record unconditionally (that was finding N3: "当前活进程的 running 被 recover
    // 改成 unknown"), so a crash must be expressed as what it actually is — a
    // dead owner — rather than as "somebody opened the store again".
    expect((await resumed.recoverInFlight({ isAlive: () => false })).unknown).toBe(1);
    expect(await resumed.statusOf(k)).toBe("outcome_unknown");
  }

  it("a recovered unit can be reconciled with `retry`, and then begins AGAIN", async () => {
    const dir = await tempDir();
    const k = key("reg-16-cicd-step");
    await quarantined(dir, k);
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    // Without a decision, the unit is still refused (the quarantine holds).
    await expect(s.begin(k, { reservationId: "r-10", inputDigest: "in-crash" })).rejects.toThrow(/outcome_unknown/i);
    expect(await s.mustNotRetry(k)).toBe(true);

    const reconciled = await s.reconcile(k, { action: "retry" });
    expect(reconciled.status).toBe("failed");
    // `retry` is NOT "delete the record": the unit is terminal for the attempt
    // that may have been billed, and re-runnable by the caller.
    expect(await s.mustNotRetry(k)).toBe(false);
    // ...but it is NOT `isDone`. Finding N3: the old store left `isDone === true`
    // after a retry reconciliation, so the driver skipped the unit FOREVER and
    // the operator's retry never happened. A unit awaiting its authorised retry
    // must be re-selected.
    expect(await s.isDone(k), "a reconciled-for-retry unit must be re-selected").toBe(false);

    // ...and a caller CAN begin it again. The new attempt starts `running`, so
    // it is no longer "done" until it reaches a terminal state of its own.
    const attempt2 = await s.begin(k, { reservationId: "r-11", inputDigest: "in-crash" });
    expect(attempt2).not.toBe(reconciled.attemptId);
    expect(await s.statusOf(k)).toBe("running");
    expect(await s.isDone(k)).toBe(false);

    await s.complete(attempt2, { resultHash: "fresh-result" });
    expect(await s.isDone(k)).toBe(true);
    expect(await s.statusOf(k)).toBe("completed");
    expect((await s.recordFor(k))?.resultHash).toBe("fresh-result");
  });

  it("`retry` keeps the evidence: the record names the reconciliation and carries a hash", async () => {
    const dir = await tempDir();
    const k = key("reg-14-stack");
    await quarantined(dir, k);
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    const reconciled = await s.reconcile(k, { action: "retry", detail: "the upstream 400 is now fixed", now: 1_700_000_000_000 });
    expect(reconciled.detail).toMatch(/reconcil/i);
    expect(reconciled.detail).toMatch(/operator/i);
    expect(reconciled.detail).toContain("the upstream 400 is now fixed");
    // The hash is a reconciliation MARKER, never an empty string: the parser
    // refuses a terminal record without one.
    expect(reconciled.resultHash).not.toBeNull();
    expect(reconciled.resultHash).not.toBe("");
    expect(String(reconciled.resultHash).length).toBeGreaterThan(16);
    // `recoverInFlight` already stamped endedAt; reconciliation must not RE-date
    // evidence that already has a time, and must never leave it null.
    const quarantinedRecord = await s.recordFor(k);
    expect(reconciled.endedAt).not.toBeNull();
    expect(reconciled.endedAt).toBe(quarantinedRecord?.endedAt);
  });

  it("`retry` persists an operator-supplied hash instead of inventing a marker", async () => {
    const dir = await tempDir();
    const k = key("reg-08-dedupe", "candidate");
    await quarantined(dir, k);
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    // persisted BEFORE the decision, so the timestamp is not re-derived later.
    const before = await s.recordFor(k);
    const withHash = await s.reconcile(k, { action: "retry", resultHash: "observed-hash" });
    expect(withHash.resultHash).toBe("observed-hash");
    // The marker path is only for the case where the operator has NO hash: an
    // empty hash would be an unsubstantiated terminal record.
    expect(withHash.resultHash).not.toBe("");
    expect((await s.recordFor(k))?.resultHash).toBe("observed-hash");
    // An explicitly EMPTY hash is a caller bug, not a decision. The unit is
    // already terminal here, so the guard that fires is the state guard — the
    // point is that NOTHING was written.
    await expect(s.reconcile(k, { action: "retry", resultHash: "" })).rejects.toThrow(/NOT_RECONCILABLE|empty resultHash/i);
    expect((await s.recordFor(k))?.resultHash).toBe("observed-hash");
    expect(before?.resultHash).not.toBe("");
  });

  it("`accept-as-failed` closes the unit as terminal and failed", async () => {
    const dir = await tempDir();
    const k = key("reg-17-gcd", "candidate");
    await quarantined(dir, k);
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    const rec = await s.reconcile(k, { action: "accept-as-failed", resultHash: "h-unknown-1", detail: "provider refused to confirm" });
    expect(rec.status).toBe("failed");
    expect(rec.resultHash).toBe("h-unknown-1");
    expect(rec.detail).toContain("provider refused to confirm");
    expect(await s.isDone(k)).toBe(true);
    expect(await s.statusOf(k)).toBe("failed");
    expect(await s.mustNotRetry(k)).toBe(false);
    // A terminal unit is skipped, not restarted — the operator closed it.
    await expect(s.begin(k, { reservationId: "r-12", inputDigest: "in-crash" })).rejects.toThrow(/already failed/i);
  });

  it("`accept-as-failed` WITHOUT a result hash throws", async () => {
    const dir = await tempDir();
    const k = key("reg-24-error-handling");
    await quarantined(dir, k);
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    await expect(s.reconcile(k, { action: "accept-as-failed" })).rejects.toThrow(/resultHash|result hash/i);
    await expect(s.reconcile(k, { action: "accept-as-failed", resultHash: "" })).rejects.toThrow(/resultHash|result hash/i);
    // The refusal left the unit exactly as it was: still quarantined.
    expect(await s.statusOf(k)).toBe("outcome_unknown");
  });

  it("reconciling a unit that is NOT outcome_unknown throws (running, completed, missing)", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    // A `running` unit may still be written by its live owner.
    const kRunning = key("reg-06-json-parse-test");
    await s.begin(kRunning, { reservationId: "r-13", inputDigest: "in-13" });
    await expect(s.reconcile(kRunning, { action: "retry" })).rejects.toThrow(/running|outcome_unknown/i);

    // A `completed` unit already carries its decision.
    const kDone = key("reg-03-add-import");
    const attempt = await s.begin(kDone, { reservationId: "r-14", inputDigest: "in-14" });
    await s.complete(attempt, { resultHash: "h-14" });
    await expect(s.reconcile(kDone, { action: "accept-as-failed", resultHash: "h-x" })).rejects.toThrow(
      /completed|outcome_unknown/i,
    );

    // A unit with NO record at all: reconciliation resolves an outcome, it does
    // not manufacture one.
    const kMissing = key("reg-20-never-started");
    expect(await s.recordFor(kMissing)).toBeNull();
    await expect(s.reconcile(kMissing, { action: "retry" })).rejects.toThrow(/no execution record|NOT_RECONCILABLE/i);
  });

  it("a reconciliation is DURABLE across store handles", async () => {
    const dir = await tempDir();
    const k = key("stress-many-artifacts");
    await quarantined(dir, k);
    const a = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await a.reconcile(k, { action: "accept-as-failed", resultHash: "h-durable", detail: "accepted after review" });

    // A fresh process (a resume) reads the SAME decision, not the old quarantine.
    const b = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const seen = await b.recordFor(k);
    expect(seen?.status).toBe("failed");
    expect(seen?.resultHash).toBe("h-durable");
    expect(seen?.detail).toContain("accepted after review");
    expect(await b.isDone(k)).toBe(true);
    expect(await b.mustNotRetry(k)).toBe(false);
  });

  it("reconciliation MUTATES one record and never appends a duplicate", async () => {
    const dir = await tempDir();
    const k = key("reg-17-gcd");
    const other = key("reg-17-gcd", "candidate");
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    await s.begin(other, { reservationId: "r-15", inputDigest: "in-15" });
    await s.begin(k, { reservationId: "r-16", inputDigest: "in-16" });
    await s.recoverInFlight({ isAlive: () => false });

    const before = await s.records();
    expect(before.length).toBe(2);
    const attemptIdBefore = (await s.recordFor(k))?.attemptId;

    await s.reconcile(k, { action: "retry" });

    const after = await s.records();
    expect(after.length).toBe(before.length);
    expect(after.length).toBe(2);
    // Same attempt identity, same key — it was edited in place.
    expect((await s.recordFor(k))?.attemptId).toBe(attemptIdBefore);
    expect(after.filter((r) => unitKeyOf(r) === unitKeyOf(k)).length).toBe(1);
    // The neighbour was untouched by the decision.
    expect(await s.statusOf(other)).toBe("outcome_unknown");
  });

  it("only an OPERATOR retry reopens a terminal unit — a plain failure does not", async () => {
    const dir = await tempDir();
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });

    // An ordinary `fail()` is terminal and stays terminal: the retry door is
    // opened by the reconciliation decision, not by the status alone.
    const kFailed = key("reg-07-nested-loop");
    const attempt = await s.begin(kFailed, { reservationId: "r-17", inputDigest: "in-17" });
    await s.fail(attempt, { resultHash: "h-17", detail: "verification_failed" });
    await expect(s.begin(kFailed, { reservationId: "r-18", inputDigest: "in-17" })).rejects.toThrow(/already failed/i);

    // `accept-as-failed` is the same kind of closure and must NOT reopen either.
    const kAccepted = key("reg-11-binary-search");
    await s.begin(kAccepted, { reservationId: "r-19", inputDigest: "in-19" });
    await s.recoverInFlight({ isAlive: () => false });
    await s.reconcile(kAccepted, { action: "accept-as-failed", resultHash: "h-19" });
    await expect(s.begin(kAccepted, { reservationId: "r-20", inputDigest: "in-19" })).rejects.toThrow(/already failed/i);

    // A `completed` unit can never be reopened through the retry marker, even if
    // a hand-edited store carries it: the status check comes first.
    const kDrift = key("reg-12-anagram");
    await s.begin(kDrift, { reservationId: "r-21", inputDigest: "in-21" });
    await s.recoverInFlight({ isAlive: () => false });
    await s.reconcile(kDrift, { action: "retry" });
    // A reconciled retry must run the SAME inputs — changed inputs are drift.
    await expect(s.begin(kDrift, { reservationId: "r-22", inputDigest: "in-CHANGED" })).rejects.toThrow(/INPUT_DRIFT|input digest/i);
  });
});

describe("R99-A E5: the evidence link travels with the terminal record and its attempt", () => {
  // Plan §T3 怎么做 4: "原始报告落入 campaign 的不可混淆 attempt 目录，校验后计算字节
  // hash 和相对路径，再原子写 terminal journal." The link is what makes a DELETED or
  // EDITED report detectable on a resume, so it must survive a round trip through
  // the file — and it must stay attached to the attempt that produced it.

  const EVIDENCE = { path: "attempts/baseline/reg-01/1/a-1.json", sha256: "b".repeat(64) };

  it("round-trips a completed record's evidence link through the file", async () => {
    const dir = await tempDir();
    const k = key("reg-01-two-sum");
    const first = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const attempt = await first.begin(k, { reservationId: "r-31", inputDigest: "in-31" });
    await first.complete(attempt, { resultHash: "h-31", detail: "passed", evidence: EVIDENCE });

    // A SECOND open re-reads the file, so this asserts the persisted bytes and
    // not an in-memory object that merely happens to still hold the link.
    const second = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN, mode: "resume" });
    const record = await second.recordFor(k);
    expect(record?.evidence).toEqual(EVIDENCE);
    expect(record?.attempts[0]?.evidence).toEqual(EVIDENCE);
  });

  it("keeps a FAILED record's evidence too — a negative is a result", async () => {
    const dir = await tempDir();
    const k = key("reg-02-add-two");
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const attempt = await s.begin(k, { reservationId: "r-32", inputDigest: "in-32" });
    await s.fail(attempt, { resultHash: "h-32", detail: "verification_failed", evidence: EVIDENCE });

    const reopened = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN, mode: "resume" });
    expect((await reopened.recordFor(k))?.evidence).toEqual(EVIDENCE);
  });

  it("an OLD attempt keeps its own evidence after a retry, so it stays attributable", async () => {
    const dir = await tempDir();
    const k = key("reg-03-reverse");
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const crashed = await s.begin(k, { reservationId: "r-33", inputDigest: "in-33" });
    await s.recoverInFlight({ isAlive: () => false });
    await s.reconcile(k, { action: "retry" });
    const retried = await s.begin(k, { reservationId: "r-34", inputDigest: "in-33" });
    const secondEvidence = { path: "attempts/baseline/reg-03/1/a-2.json", sha256: "c".repeat(64) };
    await s.fail(retried, { resultHash: "h-34", detail: "verification_failed", evidence: secondEvidence });

    const record = await s.recordFor(k);
    // The crash produced no evidence; the retry's is on BOTH the record and the
    // journal entry for the retry — and the two attempts are distinct entries.
    expect(record?.attempts.length).toBe(2);
    expect(record?.attempts[0]?.attemptId).toBe(crashed);
    expect(record?.attempts[0]?.evidence ?? null).toBeNull();
    expect(record?.attempts[1]?.attemptId).toBe(retried);
    expect(record?.attempts[1]?.evidence).toEqual(secondEvidence);
    expect(record?.evidence).toEqual(secondEvidence);
  });

  it("REFUSES a malformed link rather than silently dropping it", async () => {
    const dir = await tempDir();
    const k = key("reg-04-merge");
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const attempt = await s.begin(k, { reservationId: "r-35", inputDigest: "in-35" });
    await s.complete(attempt, { resultHash: "h-35", evidence: EVIDENCE });

    // A path that escapes the campaign root, and a hash that is not a sha256:
    // each is damage, and a store that ignored either would let a record point
    // its evidence anywhere and still "verify".
    const raw = JSON.parse(await readFile(join(dir, R97_EXEC_FILENAME), "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    for (const bad of [
      { path: "../outside.json", sha256: "b".repeat(64) },
      { path: "attempts/baseline/reg-04/1/a.json", sha256: "not-a-digest" },
      { path: "", sha256: "b".repeat(64) },
    ]) {
      const tampered = { ...raw, records: raw.records.map((r) => ({ ...r, evidence: bad })) };
      await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(tampered), "utf8");
      await expect(
        openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN, mode: "resume" }),
      ).rejects.toThrow(/EVIDENCE|evidence/);
    }
  });

  it("accepts a record with NO link, because the provider mode has no report to link", async () => {
    // The store is shared by both execution modes. A rehearsal record has no arm
    // report, so requiring a link HERE would force the fake-provider path to
    // fabricate one. The requirement lives in the driver's arm-worker resume,
    // where the mode is known.
    const dir = await tempDir();
    const k = key("reg-05-lru");
    const s = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN });
    const attempt = await s.begin(k, { reservationId: "r-36", inputDigest: "in-36" });
    await s.complete(attempt, { resultHash: "h-36", detail: "rehearsal" });

    const reopened = await openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN, mode: "resume" });
    expect((await reopened.recordFor(k))?.evidence ?? null).toBeNull();
  });
});
