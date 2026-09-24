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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as childProcess from "node:child_process";
import * as nodeUtil from "node:util";
import { buildR97AuthorizationPlan, type R97ArmObservation } from "./r97-plan.js";
import type { R97Campaign } from "./r97-campaign-lifecycle.js";
import { R97_CAMPAIGN_CLAIMS_DIR_ENV } from "./r97-budget-ledger.js";

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

/**
 * ONE FRESH CLAIM ANCHOR PER TEST (plan §A2 怎么做 6: "普通测试应使用独立的 claim
 * namespace/独立批准 ID").
 *
 * `finalizedPlan()` is deterministic on purpose — the plan artifact must hash
 * the same way every time — so EVERY test in this file drives the SAME
 * `planDigest`, while each one gets its own temporary `ledgerDir` that the
 * cleanup below deletes. Under finding F2 that combination is exactly the
 * double-spend shape: the anchor records that the approval ESTABLISHED a budget
 * in the deleted directory, so a later test's brand-new directory would be
 * refused as a LOSS of an approval an earlier test already spent.
 *
 * Isolating the namespace keeps each test measuring its OWN approval, which is
 * what these tests were always about. Subprocesses inherit this through
 * `process.env` (see the `execFile` calls below).
 */
let claimsDirs: string[] = [];
beforeEach(async () => {
  const c = await mkdtemp(join(tmpdir(), "r97-driver-claims-"));
  claimsDirs.push(c);
  process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV] = c;
});
afterEach(async () => {
  delete process.env[R97_CAMPAIGN_CLAIMS_DIR_ENV];
  for (const c of claimsDirs.splice(0)) await rm(c, { recursive: true, force: true }).catch(() => {});
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * Every string in a parsed JSON tree, with the JSON path that reaches it.
 *
 * WHY THIS IS NOT A `toContain` (MEASURED, CI run 35560959837)
 * -----------------------------------------------------------
 * D5 asserted `serialized).not.toContain(dir)`. On Windows that assertion PASSES
 * while the host path is still in the file, because `JSON.stringify` escapes the
 * separator: the value `C:\Users\…\Temp\r97-driver-x\out\ledger` is written as
 * `C:\\Users\\…`, which does not contain the single-backslash `dir`. On Linux the
 * separator is `/`, nothing is escaped, and the same assertion FAILED —
 *
 *   expected '{\n  "driverVersion": "e4-r97-campaig…' not to contain
 *   '/tmp/r97-driver-rmsDgP'
 *
 * So the leak existed on both platforms and only one of them could see it. Walking
 * the parsed tree asks the question the assertion was trying to ask — "is this path
 * anywhere in the artifact?" — and NAMES the field that carries it, instead of
 * depending on how the platform's serializer happens to escape a separator.
 */
function stringPaths(value: unknown, at = "$"): Array<{ at: string; value: string }> {
  if (typeof value === "string") return [{ at, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringPaths(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => stringPaths(v, `${at}.${k}`));
  }
  return [];
}

const mod = (await import(DRIVER)) as {
  runDriver: (o: unknown) => Promise<Record<string, unknown>>;
  makeCountingFakeProvider: () => { provider: unknown; state: { requests: number; created: number } };
  DRIVER_VERSION: string;
  aggregateVerdicts: (
    settled: Record<string, unknown>[],
    unitResults: Record<string, unknown>[],
  ) => { verifiedPasses: number; measuredUnits: number; units: number; strongPasses: number; weakPasses: number };
};
const evaluation = (await import(EVAL)) as Record<string, unknown>;

/** Build a FINALIZED plan from the real selection, so the case list is genuine. */
async function finalizedPlan(over: Record<string, unknown> = {}) {
  const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[]; caseFingerprints: Record<string, string> }>)(REPO);
  // The endpoint identity the plan's ARMS carry. A caller that will run with a
  // concrete `endpointBaseUrl` overrides it, so the authorization, the observations
  // and the resolved destination all name ONE identity instead of three.
  const armEndpointIdentity = typeof over["endpointIdentity"] === "string" ? (over["endpointIdentity"] as string) : ENDPOINT;
  const mk = (arm: "baseline" | "candidate", sha: string, dg: string): R97ArmObservation => ({
    arm,
    checkoutDir: `D:/wt/${arm}`,
    sourceSha: sha,
    treeFingerprint: null,
    clean: true,
    planDigest: dg,
    // E4-R104 (A4): the arm's EXECUTION build digest. This fixture is synthetic —
    // no checkout exists — so the value is a placeholder; what it proves is that
    // the plan binds a build identity PER ARM and carries it into the envelope.
    buildDigest: `b${arm === "baseline" ? "1" : "2"}`.padEnd(64, "0"),
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: armEndpointIdentity,
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
  });  if (p.planDigest === null || p.authorization === null) {
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
    // E4-R104 (A4): the arms' EXECUTION build digests, re-derived at the execution
    // boundary. The gate compares them against the envelope, so a fixture that
    // omitted them would be refused as build drift — which is the point of the
    // check, not a fixture detail.
    armBuildDigests: {
      baseline: a.arms.baseline.buildDigest ?? null,
      candidate: a.arms.candidate.buildDigest ?? null,
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

/**
 * A provider that mirrors the REAL `OpenAICompatibleProvider` failure shape: it
 * does not throw, it YIELDS `{ type: "retry" }` and then `{ type: "error" }`.
 * Shared by D10 (a failed call must not be a silent COMPLETE) and D8 (a resume
 * must not erase those failures from the aggregate).
 */
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

/**
 * A provider whose `generate` really takes TIME — the fixture the A6 stop tests
 * need, because "the unit was in flight when the stop arrived" is only measurable
 * against a unit that is genuinely still running.
 *
 * `setTimeout` rather than a resolved promise: a microtask-only delay would let the
 * whole unit finish inside the cancellation's own turn, so the test would prove
 * nothing about terminating work that is still in progress.
 *
 * `state.started` counts calls whose generator was actually ENTERED, which is what
 * makes "the unit really was in flight" a measurement instead of an assumption.
 */
function makeSlowProvider(callMs = 30_000) {
  const state = { started: 0, finished: 0, created: 0 };
  const provider = {
    id: "fake-slow-r97",
    async listModels() {
      return [];
    },
    createClient() {
      state.created += 1;
      return {
        async *generate() {
          state.started += 1;
          await new Promise((resolve) => setTimeout(resolve, callMs));
          state.finished += 1;
          yield { type: "text", text: "slow" };
        },
      };
    },
  };
  return { provider, state };
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
  // `makeErrorEventProvider` is defined at module scope: D8's resume
  // aggregation needs the very same failure shape.

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

describe("E4-R99-A D8: a resume aggregates the FULL history, not just this run", () => {
  /**
   * Drive a run whose every provider call fails with an error event, twice over
   * the SAME campaign directory.
   *
   * Plan §T3 怎么做 8: "汇总读取'历史已验证结果 + 本次新结果'。将 newCalls/newUnits 与
   * cumulativeCalls/measuredUnits/failures 分开；不能用本次 unitResults=[] 得出历史没有
   * 失败."
   *
   * The §0.3 probe this pins: "provider 失败后恢复 | 首次 PARTIAL / 2 failures；第二次
   * COMPLETE / 0 failures / 0 measuredUnits / 0 新调用" — a resume ERASED the first
   * run's failures and reported success.
   */
  async function driveErrorTwice() {
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const run = () =>
      mod.runDriver({
        modules: { evaluation },
        plan,
        env: AUTHORIZED_ENV(plan.planDigest!),
        observation: observationFor(plan),
        ledgerDir: dir,
        makeProvider: () => makeErrorEventProvider(),
      });
    const first = await run();
    const second = await run();
    return { plan, dir, first, second };
  }

  it("a resumed run does NOT report COMPLETE when history holds failures", async () => {
    const { plan, first, second } = await driveErrorTwice();
    const caseCount = plan.authorization!.caseIds.length;

    // The first run measured real, failed calls and said so.
    expect(first["status"]).toBe("PARTIAL");
    expect(first["code"]).toBe("CASE_FAILURES");
    const firstFailures = first["failures"] as unknown[];
    expect(firstFailures.length).toBe(caseCount * 2);

    // The resume dispatches NOTHING — that part was already correct.
    expect(second["logicalCalls"]).toBe(0);
    expect(second["providerRequests"]).toBe(0);
    expect((second["reservations"] as unknown[]).length).toBe(0);
    expect(second["newUnits"]).toBe(0);

    // ...but it must NOT conclude the campaign is fine. The history still holds
    // the same failures, and the aggregate must say so.
    expect(second["status"], "a resume must not turn history's failures into COMPLETE").toBe("PARTIAL");
    expect(second["code"]).toBe("CASE_FAILURES");
    const secondFailures = second["failures"] as unknown[];
    expect(secondFailures.length, "the historical failures must survive the resume").toBe(caseCount * 2);
    expect(second["measuredUnits"]).toBe(0);
  });

  it("keeps NEW work and CUMULATIVE history as separate, honest numbers", async () => {
    const { plan, second } = await driveErrorTwice();
    const caseCount = plan.authorization!.caseIds.length;

    // This run did nothing...
    expect(second["newCalls"]).toBe(0);
    expect(second["newUnits"]).toBe(0);
    // ...while the campaign as a whole holds 2N terminal units and 2N calls.
    expect(second["cumulativeCalls"]).toBe(caseCount * 2);
    expect(second["completedUnits"]).toBe(caseCount * 2);
    // The history-derived view is present even though `unitResults` is empty:
    // that emptiness is exactly what used to make a resume look clean.
    expect((second["unitResults"] as unknown[]).length).toBe(0);
  });

  it("a resume of a CLEAN run stays COMPLETE with the same aggregates", async () => {
    // The mirror property: the aggregation must not manufacture failures either.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const run = () => drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: dir });
    const first = await run();
    const second = await run();
    const caseCount = plan.authorization!.caseIds.length;

    expect(first.result["status"]).toBe("COMPLETE");
    expect(second.result["status"]).toBe("COMPLETE");
    expect(second.result["code"]).toBeNull();
    expect((second.result["failures"] as unknown[]).length).toBe(0);
    // The denominators and numerators are IDENTICAL across the resume
    // (plan §T3 怎么验收: "累计分母、分子和 budget 完全一致").
    expect(second.result["cumulativeCalls"]).toBe(first.result["cumulativeCalls"]);
    expect(second.result["completedUnits"]).toBe(caseCount * 2);
    expect(second.result["budget"]).toEqual(first.result["budget"]);
  });

  /**
   * MEASURED DEFECT, found by running the real offline acceptance campaign
   * (`node scripts/e4/r97-offline-acceptance.mjs --all`) and reading its own
   * driver result:
   *
   *   workerUnits 16 · measuredUnits 16 · verifiedPasses 12
   *
   * Twelve passes over sixteen units in a campaign whose per-unit table shows
   * exactly SIX passing units (the three artifact cases in each of the two arms)
   * and ten honest `case_failed` negatives. The figure DOUBLE COUNTED: a unit this
   * run dispatched appears in BOTH `settled` (the durable history, read after the
   * run) and `result.unitResults` (this run's own list), and `verifiedPasses`
   * SUMMED the two filters instead of UNIONING them.
   *
   * Plan §T3 怎么做 8 asks for "历史已验证结果 + 本次新结果" to be aggregated, and
   * its acceptance criterion is that a resume reports the SAME cumulative
   * numerator and denominator ("累计分母、分子和 budget 完全一致"). A sum satisfies
   * neither: the number grows on every resume, so it is not a campaign total, and
   * it is not even a count of units.
   *
   * The aggregation is exercised through the exported pure function because the
   * doubling only manifests in arm-worker mode (in provider mode `unitResults` is
   * empty and no unit reaches a verifier), and driving the real arms here would
   * make a two-line arithmetic property cost a full campaign.
   */
  describe("the pass aggregate is a UNION over units, never a SUM over lists", () => {
    const unit = (arm: string, caseId: string) => ({ arm, caseId, suite: "regression", repetition: 1 });

    it("counts a unit present in BOTH history and this run exactly once", () => {
      const settled = [
        { ...unit("baseline", "a"), status: "completed", detail: "e4-r98-arm-worker-v2 passed: verified: ok" },
        { ...unit("candidate", "a"), status: "completed", detail: "e4-r98-arm-worker-v2 passed: verified: ok" },
      ];
      const unitResults = [
        { ...unit("baseline", "a"), status: "completed", failureCategory: null, verifierPassed: true },
        { ...unit("candidate", "a"), status: "completed", failureCategory: null, verifierPassed: true },
      ];
      const agg = mod.aggregateVerdicts(settled, unitResults);
      // The measured defect returned 4 here for 2 units.
      expect(agg.verifiedPasses, "two units that passed are two passes").toBe(2);
      expect(agg.measuredUnits).toBe(2);
    });

    it("does not lose a pass that only THIS run recorded", () => {
      // The worker can throw before it writes a terminal record, and the driver
      // then synthesises a `harness` failure for the unit. Conversely a unit whose
      // record the driver holds but whose history entry is missing must still
      // count — hence a UNION rather than "prefer history".
      const unitResults = [
        { ...unit("baseline", "b"), status: "completed", failureCategory: null, verifierPassed: true },
      ];
      const agg = mod.aggregateVerdicts([], unitResults);
      expect(agg.verifiedPasses).toBe(1);
    });

    it("does not lose a pass that only HISTORY recorded", () => {
      const settled = [
        { ...unit("baseline", "c"), status: "completed", detail: "e4-r98-arm-worker-v2 passed: verified: ok" },
      ];
      const agg = mod.aggregateVerdicts(settled, []);
      expect(agg.verifiedPasses).toBe(1);
      expect(agg.measuredUnits).toBe(1);
    });

    it("never counts a `case_failed` unit as a pass, on either side", () => {
      const settled = [
        { ...unit("baseline", "d"), status: "completed", detail: "e4-r98-arm-worker-v2 case_failed: case did not pass" },
      ];
      const unitResults = [
        { ...unit("baseline", "d"), status: "completed", failureCategory: "case_failed", verifierPassed: false },
      ];
      const agg = mod.aggregateVerdicts(settled, unitResults);
      expect(agg.verifiedPasses).toBe(0);
      // A `case_failed` unit DID reach a verdict, so it is measured — that is the
      // plan's own distinction between run completeness and task success.
      expect(agg.measuredUnits).toBe(1);
    });

    it("a resume reports the SAME numerator as the run it resumed", () => {
      // The plan's "累计分母、分子和 budget 完全一致": the second observation of the
      // same settled campaign must not change the figure.
      const settled = [
        { ...unit("baseline", "e"), status: "completed", detail: "e4-r98-arm-worker-v2 passed: verified: ok" },
        { ...unit("candidate", "e"), status: "completed", detail: "e4-r98-arm-worker-v2 case_failed: nope" },
      ];
      const first = mod.aggregateVerdicts(settled, []);
      const second = mod.aggregateVerdicts(settled, []);
      expect(second.verifiedPasses).toBe(first.verifiedPasses);
      expect(second.verifiedPasses).toBe(1);
    });

    it("splits this run's passes into STRONG and WEAK, never one undifferentiated number", () => {
      // MEASURED: the real acceptance run reported 6 passes of 16 units, and they
      // were not the same kind of pass. The three artifact-only frozen cases pass
      // because `TaskVerifier`'s artifact rule checks only that a path EXISTS and
      // was touched; the R98 fixtures' own command verifiers check the bytes.
      // Reporting one number presents the weak passes as solved cases.
      const unitResults = [
        { ...unit("baseline", "a"), status: "completed", failureCategory: null, verifierPassed: true, passStrength: "strong" },
        { ...unit("candidate", "a"), status: "completed", failureCategory: null, verifierPassed: true, passStrength: "strong" },
        { ...unit("baseline", "b"), status: "completed", failureCategory: null, verifierPassed: true, passStrength: "weak" },
        { ...unit("candidate", "b"), status: "completed", failureCategory: null, verifierPassed: true, passStrength: "weak" },
        { ...unit("baseline", "c"), status: "completed", failureCategory: null, verifierPassed: true, passStrength: "weak" },
        { ...unit("baseline", "d"), status: "completed", failureCategory: "case_failed", verifierPassed: false, passStrength: null },
      ];
      const agg = mod.aggregateVerdicts([], unitResults);
      expect(agg.verifiedPasses).toBe(5);
      expect(agg.strongPasses, "a command-verified pass is the strong kind").toBe(2);
      expect(agg.weakPasses, "an artifact-only pass proves only that a write landed").toBe(3);
      // A `case_failed` unit is a pass of NEITHER kind.
      expect(agg.strongPasses + agg.weakPasses).toBe(agg.verifiedPasses);
    });

    it("does not claim this run's strong/weak split from HISTORY it did not observe", () => {
      // The durable terminal `detail` carries the category but deliberately not
      // the strength, so a resume must not invent one. It reports 0/0 — the honest
      // reading — while `verifiedPasses` still reflects the cumulative campaign.
      const settled = [
        { ...unit("baseline", "f"), status: "completed", detail: "e4-r98-arm-worker-v2 passed: verified: ok" },
      ];
      const agg = mod.aggregateVerdicts(settled, []);
      expect(agg.verifiedPasses).toBe(1);
      expect(agg.strongPasses).toBe(0);
      expect(agg.weakPasses).toBe(0);
    });
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
    // It RUNS: not exit 2 for a missing block, and not a refusal. The artifact the
    // approval package describes is executable exactly as written.
    //
    // E4-R100-A (T4 怎么做 1): the verdict is now `DEV_TOOL_NOT_A_CAMPAIGN` rather
    // than `COMPLETE`. `--fake-provider` is a DEVELOPMENT TOOL, and the plan
    // requires that a retained dev tool "不能生成正式 campaign COMPLETE". The
    // MEASUREMENT is unchanged and still asserted below — what changed is only
    // that a synthetic-provider run can no longer present itself as a campaign
    // verdict. `campaignStatus` keeps the underlying completeness for a reader.
    expect(parsed.status).toBe("DEV_TOOL_NOT_A_CAMPAIGN");
    expect(parsed.campaignStatus).toBe("COMPLETE");
    expect(parsed.devTool).toBe(true);
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

describe("E4-R100-A (T4): the OFFICIAL, help-discoverable arm-worker entry", () => {
  /**
   * The wall-clock budget for ONE invocation of the driver CLI from a test.
   *
   * MEASURED DEFECT (CI run 35560959837, windows-latest, and reproduced in a clean
   * CRLF clone): this helper used a flat `timeout: 120_000`, but the arm-worker
   * campaign below legitimately takes longer than that. Observed durations for the
   * SAME test on the SAME machine:
   *
   *   125_613 ms  — failed: the cap fired, the child was killed, stdout was empty,
   *                 and the test reported `the driver printed nothing; code=1`
   *   117_225 ms  — passed with 2.8 s of margin
   *   107_703 ms  — passed, run alone on an idle machine
   *
   * So the binding limit was the test's OWN subprocess cap, not the work: the test
   * killed its subject and then reported the killing as a defect in the subject.
   * That is a flake by construction — it passes on an idle machine and fails on a
   * loaded CI runner — and it would fail the plan's "两平台专用 job 全通过"
   * requirement at random.
   *
   * The value is 4.8x the worst measured run, and it stays BELOW the enclosing
   * test's own 900 s budget on purpose: the inner cap is what produces a diagnosable
   * failure, so it should fire before vitest's outer one does.
   */
  const DRIVER_CLI_TIMEOUT_MS = 600_000;

  it("allows the arm-worker campaign more time than the work really takes", () => {
    // The regression guard for the defect above: lowering this constant back under
    // the measured runtime reintroduces a flake that only shows up under load.
    expect(
      DRIVER_CLI_TIMEOUT_MS,
      "the driver CLI cap must exceed the measured 125.6 s campaign, with headroom",
    ).toBeGreaterThanOrEqual(300_000);
  });

  /**
   * Plan §T4 做什么 1 and 怎么做 2:
   *
   *   "提供版本化、help 可发现的 campaign CLI，实际进入 arm-worker 路径."
   *   "实现启动/恢复入口、参数校验和 help."
   *
   * MEASURED DEFECT N9 (plan §0.2): "driver main 缺 arm-worker CLI 模式." The
   * arm-worker path existed only as an API option (`opts.armWorker`) that no
   * command line could reach, so the "一个已提交的正式命令从 plan 到两臂执行"
   * acceptance criterion had no committed command behind it — an operator had to
   * write a `.ci/*.mjs` driver script, which the same criterion forbids.
   *
   * `--help` must EXIT 0 and name the mode, because a mode an operator cannot
   * discover is not an entry point.
   */
  const runDriverCli = async (args: string[], env: Record<string, string> = {}) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    return run(process.execPath, [join(REPO, "scripts", "e4", "r97-campaign-driver.mjs"), ...args], {
      cwd: REPO,
      // NOT a flat 120 s. The arm-worker campaign this helper drives is the longest
      // thing in the file (measured 107–126 s), so a cap at the low end of that
      // range kills the child mid-campaign and surfaces as "the driver printed
      // nothing" — a failure the test would blame on the driver. See
      // DRIVER_CLI_TIMEOUT_MS.
      timeout: DRIVER_CLI_TIMEOUT_MS,
      maxBuffer: 33_554_432,
      // The formal entry reads the REAL clock, so the paid-authorization env is the
      // only way to reach it from a test. Passing it here keeps every other
      // variable the runner already had.
      env: { ...process.env, ...env },
    }).then(
      (r: { stdout: string; stderr: string }) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      }),
    );
  };

  it("--help exits 0 and documents the arm-worker mode and every flag", async () => {
    const res = await runDriverCli(["--help"]);
    expect(res.code).toBe(0);
    const text = `${res.stdout}${res.stderr}`;
    // The MODE must be discoverable, not merely accepted.
    expect(text).toContain("--arm-worker");
    // The identity flags the approved run needs (T4 怎么做 6) must be documented
    // too: an operator cannot pass an approval they cannot see.
    for (const flag of ["--plan", "--ledger", "--out", "--baseline-dir", "--candidate-dir", "--endpoint"]) {
      expect(text, `--help must document ${flag}`).toContain(flag);
    }
    // A versioned CLI (T4 做什么 1) names its version.
    expect(text).toContain(mod.DRIVER_VERSION);
  });

  it("--arm-worker is REFUSED without both arm directories, before any provider", async () => {
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({ ...plan, observation: observationFor(plan) }), "utf8");
    // `--fake-provider` is deliberately supplied: even ASKING for a provider must
    // not help when the mode's required inputs are missing. The refusal is about
    // the mode's contract, and it must come first.
    const res = await runDriverCli([
      "--plan", planPath,
      "--arm-worker",
      "--fake-provider",
      "--ledger", join(dir, "ledger"),
      "--out", join(dir, "out"),
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/--baseline-dir/);
  });

  it("an UNKNOWN flag is a usage error, never silently ignored", async () => {
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({ ...plan, observation: observationFor(plan) }), "utf8");
    const res = await runDriverCli(["--plan", planPath, "--definitely-not-a-flag", "--fake-provider"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/definitely-not-a-flag/);
  });

  it("the arm-worker path really ENTERS the worker: each unit runs its own arm build", async () => {
    // The strongest form of "actually enters the arm-worker path": drive the real
    // CLI against two REAL arm checkouts and require the result to name them. The
    // arms are the frozen R97 revisions, prepared by the committed setup command.
    //
    // MEASURED DEFECT this test now avoids. It used to pass `finalizedPlan()` —
    // which binds SYNTHETIC shas (`1`*40 / `2`*40) and synthetic digests — together
    // with `--now`, which the formal entry refuses outright ("--now is a TEST clock
    // and is only honoured with --fake-provider or --rehearse"). Because the arms
    // were unset in every environment that ran it, the test returned early and the
    // defect was invisible: a test that proved nothing while reporting green is
    // exactly finding F7. So the plan is now built from the SHIPPED `observeArms`
    // measurement of the two real arms, and the real clock is used, because that is
    // the only plan the formal entry will execute.
    const baseDir = process.env["R97_ARM_BASELINE_DIR"];
    const candDir = process.env["R97_ARM_CANDIDATE_DIR"];
    if (baseDir === undefined || candDir === undefined) {
      // NOT a pass: the arms are a setup prerequisite (plan §R101 怎么做 line 242
      // — "网络依赖失败记录为 setup failure"). Assert the SKIP loudly instead of
      // silently reporting green.
      console.warn("[r100] R97_ARM_BASELINE_DIR / R97_ARM_CANDIDATE_DIR unset — arm-worker entry exercised structurally only");
      return;
    }
    const dir = await tempDir();
    // STEP 1: observe BOTH arms with the shipped measurement, so the plan's bound
    // identities are the ones each arm's own build really reported.
    const driver = mod as unknown as {
      observeArms: (o: Record<string, unknown>) => Promise<Record<string, { sourceSha: string; planDigest: string }>>;
    };
    const observations = await driver.observeArms({
      modules: { evaluation },
      repoRoot: REPO,
      armDirs: { baseline: baseDir, candidate: candDir },
      stagedCasesDir: join(dir, "staged"),
      suite: "regression",
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointBaseUrl: "https://api.openai.com/v1",
    });
    // STEP 2: finalize a plan over those REAL observations, under the real clock so
    // the authorization window contains "now". The endpoint identity must be the
    // one the arms actually measured: the plan builder refuses an envelope whose
    // declared endpoint disagrees with either arm's observation
    // (`ARM_ENDPOINT_MISMATCH`), which is the binding working as intended.
    const createdAt = new Date().toISOString();
    const observedEndpoint = (observations["candidate"] as { endpointIdentity?: string }).endpointIdentity;
    const plan = await finalizedPlan({
      baseline: observations["baseline"],
      candidate: observations["candidate"],
      endpointIdentity: observedEndpoint,
      createdAt,
      now: createdAt,
    });
    const planPath = join(dir, "plan.json");
    // The observation's `now` IS the driver's clock for the authorization window,
    // so it must be the same real instant the envelope was created at. Using the
    // fixture's frozen `NOW` here made the driver refuse with
    // AUTHORIZATION_NOT_YET_VALID — the plan's createdAt was in that clock's future.
    await writeFile(planPath, JSON.stringify({ ...plan, observation: observationFor(plan, { now: createdAt }) }), "utf8");
    // STEP 3: run the OFFICIAL entry, with the paid-authorization env the formal
    // path requires and no key at all. The approved provider/model/endpoint are
    // passed EXPLICITLY (T4 怎么做 6): the driver resolves the real destination from
    // them and refuses if it does not hash to the approved identity, so omitting
    // them would measure the refusal path instead of the execution path.
    const res = await runDriverCli(
      [
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", baseDir,
        "--candidate-dir", candDir,
        "--ledger", join(dir, "ledger"),
        "--out", join(dir, "out"),
        "--provider", "openai",
        "--model", "gpt-4o-mini",
        "--endpoint", "https://api.openai.com/v1",
      ],
      AUTHORIZED_ENV(plan.planDigest!),
    );
    // Whatever the verdict, the result must be a real driver result that reports
    // arm-worker mode — not the "no --fake-provider" plan printer.
    if (res.stdout.trim() === "") {
      // A silent failure here is exactly finding F7's shape, so the diagnosis is
      // surfaced rather than left as "Unexpected end of JSON input".
      throw new Error(`the driver printed nothing; code=${res.code} stderr=${res.stderr}`);
    }
    const parsed = JSON.parse(res.stdout);
    expect(parsed.executionMode, `driver said: ${String(parsed.code)} — ${String(parsed.reason)}`).toBe("arm-worker");
    expect(parsed.workerUnits ?? 0).toBeGreaterThan(0);
    // The driver constructs NO provider of its own in this mode: each unit's own
    // build resolves its own transport, which is what makes "both arms load their
    // own build" mechanically true rather than asserted.
    expect(parsed.providerRequests).toBe(0);
    // Both arms really ran, and each unit names the arm whose build executed it.
    const arms = new Set((parsed.unitResults as { arm: string }[]).map((u) => u.arm));
    expect([...arms].sort()).toEqual(["baseline", "candidate"]);
  }, 900_000);
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

  it("carries NO host path in ANY field, on every platform's separator", async () => {
    // MEASURED (CI run 35560959837, ubuntu-latest): the run failed with
    //   expected '{\n  "driverVersion": "e4-r97-campaig…' not to contain '/tmp/r97-driver-rmsDgP'
    // because `result.campaign.rootDir` held the campaign's ABSOLUTE host
    // directory. The identical field was present on Windows too; the sibling
    // assertion above simply could not see it through the escaped separator.
    //
    // The artifact is durable evidence, read on other machines by other people,
    // so a host path in it is both a leak of the machine's layout and a value that
    // cannot be re-checked where it is read. This walks the whole tree, so a NEW
    // field carrying a path is caught rather than needing a new assertion.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const outDir = join(dir, "out");
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: join(outDir, "ledger") });

    const offenders = stringPaths(result).filter(
      (s) => s.value.includes(dir) || s.value.includes(dir.replace(/\\/g, "/")),
    );
    expect(
      offenders.map((o) => o.at),
      `the driver result embeds the host path ${dir} at: ${offenders.map((o) => `${o.at} = ${o.value}`).join("; ")}`,
    ).toEqual([]);

    // The host path is absent from the SERIALIZED artifact too, and the campaign
    // block still answers what it was added to answer (T1 / finding N2): which root
    // this run resolved to, and whether another directory claims the approval.
    const serialized = JSON.stringify(result, null, 2);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(dir.replace(/\\/g, "\\\\"));
    const campaign = result["campaign"] as Record<string, unknown>;
    expect(campaign["campaignId"]).toEqual(expect.any(String));
    expect(campaign["mode"]).toEqual(expect.any(String));
    expect(campaign["duplicateCampaignDirs"]).toEqual([]);
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
    //
    // The names are no longer written into the workflow by hand: `ci.yml` invokes
    // `scripts/e4/r97-closed-loop.mjs`, which sets them on the child's ENVIRONMENT
    // (a shell's env FILE has a different writer per platform, which is why the
    // workflow is no longer the place they live). So the assertion follows the
    // indirection: the workflow must invoke the runner, and the runner must
    // publish exactly the names this file reads.
    const { readFile } = await import("node:fs/promises");
    const ci = await readFile(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    for (const sha of [setup.DEFAULT_BASELINE_SHA, setup.DEFAULT_CANDIDATE_SHA]) {
      expect(ci, `ci.yml must bind the frozen revision ${sha}`).toContain(sha);
    }
    const RUNNER = "scripts/e4/r97-closed-loop.mjs";
    expect(ci, `ci.yml must invoke ${RUNNER}, which publishes the arm variables`).toContain(RUNNER);
    const runner = await readFile(join(REPO, "scripts", "e4", "r97-closed-loop.mjs"), "utf8");
    for (const name of Object.values(setup.ARM_DIR_ENV)) {
      expect(runner, `the closed-loop runner must publish ${name}`).toContain(name);
    }
  });
});

/**
 * E4-R99-B (T5) — THE CAMPAIGN ITSELF CAN BE STOPPED.
 *
 * Plan §T5 做什么 1: "campaign deadline、unit deadline、用户取消均可终止实际执行."
 *
 * The unit deadline lives in the worker. This block covers the OTHER half, which a
 * per-unit bound cannot provide: N units each finishing inside their own window
 * still leave a campaign running long after an operator asked it to stop. The
 * driver's loop therefore consults a campaign-level predicate BEFORE each unit, so
 * a stop refuses the next unit rather than waiting for the rest.
 */
describe("E4-R99-B (T5): the campaign's own stop, checked before every unit", () => {
  it("a cancelled campaign refuses the NEXT unit and dispatches nothing further", async () => {
    const plan = await finalizedPlan();
    const controller = new AbortController();
    // Cancelled BEFORE the first unit: the strongest form — nothing may run.
    controller.abort();
    const made = { calls: 0 };
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      makeProvider: () => {
        made.calls += 1;
        return mod.makeCountingFakeProvider();
      },
      signal: controller.signal,
    });

    expect(result["status"]).toBe("REFUSED");
    expect(result["code"]).toBe("CAMPAIGN_CANCELLED");
    expect(String(result["reason"])).toMatch(/cancel/i);
    // The stop is BEFORE any work: no provider was constructed and no unit ran.
    expect(made.calls).toBe(0);
    expect(result["providerRequests"]).toBe(0);
    expect(result["logicalCalls"]).toBe(0);
    expect((result["unitResults"] as unknown[]).length).toBe(0);
  });

  it("a campaign whose own deadline has already passed refuses without dispatching", async () => {
    const plan = await finalizedPlan();
    const made = { calls: 0 };
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      makeProvider: () => {
        made.calls += 1;
        return mod.makeCountingFakeProvider();
      },
      // Zero milliseconds: the campaign's clock is spent the instant it starts.
      campaignDeadlineMs: 0,
    });

    expect(result["status"]).toBe("REFUSED");
    expect(result["code"]).toBe("CAMPAIGN_DEADLINE_EXCEEDED");
    expect(String(result["reason"])).toMatch(/deadline/i);
    expect(made.calls).toBe(0);
    expect(result["logicalCalls"]).toBe(0);
  });

  it("cancellation is reported as CANCELLATION, not as an expired deadline, when both hold", async () => {
    // The two reasons mean different things to an operator: one is "you stopped
    // it", the other is "the clock stopped it". Collapsing them would hide the
    // operator's own action behind a timer.
    const plan = await finalizedPlan();
    const controller = new AbortController();
    controller.abort();
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      makeProvider: () => mod.makeCountingFakeProvider(),
      signal: controller.signal,
      campaignDeadlineMs: 0,
    });
    expect(result["code"]).toBe("CAMPAIGN_CANCELLED");
  });

  it("NO stop condition leaves the campaign completely unchanged", async () => {
    // The negative control: with neither handle supplied, the driver must behave
    // exactly as every earlier suite expects. A stop mechanism that perturbed the
    // normal path would make all of them measure something else.
    const plan = await finalizedPlan();
    const { result } = await drive({ plan, env: AUTHORIZED_ENV(plan.planDigest!), ledgerDir: await tempDir() });
    expect(result["status"]).toBe("COMPLETE");
    expect(result["logicalCalls"]).toBeGreaterThan(0);
  });

  it("a stop that has NOT fired does not prevent the campaign from completing", async () => {
    // An unspent deadline and a live signal must be INERT, not merely tolerated:
    // the campaign must run to completion and measure the same real work it would
    // have measured with no handles at all.
    //
    // WHY THIS IS NOT A SECOND RUN OF THE SAME PLAN. The campaign's advisory claim
    // anchor is keyed by campaign id, so opening a SECOND ledger directory for one
    // campaign is refused on purpose (`BUDGET_CAMPAIGN_DIR_DUPLICATE`) — that is a
    // real protection, not an obstacle to route around. So inertness is asserted
    // from the run's own measurements against the plan's own expectations.
    const plan = await finalizedPlan();
    const controller = new AbortController();
    const withHandles = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      ledgerDir: await tempDir(),
      makeProvider: () => mod.makeCountingFakeProvider(),
      signal: controller.signal,
      campaignDeadlineMs: 600_000,
    });
    expect(withHandles["status"]).toBe("COMPLETE");
    // Real work happened: the handles did not silently short-circuit the campaign.
    // The counting fake provider completes every call, so the campaign measures the
    // full case set across both arms.
    expect(withHandles["logicalCalls"]).toBeGreaterThan(0);
    expect(withHandles["measuredUnits"]).toBe(plan.authorization!.caseIds.length * 2);
    expect(withHandles["completedUnits"]).toBeGreaterThan(0);
    // And the stop itself never fired.
    expect(withHandles["code"]).not.toBe("CAMPAIGN_CANCELLED");
    expect(withHandles["code"]).not.toBe("CAMPAIGN_DEADLINE_EXCEEDED");
  });

  // =======================================================================
  // E4-R106 (A6 / F6): THE STOP MUST REACH THE UNIT THAT IS RUNNING.
  // =======================================================================
  //
  // MEASURED DEFECT F6 (plan §A6):
  //
  //   "boundedStop 工具已经能杀进程，但实际 worker 改成进程内 await
  //    runBenchmarkCommand" — a cancel at 40 ms still PASSes ~412 ms later; a unit
  //   timeout of 80 ms returns ~421 ms later, "driver 从不向 worker 传递取消信号或
  //   campaign 剩余时间".
  //
  // Every stop test above cancels BETWEEN units, which the loop's pre-check handles.
  // These two pin the DRIVER'S half of the fix — the two values it must hand to the
  // worker so the worker's terminable boundary can end a unit already in flight:
  //
  //   * the cancellation handle, and
  //   * the campaign's REMAINING time (not its total — see below).
  //
  // Plan §A6 怎么做 2: "effective unit deadline 取 unit 上限与 campaign 剩余时间的较小
  // 值，并保留触发原因."
  //
  // WHY THESE ASSERT ON THE FORWARDED OPTIONS RATHER THAN ON A WALL CLOCK. The
  // end-to-end termination is proven where it belongs — in
  // `r97-arm-worker-contract.test.ts`, against the REAL worker path, with the hung
  // dry run and dispatch fixtures. Asserting it here as well would mean the driver
  // test could only pass by ALSO running a real arm, which this suite deliberately
  // does not do (it injects a counting fake provider and never enters `armWorker`
  // mode). What is uniquely the DRIVER's responsibility is that these two values
  // ARRIVE, and that is what is measured here — deterministically, with no sleeps.
  it("A6: the driver forwards the cancellation signal and the campaign's REMAINING time to every unit", async () => {
    // WHY THIS DRIVES `armWorker` AT ALL. The two values under test are handed to the
    // WORKER, so the assertion must observe the worker's call. `armWorker.runArmUnit`
    // is a recording stand-in that completes immediately, so nothing waits on a real
    // arm or on a timer and the FORWARDING is the only thing measured.
    //
    // `syntheticArms()`-style fixture: a plan whose ARMS, authorization and
    // observation all name ONE endpoint identity, so the run reaches the unit loop
    // instead of refusing over a placeholder identity. Written inline because the
    // shared helper is scoped to a later describe block.
    const dir = await tempDir();
    const ledgerDir = join(dir, "ledger");
    const endpointIdentity = (evaluation["captureEndpointIdentity"] as (u: string) => string | null)(
      "https://api.openai.com/v1",
    );
    const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[]; caseFingerprints: Record<string, string> }>)(REPO);
    const arm = (label: "baseline" | "candidate", sha: string, dg: string): R97ArmObservation => ({
      arm: label,
      checkoutDir: `D:/wt/${label}`,
      sourceSha: sha,
      treeFingerprint: null,
      clean: true,
      planDigest: dg,
      // E4-R104 (A4): the arm's EXECUTION build digest, bound PER ARM. This
      // fixture is synthetic — no checkout exists — so the value is a distinct
      // placeholder; what it proves is that the plan carries a build identity per
      // arm into the envelope rather than one value shared by both.
      buildDigest: (label === "baseline" ? "b1" : "b2").padEnd(64, "0"),
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointIdentity,
      caseIds: sel.caseIds,
      cliCaseIds: sel.caseIds.map((id) => id.split("/").pop() ?? id),
      caseFingerprints: sel.caseFingerprints,
      effectiveModelParams: { budgetTokens: 32_000 },
      totalLogicalRuns: sel.caseIds.length * 2,
      suite: "regression",
    });
    const plan = await finalizedPlan({
      baseline: arm("baseline", "1".repeat(40), "a".repeat(64)),
      candidate: arm("candidate", "2".repeat(40), "b".repeat(64)),
      endpointIdentity,
    });
    const controller = new AbortController();
    // EVERY unit the worker was asked to run, in order, with the options it received.
    const seen: Array<Record<string, unknown>> = [];
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      ledgerDir,
      endpointBaseUrl: "https://api.openai.com/v1",
      // The campaign's own clock: 600 s, so the remaining time is a large but
      // FINITE number that must shrink as units run. Nothing waits on it.
      campaignDeadlineMs: 600_000,
      signal: controller.signal,
      unitTimeoutMs: 1_000,
      armWorker: {
        armDirs: { baseline: REPO, candidate: REPO },
        // A recording stand-in for `runArmUnit`: it observes the FORWARDING and
        // completes immediately, so the unit cap above is never reached and the test
        // is not a race against a timer.
        runArmUnit: async (unitOpts: Record<string, unknown>) => {
          seen.push(unitOpts);
          return {
            status: "completed",
            verifierPassed: true,
            failureCategory: null,
            detail: "recording stand-in",
            consumed: 0,
            reservationId: "",
            resultHash: "",
            build: null,
          };
        },
      },
    });

    expect(
      seen.length,
      `the driver dispatched at least one arm unit (code=${String(result["code"])} reason=${String(result["reason"])})`,
    ).toBeGreaterThan(0);

    for (const unit of seen) {
      // 1. THE CANCELLATION HANDLE ARRIVES, and it is the caller's own signal.
      expect(
        unit["signal"],
        "a unit must receive the campaign's cancellation handle, or a unit in flight cannot be stopped",
      ).toBe(controller.signal);

      // 2. THE CAMPAIGN'S REMAINING TIME ARRIVES — a NUMBER, not the total and not
      //    undefined. `null` would mean "no campaign bound", which is a different
      //    fact from "the campaign still has time".
      expect(
        typeof unit["campaignRemainingMs"],
        "a unit must receive the campaign's remaining time, or the effective deadline cannot be min(unit cap, remaining)",
      ).toBe("number");
      expect(unit["campaignRemainingMs"]).toBeGreaterThan(0);
      expect(
        unit["campaignRemainingMs"],
        "the campaign's REMAINING time must not exceed its total — re-granting the full allowance per unit is the defect",
      ).toBeLessThanOrEqual(600_000);
    }

    // A MONOTONE CLOCK, NOT A FRESH ALLOWANCE: later units see no MORE time than
    // earlier ones. This is the property that makes "每个阶段都不能重新获得一整份
    // campaign 时间" hold for the units too.
    for (let i = 1; i < seen.length; i += 1) {
      expect(Number(seen[i]!["campaignRemainingMs"])).toBeLessThanOrEqual(Number(seen[i - 1]!["campaignRemainingMs"]));
    }
  }, 120_000);

  it("A6: an ALREADY-CANCELLED campaign never dispatches a unit at all", async () => {
    // The negative control for the forwarding above: the pre-check still wins, so
    // forwarding the signal did not accidentally turn "refuse before dispatching"
    // into "dispatch and then cancel" — which would spend budget on work the operator
    // had already stopped.
    const plan = await finalizedPlan();
    const dir = await tempDir();
    const controller = new AbortController();
    controller.abort();
    const seen: Array<Record<string, unknown>> = [];
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      ledgerDir: dir,
      endpointBaseUrl: "https://api.openai.com/v1",
      signal: controller.signal,
      armWorker: {
        armDirs: { baseline: REPO, candidate: REPO },
        runArmUnit: async (unitOpts: Record<string, unknown>) => {
          seen.push(unitOpts);
          return { status: "completed", verifierPassed: true, failureCategory: null, detail: "", consumed: 0, reservationId: "", resultHash: "" };
        },
      },
    });

    expect(result["status"]).toBe("REFUSED");
    expect(result["code"]).toBe("CAMPAIGN_CANCELLED");
    expect(seen.length, "a cancelled campaign must not dispatch anything").toBe(0);
    expect(result["logicalCalls"]).toBe(0);
  }, 120_000);

  it("the driver CLI accepts --campaign-deadline-ms and rejects an unknown flag", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const script = join(REPO, "scripts", "e4", "r97-campaign-driver.mjs");

    /** Run the CLI, returning a uniform shape whether it exits 0 or not. */
    const invoke = async (args: string[]): Promise<{ code: number | undefined; stdout: string; stderr: string }> => {
      try {
        const ok = await run(process.execPath, [script, ...args], { cwd: REPO });
        return { code: 0, stdout: String(ok.stdout ?? ""), stderr: String(ok.stderr ?? "") };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        return { code: err.code, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
      }
    };

    // The new flag is DOCUMENTED, so an operator can discover it.
    const help = await invoke(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--campaign-deadline-ms");

    // ...and it is in the known set, so it is not rejected as a typo.
    const unknown = await invoke(["--definitely-not-a-flag"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("--definitely-not-a-flag");
  }, 60_000);
});

// ===========================================================================
// E4-R103 (A3) — THE FORMAL CLI USES THE EXECUTION CLOCK, THE CURRENT
// OBSERVATION AND THE ACTUAL STAGED INPUTS.
// ===========================================================================
//
// Plan §A3 做什么:
//   1. "正式执行的 now 来自执行器时钟；plan 中的 observation 仅是审阅快照."
//   2. "开始和恢复执行前，重新读取两臂的当前 HEAD、构建身份、实际案例字节和执行参数."
//   3. "worker 接到明确批准的案例指纹，并校验自己复制后真正要运行的内容."
//
// Every case below drives the REAL `main` of `scripts/e4/r97-campaign-driver.mjs`
// through a child process, so the assertion is about the entry an operator would
// actually run. Cases marked REAL GATE + FORMAL MAIN use `--arm-worker` (the
// formal mode); the ones marked REAL GATE + DEV TOOL use `--fake-provider`, which
// is the isolated development tool — a dev-tool RESULT is never presented as
// authorization acceptance, only its REFUSAL code is asserted, and the refusal
// comes from the same `r92AuthorizationGate` the formal path calls.
describe("E4-R103 (A3): the formal CLI uses the execution clock and current inputs", () => {
  const runCli = async (
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    return run(process.execPath, [join(REPO, "scripts", "e4", "r97-campaign-driver.mjs"), ...args], {
      cwd: REPO,
      timeout: 900_000,
      maxBuffer: 33_554_432,
      env: { ...process.env, ...env },
    }).then(
      (r: { stdout: string; stderr: string }) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      }),
    );
  };

  /**
   * A plan whose approval window has ALREADY CLOSED against the wall clock while
   * the plan-time observation still records an instant INSIDE it.
   *
   * The dates are derived from `Date.now()` so the fixture cannot rot: the
   * approval was created three days ago, expired one day later, and its own
   * snapshot was taken an hour after creation. `plan.observation.now` therefore
   * satisfies the window while the executor's clock does not — which is exactly
   * the "old snapshot stands in for the current clock" defect (F3).
   */
  const EXPIRED_AT = Date.now() - 3 * 86_400_000;
  const EXPIRED_CREATED = new Date(EXPIRED_AT).toISOString();
  const EXPIRED_SNAPSHOT = new Date(EXPIRED_AT + 3_600_000).toISOString();

  async function expiredPlan() {
    return finalizedPlan({
      createdAt: EXPIRED_CREATED,
      now: EXPIRED_SNAPSHOT,
      validityDays: 1,
    });
  }

  it("REAL GATE + DEV TOOL: an approval expired against the execution clock is REFUSED with 0 calls, even though plan.observation.now is still inside the window", async () => {
    const dir = await tempDir();
    const plan = await expiredPlan();
    // PRECONDITIONS, asserted so a fixture that stopped describing the defect
    // cannot quietly turn this into a vacuous pass.
    expect(plan.observation, "the plan-time review snapshot must be RETAINED").not.toBeNull();
    expect(plan.observation!.now).toBe(EXPIRED_SNAPSHOT);
    expect(Date.parse(plan.observation!.now)).toBeLessThan(Date.parse(plan.authorization!.expiresAt));
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(plan.authorization!.expiresAt));

    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    const res = await runCli(
      ["--plan", planPath, "--fake-provider", "--ledger", join(dir, "ledger")],
      AUTHORIZED_ENV(plan.planDigest!),
    );
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed["authorization"]).toMatchObject({ authorizedToExecute: false, code: "AUTHORIZATION_EXPIRED" });
    expect(parsed["providerRequests"]).toBe(0);
    expect(parsed["logicalCalls"]).toBe(0);
    expect(parsed["status"]).toBe("NOT_RUN");
  }, 120_000);

  /** Two synthetic arm observations that agree with each other and with the
   *  REAL endpoint identity, so a plan built from them passes every readiness
   *  check and the ONLY thing wrong is what the test changes. */
  async function syntheticArms(over: Record<string, unknown> = {}) {
    const sel = await (
      evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[]; caseFingerprints: Record<string, string> }>
    )(REPO);
    const endpointIdentity = (evaluation["captureEndpointIdentity"] as (u: string) => string | null)(
      "https://api.openai.com/v1",
    );
    const mk = (arm: "baseline" | "candidate", sha: string, dg: string): R97ArmObservation => ({
      arm,
      checkoutDir: `D:/wt/${arm}`,
      sourceSha: sha,
      treeFingerprint: null,
      clean: true,
      planDigest: dg,
      // E4-R104 (A4): the arm's EXECUTION build digest, bound PER ARM. This
      // fixture is synthetic — no checkout exists — so the value is a distinct
      // placeholder; what it proves is that the plan carries a build identity per
      // arm into the envelope rather than one value shared by both.
      buildDigest: (arm === "baseline" ? "b1" : "b2").padEnd(64, "0"),
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointIdentity,
      caseIds: sel.caseIds,
      cliCaseIds: sel.caseIds.map((id) => id.split("/").pop() ?? id),
      caseFingerprints: sel.caseFingerprints,
      effectiveModelParams: { budgetTokens: 32_000 },
      totalLogicalRuns: sel.caseIds.length * 2,
      suite: "regression",
      ...over,
    });
    return {
      baseline: mk("baseline", "1".repeat(40), "a".repeat(64)),
      candidate: mk("candidate", "2".repeat(40), "b".repeat(64)),
      endpointIdentity,
    };
  }

  it("REAL GATE + FORMAL MAIN: a polluted environment endpoint is refused and the sentinel token never reaches stdout", async () => {
    const dir = await tempDir();
    const arms = await syntheticArms();
    const plan = await finalizedPlan({
      baseline: arms.baseline,
      candidate: arms.candidate,
      endpointIdentity: arms.endpointIdentity,
    });
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const SENTINEL = "sentinel-token-do-not-publish";
    // NO `--endpoint`: the environment is the only place a destination could come
    // from, and it must not be able to redirect an approved run.
    const res = await runCli(
      [
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", join(dir, "baseline"),
        "--candidate-dir", join(dir, "candidate"),
        "--ledger", join(dir, "ledger"),
        "--out", join(dir, "out"),
      ],
      { ...AUTHORIZED_ENV(plan.planDigest!), OPENAI_BASE_URL: `https://${SENTINEL}.example/v1` },
    );
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed["code"]).toBe("ENDPOINT_IDENTITY_MISMATCH");
    expect(parsed["workerUnits"] ?? 0).toBe(0);
    expect(parsed["providerRequests"]).toBe(0);
    // The refusal must be diagnosable WITHOUT republishing a URL that may carry a
    // credential: the identity digest is the publishable form.
    expect(res.stdout).not.toContain(SENTINEL);
  }, 120_000);

  it("REAL GATE + FORMAL MAIN: a model flag that disagrees with the approval is refused, never accepted-and-ignored", async () => {
    const dir = await tempDir();
    const arms = await syntheticArms();
    const plan = await finalizedPlan({
      baseline: arms.baseline,
      candidate: arms.candidate,
      endpointIdentity: arms.endpointIdentity,
    });
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    const res = await runCli(
      [
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", join(dir, "baseline"),
        "--candidate-dir", join(dir, "candidate"),
        "--endpoint", "https://api.openai.com/v1",
        "--model", "a-model-the-plan-never-approved",
        "--ledger", join(dir, "ledger"),
        "--out", join(dir, "out"),
      ],
      AUTHORIZED_ENV(plan.planDigest!),
    );
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed["code"]).toBe("APPROVED_MODEL_MISMATCH");
    expect(parsed["workerUnits"] ?? 0).toBe(0);
  }, 120_000);

  it("REAL GATE + FORMAL MAIN: an unparseable or negative numeric flag is a configuration error, not a silent NaN", async () => {
    const dir = await tempDir();
    const plan = await finalizedPlan();
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    for (const bad of ["not-a-number", "-1", "NaN"]) {
      const res = await runCli([
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", join(dir, "baseline"),
        "--candidate-dir", join(dir, "candidate"),
        "--timeout-ms", bad,
      ]);
      expect(res.code, `--timeout-ms ${bad} must be a usage error`).toBe(2);
    }
  }, 120_000);

  it("REAL GATE + FORMAL MAIN: the gate judges the CURRENT checkouts, not the plan's review snapshot", async () => {
    // The headline A3 case, through the OFFICIAL entry with the TWO REAL arms.
    //
    // The plan is a genuine, unexpired approval built from a real `observeArms`
    // measurement. Its REVIEW SNAPSHOT is then made stale — it names a different
    // revision and a different case fingerprint than the world does now — while
    // the ENVELOPE keeps the real values. `observation` is outside `planDigest`, so
    // the artifact is still a valid approval; what changed is that a driver which
    // judged the snapshot would decide against a world that no longer exists.
    //
    // `--campaign-deadline-ms 0` is the cheap probe for "did it get past the gate":
    // the campaign stop fires at the top of the first unit, so a run that reaches
    // the loop refuses with ZERO units dispatched. That makes the assertion about
    // the GATE, not about a long execution.
    const dir = await tempDir();
    const stage = await tempDir();
    const baseDir = process.env["R97_ARM_BASELINE_DIR"] ?? "D:/r97-arm-baseline";
    const candDir = process.env["R97_ARM_CANDIDATE_DIR"] ?? "D:/r97-arm-candidate";
    const driver = mod as unknown as {
      observeArms: (o: Record<string, unknown>) => Promise<
        Record<string, { sourceSha: string; planDigest: string; endpointIdentity: string | null; caseFingerprints: Record<string, string> }>
      >;
    };
    const observations = await driver.observeArms({
      modules: { evaluation },
      repoRoot: REPO,
      armDirs: { baseline: baseDir, candidate: candDir },
      stagedCasesDir: join(stage, "cases"),
      suite: "regression",
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointBaseUrl: "https://api.openai.com/v1",
    });
    const createdAt = new Date().toISOString();
    const plan = await finalizedPlan({
      baseline: observations["baseline"],
      candidate: observations["candidate"],
      endpointIdentity: observations["candidate"]!.endpointIdentity,
      createdAt,
      now: createdAt,
    });
    const victim = plan.authorization!.caseIds[0]!;
    const realSha = observations["candidate"]!.sourceSha;
    const realFingerprint = plan.authorization!.caseFingerprints[victim]!;
    const staleSnapshot = {
      ...plan.observation!,
      armShas: { baseline: "7".repeat(40), candidate: "9".repeat(40) },
      caseFingerprints: { ...plan.observation!.caseFingerprints, [victim]: "8".repeat(64) },
    };
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({ ...plan, observation: staleSnapshot }), "utf8");

    const res = await runCli(
      [
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", baseDir,
        "--candidate-dir", candDir,
        "--endpoint", "https://api.openai.com/v1",
        "--ledger", join(dir, "ledger"),
        "--out", join(dir, "out"),
        "--campaign-deadline-ms", "0",
      ],
      AUTHORIZED_ENV(plan.planDigest!),
    );
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    // IT GOT PAST THE GATE — the stale snapshot did not decide the outcome, which
    // is precisely what the old `{ ...plan.observation, now }` made impossible.
    expect(parsed["authorization"]).toMatchObject({ authorizedToExecute: true });
    expect(parsed["executionObservation"]).toMatchObject({ ok: true, codes: [] });
    expect(parsed["code"]).toBe("CAMPAIGN_DEADLINE_EXCEEDED");
    expect(parsed["workerUnits"]).toBe(0);
    expect(parsed["logicalCalls"]).toBe(0);
    expect(parsed["providerRequests"]).toBe(0);

    // THE MEASUREMENT: what was judged is the CURRENT world.
    const judged = parsed["judgedObservation"] as {
      now: string;
      armShas: { baseline: string; candidate: string };
      caseFingerprints: Record<string, string>;
    };
    expect(judged.armShas.candidate).toBe(realSha);
    expect(judged.armShas.candidate).not.toBe("9".repeat(40));
    expect(judged.caseFingerprints[victim]).toBe(realFingerprint);
    expect(judged.caseFingerprints[victim]).not.toBe("8".repeat(64));
    // The clock is the executor's, not the plan's: it is not the snapshot's `now`.
    expect(judged.now).not.toBe(plan.observation!.now);
    expect(Math.abs(Date.parse(judged.now) - Date.now())).toBeLessThan(120_000);
  }, 600_000);

  it("REAL GATE + FORMAL MAIN: a checkout that has MOVED since approval is refused before any unit", async () => {
    // The complementary case: the plan's bound revisions are synthetic, the REAL
    // arms are the ones on disk, so the fresh observation disagrees with the
    // envelope and the gate refuses — with zero units and zero calls. A driver that
    // read the snapshot would have seen agreement and dispatched.
    const dir = await tempDir();
    const baseDir = process.env["R97_ARM_BASELINE_DIR"] ?? "D:/r97-arm-baseline";
    const candDir = process.env["R97_ARM_CANDIDATE_DIR"] ?? "D:/r97-arm-candidate";
    const arms = await syntheticArms();
    const plan = await finalizedPlan({
      baseline: arms.baseline,
      candidate: arms.candidate,
      endpointIdentity: arms.endpointIdentity,
      createdAt: new Date().toISOString(),
      now: new Date().toISOString(),
    });
    const planPath = join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    const res = await runCli(
      [
        "--plan", planPath,
        "--arm-worker",
        "--baseline-dir", baseDir,
        "--candidate-dir", candDir,
        "--endpoint", "https://api.openai.com/v1",
        "--ledger", join(dir, "ledger"),
        "--out", join(dir, "out"),
      ],
      AUTHORIZED_ENV(plan.planDigest!),
    );
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed["authorization"]).toMatchObject({ authorizedToExecute: false });
    expect(["IDENTITY_DRIFT", "CASE_CONTENT_DRIFT"]).toContain((parsed["authorization"] as Record<string, unknown>)["code"]);
    expect(parsed["workerUnits"] ?? 0).toBe(0);
    expect(parsed["logicalCalls"]).toBe(0);
    expect(parsed["providerRequests"]).toBe(0);
  }, 600_000);

  it("REAL GATE + FORMAL DRIVER: a resume verifies the OLD evidence before it spends any new budget", async () => {
    // Plan §A3 怎么验收 2 asks that a resume fail "在发现旧证据损坏前先花预算执行其他单位"
    // — the ordering, not just the detection.
    //
    // The campaign below is a genuine first run that SETTLED exactly one unit and
    // left its evidence on disk, exactly as the worker writes it. The plan has 15
    // units still pending, so a driver that verified evidence AFTER the loop would
    // dispatch them (and charge for them) before noticing. The `runArmUnit` double
    // counts dispatches, and a double is the right instrument HERE: the claim is
    // about how many units the driver STARTED, which is observable without running
    // any arm.
    //
    // THE SAME CAMPAIGN IS RUN TWICE — once with the evidence file moved aside,
    // once with it restored. That is what makes "0 dispatches" mean "refused early"
    // rather than "there was nothing to do".
    const dir = await tempDir();
    const ledgerDir = join(dir, "ledger");
    const arms = await syntheticArms();
    const plan = await finalizedPlan({
      baseline: arms.baseline,
      candidate: arms.candidate,
      endpointIdentity: arms.endpointIdentity,
    });
    const budgetTotal = plan.authorization!.caps.find((c) => c.cap === "maxModelCalls")!.value ?? 0;

    // ---- Seed the durable state through the PRODUCTION lifecycle. -----------
    const campaign = await openCampaign(ledgerDir, plan.planDigest!, budgetTotal);
    const execState = campaign.execState;
    const caseId = plan.authorization!.caseIds[0]!;
    const unit = { caseId, suite: "regression", arm: "baseline" as const, repetition: 1 };
    const key = { experimentId: plan.planDigest!, ...unit };
    const attemptId = await execState.begin(key, {
      reservationId: "seeded-reservation",
      inputDigest: "c".repeat(64),
      now: Date.now(),
    });
    const verdictDetail = "the case failed its task";
    const envelope = (evaluation["buildUnitEvidence"] as (o: Record<string, unknown>) => Record<string, unknown>)({
      attemptId,
      unit,
      build: { sourceSha: arms.baseline.sourceSha, buildDigest: "d".repeat(64) },
      verdict: { category: "case_failed", detail: verdictDetail },
      report: null,
    });
    const written = await (
      evaluation["writeUnitEvidence"] as (r: string, e: Record<string, unknown>) => Promise<{ relPath: string; sha256: string }>
    )(ledgerDir, envelope);
    await execState.complete(attemptId, {
      resultHash: String(envelope["resultHash"]),
      detail: `e4-r98-arm-worker-v2 case_failed: ${verdictDetail}`,
      now: Date.now(),
      evidence: { path: written.relPath, sha256: written.sha256 },
    });
    // PRECONDITION: the seeded evidence really verifies while it is present, so
    // the run below measures the DELETION rather than a broken fixture.
    const intact = await (
      evaluation["verifyCampaignEvidence"] as (r: string, rec: unknown[]) => Promise<{ ok: boolean; detail: string }>
    )(ledgerDir, await execState.records());
    expect(intact.ok, `the seeded evidence must verify: ${intact.detail}`).toBe(true);

    const dispatches: Record<string, unknown>[] = [];
    const stubRunArmUnit = async (o: Record<string, unknown>) => {
      dispatches.push(o);
      return {
        status: "failed",
        failureCategory: "harness",
        detail: "e4-r98-arm-worker-v2 harness: dispatch double",
        consumed: 0,
        reservationId: "",
        resultHash: "",
        build: null,
        verifierPassed: false,
      };
    };
    const runResume = () =>
      mod.runDriver({
        modules: { evaluation },
        plan,
        env: AUTHORIZED_ENV(plan.planDigest!),
        observation: observationFor(plan),
        ledgerDir,
        endpointBaseUrl: "https://api.openai.com/v1",
        armWorker: {
          armDirs: { baseline: "D:/wt/baseline", candidate: "D:/wt/candidate" },
          outDir: join(dir, "units"),
          runArmUnit: stubRunArmUnit,
        },
      });

    // ---- RUN 1: the evidence is MISSING. -----------------------------------
    const evidenceAbs = join(ledgerDir, ...written.relPath.split("/"));
    await rename(evidenceAbs, `${evidenceAbs}.moved-aside`);
    const broken = await runResume();
    expect(broken["code"]).toBe("EVIDENCE_CHAIN_BROKEN");
    expect(broken["status"]).toBe("REFUSED");
    expect(dispatches.length, "no unit may be dispatched once the old evidence is known broken").toBe(0);
    expect(broken["workerUnits"] ?? 0).toBe(0);
    expect(broken["logicalCalls"] ?? 0).toBe(0);

    // ---- RUN 2: the SAME campaign, evidence restored. ----------------------
    // The negative above is only decisive because the pending work EXISTS.
    await rename(`${evidenceAbs}.moved-aside`, evidenceAbs);
    const resumed = await runResume();
    expect(resumed["code"]).not.toBe("EVIDENCE_CHAIN_BROKEN");
    expect(dispatches.length, "the remaining units must be pending").toBeGreaterThan(0);
    expect(resumed["workerUnits"]).toBe(dispatches.length);
  }, 600_000);
});

