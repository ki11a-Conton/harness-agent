/**
 * E4-R98-B (plan T2 / findings N3, N4) — THE CASE STATE MACHINE.
 *
 * MEASURED DEFECTS (plan §0.2 and §0.3, all reproduced by the plan's own probes):
 *
 *   N3 "execution-state 的 read 在文件缺失时返回空状态；begin 允许覆盖 running；
 *       recoverInFlight 不判断 owner；retry reconciliation 后 isDone 仍返回 true"
 *
 *   §0.3 probe rows this file pins:
 *     - "仅删除 execution-state.json | 同计划再运行新增 2 次，累计 committed 从 2 变 4"
 *     - "状态所有权 | 同单位第二次 begin 被接受；当前活进程的 running 被 recover 改成
 *        unknown；reconcile(retry) 后 isDone=true"
 *
 *   N4 "isDone 只判断状态；不验证 resultHash/inputDigest" — a tampered result was
 *      still skipped as done, and a `completed` record was accepted on the strength
 *      of "there is a non-empty resultHash string" alone.
 *
 * THE CONTRACT (plan §T2 怎么验收):
 *
 *   "删除当前 handle 或重启后所需 state 文件：命名拒绝、0 新调用，原 ledger 不变."
 *   "两个进程竞争同一 case×arm×repetition：只有一个 begin 成功."
 *   "第二次打开 campaign 不会将活进程的 running 改 unknown；死 owner 被隔离后不会自动
 *    重发."
 *   "reconcile(retry) 后 dispatcher 真正执行一个新 attempt."
 *   "完成单位不可通过 reconciliation 随意重开."
 *
 * Every test drives the REAL store against a REAL temp directory. No provider is
 * constructed and no network call is made anywhere in this file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  openR97ExecutionState,
  readR97ExecutionStateFile,
  R97_EXEC_FILENAME,
  R97_EXEC_STATE_MISSING,
  R97_EXEC_BUSY,
  R97_EXEC_ATTEMPT_STALE,
  R97_EXEC_NOT_RECONCILABLE,
  R97_EXEC_INPUT_DRIFT,
  type R97UnitKey,
} from "./r97-execution-state.js";
import { openR97BudgetLedger, R97_LEDGER_FILENAME } from "./r97-budget-ledger.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-state-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const PLAN = "f".repeat(64);
const EXPERIMENT = PLAN;

function key(over: Partial<R97UnitKey> = {}): R97UnitKey {
  return { experimentId: EXPERIMENT, caseId: "c1", suite: "regression", arm: "baseline", repetition: 1, ...over };
}

async function open(dir: string, mode: "first-run" | "resume" | "auto" = "auto") {
  return openR97ExecutionState(dir, { experimentId: EXPERIMENT, planDigest: PLAN, mode });
}

/**
 * Make `dir` an ESTABLISHED campaign by writing its budget ledger there.
 *
 * This is the real inference signal the store reads in `"auto"` mode: a campaign
 * that has been authorized has a ledger, so a missing execution state is a LOSS
 * rather than a blank slate. The driver passes ONE directory for both.
 */
async function establishCampaign(dir: string): Promise<void> {
  const ledger = await openR97BudgetLedger(dir, { planDigest: PLAN, campaignModelCalls: 10, mode: "first-run" });
  expect(await ledger.view()).toBeDefined();
}

/**
 * Drive a unit into `outcome_unknown` the ONLY way it can legitimately happen:
 * an attempt that persisted `running` and whose owner then died.
 */
async function quarantineDeadOwner(dir: string, k: R97UnitKey): Promise<void> {
  const first = await open(dir, "first-run");
  await first.begin(k, { reservationId: "r-crash", inputDigest: "d1" });
  const resumed = await open(dir, "first-run");
  expect((await resumed.recoverInFlight({ isAlive: () => false })).unknown).toBe(1);
  expect(await resumed.statusOf(k)).toBe("outcome_unknown");
}

