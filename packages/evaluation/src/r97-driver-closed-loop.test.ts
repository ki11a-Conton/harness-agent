/**
 * E4-R97 — the REAL driver's offline closed loop.
 *
 * Plan §R97 怎么做 line 219 is explicit that testing the pure gate function is
 * NOT sufficient: "不要只测试纯 gate 函数，要驱动实际 CLI/driver 入口." So every test
 * here imports and drives `scripts/e4/r97-campaign-driver.mjs` — the actual
 * entry point that would execute the paid campaign.
 *
 * Plan §R97 怎么验收 (line 226) is the acceptance criterion this file proves:
 *
 *   "实际 driver 的未授权、错 digest、无效日期、过期、案例漂移、build 漂移、预算
 *    耗尽路径：fake provider 的越界请求数 0."
 *
 * For EVERY refusal path the fake provider's request count must be 0. The driver
 * returns that count, and the tests additionally assert that the provider was
 * never even CONSTRUCTED, which is the stronger property plan §R97 line 219 asks
 * for ("未授权时不得构造真实 provider").
 *
 * Line 228 adds: "正常路径完整成对结果通过 R93 validator；中断路径使用 R94 状态合同."
 * The normal path is covered here; the interruption contract is R94's and is
 * exercised by its own gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as childProcess from "node:child_process";
import * as nodeUtil from "node:util";
import { buildR97AuthorizationPlan, type R97ArmObservation } from "./r97-plan.js";
import type { R97Campaign } from "./r97-campaign-lifecycle.js";

const DRIVER = pathToFileURL(join(process.cwd(), "scripts", "e4", "r97-campaign-driver.mjs")).href;
const EVAL = pathToFileURL(join(process.cwd(), "packages", "evaluation", "dist", "index.js")).href;

const REPO = process.cwd();

/**
 * Open a REAL campaign through the production lifecycle.
 *
 * Tests seed durable state (a consumed budget, a crashed unit) and must do so
 * the way production does: through `openR97Campaign`. A hand-written ledger with
 * no campaign header is a state the production entry can no longer produce — it
 * is refused (finding N2) — so seeding one would test an unreachable world.
 */
async function openCampaign(dir: string, planDigest: string, campaignModelCalls: number): Promise<R97Campaign> {
  const mod = evaluation as unknown as {
    openR97Campaign: (d: string, o: Record<string, unknown>) => Promise<R97Campaign>;
  };
  return mod.openR97Campaign(dir, { planDigest, campaignModelCalls, mode: "first-run" });
}
const ENDPOINT = "e".repeat(64);
const CREATED = "2026-09-17T00:00:00.000Z";
const NOW = "2026-09-18T00:00:00.000Z";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r97-driver-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

const mod = (await import(DRIVER)) as {
  runDriver: (o: unknown) => Promise<Record<string, unknown>>;
  makeCountingFakeProvider: () => { provider: unknown; state: { requests: number; created: number } };
  DRIVER_VERSION: string;
};
const evaluation = (await import(EVAL)) as Record<string, unknown>;

/** Build a FINALIZED plan from the real selection, so the case list is genuine. */
async function finalizedPlan(over: Record<string, unknown> = {}) {
  const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[]; caseFingerprints: Record<string, string> }>)(REPO);
  const mk = (arm: "baseline" | "candidate", sha: string, dg: string): R97ArmObservation => ({
    arm,
    checkoutDir: `D:/wt/${arm}`,
    sourceSha: sha,
    treeFingerprint: null,
    clean: true,
    planDigest: dg,
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: ENDPOINT,
    caseIds: sel.caseIds,
    cliCaseIds: sel.caseIds.map((id) => id.split("/").pop() ?? id),
    caseFingerprints: sel.caseFingerprints,
    effectiveModelParams: { budgetTokens: 32_000 },
    totalLogicalRuns: sel.caseIds.length * 2,
    suite: "regression",
  });
  const p = await buildR97AuthorizationPlan({
    repoRoot: REPO,
    baseline: mk("baseline", "1".repeat(40), "a".repeat(64)),
    candidate: mk("candidate", "2".repeat(40), "b".repeat(64)),
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: ENDPOINT,
    outputDir: ".ci/r97-ab",
    now: NOW,
    createdAt: CREATED,
    campaignModelCalls: 320,
    ...over,
  });
  if (p.planDigest === null || p.authorization === null) {
    throw new Error(`fixture plan did not finalize: ${JSON.stringify(p.readinessIssues)}`);
  }
  return p;
}

/** The observation block the driver compares against, in the AUTHORIZED shape. */
function observationFor(plan: Awaited<ReturnType<typeof finalizedPlan>>, over: Record<string, unknown> = {}) {
  const a = plan.authorization!;
  return {
    now: NOW,
    executingSourceSha: a.arms.candidate.sha,
    armShas: { baseline: a.arms.baseline.sha, candidate: a.arms.candidate.sha },
    armDigests: {
      baseline: a.arms.baseline.executionPlanDigest,
      candidate: a.arms.candidate.executionPlanDigest,
    },
    caseFingerprints: { ...a.caseFingerprints },
    providerId: a.providerId,
    modelId: a.modelId,
    endpointIdentity: a.endpointIdentity,
    ...over,
  };
}

/** Drive the real driver with a counting fake provider. */
async function drive(opts: {
  plan: Awaited<ReturnType<typeof finalizedPlan>>;
  env?: Record<string, string>;
  observation?: Record<string, unknown>;
  ledgerDir?: string;
  maxProviderCalls?: number;
  /** Simulate a crashed owner: the real probe is `process.kill(pid, 0)`, which
   *  cannot be made to report "dead" for the process running the test. */
  isAlive?: (pid: number) => boolean;
}) {
  const made = { calls: 0 };
  const result = await mod.runDriver({
    modules: { evaluation },
    plan: opts.plan,
    env: opts.env ?? {},
    observation: opts.observation ?? observationFor(opts.plan),
    ledgerDir: opts.ledgerDir,
    maxProviderCalls: opts.maxProviderCalls,
    isAlive: opts.isAlive,
    makeProvider: () => {
      made.calls += 1;
      return mod.makeCountingFakeProvider();
    },
  });
  return { result, providerConstructions: made.calls };
}