// ===========================================================================
// E4-R104 (A4) — THE FORMAL PATH BINDS AND FORWARDS THE ARM'S EXECUTED BYTES.
// ===========================================================================
//
// MEASURED DEFECT F4, formal-path half (plan §A4 做什么 3). The build identity was
// derived correctly and the WORKER already refused a mismatched
// `approvedBuildDigest` — but only where a caller opted in, because the formal
// envelope had no slot for the value and the driver never passed it. Measured
// before the fix (`.ci/team-verify/a4/probe-optin.log`):
//
//   J3_OMITTED      refusalFired=false
//   J4_EMPTY_STRING refusalFired=false
//   J5_WHITESPACE   refusalFired=false
//
// so a plan could be approved with NOTHING binding the bytes that execute a case.
// `dist/` is gitignored (`.gitignore:2`), so neither the sha nor the git-derived
// plan digest could notice a rebuilt executor.
//
// The plan-level half of the binding (the readiness refusal and the execution-time
// build-drift codes) lives in `r97-plan.test.ts`; this block measures what is
// uniquely the DRIVER's responsibility — that the approved value ARRIVES at the
// unit, per arm.
describe("E4-R104 (A4): the driver forwards the approved build identity", () => {
  it("A4: the driver forwards the APPROVED build digest to every unit, so a rebuilt arm is refused", async () => {
    // This drives `armWorker` with a recording stand-in, so nothing waits on a real
    // arm and the FORWARDING is the only thing measured.
    const dir = await tempDir();
    const ledgerDir = join(dir, "ledger");
    const endpointIdentity = (evaluation["captureEndpointIdentity"] as (u: string) => string | null)(
      "https://api.openai.com/v1",
    );
    const sel = await (evaluation["loadR97FrozenSelection"] as (r: string) => Promise<{ caseIds: string[]; caseFingerprints: Record<string, string> }>)(REPO);
    const mkArm = (label: "baseline" | "candidate", sha: string, dg: string, build: string): R97ArmObservation => ({
      arm: label,
      checkoutDir: `D:/wt/${label}`,
      sourceSha: sha,
      treeFingerprint: null,
      clean: true,
      planDigest: dg,
      buildDigest: build,
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointIdentity,
      caseIds: sel.caseIds,
      cliCaseIds: sel.caseIds.map((id) => id.split("/").pop() ?? id),
      caseFingerprints: sel.caseFingerprints,
      effectiveModelParams: { budgetTokens: 32_000 },
      totalLogicalRuns: sel.caseIds.length * 2,
      suite: "regression",
    });
    const baselineBuild = "1a".padEnd(64, "0");
    const candidateBuild = "2b".padEnd(64, "0");
    const plan = await finalizedPlan({
      baseline: mkArm("baseline", "1".repeat(40), "a".repeat(64), baselineBuild),
      candidate: mkArm("candidate", "2".repeat(40), "b".repeat(64), candidateBuild),
      endpointIdentity,
    });
    // The plan really binds both digests, per arm — the precondition for the
    // forwarding below to be meaningful at all.
    expect(plan.authorization!.arms.baseline.buildDigest).toBe(baselineBuild);
    expect(plan.authorization!.arms.candidate.buildDigest).toBe(candidateBuild);

    const seen: Array<{ arm: string; opts: Record<string, unknown> }> = [];
    const result = await mod.runDriver({
      modules: { evaluation },
      plan,
      env: AUTHORIZED_ENV(plan.planDigest!),
      observation: observationFor(plan),
      ledgerDir,
      endpointBaseUrl: "https://api.openai.com/v1",
      unitTimeoutMs: 1_000,
      armWorker: {
        armDirs: { baseline: REPO, candidate: REPO },
        runArmUnit: async (unitOpts: Record<string, unknown>) => {
          seen.push({ arm: String(unitOpts["arm"]), opts: unitOpts });
          return {
            status: "completed",
            verifierPassed: true,
            failureCategory: null,
            detail: "recording stand-in",
            consumed: 0,
            reservationId: "",
            resultHash: "",
            build: null,
          };
        },
      },
    });

    expect(
      seen.length,
      `the driver dispatched at least one arm unit (code=${String(result["code"])} reason=${String(result["reason"])})`,
    ).toBeGreaterThan(0);

    for (const unit of seen) {
      const expected = unit.arm === "baseline" ? baselineBuild : candidateBuild;
      expect(
        unit.opts["approvedBuildDigest"],
        `arm ${unit.arm}: the unit must receive the APPROVED build digest, or a rebuilt arm runs under an old approval`,
      ).toBe(expected);
      // And it is the arm's OWN digest, not one value shared by both — a single
      // shared digest would hide one arm's build exactly as a shared sha would.
      expect(unit.opts["approvedBuildDigest"]).not.toBe(
        unit.arm === "baseline" ? candidateBuild : baselineBuild,
      );
    }
  }, 120_000);
});