describe("R98-B S1: an ESTABLISHED campaign's missing state is a LOSS, not a blank slate", () => {
  it("REFUSES to treat a deleted state file as 'nothing has run'", async () => {
    // §0.3: "仅删除 execution-state.json | 同计划再运行新增 2 次，累计 committed 从 2 变 4."
    const dir = await tempDir();
    const first = await open(dir, "first-run");
    const a1 = await first.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await first.complete(a1, { resultHash: "h1" });

    // The campaign is ESTABLISHED: its authorization ledger is on disk. This is
    // what makes the state file's absence a LOSS rather than a fresh start.
    await establishCampaign(dir);

    // The file disappears between runs.
    await rm(join(dir, R97_EXEC_FILENAME), { force: true });

    // An `auto` open must NOT conjure an empty state: the ledger still vouches
    // for a campaign that has run work.
    await expect(open(dir, "auto")).rejects.toThrow(new RegExp(R97_EXEC_STATE_MISSING));
    // And a `resume` explicitly refuses too.
    await expect(open(dir, "resume")).rejects.toThrow(new RegExp(R97_EXEC_STATE_MISSING));
    // Nothing was created: the loss is not papered over with a new empty file.
    await expect(readFile(join(dir, R97_EXEC_FILENAME), "utf8")).rejects.toThrow();
    // The LEDGER is untouched by the refusal — the plan requires "原 ledger 不变".
    await expect(readFile(join(dir, R97_LEDGER_FILENAME), "utf8")).resolves.toBeTruthy();
  });

  it("still CREATES state on a genuine first run (no ledger yet)", async () => {
    const dir = await tempDir();
    const s = await open(dir, "auto");
    expect(await s.records()).toEqual([]);
    // The identity is persisted, so a later process has something to compare to.
    const file = await readR97ExecutionStateFile(dir);
    expect(file!.experimentId).toBe(EXPERIMENT);
    expect(file!.planDigest).toBe(PLAN);
  });
});

describe("R98-B S2: one unit has exactly ONE owner at a time", () => {
  it("REFUSES a second begin while the unit is running", async () => {
    // §0.3: "状态所有权 | 同单位第二次 begin 被接受."
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await expect(s.begin(key(), { reservationId: "r2", inputDigest: "d1" })).rejects.toThrow(new RegExp(R97_EXEC_BUSY));

    // The FIRST attempt is still the live one, and it can still finish.
    await s.complete(a1, { resultHash: "h1" });
    expect(await s.isDone(key())).toBe(true);
  });

  it("records owner evidence (pid + host) on the attempt", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    const rec = (await s.recordFor(key()))!;
    expect(rec.ownerPid).toBe(process.pid);
    expect(rec.ownerHost).toBe(hostname());
  });

  it("REFUSES a terminal write from a SUPERSEDED attempt", async () => {
    // The old owner must not be able to finish a newer attempt's record.
    const dir = await tempDir();
    await quarantineDeadOwner(dir, key());
    const s = await open(dir, "first-run");
    const a1 = (await s.recordFor(key()))!.attemptId;
    // Reconcile the quarantined attempt, then begin the authorised retry.
    await s.reconcile(key(), { action: "retry", detail: "operator retry" });
    const a2 = await s.begin(key(), { reservationId: "r2", inputDigest: "d1" });
    expect(a2).not.toBe(a1);
    // The FIRST attempt id is now stale.
    await expect(s.complete(a1, { resultHash: "h-stale" })).rejects.toThrow(new RegExp(R97_EXEC_ATTEMPT_STALE));
    await expect(s.fail(a1, { resultHash: "h-stale" })).rejects.toThrow(new RegExp(R97_EXEC_ATTEMPT_STALE));
    // The current one still works.
    await s.complete(a2, { resultHash: "h2" });
    expect(await s.statusOf(key())).toBe("completed");
  });
});