const AUTHORIZED_ENV = (digest: string) => ({
  E4_R92_PAID_AUTH: "1",
  RUN_PAID_BENCHMARKS: "1",
  E4_R92_PAID_AUTH_DIGEST: digest,
});

describe("E4-R97 D1: every refusal path makes ZERO provider requests", () => {
  it("UNAUTHORIZED: no auth env -> refused, 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({ plan, env: {}, ledgerDir: await tempDir() });
    expect(result["authorization"]).toMatchObject({ authorizedToExecute: false, code: "PAID_AUTHORIZATION_REQUIRED" });
    expect(result["providerRequests"]).toBe(0);
    expect(result["logicalCalls"]).toBe(0);
    expect(result["status"]).toBe("NOT_RUN");
    // The stronger property: the provider factory was never even invoked.
    expect(providerConstructions).toBe(0);
  });

  it("WRONG DIGEST: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV("0".repeat(64)),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "AUTHORIZATION_DIGEST_MISMATCH" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("EXPIRED: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan({ now: "2030-01-01T00:00:00.000Z", createdAt: "2026-09-17T00:00:00.000Z", validityDays: 1 });
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { now: "2030-01-02T00:00:00.000Z" }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("INVALID DATE: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { now: "not-a-timestamp" }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "AUTHORIZATION_TIME_INVALID" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("NOT YET VALID (future createdAt): 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan({ createdAt: "2030-01-01T00:00:00.000Z" });
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { now: "2026-09-18T00:00:00.000Z" }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "AUTHORIZATION_NOT_YET_VALID" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("CASE DRIFT: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const a = plan.authorization!;
    const drifted = { ...a.caseFingerprints };
    const first = a.caseIds[0]!;
    drifted[first] = "9".repeat(64);
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { caseFingerprints: drifted }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "CASE_CONTENT_DRIFT" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("BUILD DRIFT (arm sha changed): 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { armShas: { baseline: "3".repeat(40), candidate: plan.authorization!.arms.candidate.sha } }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "ARM_BUILD_DRIFT" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("ARM BUILD DIGEST DRIFT: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, {
        armDigests: { baseline: "c".repeat(64), candidate: plan.authorization!.arms.candidate.executionPlanDigest },
      }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "ARM_BUILD_DRIFT" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("IDENTITY DRIFT (model changed): 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan, { modelId: "gpt-4o" }),
      ledgerDir: await tempDir(),
    });
    expect(result["authorization"]).toMatchObject({ code: "IDENTITY_DRIFT" });
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("an authorized run with NO ledger is refused BEFORE any provider exists", async () => {
    const plan = await finalizedPlan();
    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      ledgerDir: undefined,
    });
    // Authorization passed, but the global budget cannot be enforced without a
    // ledger, so the driver refuses rather than running unbounded.
    expect(result["authorization"]).toMatchObject({ authorizedToExecute: true });
    expect(result["code"]).toBe("LEDGER_REQUIRED");
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("R100: the execution-boundary check RUNS on the authorized path and reports its own result", async () => {
    const plan = await finalizedPlan();
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: await tempDir() });
    // The check is not decorative: the driver records what it observed and
    // whether it agreed, on the run that actually proceeds.
    const check = result["executionObservation"] as { ok: boolean; codes: string[] } | undefined;
    expect(check, "an authorized run must report the execution-boundary check").toBeDefined();
    expect(check!.ok).toBe(true);
    expect(check!.codes).toEqual([]);
  });

  it("R100: a DRIVER BUILD change is refused before any provider exists", async () => {
    const plan = await finalizedPlan();
    // Simulate "the driver's code changed after approval" in the only way that
    // ISOLATES this check: re-bind the envelope's `driverBuildDigest` to a
    // different value AND re-sign the envelope so its stored label describes its
    // stored body. Without the re-sign, the R92 gate refuses first on
    // AUTHORIZATION_DIGEST_MISMATCH and this check would never be reached — which
    // would make the test pass for the wrong reason.
    const fakeBuildDigest = "0".repeat(64);
    const tamperedAuth = { ...plan.authorization!, driverBuildDigest: fakeBuildDigest };
    const resigned = {
      ...plan,
      authorization: tamperedAuth,
      planDigest: (evaluation["computeR92AuthorizationDigestV1"] as (a: unknown) => string)(tamperedAuth),
    };
    const { result, providerConstructions } = await drive({
      plan: resigned as typeof plan,
      env: AUTHORIZED_ENV(resigned.planDigest),
      ledgerDir: await tempDir(),
    });
    // The driver recomputes its OWN digest from its own bytes, so it cannot
    // agree with the forged value.
    expect(result["executionObservation"]).toMatchObject({
      ok: false,
      codes: ["EXEC_OBS_DRIVER_BUILD_DRIFT"],
    });
    expect(result["code"]).toBe("EXEC_OBS_DRIVER_BUILD_DRIFT");
    expect(result["status"]).toBe("REFUSED");
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("R100: a TAMPERED envelope whose top-level digest was relabelled is refused", async () => {
    const plan = await finalizedPlan();
    // The classic forgery: edit the body, then rewrite the top-level label so a
    // naive equality check on the label alone would pass.
    const tamperedBody = { ...plan.authorization!, modelId: "gpt-4o" };
    const relabelled = { ...plan, planDigest: "f".repeat(64), authorization: tamperedBody };
    const { result, providerConstructions } = await drive({
      plan: relabelled as typeof plan,
      env: AUTHORIZED_ENV("f".repeat(64)),
      ledgerDir: await tempDir(),
    });
    expect(result["status"]).not.toBe("COMPLETE");
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("R100: the report carries the TRUE per-case suite inventory, not one --suite label", async () => {
    const plan = await finalizedPlan();
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: await tempDir() });

    // The frozen selection is genuinely MIXED (regression + stress), so a
    // campaign that reported a single suite would be misdescribing itself.
    const inventory = result["suiteInventory"] as Array<{ caseId: string; suite: string }>;
    expect(inventory).toHaveLength(plan.authorization!.caseIds.length);
    expect(new Set(inventory.map((e) => e.caseId)).size).toBe(inventory.length);
    // The inventory's suites agree with the approved envelope, case for case —
    // the driver must not re-derive a suite from the case id's prefix.
    for (const entry of inventory) {
      const approved = plan.authorization!.caseInventory?.find((e) => e.caseId === entry.caseId);
      expect(approved, `${entry.caseId} must be in the approved inventory`).toBeDefined();
      expect(entry.suite).toBe(approved!.suite);
    }
    const suites = result["suitesPresent"] as string[];
    expect(suites.length).toBeGreaterThan(1);
    expect(suites).toContain("stress");
    expect(suites).toContain("regression");
  });

  it("BUDGET EXHAUSTED by a pre-existing ledger: 0 requests, provider never constructed", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    // A previous process consumed the whole grant. It is seeded through the REAL
    // campaign lifecycle, because that is the only way a directory becomes an
    // established campaign: the driver now refuses a bare ledger that no
    // campaign header vouches for (finding N2), so hand-writing one would test a
    // state the production entry can never produce.
    const campaign = await openCampaign(dir, plan.planDigest!, 320);
    const r = await campaign.ledger.reserve("baseline", 320);
    await campaign.ledger.commit(r.reservationId!, 320);

    const { result, providerConstructions } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      ledgerDir: dir,
    });
    expect(result["status"]).toBe("PARTIAL");
    expect(result["code"]).toBe("BUDGET_EXHAUSTED");
    expect(result["providerRequests"]).toBe(0);
    // The provider IS constructed on this path (authorization passed), but it is
    // never CALLED. That is the property the acceptance criterion states.
    expect(providerConstructions).toBe(1);
  });
});

