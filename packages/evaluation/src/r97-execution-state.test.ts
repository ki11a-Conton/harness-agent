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
    const recovered = await resumed.recoverInFlight();
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