describe("R98-B S3: recovery respects a LIVE owner", () => {
  it("does NOT reclassify a running unit whose owner is alive", async () => {
    // §0.3: "当前活进程的 running 被 recover 改成 unknown."
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    // The owner (this very process) is alive.
    const recovered = await s.recoverInFlight({ isAlive: () => true });
    expect(recovered.unknown).toBe(0);
    expect(await s.statusOf(key())).toBe("running");
  });

  it("quarantines a running unit whose owner is provably DEAD, keeping its allowance", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    const recovered = await s.recoverInFlight({ isAlive: () => false });
    expect(recovered.unknown).toBe(1);
    expect(await s.statusOf(key())).toBe("outcome_unknown");
    // The reservation is NOT forgotten: the attempt may have been billed.
    expect((await s.recordFor(key()))!.reservationId).toBe("r1");
  });

  it("conservatively does NOT touch a running unit owned by ANOTHER HOST", async () => {
    // Plan §T2 怎么做 5: "跨主机无法判断时保守停止，不能把'不知道'视为死亡."
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    // Rewrite the record to claim a foreign host, as a shared filesystem would.
    const text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    const file = JSON.parse(text);
    file.records[0].ownerHost = "some-other-host";
    await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(file), "utf8");

    const recovered = await s.recoverInFlight({ isAlive: () => false });
    expect(recovered.unknown, "a foreign owner is 'unknown', never 'dead'").toBe(0);
    expect(recovered.foreign).toBe(1);
    expect(await s.statusOf(key())).toBe("running");
  });
});

describe("R98-B S4: reconciliation actually re-opens the unit", () => {
  it("isDone is FALSE after a retry reconciliation, so the dispatcher re-runs it", async () => {
    // §0.3: "reconcile(retry) 后 isDone=true" — which made the driver skip the
    // unit FOREVER, so the reconciliation had no effect.
    const dir = await tempDir();
    await quarantineDeadOwner(dir, key());
    const s = await open(dir, "first-run");
    expect(await s.isDone(key())).toBe(false);

    const reconciled = await s.reconcile(key(), { action: "retry", detail: "authorised retry" });
    expect(reconciled.reconciledForRetry).toBe(true);
    // THE FIX: a unit awaiting its authorised retry is NOT done, so the
    // dispatcher re-selects it instead of skipping it forever.
    expect(await s.isDone(key()), "a reconciled-for-retry unit must be re-selected").toBe(false);
    expect(await s.mustNotRetry(key())).toBe(false);

    // And a new attempt is genuinely permitted, bound to the SAME input digest.
    const a2 = await s.begin(key(), { reservationId: "r2", inputDigest: "d1" });
    expect(a2).not.toBe(reconciled.attemptId);
    expect(await s.statusOf(key())).toBe("running");
    await s.complete(a2, { resultHash: "h2" });
    expect(await s.isDone(key())).toBe(true);
  });

  it("a retry with a CHANGED input digest is drift, not a retry", async () => {
    const dir = await tempDir();
    await quarantineDeadOwner(dir, key());
    const s = await open(dir, "first-run");
    await s.reconcile(key(), { action: "retry" });
    await expect(s.begin(key(), { reservationId: "r2", inputDigest: "DIFFERENT" })).rejects.toThrow(
      new RegExp(R97_EXEC_INPUT_DRIFT),
    );
  });

  it("accept-as-failed stays terminal and is NOT re-runnable", async () => {
    const dir = await tempDir();
    await quarantineDeadOwner(dir, key());
    const s = await open(dir, "first-run");
    await s.reconcile(key(), { action: "accept-as-failed", resultHash: "h-accepted" });
    expect(await s.isDone(key())).toBe(true);
    await expect(s.begin(key(), { reservationId: "r2", inputDigest: "d1" })).rejects.toThrow(/already failed/);
  });

  it("REFUSES to reconcile a unit that is not outcome_unknown", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await expect(s.reconcile(key(), { action: "retry" })).rejects.toThrow(new RegExp(R97_EXEC_NOT_RECONCILABLE));
  });

  it("preserves the OLD attempt's audit trail rather than overwriting it", async () => {
    // Plan §T2 怎么做 7: "保留旧 attempt 的审计记录 … 可以扩展现有 journal."
    const dir = await tempDir();
    await quarantineDeadOwner(dir, key());
    const s = await open(dir, "first-run");
    const a1 = (await s.recordFor(key()))!.attemptId;
    await s.reconcile(key(), { action: "retry" });
    const a2 = await s.begin(key(), { reservationId: "r2", inputDigest: "d1" });
    await s.complete(a2, { resultHash: "h2" });

    const rec = (await s.recordFor(key()))!;
    // The FIRST attempt is still visible, with its own reservation — the
    // reservation that may already have been billed.
    expect(rec.attempts, "the old attempt must remain auditable").toBeDefined();
    expect(rec.attempts.length).toBe(2);
    expect(rec.attempts[0]!.attemptId).toBe(a1);
    expect(rec.attempts[0]!.reservationId).toBe("r-crash");
    expect(rec.attempts[0]!.status).toBe("outcome_unknown");
    expect(rec.attempts[1]!.attemptId).toBe(a2);
    expect(rec.attempts[1]!.reservationId).toBe("r2");
    expect(rec.attempts[1]!.status).toBe("completed");
  });
});