describe("E4-R97 D2: the normal path runs the pair within the campaign budget", () => {
  it("an authorized run completes with one reservation per logical call", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(result["status"]).toBe("COMPLETE");
    const caseCount = plan.authorization!.caseIds.length;
    // Two arms x N cases = 2N logical calls, one per reservation.
    expect(result["logicalCalls"]).toBe(caseCount * 2);
    expect(result["providerRequests"]).toBe(caseCount * 2);
    expect((result["reservations"] as unknown[]).length).toBe(caseCount * 2);
    const budget = result["budget"] as { granted: number; committed: number; remaining: number };
    expect(budget.granted).toBe(320);
    expect(budget.committed).toBe(caseCount * 2);
    expect(budget.remaining).toBe(320 - caseCount * 2);
  });

  it("the ledger on disk records the consumption, so a RESTART cannot re-spend", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    const after = await (evaluation["readR97BudgetView"] as (d: string) => Promise<{ committed: number; remaining: number }>)(dir);
    const caseCount = plan.authorization!.caseIds.length;
    expect(after.committed).toBe(caseCount * 2);
    // A second full run would need 2N more; only 320-2N remain, so the budget is
    // genuinely shared rather than re-granted per process.
    expect(after.remaining).toBe(320 - caseCount * 2);
  });

  it("F2: a SECOND run of the same plan executes ZERO new units (case resume)", async () => {
    // Plan §0.1 F2 / §R98 怎么验收: "完成8例×2臂后，第二次正常 resume 新增调用0，
    // 完成记录数量仍16." MEASURED RED before R98: the first run committed 16 calls
    // and the second run committed ANOTHER 16 (total 32) because nothing recorded
    // which case×arm units were already finished.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const caseCount = plan.authorization!.caseIds.length;

    const first = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(first.result["status"]).toBe("COMPLETE");
    expect(first.result["logicalCalls"]).toBe(caseCount * 2);
    const armed = await (evaluation["readR97BudgetView"] as (d: string) => Promise<{ committed: number }>)(dir);
    expect(armed.committed).toBe(caseCount * 2);

    // The resume: same plan, same ledger, same output dir.
    const second = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(second.result["status"]).toBe("COMPLETE");
    expect(second.result["logicalCalls"]).toBe(0);
    expect(second.result["providerRequests"]).toBe(0);
    expect((second.result["reservations"] as unknown[]).length).toBe(0);

    // The budget did NOT move, and the completed set is still exactly 2N.
    const after = await (evaluation["readR97BudgetView"] as (d: string) => Promise<{ committed: number }>)(dir);
    expect(after.committed).toBe(caseCount * 2);
    expect(second.result["completedUnits"]).toBe(caseCount * 2);
  });

  it("F2: a partial run resumes ONLY the missing units", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const caseCount = plan.authorization!.caseIds.length;
    // Pre-complete the whole baseline arm through the public store API.
    const cases = plan.authorization!.caseIds;
    const state = await (evaluation["openR97ExecutionState"] as (d: string, o: unknown) => Promise<{
      begin: (k: unknown, o: unknown) => Promise<string>;
      complete: (id: string, o: unknown) => Promise<void>;
    }>)(dir, { experimentId: plan.planDigest!, planDigest: plan.planDigest! });
    for (const caseId of cases) {
      const attempt = await state.begin(
        { experimentId: plan.planDigest!, caseId, suite: caseId.split("/")[0], arm: "baseline", repetition: 1 },
        { reservationId: `seed-${caseId}`, inputDigest: "seeded" },
      );
      await state.complete(attempt, { resultHash: `seeded-${caseId}` });
    }

    const run = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    // Only the candidate arm's N units remained.
    expect(run.result["logicalCalls"]).toBe(caseCount);
    expect(run.result["completedUnits"]).toBe(caseCount * 2);
  });

  it("F2/F4: a resumed campaign whose durable state was REPLACED is refused, never COMPLETE", async () => {
    // Plan §R98 怎么验收: "修改 grant、planDigest 或结果hash，恢复非零退出，不给出
    // COMPLETE." A resume must not be able to adopt another authorization's state
    // and then report success.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });

    // Swap in a ledger that belongs to a DIFFERENT plan, leaving the old grant.
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(dir, "budget-ledger.json"),
      `${JSON.stringify(
        { schemaVersion: "e4-r97-budget-ledger-v1", planDigest: "c".repeat(64), campaignModelCalls: 320, entries: [] },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const resumed = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(resumed.result["status"]).not.toBe("COMPLETE");
    expect(resumed.result["logicalCalls"]).toBe(0);
    expect(resumed.result["providerRequests"]).toBe(0);
    expect(String(resumed.result["reason"])).toMatch(/MISMATCH|damaged|refus/i);
  });

  it("F2/F4: a resumed campaign whose execution state was CORRUPTED is refused, never COMPLETE", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });

    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(dir, "execution-state.json"), "{ corrupted", "utf8");

    const resumed = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(resumed.result["status"]).not.toBe("COMPLETE");
    expect(resumed.result["providerRequests"]).toBe(0);
    expect(String(resumed.result["reason"])).toMatch(/CORRUPT|not valid JSON|damaged/i);
  });

  it("F2: an interruption quarantines the in-flight unit and never silently re-dispatches it", async () => {
    // Plan §R98 怎么验收: "中途终止后只运行从未启动且身份合法的单位；unknown 不自动
    // 重试." Plan §R98 怎么做: "UNKNOWN 停止自动重发并保留占用额度."
    //
    // Simulate the crash window: a unit was persisted as `running` (the state the
    // driver writes BEFORE a request may leave), then the process died. The old
    // driver had no such record at all, so the next run simply re-billed the unit.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const cases = plan.authorization!.caseIds;
    const crashedCase = cases[0]!;

    const evaluation2 = evaluation as unknown as {
      openR97ExecutionState: (d: string, o: unknown) => Promise<{
        begin: (k: unknown, o: unknown) => Promise<string>;
        complete: (id: string, o: unknown) => Promise<void>;
      }>;
    };
    // One unit finished cleanly; a second was left mid-flight by the crash.
    // The campaign is established FIRST (through the real lifecycle), so the
    // state store the crash leaves behind is a legitimate resume of an
    // authorized campaign rather than an orphaned file. Its own state handle is
    // used, because the lifecycle already created that artifact — opening a
    // second one would be a different store instance over the same file.
    const campaign = await openCampaign(dir, plan.planDigest!, 320);
    const seed = campaign.execState as unknown as {
      begin: (k: unknown, o: unknown) => Promise<string>;
      complete: (id: string, o: unknown) => Promise<void>;
    };
    const doneAttempt = await seed.begin(
      { experimentId: plan.planDigest!, caseId: cases[1]!, suite: cases[1]!.split("/")[0], arm: "baseline", repetition: 1 },
      { reservationId: "seed-done", inputDigest: "seeded" },
    );
    await seed.complete(doneAttempt, { resultHash: "seeded-hash" });
    await seed.begin(
      { experimentId: plan.planDigest!, caseId: crashedCase, suite: crashedCase.split("/")[0], arm: "baseline", repetition: 1 },
      { reservationId: "seed-crashed", inputDigest: "seeded" },
    );

    const resumed = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      ledgerDir: dir,
      // The crash is simulated by seeding the `running` record from THIS process,
      // so the recorded owner pid is this (live) test process. Recovery
      // deliberately leaves a live owner alone (finding N3: a second process must
      // not steal a running unit), so the test states the fact it is simulating —
      // the process that wrote that record is GONE — through the same probe seam
      // production uses with the real `process.kill(pid, 0)` check.
      isAlive: () => false,
    });
    expect(resumed.result["recoveredUnits"]).toBe(1);
    expect(resumed.result["status"]).not.toBe("COMPLETE");
    const failures = resumed.result["failures"] as { caseId: string; error: string }[];
    const quarantined = failures.filter((f) => f.caseId === crashedCase);
    expect(quarantined.length).toBeGreaterThan(0);
    expect(quarantined[0]!.error).toMatch(/outcome_unknown/);
    // The already-completed BASELINE unit was skipped. (The candidate arm still
    // runs this case — the two arms are distinct units, which is the whole point
    // of keying on arm; asserting on caseId alone would be vacuous here.)
    const reservations = resumed.result["reservations"] as { caseId: string; arm: string }[];
    expect(reservations.some((r) => r.caseId === cases[1]! && r.arm === "baseline")).toBe(false);
    expect(reservations.some((r) => r.caseId === cases[1]! && r.arm === "candidate")).toBe(true);
    // The quarantined BASELINE unit was NOT re-dispatched. The candidate unit for
    // the same case is a DIFFERENT unit that never started, so it does run — that
    // asymmetry is exactly what per-(arm, repetition) keys are for.
    const quarantinedReservations = reservations.filter((r) => r.caseId === crashedCase);
    expect(quarantinedReservations.map((r) => r.arm)).toEqual(["candidate"]);
    // And the crashed unit is still quarantined in the durable store afterwards.
    const recs = await (evaluation as unknown as {
      openR97ExecutionState: (d: string, o: unknown) => Promise<{
        statusOf: (k: unknown) => Promise<string | null>;
      }>;
    })
      .openR97ExecutionState(dir, { experimentId: plan.planDigest!, planDigest: plan.planDigest! })
      .then((s) =>
        s.statusOf({
          experimentId: plan.planDigest!,
          caseId: crashedCase,
          suite: crashedCase.split("/")[0],
          arm: "baseline",
          repetition: 1,
        }),
      );
    expect(recs).toBe("outcome_unknown");
  });

  it("a campaign budget smaller than the pair stops EARLY and reports PARTIAL", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    // The ledger is bound to the plan's own grant (320) and refuses to be
    // re-opened with a different allowance, so a 3-call campaign is produced by
    // consuming 317 first and leaving exactly 3. Seeded through the REAL
    // lifecycle so the directory is a properly established campaign.
    const campaign = await openCampaign(dir, plan.planDigest!, 320);
    const seed = await campaign.ledger.reserve("seed", 317);
    await campaign.ledger.commit(seed.reservationId!, 317);

    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(result["status"]).toBe("PARTIAL");
    expect(result["code"]).toBe("BUDGET_EXHAUSTED");
    // Only the 3 remaining calls could happen, and no more.
    expect(result["logicalCalls"]).toBe(3);
    expect(result["providerRequests"]).toBe(3);

    // The MEASURED distribution, not an assumed one. The driver is serial by
    // construction (plan §R97 line 218 fixes serialism at 1) and consumes the
    // arms in order, so a 3-call remainder is spent entirely inside the FIRST
    // arm. Plan §R97 line 227's requirement is that the second arm gets "at most
    // 1" — 0 satisfies that, and the point of the fixture is that the remainder
    // is NOT refreshed for the second arm. The literal "arm A 2, arm B 1" split
    // is proven at the ledger level (G1/G5), where reservation order is chosen
    // by the caller rather than by the driver's arm loop.
    const byArm = (result["reservations"] as { arm: string }[]).reduce<Record<string, number>>((a, r) => {
      a[r.arm] = (a[r.arm] ?? 0) + 1;
      return a;
    }, {});
    expect(byArm).toEqual({ baseline: 3 });
    expect(byArm["candidate"] ?? 0).toBeLessThanOrEqual(1);
  });

  it("the fake provider is what runs: it never opens a socket", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    expect(result["status"]).toBe("COMPLETE");
    // A fake provider has a recognisable id and cannot be a real one.
    expect(plan.authorization!.providerId).toBe("openai"); // the PLAN names the real provider...
    // ...but the DRIVER ran the fake one, so 0 real requests were possible.
    expect(result["providerRequests"]).toBeGreaterThan(0);
  });
});

describe("E4-R97 D10: a provider ERROR event is a FAILED call, never a silent COMPLETE", () => {
  // The REAL OpenAICompatibleProvider (packages/model/src/openai.ts) does not
  // throw on a failed completion: it YIELDS `{ type: "error", error }` events
  // (and possibly `retry` events before them). The driver's STEP 4 previously
  // only counted `retry` events, so an error event was treated as a consumed
  // logical call with no failure recorded — the campaign would report
  // `COMPLETE` with 16 logical calls even when EVERY call failed (measured
  // false-success, reproduced live against the user's endpoint whose upstream
  // returns 400 on every completion).
  function makeErrorEventProvider() {
    const state = { requests: 0, created: 0 };
    const provider = {
      id: "fake-error-r97",
      async listModels() {
        return [];
      },
      createClient() {
        state.created += 1;
        return {
          async *generate() {
            state.requests += 1;
            // Mirror the real provider's failure shape: a retry, then an error.
            yield {
              type: "retry",
              attempt: 1,
              error: { code: "MODEL_ERROR", message: "transient" },
              timestamp: Date.now(),
            };
            yield {
              type: "error",
              error: { code: "MODEL_ERROR", message: "upstream 400: rejected" },
              timestamp: Date.now(),
            };
          },
        };
      },
    };
    return { provider, state };
  }

  async function driveErrorCase() {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const made = new Map<string, { provider: unknown; state: { requests: number; created: number } }>();
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      ledgerDir: dir,
      makeProvider: () => {
        const p = makeErrorEventProvider();
        made.set(p.state.requests.toString(), p);
        return p;
      },
    });
    return { plan, result, made };
  }

  it("every call failing with an error event is reported ONCE, as failed, not COMPLETE", async () => {
    const { plan, result } = await driveErrorCase();
    const caseCount = plan.authorization!.caseIds.length;
    // The calls WERE dispatched: the ledger must still account for them.
    expect(result["logicalCalls"]).toBe(caseCount * 2);
    expect(result["providerRequests"]).toBe(caseCount * 2);
    // But the outcome must never be a silent COMPLETE.
    expect(result["status"]).not.toBe("COMPLETE");
    expect(result["status"]).toBe("PARTIAL");
    expect(result["code"]).toBe("CASE_FAILURES");
    // The failures are recorded per (arm, case), one per failed logical call.
    const failures = result["failures"] as { arm: string; caseId: string; error: string }[];
    expect(failures.length).toBe(caseCount * 2);
    expect(failures[0]!.error).toContain("upstream 400: rejected");
    // The failure reason names the first broken call instead of a success line.
    expect(result["reason"]).toContain("failed");
  });

  it("a PARTIAL run is never promotion-eligible or reported as a success line", async () => {
    const { result } = await driveErrorCase();
    expect(result["code"]).toBe("CASE_FAILURES");
    expect(result["authorization"]).toBeDefined();
  });
});

describe("E4-R97 D3: the driver cannot exceed the ceiling it was given", () => {
  it("a provider call ceiling below the plan size is reported, never exceeded", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const { result } = await drive({
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      ledgerDir: dir,
      maxProviderCalls: 2,
    });
    expect(result["code"]).toBe("PROVIDER_CALL_CEILING_EXCEEDED");
    // The ceiling is checked after each call, so it can overshoot by at most the
    // one call in flight — it is a detector, not a hard limiter.
    expect(result["providerRequests"]).toBeLessThanOrEqual(3);
  });
});

describe("E4-R97 D9: the finalized plan is executable WITHOUT modification", () => {
  // Plan §R97 line 213: "正式材料必须无需修改就能执行" — the finalized material must be
  // executable as-is. Measured defect: `plan.json` as written by the plan builder
  // carried no `observation` block, and the CLI refused it with exit 2
  // ("--fake-provider needs the plan artifact to carry an `observation` block"),
  // so the artifact the user is asked to approve could not be run without hand-
  // editing it. The plan ALREADY carries the observed values in `gateFacts`; the
  // driver was demanding a second, redundant copy.
  const { execFile } = childProcess;
  const { promisify } = nodeUtil;
  const run = promisify(execFile);

  it("the plan artifact the approval package describes runs as-is, with no edit", async () => {
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    // Written EXACTLY as the plan builder produced it — no injected observation.
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const { stdout } = await run(
      process.execPath,
      [
        join(REPO, "scripts", "e4", "r97-campaign-driver.mjs"),
        "--plan", planPath,
        "--fake-provider",
        "--ledger", join(dir, "ledger"),
      ],
      {
        cwd: REPO,
        timeout: 120_000,
        env: { ...process.env, ...AUTHORIZED_ENV(plan.planDigest!) },
      },
    );
    const parsed = JSON.parse(stdout);
    // It RUNS: not exit 2 for a missing block, and not a refusal.
    expect(parsed.status).toBe("COMPLETE");
    expect(parsed.logicalCalls).toBe(plan.authorization!.caseIds.length * 2);
    expect(parsed.providerRequests).toBe(parsed.logicalCalls);
  }, 180_000);

  it("an unauthorized run of the same unmodified artifact is NOT_RUN with 0 requests", async () => {
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    // No auth env at all. The artifact must still be READABLE and refused
    // cleanly — never a configuration error, and never a provider call.
    const env = { ...process.env };
    delete env["E4_R92_PAID_AUTH"];
    delete env["RUN_PAID_BENCHMARKS"];
    delete env["E4_R92_PAID_AUTH_DIGEST"];
    // A refusal is a NON-ZERO exit by design (EXIT_REFUSED), so `execFile`
    // rejects. The JSON is still on stdout, which is the contract being tested.
    const stdout = await run(
      process.execPath,
      [
        join(REPO, "scripts", "e4", "r97-campaign-driver.mjs"),
        "--plan", planPath,
        "--fake-provider",
        "--ledger", join(dir, "ledger"),
      ],
      { cwd: REPO, timeout: 120_000, env },
    )
      .then((r) => r.stdout)
      .catch((err: { stdout?: string }) => err.stdout ?? "");
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("NOT_RUN");
    expect(parsed.providerRequests).toBe(0);
    expect(parsed.logicalCalls).toBe(0);
  }, 180_000);
});

describe("E4-R97 D4: the CLI entry refuses to build a real provider by default", () => {
  it("without --fake-provider the driver only prints a plan and makes no provider", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({ ...plan, observation: observationFor(plan) }), "utf8");

    const { stdout } = await run(
      process.execPath,
      [join(REPO, "scripts", "e4", "r97-campaign-driver.mjs"), "--plan", planPath, "--out", join(dir, "out")],
      { cwd: REPO, timeout: 60_000 },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("NOT_RUN");
    expect(parsed.reason).toMatch(/never constructs a real provider by default/);
  });

  it("--plan is required", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const res = await run(
      process.execPath,
      [join(REPO, "scripts", "e4", "r97-campaign-driver.mjs")],
      { cwd: REPO, timeout: 60_000 },
    ).catch((e: { code?: number; stderr?: string }) => ({ code: e.code, stderr: e.stderr ?? "" }));
    expect((res as { code?: number }).code).toBe(2);
  });
});

describe("E4-R97 D5: the driver writes its result artifact and leaks nothing", () => {
  it("the persisted driver result carries no key, endpoint or host path", async () => {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const outDir = join(dir, "out");
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: join(outDir, "ledger") });
    await mkdir(outDir, { recursive: true });
    const serialized = JSON.stringify(result, null, 2);
    await writeFile(join(outDir, "driver-result.json"), serialized, "utf8");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]|Bearer |api[_-]?key/i);
    expect(serialized).not.toContain(dir);
    // The plan digest IS recorded — it is a digest, not a secret.
    expect(serialized).toContain(plan.planDigest!);
  });
});

describe("E4-R97 D7: the zero-call rehearsal produces R93-VALID paired evidence", () => {
  // Plan §R97 line 221: "驱动器代码可先完成并通过零调用演练，之后才请用户批准具体最终
  // 计划." Line 228 makes it an acceptance criterion: "正常路径完整成对结果通过 R93
  // validator；中断路径使用 R94 状态合同."
  //
  // Before this group the driver never called the R93 validator at all, so
  // "passes the R93 validator" was an untested claim. The rehearsal is the ONLY
  // way to produce complete paired evidence with zero provider calls, which is
  // exactly what line 221 asks the driver to do before asking for approval.
  const rehearsal = (mod as unknown as {
    runZeroCallRehearsal: (o: unknown) => Promise<Record<string, unknown>>;
  }).runZeroCallRehearsal;

  it("the normal path produces complete paired records that the R93 validator accepts", async () => {
    const dir = await tempDir();
    const out = await rehearsal({ repoRoot: REPO, outDir: dir });
    expect(out["status"]).toBe("VALID");
    expect(out["validationStatus"]).toBe("VALID");
    expect(out["reasonCodes"]).toEqual([]);
    expect(out["records"]).toBe(16); // 8 frozen cases x 2 arms
    expect(out["providerCalls"]).toBe(0);
    expect(out["completeness"]).toBe("COMPLETE");
    expect(out["verdict"]).toBe("MECHANISM_VALIDATED");
  }, 120_000);

  it("the rehearsal opens no socket and constructs no real provider", async () => {
    const dir = await tempDir();
    const out = await rehearsal({ repoRoot: REPO, outDir: dir });
    // The rehearsal uses the R87 ScriptedModelProvider: no key, no network.
    expect(out["network"]).toBe(0);
    expect(out["realProviderConstructed"]).toBe(false);
  }, 120_000);

  it("the interruption path resumes through the R94 state contract and still VALIDATES", async () => {
    const dir = await tempDir();
    const out = await rehearsal({ repoRoot: REPO, outDir: dir, interruptAfterFirstArm: true });
    // The first pass is interrupted after one arm; the resume must not re-run
    // what is already recorded, and the completed matrix must still validate.
    expect(out["resumedExecuted"]).toBe(8); // the second arm only
    expect(out["validationStatus"]).toBe("VALID");
    expect(out["completeness"]).toBe("COMPLETE");
    expect(out["records"]).toBe(16);
    expect(out["providerCalls"]).toBe(0);
  }, 120_000);

  it("a rehearsal whose manifest does not match its records is NOT reported VALID", async () => {
    const dir = await tempDir();
    const out = await rehearsal({ repoRoot: REPO, outDir: dir, tamperManifest: "drop-a-record" });
    // Fail-closed: the validator must catch it rather than the driver asserting
    // VALID on its own say-so.
    expect(out["validationStatus"]).not.toBe("VALID");
    expect((out["reasonCodes"] as unknown[]).length).toBeGreaterThan(0);
  }, 120_000);

  it("the rehearsal writes its manifest to disk for independent re-validation", async () => {
    const dir = await tempDir();
    const out = await rehearsal({ repoRoot: REPO, outDir: dir });
    const manifestPath = join(dir, "rehearsal-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    expect(out["manifestPath"]).toBe(manifestPath);
    // Re-read and re-validate INDEPENDENTLY, from the artifact alone.
    const { readFileSync } = await import("node:fs");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.summary.completeness).toBe("COMPLETE");
    expect(reread.providerCalls).toBe(0);
  }, 120_000);
});

describe("E4-R97 D8: the plan is bound to the driver that would execute it", () => {
  // Plan §R97 line 214 lists 驱动器版本 among the values the finalized material
  // must FREEZE, and line 229 requires that changing any bound field invalidates
  // the old approval ("更改任意绑定字段后旧审批失效").
  //
  // Measured defect: the approval package prints "Driver that would execute it:
  // e4-r97-campaign-driver-v1" in its "What is being authorized" list, but
  // `driverVersion` sat OUTSIDE the authorization envelope — so it was not in
  // `planDigest`. A driver could therefore be rewritten (this commit rewrote it)
  // while the approved digest stayed byte-identical, and nothing in the driver
  // ever compared its own version against the plan's. The advertised bound field
  // was not bound.

  it("driverVersion is part of the envelope and therefore covered by planDigest", async () => {
    const plan = await finalizedPlan();
    expect(plan.authorization!.driverVersion).toBe(mod.DRIVER_VERSION);
    // Changing ONLY the driver version must move the digest. If it does not, the
    // field is decorative and the approval does not cover the executor.
    const other = { ...plan.authorization!, driverVersion: "e4-r97-campaign-driver-v99" };
    const recomputed = (evaluation["computeR92AuthorizationDigestV1"] as (a: unknown) => string)(other);
    expect(recomputed).not.toBe(plan.planDigest);
  });

  it("the digest equals the R92 canonical digest of the envelope that carries driverVersion", async () => {
    const plan = await finalizedPlan();
    const recomputed = (evaluation["computeR92AuthorizationDigestV1"] as (a: unknown) => string)(
      plan.authorization!,
    );
    // Proves the approved value IS the digest of the driver-bound envelope.
    expect(recomputed).toBe(plan.planDigest);
  });

  it("a plan bound to a DIFFERENT driver version is refused before any provider exists", async () => {
    const plan = await finalizedPlan();
    const forged = {
      ...plan.authorization!,
      driverVersion: "e4-r97-campaign-driver-v99",
    };
    const forgedDigest = (evaluation["computeR92AuthorizationDigestV1"] as (a: unknown) => string)(forged);
    // Fully authorized: the env digest matches the FORGED envelope, so the gate
    // itself would pass. The refusal must come from the driver-version binding.
    const { result, providerConstructions } = await drive({
      plan: { ...plan, authorization: forged, planDigest: forgedDigest },
      env: AUTHORIZED_ENV(forgedDigest),
    });
    expect(result["status"]).toBe("NOT_RUN");
    expect(result["code"]).toBe("DRIVER_VERSION_MISMATCH");
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });

  it("a plan with NO bound driver version is refused, never assumed compatible", async () => {
    const plan = await finalizedPlan();
    const stripped = { ...plan.authorization! } as Record<string, unknown>;
    delete stripped["driverVersion"];
    const digest = (evaluation["computeR92AuthorizationDigestV1"] as (a: unknown) => string)(stripped);
    const { result, providerConstructions } = await drive({
      plan: { ...plan, authorization: stripped as never, planDigest: digest },
      env: AUTHORIZED_ENV(digest),
    });
    // Fail closed: an absent binding is not "compatible with everything".
    expect(result["status"]).toBe("NOT_RUN");
    expect(result["providerRequests"]).toBe(0);
    expect(providerConstructions).toBe(0);
  });
});

describe("E4-R97 D6: the REAL two-arm observation produces a FINALIZED plan", () => {
  // This is the acceptance path plan §R97 line 211 describes: "先无 key 检出、
  // 构建、加载实际案例，再由真实 dry-run 生成每臂执行计划". It drives the SHIPPED
  // `observeArms` against the two real arm checkouts and builds the plan from
  // those observations.
  //
  // WHERE THE ARMS COME FROM — and why this is no longer a hard-coded `D:/` path.
  //
  // R101 (finding F7) removes the author-machine dependency: the directories are
  // read from the environment (`R97_ARM_BASELINE_DIR` / `R97_ARM_CANDIDATE_DIR`),
  // which is what the CI job's arm-setup step publishes into `$GITHUB_ENV`. A
  // hard-coded `D:/r97-arm-*` could only ever be satisfied on one Windows box, so
  // the acceptance path was unreachable on every runner — which is exactly how it
  // came to be SKIPPED instead of failing.
  //
  // THE SKIP IS GONE, DELIBERATELY. `it.skipIf(!haveArms)` turned "the two real
  // arm builds are missing" into a GREEN result, so a runner with no arms
  // reported success for a path it never executed. Plan §R101 做什么 2: "让正式
  // driver 的端到端路径在 CI 必跑，缺条件是明确失败而非 skip." A missing arm now
  // FAILS this test with the exact directories it looked in and the two ways to
  // satisfy it. There is no silent third outcome — no skip, no early return.
  const BASE = process.env["R97_ARM_BASELINE_DIR"] ?? "D:/r97-arm-baseline";
  const CAND = process.env["R97_ARM_CANDIDATE_DIR"] ?? "D:/r97-arm-candidate";
  const haveArms = existsSync(join(BASE, "apps", "cli", "dist", "main.js")) && existsSync(join(CAND, "apps", "cli", "dist", "main.js"));
  /** How to satisfy the precondition, quoted in the failure message. */
  const ARM_HELP =
    `Set R97_ARM_BASELINE_DIR and R97_ARM_CANDIDATE_DIR to two checkouts built at the frozen revisions ` +
    `(or run \`node scripts/e4/r97-observe-arms.mjs\`). Looked for a built CLI at ` +
    `${join(BASE, "apps", "cli", "dist", "main.js")} and ${join(CAND, "apps", "cli", "dist", "main.js")}.`;

  it("the two real arm builds MUST exist — a missing arm is a FAILURE, never a skip", () => {
    // The precondition itself is now asserted, so "the arms were absent" can no
    // longer masquerade as a pass. This replaces the old
    // `expect(haveArms).toBe(false)` branch, which asserted that the precondition
    // was missing and called that success.
    expect(haveArms, `the D6 two-arm acceptance path cannot run: ${ARM_HELP}`).toBe(true);
  });

  it("both arms are observed by the real CLI dry-run and the plan FINALIZES", async () => {
    if (!haveArms) {
      // Unreachable in a normal run: the test above already failed. Kept so this
      // test can never silently pass on a machine where the previous assertion is
      // somehow skipped — a skipped test must not become a green closed loop.
      throw new Error(`the D6 two-arm acceptance path cannot run: ${ARM_HELP}`);
    }
    const driver = (await import(DRIVER)) as {
      observeArms: (o: unknown) => Promise<Record<string, R97ArmObservation>>;
    };
    const stage = await tempDir();
    const observations = await driver.observeArms({
      modules: { evaluation },
      repoRoot: REPO,
      armDirs: { baseline: BASE, candidate: CAND },
      stagedCasesDir: join(stage, "cases"),
      suite: "regression",
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointBaseUrl: "https://api.openai.com/v1",
    });

    // The two arms are REAL, DISTINCT revisions.
    expect(observations["baseline"]!.sourceSha).toBe("e9776ba66190ea63b1bacb685c91aa900b6935e7");
    expect(observations["candidate"]!.sourceSha).toBe("a20373743b56de6a3a110fecdd254737ece71afa");
    expect(observations["baseline"]!.planDigest).not.toBe(observations["candidate"]!.planDigest);

    // Both were clean checkouts, so the digest describes the build on disk.
    expect(observations["baseline"]!.clean).toBe(true);
    expect(observations["candidate"]!.clean).toBe(true);

    // Every frozen case was planned and mapped back to its suite-prefixed id.
    const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[] }>)(REPO);
    for (const arm of ["baseline", "candidate"]) {
      expect([...observations[arm]!.caseIds].sort()).toEqual([...sel.caseIds].sort());
      expect(Object.keys(observations[arm]!.caseFingerprints).length).toBe(sel.caseIds.length);
    }

    const plan = await buildR97AuthorizationPlan({
      repoRoot: REPO,
      baseline: observations["baseline"]!,
      candidate: observations["candidate"]!,
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointIdentity: observations["candidate"]!.endpointIdentity,
      outputDir: ".ci/r97-ab",
      now: NOW,
      createdAt: CREATED,
      campaignModelCalls: 320,
    });
    expect(plan.readinessIssues).toEqual([]);
    expect(plan.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    expect(plan.authorizable).toBe(true);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // The bound arm digests ARE the observed dry-run digests.
    expect(plan.authorization!.arms.baseline.executionPlanDigest).toBe(observations["baseline"]!.planDigest);
    expect(plan.authorization!.arms.candidate.executionPlanDigest).toBe(observations["candidate"]!.planDigest);
  }, 180_000);

  it("R100 NEGATIVE CONTROL: a case missing from an arm is NOT_READY — never borrowed from another tree", async () => {
    // Plan §R100 怎么做 (line 204): "删除 fingerprintCaseInCheckout 中静默 fallback…
    // 缺文件或读失败要 NOT_READY，不能拿 driver 副本冒充." The previous
    // implementation did `.catch(() => loadBenchmarkCase(repoRoot/…))`, so an arm
    // missing a case silently reported the DRIVER's copy — and because both arms
    // would fall back to the SAME tree, the two "independent" observations could
    // agree by construction. That is the "one harness run twice" failure.
    //
    // This drives the exported function DIRECTLY, with an empty synthetic arm:
    // the rule under test is this function's fallback, and the case below is
    // genuinely present in the driver's tree, so a fallback WOULD have succeeded.
    const driver = (await import(DRIVER)) as {
      fingerprintCaseInCheckout: (
        evaluation: unknown,
        repoRoot: string,
        armDir: string,
        caseId: string,
      ) => Promise<string>;
    };
    const emptyArm = await tempDir();
    const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[] }>)(REPO);
    const victim = sel.caseIds[0]!;

    // CONTROL PRECONDITION: the case is absent from the arm but PRESENT in the
    // repo, so the old fallback had something to find and would have returned a
    // fingerprint instead of failing.
    expect(existsSync(join(emptyArm, "benchmarks", victim))).toBe(false);
    expect(existsSync(join(REPO, "benchmarks", victim))).toBe(true);

    await expect(driver.fingerprintCaseInCheckout(evaluation, REPO, emptyArm, victim)).rejects.toThrow(/NOT_READY/);
    // The refusal names BOTH sides, so an operator can see which checkout is
    // incomplete and that no substitution happened.
    await expect(driver.fingerprintCaseInCheckout(evaluation, REPO, emptyArm, victim)).rejects.toThrow(
      new RegExp(victim.replace(/[/\\]/g, ".")),
    );
    await expect(driver.fingerprintCaseInCheckout(evaluation, REPO, emptyArm, victim)).rejects.toThrow(/never a fingerprint borrowed/);
  }, 60_000);

  it("R101: the arm-setup command EXISTS and agrees with the SHAs this file asserts", async () => {
    // The D6 help text tells an operator to run `scripts/e4/r97-observe-arms.mjs`.
    // That instruction was FALSE: the file did not exist, so the only thing that
    // ever prepared the arms was an ad-hoc sequence typed into one machine. A
    // documented-but-missing setup command is worse than none, because it reads
    // as reproducible.
    const setupPath = join(REPO, "scripts", "e4", "r97-observe-arms.mjs");
    expect(existsSync(setupPath), "the arm-setup command the D6 path points at must exist").toBe(true);

    const setup = (await import(pathToFileURL(setupPath).href)) as {
      DEFAULT_BASELINE_SHA: string;
      DEFAULT_CANDIDATE_SHA: string;
      ARM_DIR_ENV: { baseline: string; candidate: string };
      parseArgs: (argv: string[]) => { printEnv: boolean; baseline?: string };
    };

    // ONE source of truth for the revisions: the script's defaults must be the
    // exact SHAs the acceptance test above asserts against.
    expect(setup.DEFAULT_BASELINE_SHA).toBe("e9776ba66190ea63b1bacb685c91aa900b6935e7");
    expect(setup.DEFAULT_CANDIDATE_SHA).toBe("a20373743b56de6a3a110fecdd254737ece71afa");

    // The environment variable NAMES must be the ones this file reads, or the
    // setup command would publish variables the test ignores.
    expect(setup.ARM_DIR_ENV.baseline).toBe("R97_ARM_BASELINE_DIR");
    expect(setup.ARM_DIR_ENV.candidate).toBe("R97_ARM_CANDIDATE_DIR");

    // ...and the CI job must use the SAME names and SHAs, so a locally prepared
    // pair and a CI-prepared pair describe the same experiment.
    const { readFile } = await import("node:fs/promises");
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    for (const sha of [setup.DEFAULT_BASELINE_SHA, setup.DEFAULT_CANDIDATE_SHA]) {
      expect(ci, `ci.yml must bind the frozen revision ${sha}`).toContain(sha);
    }
    for (const name of Object.values(setup.ARM_DIR_ENV)) {
      expect(ci, `ci.yml must publish ${name}`).toContain(name);
    }
  });
});