describe("R98-B S5: a skip is only legitimate when the RECORD is trustworthy", () => {
  it("a COMPLETED record whose input digest changed is drift, not a cache hit", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await s.complete(a1, { resultHash: "h1" });
    await expect(s.begin(key(), { reservationId: "r2", inputDigest: "d2" })).rejects.toThrow(
      new RegExp(R97_EXEC_INPUT_DRIFT),
    );
  });

  it("a TERMINAL record with an EMPTY resultHash is refused by the parser", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await s.complete(a1, { resultHash: "h1" });
    // Tamper: strip the hash, leaving a "completed" record that substantiates
    // nothing.
    const text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    const file = JSON.parse(text);
    file.records[0].resultHash = "";
    await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(file), "utf8");
    await expect(s.records()).rejects.toThrow(/resultHash/);
  });

  it("REFUSES a record whose experimentId disagrees with the header", async () => {
    // Plan §T2 怎么做 8: "parser 严格检查每条记录的 experimentId/planDigest 与 header 一致."
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await s.complete(a1, { resultHash: "h1" });
    const text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    const file = JSON.parse(text);
    file.records[0].experimentId = "a-different-experiment";
    await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(file), "utf8");
    await expect(s.records()).rejects.toThrow(/experimentId/);
  });

  it("REFUSES a missing startedAt rather than silently reading it as 0", async () => {
    // Plan §T2 怎么做 8: "不能把缺 startedAt 静默变成 0."
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await s.complete(a1, { resultHash: "h1" });
    const text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    const file = JSON.parse(text);
    delete file.records[0].startedAt;
    await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(file), "utf8");
    await expect(s.records()).rejects.toThrow(/startedAt/);
  });

  it("REFUSES a duplicate attemptId across records", async () => {
    const dir = await tempDir();
    const s = await open(dir, "first-run");
    const a1 = await s.begin(key(), { reservationId: "r1", inputDigest: "d1" });
    await s.complete(a1, { resultHash: "h1" });
    await s.begin(key({ caseId: "c2" }), { reservationId: "r2", inputDigest: "d2" });
    const text = await readFile(join(dir, R97_EXEC_FILENAME), "utf8");
    const file = JSON.parse(text);
    file.records[1].attemptId = a1; // duplicate
    await writeFile(join(dir, R97_EXEC_FILENAME), JSON.stringify(file), "utf8");
    await expect(s.records()).rejects.toThrow(/duplicate/i);
  });
});
