/**
 * E4-R99 — the ARM WORKER's contract, driven for real.
 *
 * PURPOSE (plan §R99 怎么验收): "两臂均加载自身构建，结果记录 observed build
 * identity；故意互换 worker 构建时失败" and "两个不同 case 的真实模型输入、
 * fixture 输出、verifier 结果均各自正确，不再出现统一占位请求."
 *
 * Plan §R97 line 5 states the testing standard this file obeys: "不要只测试纯
 * gate 函数，要驱动实际 CLI/driver 入口." So this file does NOT re-implement the
 * worker's logic and does NOT mock it: it imports `scripts/e4/r97-arm-worker.mjs`
 * and drives `runArmUnit` / `main` against the REAL repo build, the REAL budget
 * ledger and the REAL execution state.
 *
 * The execution itself goes through each arm's OWN BUILD: `r97-arm-exec.mjs` loads
 * THAT arm's `apps/cli/dist/benchmark-command.js` and `packages/model/dist`, so the
 * code under test is the arm's shipped code rather than a re-implementation. (It is
 * loaded in-process rather than as a child CLI — see the header of `r97-arm-exec.mjs`
 * for why: a child that resolves its own provider makes the campaign BUDGET
 * unenforceable, which was measured defect N1.)
 *
 * WHAT MAKES THESE TESTS NON-VACUOUS
 * ----------------------------------
 * The worker's whole purpose is to turn a fixed placeholder into a real
 * execution. The discriminating evidence is therefore the VERDICT TEXT:
 *
 *   - a unit that never dispatched reports a `harness`/`infrastructure` category
 *     and a sentence about the plan, the build, or a missing file;
 *   - a unit that ACTUALLY executed reports a category derived from the arm
 *     CLI's own report and a sentence carrying `verification_passed=`, which can
 *     only come from parsing a real `baseline.json`.
 *
 * So "did a case really run" is asserted by requiring the report-derived text,
 * not by asserting that a function was called.
 *
 * HONEST LIMITS OF THE OFFLINE PATH (stated, not hidden)
 * ------------------------------------------------------
 * THIS SECTION WAS CORRECTED in E4-R101 (T6). It used to say that this file
 * "CANNOT produce a verified PASS", because `--provider` in the arm CLI accepts
 * exactly one id (`openai`) and the keyless "stub" transport is chosen by the
 * ABSENCE of a key — so the stub yields a `MODEL_ERROR` and every offline unit ends
 * as an honest negative. That was true of the CHILD-CLI dispatch, and it is FALSE
 * of the seam this suite now drives (see `scripts/e4/r97-arm-exec.mjs`).
 *
 * Plan §0.4 found the interface that changes it: both frozen arms export
 * `runBenchmarkCommand(argv, providerOverride)` from their OWN
 * `apps/cli/dist/benchmark-command.js`, and `ScriptedModelProvider` from their own
 * `packages/model/dist`. Injecting a scripted provider through that override drives
 * the REAL request, the REAL tool loop and the REAL `TaskVerifier` with ZERO
 * external requests, and a case CAN therefore reach a verified
 * `verification_passed=true`. The W8 tests below measure exactly that, and they
 * assert a REAL pass rather than a negative.
 *
 * WHAT REMAINS TRUE, AND IS THE POINT OF THE DISTINCTION
 * -----------------------------------------------------
 * A pass produced this way is a pass of the TOOLCHAIN, not of a model. The scripted
 * provider is authored by this repository, so nothing here supports any claim about
 * model quality, win rate or promotability. The offline path also does not prove
 * the PAID two-version experiment ran; that remains `NOT_RUN` (plan §T6 怎么验收 5:
 * 无外部付费执行时标为 `OFFLINE_ACCEPTED / PAID_NOT_RUN`).
 *
 * ZERO external requests: no test sets `OPENAI_API_KEY`, and `runArmUnit` deletes
 * it from the child environment it builds.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openR97BudgetLedger, viewOfR97Ledger } from "./r97-budget-ledger.js";
import { verifyUnitEvidence } from "./r97-campaign-evidence.js";

const REPO = process.cwd();
const WORKER = pathToFileURL(join(REPO, "scripts", "e4", "r97-arm-worker.mjs")).href;
const LEDGER_FILE = "budget-ledger.json";
const EXEC_FILE = "execution-state.json";

/** The R98 fixture: a real case whose request demands a real tool write. */
const CASE_ID = "r98-tool-write-request";
const SECOND_CASE_ID = "r98-tool-write-second";

interface ArmUnitRecord {
  workerVersion: string;
  execVersion?: string;
  unit: { caseId: string; suite: string; arm: string; repetition: number };
  build: { checkoutDir: string; sourceSha: string | null; buildDigest: string | null };
  status: string;
  failureCategory: string | null;
  reservationId: string;
  reservationIds?: string[];
  resultHash: string;
  durationMs: number;
  detail: string | null;
  caseSource?: string;
  verifierPassed?: boolean;
  consumed?: number;
  budget?: {
    logicalCalls: number;
    transportRetries: number;
    unknownCalls: number;
    refusedCalls: number;
    reservationIds: string[];
    /**
     * The channel's EXPLICIT per-reservation dispatch state (A1/F1), in order.
     *
     * It is a MEASUREMENT taken as the call proceeds rather than an inference from
     * a return value, so it survives the throw: `entered === true && settled ===
     * false` is the measured fact that a call was ADMITTED and that its terminal
     * ledger write did NOT land.
     */
    dispatches?: Array<{
      reservationId: string;
      entered: boolean;
      completed: boolean;
      settled: boolean;
      settlement: string | null;
    }>;
    /** Admitted calls whose terminal ledger write FAILED. Non-zero means the
     *  ledger still shows an outstanding reservation. */
    settlementFailures?: number;
    /** The last settlement failure message, so the verdict can name the cause. */
    lastSettlementError?: string | null;
  } | null;
  execution?: { digest: string; files: number } | null;
  /**
   * The identity the unit ACTUALLY executed under (T4 / N6, extended by A5).
   *
   * `declared*` comes from the arm's own dry-run plan, `runtime*` from the
   * `ModelRef` the core runtime handed to `createClient`, and `approved*` from
   * the caller's envelope — three INDEPENDENT views, so a disagreement is a
   * measurement rather than a restatement. `drift` is the diagnostic list of
   * disagreements; `null` when the unit never reached the executor.
   */
  executionIdentity?: {
    declaredProviderId?: string | null;
    declaredModelId?: string | null;
    declaredEndpointIdentity?: string | null;
    runtimeProviderId?: string | null;
    runtimeModelId?: string | null;
    approvedProviderId?: string | null;
    approvedModelId?: string | null;
    approvedEndpointIdentity?: string | null;
    executingProviderId?: string | null;
    providerIsOfflineSubstitute?: boolean;
    drift?: string[];
  } | null;
  capturedRequests: Array<{ messageCount: number; messages: Array<{ role: string; content: string }>; digest: string }>;
  report: {
    task_id: string | null;
    success: boolean;
    verification_passed: boolean;
    model_calls: number | null;
    reportHash: string;
    [k: string]: unknown;
  } | null;
}

const mod = (await import(WORKER)) as {
  ARM_WORKER_VERSION: string;
  EXIT_OK: number;
  EXIT_REFUSED: number;
  EXIT_CONFIG: number;
  FAILURE_CATEGORIES: string[];
  redact: (v: unknown) => string;
  redactFailureText: (v: unknown) => string;
  /**
   * The terminal record's verdict text.
   *
   * Exported as the SINGLE SOURCE OF TRUTH for the record↔evidence contract: the
   * record's `detail` and the evidence envelope's `verdict.detail` must be the same
   * string modulo the `<version> <category>: ` prefix, or the validator that
   * re-derives the campaign refuses an honest run.
   */
  terminalDetailFor: (v: { category: string | null; detail: string }) => string;
  armBuildIdentity: (dir: string) => { checkoutDir: string; sourceSha: string | null; buildDigest: string | null };
  /** The explicit artifact manifest the build identity covers (T4 / N7). */
  BUILD_ARTIFACT_PATHS: readonly (readonly string[])[];
  /**
   * E4-R104 (A4): the DERIVED closure of those declared entries, as root-relative
   * POSIX paths. A fixture that has to be "a real, complete build" must copy THIS,
   * because the digest covers the closure rather than the declared list.
   */
  armBuildClosurePaths: (dir: string) => string[];
  cliEntryOf: (dir: string) => string;
  reportPathOf: (outDir: string, suite: string) => string;
  dispatchArgs: (o: Record<string, unknown>) => string[];
  dryRunArgs: (o: Record<string, unknown>) => string[];
  inputDigestFor: (o: Record<string, unknown>) => string;
  classifyReport: (report: unknown, caseId: string) => { passed: boolean; category: string | null; detail: string };
  runArmUnit: (o: Record<string, unknown>) => Promise<ArmUnitRecord>;
  reportRowFor: (report: unknown, caseId: string) => ArmUnitRecord["report"];
  parsePlanDigest: (stdout: string) => string | null;
  main: (argv: string[]) => Promise<number>;
  /**
   * E4-R105 (A5): the verdict priority table and the fold that applies it. The
   * record-level tests below drive real units; these two are exported so the
   * TABLE itself can be asserted directly, entry by entry, rather than inferred
   * from one unit's outcome.
   */
  R97_VERDICT_PRIORITY: readonly string[];
  foldR97Verdict: (
    current: { category: string | null; detail: string } | null,
    next: { category: string | null; detail: string },
  ) => { category: string | null; detail: string };
};

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r99-arm-"));
  dirs.push(d);
  return d;
}

/**
 * Redirect the machine-global advisory claim anchor to a per-suite scratch
 * directory.
 *
 * The ledger's claim anchor defaults to a directory under the SYSTEM temp dir, so
 * every test file that opens a ledger shares one namespace keyed by campaign id.
 * Two suites running in parallel workers then refuse each other with
 * `BUDGET_CAMPAIGN_DIR_DUPLICATE` — a collision between unrelated tests, not a
 * fact about the worker. The other R97 ledger suites already do this; the worker
 * contract suite must too now that it opens real campaigns.
 */
/**
 * ONE FRESH CLAIM ANCHOR PER TEST (plan §A2 怎么做 6: "普通测试应使用独立的 claim
 * namespace/独立批准 ID").
 *
 * The ledger's claim anchor defaults to a directory under the SYSTEM temp dir, so
 * every test file that opens a ledger shares one namespace keyed by campaign id.
 * Two suites in parallel workers would refuse each other with
 * `BUDGET_CAMPAIGN_DIR_DUPLICATE`. And since finding F2 an anchor that records
 * "this approval ESTABLISHED a budget here" is no longer ignorable just because a
 * test cleaned its directory up — several tests in THIS file reuse the same plan
 * digest in a brand-new temporary ledger dir, which under F2 is exactly the
 * double-spend shape. Isolating the namespace per test keeps each test measuring
 * its own approval.
 */
let CLAIMS_DIR = "";
beforeEach(async () => {
  CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r99-claims-"));
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = CLAIMS_DIR;
});
afterEach(async () => {
  delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  if (CLAIMS_DIR !== "") await rm(CLAIMS_DIR, { recursive: true, force: true }).catch(() => {});
  CLAIMS_DIR = "";
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * Drive ONE real unit against the repo's own build.
 *
 * `approvedSourceSha` defaults to the checkout's REAL sha, so the default is an
 * APPROVED unit — the tests that must refuse pass an explicit wrong sha rather
 * than relying on an accident.
 *
 * E4-R100-A (T4): the APPROVED IDENTITY is now REQUIRED. `runArmUnit` refuses a
 * unit with no `providerId`/`modelId` rather than defaulting to
 * `openai`/`gpt-4o-mini` (measured defect N6: "driver 不把批准的 provider/model/
 * endpoint 传给 worker"), so the default here supplies an explicit, non-default
 * pair — which is also what makes the identity assertions meaningful: a test can
 * see that the value it passed is the value that ran.
 */
async function runUnit(over: Record<string, unknown> = {}): Promise<{ record: ArmUnitRecord; root: string }> {
  const root = await tempDir();
  const build = mod.armBuildIdentity(REPO);
  const record = await mod.runArmUnit({
    checkoutDir: REPO,
    repoRoot: REPO,
    caseId: CASE_ID,
    suite: "regression",
    arm: "baseline",
    repetition: 1,
    // The R97 AUTHORIZATION ENVELOPE digest. It binds the ledger and the
    // execution state, and it is deliberately NOT what the arm CLI's dry run
    // produces (a different digest kind over a different case set).
    planDigest: "a".repeat(64),
    approvedSourceSha: build.sourceSha,
    // The approved identity (T4 怎么做 6). Explicit, never defaulted.
    providerId: "openai",
    modelId: "approved-model-x",
    endpointBaseUrl: "http://127.0.0.1:9/v1",
    executionStateDir: join(root, "state"),
    ledgerDir: join(root, "ledger"),
    outDir: join(root, "out"),
    timeoutMs: 180_000,
    ...over,
  });
  return { record, root };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("R99 W1: the worker's own identity and vocabulary", () => {
  it("exposes one worker version and the three exit codes", () => {
    expect(mod.ARM_WORKER_VERSION).toMatch(/^e4-r\d+-arm-worker-v\d+$/);
    expect(mod.EXIT_OK).toBe(0);
    expect(mod.EXIT_REFUSED).toBe(1);
    expect(mod.EXIT_CONFIG).toBe(2);
    // Distinct, so a caller can tell "refused" from "misused".
    expect(new Set([mod.EXIT_OK, mod.EXIT_REFUSED, mod.EXIT_CONFIG]).size).toBe(3);
  });

  it("names every failure category, and `null` is never a member (null means PASSED)", () => {
    expect(mod.FAILURE_CATEGORIES).toEqual(
      expect.arrayContaining(["infrastructure", "timeout", "provider", "harness", "budget", "case_failed"]),
    );
    expect(mod.FAILURE_CATEGORIES).not.toContain(null);
    expect(mod.FAILURE_CATEGORIES.every((c) => typeof c === "string" && c !== "")).toBe(true);
  });

  it("resolves the ARM'S OWN entry point and report path", () => {
    expect(mod.cliEntryOf(REPO)).toBe(join(REPO, "apps", "cli", "dist", "main.js"));
    // The CLI names a regression report `baseline.json` and other suites after
    // themselves; the worker must read the artifact the CLI documents.
    expect(mod.reportPathOf(join(REPO, "out"), "regression")).toBe(join(REPO, "out", "baseline.json"));
    expect(mod.reportPathOf(join(REPO, "out"), "holdout")).toBe(join(REPO, "out", "holdout.json"));
  });
});

describe("R99 W2: dispatch argv — the measured P0 regression", () => {
  const base = {
    cliEntry: "C:/arm/apps/cli/dist/main.js",
    suite: "regression",
    stagedCasesDir: "C:/arm/.work/cases",
    providerId: "openai",
    modelId: "gpt-4o-mini",
    maxModelCalls: 10,
    outDir: "C:/arm/.work/run",
    allowStub: true,
  };

  it("passes --plan-digest to the dispatch, which the CLI REQUIRES for an external-billed run", () => {
    // MEASURED DEFECT (P0) this test pins: `dispatchArgs` omitted
    // `--plan-digest`, so every real dispatch died in the arm CLI's preflight
    // with "a paid (external-billed) run must pass --plan-digest <digest> from a
    // prior --dry-run" — exit 1, and NOT ONE case ever executed.
    const digest = "c".repeat(64);
    const args = mod.dispatchArgs({ ...base, dispatchPlanDigest: digest });
    const i = args.indexOf("--plan-digest");
    expect(i, "dispatch argv must carry --plan-digest").toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(digest);
    // It must be the digest VALUE, not a flag with no argument.
    expect(args[i + 1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("NEGATIVE CONTROL: omits --plan-digest when no digest was supplied, so the flag is not fabricated", () => {
    const args = mod.dispatchArgs(base);
    expect(args).not.toContain("--plan-digest");
    // ...and the dispatch is otherwise complete, so the absence above is about
    // the digest alone rather than a truncated argv.
    expect(args).toContain("benchmark");
    expect(args).toContain("--cases");
    expect(args).toContain("--allow-stub");
  });

  it("NEGATIVE CONTROL: an EMPTY digest string is not passed as a flag value", () => {
    // A `--plan-digest ""` would be a real argv the CLI would reject; the worker
    // must treat "no digest" as absent rather than emit a broken argument.
    const args = mod.dispatchArgs({ ...base, dispatchPlanDigest: "" });
    expect(args).not.toContain("--plan-digest");
  });

  it("uses the ARM'S OWN cliEntry as argv[0] and never a shell string", () => {
    const args = mod.dispatchArgs({ ...base, dispatchPlanDigest: "d".repeat(64) });
    expect(args[0]).toBe(base.cliEntry);
    // The Windows path is ONE argv element; quoting it would create a directory
    // literally named `"C:\..."` and the CLI would load zero cases.
    expect(args).toContain(base.stagedCasesDir);
    expect(args.some((a) => a.startsWith('"'))).toBe(false);
  });

  it("dryRunArgs is exactly dispatchArgs plus --dry-run, so both describe ONE plan", () => {
    const o = { ...base, dispatchPlanDigest: "e".repeat(64) };
    const dispatch = mod.dispatchArgs(o);
    const dry = mod.dryRunArgs(o);
    expect(dry.slice(0, dispatch.length)).toEqual(dispatch);
    expect(dry[dry.length - 1]).toBe("--dry-run");
    expect(dry).toHaveLength(dispatch.length + 1);
  });
});

describe("R99 W3: build identity is observed, never fabricated", () => {
  it("reads the REAL git HEAD of the checkout and a 64-hex build digest", () => {
    const build = mod.armBuildIdentity(REPO);
    expect(build.checkoutDir).toBe(REPO);
    expect(build.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(build.buildDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null — not a substituted value — for a tree with no build", async () => {
    const empty = await tempDir();
    const build = mod.armBuildIdentity(empty);
    // `null` is the honest "not established". A fabricated digest here is how a
    // campaign would claim it ran a revision it never checked out.
    expect(build.buildDigest).toBeNull();
    expect(build.sourceSha).toBeNull();
  });

  it("changing the build changes the digest: a different tree is a different identity", async () => {
    const a = mod.armBuildIdentity(REPO);
    const other = await tempDir();
    // EVERY covered path must be present, or the digest is `null` rather than an
    // identity — so the fake tree mirrors the manifest instead of a hardcoded
    // subset that would silently stop covering a newly-added artifact.
    for (const parts of mod.BUILD_ARTIFACT_PATHS) {
      const abs = join(other, ...parts);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "// a DIFFERENT build\n");
    }
    const b = mod.armBuildIdentity(other);
    // Both are "established" (files exist), so this compares two real identities
    // rather than comparing a digest against null.
    expect(b.buildDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.buildDigest).not.toBe(a.buildDigest);
  });
});

describe("R99 W4: the unit input digest binds what can change a result", () => {
  const base = {
    planDigest: "a".repeat(64),
    inputsDigest: "b".repeat(64),
    caseId: CASE_ID,
    suite: "regression",
    arm: "baseline",
    repetition: 1,
    build: { sourceSha: "1".repeat(40), buildDigest: "2".repeat(64) },
  };

  it("is a 64-hex digest and is STABLE for identical inputs", () => {
    const one = mod.inputDigestFor(base);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(mod.inputDigestFor({ ...base })).toBe(one);
  });

  it("CHANGES when the build, the plan, the case, or the arm changes", () => {
    const one = mod.inputDigestFor(base);
    const variants: Array<Record<string, unknown>> = [
      { ...base, build: { sourceSha: "9".repeat(40), buildDigest: base.build.buildDigest } },
      { ...base, build: { sourceSha: base.build.sourceSha, buildDigest: "9".repeat(64) } },
      { ...base, planDigest: "9".repeat(64) },
      { ...base, caseId: SECOND_CASE_ID },
      { ...base, arm: "candidate" },
      { ...base, repetition: 2 },
      { ...base, inputsDigest: "9".repeat(64) },
    ];
    for (const v of variants) {
      expect(mod.inputDigestFor(v), `variant ${JSON.stringify(v).slice(0, 80)} must move the digest`).not.toBe(one);
    }
  });
});

describe("R99 W5: report classification is three-way and never invents a pass", () => {
  it("a PASS requires the report's own success flag — never a hardcoded true", () => {
    const passed = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: true, verification_passed: true, tool_calls: 3, termination_reason: "completed" }] },
      CASE_ID,
    );
    expect(passed.passed).toBe(true);
    expect(passed.category).toBeNull();
    // The evidence travels with the verdict.
    expect(passed.detail).toContain("verification_passed=true");
  });

  it("a case that RAN and failed its task is a VALID negative (`case_failed`), not an infrastructure error", () => {
    const failed = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: false, actual_status: "failed", failure_category: "verification", verification_passed: false, termination_reason: "completed" }] },
      CASE_ID,
    );
    expect(failed.passed).toBe(false);
    expect(failed.category).toBe("case_failed");
  });

  it("distinguishes a MODEL error (`provider`) from an infrastructure defect", () => {
    const modelErr = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: false, actual_status: "failed", failure_category: "model", verification_passed: false, termination_reason: "model_error" }] },
      CASE_ID,
    );
    expect(modelErr.category).toBe("provider");
    expect(modelErr.passed).toBe(false);

    const infra = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: false, actual_status: "error", failure_category: "infrastructure" }] },
      CASE_ID,
    );
    expect(infra.category).toBe("infrastructure");
  });

  it("an EMPTY report is an infrastructure failure, never a silent pass", () => {
    const empty = mod.classifyReport({ results: [] }, CASE_ID);
    expect(empty.passed).toBe(false);
    expect(empty.category).toBe("infrastructure");
    // The message names the missing case, so the cause is readable.
    expect(empty.detail).toContain(CASE_ID);
  });

  it("success=true WITHOUT the report's own verification evidence is infrastructure, not a pass", () => {
    // Plan §T6 怎么做 7's "跳过 verifier" mutation, as a test. The whole point of
    // `classifyReport` is that a pass must be SUBSTANTIATED: `success: true` on its
    // own is the case asserting it did the work, and a case can assert anything.
    // MEASURED: this branch had NO test before — the mutation gate found the gap,
    // because a mutation is only caught by a test that exercises the branch.
    const unsubstantiated = mod.classifyReport(
      { results: [{ task_id: CASE_ID, success: true, tool_calls: 3, termination_reason: "completed" }] },
      CASE_ID,
    );
    expect(unsubstantiated.passed, "an unsubstantiated success must never be a pass").toBe(false);
    expect(unsubstantiated.category).toBe("infrastructure");
    expect(unsubstantiated.detail).toContain("carries no verification evidence");

    // The NEGATIVE CONTROL: the SAME row WITH the evidence is a pass, so the
    // refusal above is about the missing evidence rather than about the row shape.
    const substantiated = mod.classifyReport(
      {
        results: [
          { task_id: CASE_ID, success: true, verification_passed: true, tool_calls: 3, termination_reason: "completed" },
        ],
      },
      CASE_ID,
    );
    expect(substantiated.passed).toBe(true);
    expect(substantiated.category).toBeNull();

    // And a report that claims success while its own verifier says it FAILED is a
    // case failure, never a pass — the stronger form of the same rule.
    const contradicted = mod.classifyReport(
      {
        results: [
          {
            task_id: CASE_ID,
            success: true,
            verification_passed: false,
            actual_status: "failed",
            termination_reason: "verification_failed",
          },
        ],
      },
      CASE_ID,
    );
    expect(contradicted.passed).toBe(false);
    expect(contradicted.category).not.toBeNull();
  });
});

describe("R99 W6: plan-digest parsing accepts the shapes the CLI has used", () => {
  it("reads a top-level planDigest, a bare digest, and a nested plan.planDigest", () => {
    const hex = "f".repeat(64);
    expect(mod.parsePlanDigest(JSON.stringify({ planDigest: hex }))).toBe(hex);
    expect(mod.parsePlanDigest(JSON.stringify({ digest: hex }))).toBe(hex);
    expect(mod.parsePlanDigest(JSON.stringify({ plan: { planDigest: hex } }))).toBe(hex);
  });

  it("returns null — never a guess — for malformed or non-hex input", () => {
    expect(mod.parsePlanDigest("not json at all")).toBeNull();
    expect(mod.parsePlanDigest(JSON.stringify({ planDigest: "too-short" }))).toBeNull();
    expect(mod.parsePlanDigest(JSON.stringify({ planDigest: "A".repeat(64) }))).toBeNull();
    expect(mod.parsePlanDigest("")).toBeNull();
  });
});

describe("R99 W7: the CLI entry refuses misuse instead of guessing", () => {
  it("no flags is a USAGE error (exit 2), not a defaulted run", async () => {
    // A worker that invented a ledger or state directory would spend an
    // approval against state nobody approved.
    const code = await mod.main([]);
    expect(code).toBe(mod.EXIT_CONFIG);
  });

  it("a partial flag set is still a usage error", async () => {
    const code = await mod.main(["--checkout", REPO, "--case", CASE_ID]);
    expect(code).toBe(mod.EXIT_CONFIG);
  });

  it("the approved identity is REQUIRED — the CLI cannot dodge it by omitting flags (T4)", async () => {
    // Plan §T4 怎么做 6: "worker 必须使用它们构造请求；不能回落到 openai/gpt-4o-mini
    // 或环境里的另一 endpoint。缺必需字段直接拒绝." A CLI that let a caller omit
    // `--provider`/`--model` would be an escape hatch around the very refusal the
    // library enforces, so the flag set is checked BEFORE any work starts.
    const dir = await tempDir();
    const full = [
      "--checkout", REPO,
      "--case", CASE_ID,
      "--suite", "regression",
      "--arm", "baseline",
      "--plan-digest", "a".repeat(64),
      "--state", join(dir, "state"),
      "--ledger", join(dir, "ledger"),
    ];
    // Everything EXCEPT the identity: refused as usage, not silently defaulted.
    expect(await mod.main(full)).toBe(mod.EXIT_CONFIG);
    // Adding only the provider is still incomplete: the model is required too.
    expect(await mod.main([...full, "--provider", "openai"])).toBe(mod.EXIT_CONFIG);
  });
});

describe("R99 W8: THE REAL EXECUTION — the arm's own build actually runs the case", () => {
  it("executes the case and records a verdict that can ONLY come from the real report", async () => {
    const { record, root } = await runUnit();

    // The unit ran under the approved build, observed — not asserted.
    expect(record.build.checkoutDir).toBe(REPO);
    expect(record.build.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(record.build.buildDigest).toMatch(/^[0-9a-f]{64}$/);

    // THE DISCRIMINATOR. `verification_passed=` appears in `classifyReport`'s
    // pass/fail sentence, which is built ONLY from a parsed report. A unit that
    // never dispatched or one whose execution died before writing a report
    // (infrastructure) cannot produce this text.
    expect(record.detail, "the verdict must come from the arm CLI's own report").toContain("verification_passed=");
    expect(record.failureCategory).not.toBe("infrastructure");

    // A REAL VERIFIED PASS, OFFLINE. This is what plan §0.4 established: the
    // arm's own exported `runBenchmarkCommand(argv, providerOverride)` runs the
    // real request, tool loop and TaskVerifier against an injected scripted
    // provider, so a passing case can be demonstrated with ZERO external
    // requests. Before the in-process seam existed the worker could only spawn
    // the child CLI, whose keyless transport is the stub — and a stub always
    // yields MODEL_ERROR, so the old assertion here had to pin `failed` +
    // `model_error`. That was a limitation of the route, not a property of the
    // harness, and it is now removed.
    expect(record.status).toBe("completed");
    expect(record.verifierPassed).toBe(true);
    expect(record.detail).toContain("verification_passed=true");
    expect(record.durationMs).toBeGreaterThan(0);

    // The case was found and staged from a REAL case directory.
    expect(record.caseSource).toContain(CASE_ID);
    expect(existsSync(record.caseSource!)).toBe(true);

    // BUDGET: the ledger exists and EVERY logical call the arm's runtime made
    // has its own terminal reservation. This is finding N1's fix — the old
    // worker charged one call per UNIT no matter how many the arm actually made.
    const ledger = await readJson(join(root, "ledger", LEDGER_FILE));
    expect(ledger, "a dispatched unit must leave a durable ledger").not.toBeNull();
    const entries = ledger!["entries"] as Array<Record<string, unknown>>;
    const measured = Number(record.budget!.logicalCalls);
    expect(measured, "the arm really called the provider more than once").toBeGreaterThan(1);
    expect(entries, "one reservation per real logical call, not per unit").toHaveLength(measured);
    expect(entries.every((e) => e["status"] === "committed" && e["consumed"] === 1)).toBe(true);
    // Every reservation id the channel handed out is DISTINCT: a single ledger
    // entry may never stand behind two real calls (measured regression — the
    // pre-taken reservation was per-CLIENT, so each client the runtime built
    // adopted the same entry and the ledger under-counted the spend).
    expect(new Set(record.reservationIds).size, "each real call owns its own reservation").toBe(measured);
    // The unit's own report of what it charged is the MEASURED count, not 1.
    expect(record.consumed).toBe(measured);
    // The envelope digest — not the arm CLI digest — is what binds the ledger.
    expect(ledger!["planDigest"]).toBe("a".repeat(64));

    // DURABLE EXECUTION STATE: the unit reached a TERMINAL record, which is what
    // makes a resume skip it instead of re-billing it.
    const state = await readJson(join(root, "state", EXEC_FILE));
    expect(state, "a terminal unit must leave durable state").not.toBeNull();
    const records = state!["records"] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]!["status"]).toBe("completed");
    expect(records[0]!["caseId"]).toBe(CASE_ID);
    expect(records[0]!["arm"]).toBe("baseline");
    expect(String(records[0]!["resultHash"])).toMatch(/^[0-9a-f]{64}$/);
    // N3 item 9: `begin` takes a NUMBER, so a real timestamp is stored rather
    // than the literal 0 that passing the `now` FUNCTION produced.
    expect(records[0]!["startedAt"], "startedAt must be a real clock reading").toBeGreaterThan(0);

    // The FIRST reservation — the one recorded on the durable `running` record —
    // is a genuine ledger entry, and it precedes the dispatch by construction.
    expect(records[0]!["reservationId"]).toBe(record.reservationId);
    expect(record.reservationId).not.toBe("");
    expect(entries.map((e) => e["reservationId"])).toContain(record.reservationId);

    // THE ARM'S OWN REPORT ROW IS PRESERVED as evidence (finding N5: the old
    // worker deleted the only copy in `finally`).
    expect(record.report, "the arm's report row must survive the unit").not.toBeNull();
    expect(record.report!.task_id).toBe(CASE_ID);
    expect(record.report!.success).toBe(true);
    expect(record.report!.verification_passed).toBe(true);
    expect(record.report!.reportHash).toMatch(/^[0-9a-f]{64}$/);
    // The arm's self-report and the channel's measured count AGREE — and the
    // accounting uses the measured one, not this field.
    expect(record.report!.model_calls).toBe(measured);

    // The arm's ACTUAL executed bytes are identified by content (N7: the old
    // identity covered only main.js and missed the module that runs the case).
    expect(record.execution, "the executed-bytes identity must be established").not.toBeNull();
    expect(record.execution!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.execution!.files).toBeGreaterThan(10);
  }, 240_000);

  it("TWO DIFFERENT CASES each enter their OWN context — no single placeholder request", async () => {
    // Plan §R99 怎么验收: "两个不同 case 的真实模型输入、fixture 输出、verifier
    // 结果均各自正确，不再出现统一占位请求." The pre-fix worker sent the SAME
    // `content: "r97"` for every case, so both would have been identical here.
    const root = await tempDir();
    const build = mod.armBuildIdentity(REPO);
    const common = {
      checkoutDir: REPO,
      repoRoot: REPO,
      suite: "regression",
      arm: "baseline",
      repetition: 1,
      planDigest: "a".repeat(64),
      approvedSourceSha: build.sourceSha,
      // The approved identity is REQUIRED (T4 怎么做 6 / measured defect N6).
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: 180_000,
    };
    const first = await mod.runArmUnit({ ...common, caseId: CASE_ID });
    const second = await mod.runArmUnit({ ...common, caseId: SECOND_CASE_ID });

    // Each unit staged ITS OWN case from its own directory.
    expect(first.caseSource).toContain(CASE_ID);
    expect(second.caseSource).toContain(SECOND_CASE_ID);
    expect(first.caseSource).not.toBe(second.caseSource);
    // Both really executed...
    expect(first.detail).toContain("verification_passed=");
    expect(second.detail).toContain("verification_passed=");
    // ...and produced DIFFERENT stored results, because the inputs differed.
    expect(first.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.resultHash).not.toBe(second.resultHash);

    // THE STRONGER PROPERTY plan §T4 怎么做 4 demands: "捕获实际模型输入及工具动作，
    // 不能用两个不同 caseId 产生不同 resultHash 代替上下文验证." The captured
    // requests prove the two cases entered DIFFERENT contexts, and each case's
    // OWN request text is what the model saw.
    expect(first.capturedRequests.length).toBeGreaterThan(0);
    expect(second.capturedRequests.length).toBeGreaterThan(0);
    const firstText = first.capturedRequests.map((r) => r.messages.map((m) => m.content).join(" ")).join(" ");
    const secondText = second.capturedRequests.map((r) => r.messages.map((m) => m.content).join(" ")).join(" ");
    // Each case's request.md content reached the model, and the two differ.
    expect(firstText).toContain("r98-request.txt");
    expect(secondText).toContain("r98-second.txt");
    expect(firstText).not.toContain("r98-second.txt");
    expect(secondText).not.toContain("r98-request.txt");
    // The context digests are therefore distinct — and NOT because the caseId
    // label differs, but because the captured message lists differ.
    expect(first.capturedRequests[0]!.digest).not.toBe(second.capturedRequests[0]!.digest);

    // Each case wrote ITS OWN artifact with ITS OWN content.
    expect(first.report!.task_id).toBe(CASE_ID);
    expect(second.report!.task_id).toBe(SECOND_CASE_ID);

    // BOTH units are durable and BOTH were charged PER REAL CALL.
    const state = await readJson(join(root, "state", EXEC_FILE));
    const records = state!["records"] as Array<Record<string, unknown>>;
    expect(records.map((r) => r["caseId"]).sort()).toEqual([CASE_ID, SECOND_CASE_ID].sort());
    const ledger = await readJson(join(root, "ledger", LEDGER_FILE));
    const entries = ledger!["entries"] as Array<Record<string, unknown>>;
    const totalMeasured = Number(first.budget!.logicalCalls) + Number(second.budget!.logicalCalls);
    expect(totalMeasured).toBeGreaterThan(2);
    expect(entries).toHaveLength(totalMeasured);
    expect(entries.every((e) => e["status"] === "committed" && e["consumed"] === 1)).toBe(true);
  }, 300_000);

  it("REFUSES a unit whose checkout is not the approved build, and dispatches NOTHING", async () => {
    // Plan §R99 怎么验收: "故意互换 worker 构建时失败."
    const { record, root } = await runUnit({ approvedSourceSha: "0".repeat(40), arm: "candidate" });

    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("harness");
    expect(record.detail).toContain("0000000000000000000000000000000000000000");
    // The refusal names the OBSERVED sha too, so the operator can see both sides.
    expect(record.detail).toContain(record.build.sourceSha!);
    // NOTHING was executed, so the verdict cannot be report-derived.
    expect(record.detail).not.toContain("verification_passed=");

    // THE STRONGER PROPERTY: a unit refused before dispatch touches NO budget at
    // all. A ledger that existed here would mean a call was charged for work
    // that provably never happened.
    expect(existsSync(join(root, "ledger", LEDGER_FILE))).toBe(false);
    expect(existsSync(join(root, "state", EXEC_FILE))).toBe(false);
  }, 120_000);

  it("a case MISSING from the arm is refused — never borrowed from the driver repo (T4 怎么做 7)", async () => {
    // Plan §T4 怎么做 7: "staging 后再次验证实际字节，worker 不得悄悄找 driver repo 的
    // 替代案例." and §T4 怎么验收: "缺 arm 输入不会从 driver repo 回退."
    //
    // The staging search used to carry an arm-then-repo candidate list. That second
    // entry is a genuine fallback, and for a case the ARM does not carry it
    // substituted the DRIVER's copy — so the unit executed a case the arm's build
    // had never been observed against, while reporting the arm's build identity.
    //
    // The arm here is a REAL, complete build (its dist artifacts are copied from
    // this repo, so the build identity and the CLI entry are established, and it
    // carries a real git HEAD so the build binding is established too) that simply
    // has NO `benchmarks/`. `repoRoot` is the real repo, which DOES have the case.
    // A fallback would find it there and run; a refusal cannot.
    //
    // E4-R104 (A4): "its dist artifacts" now means the DERIVED CLOSURE, not the
    // declared list. The digest is a walk of the real import graph, so a tree that
    // carries the five declared entry files but not what they import (measured:
    // `packages/model/dist/index.js` imports `./registry.js`) has no establishable
    // identity at all — and this test needs one, because it measures the CASE
    // lookup, not the identity. The fixture therefore materialises exactly what the
    // manifest derives from the repo it copies from.
    const fakeArm = await tempDir();
    for (const rel of mod.armBuildClosurePaths(REPO)) {
      const dest = join(fakeArm, ...rel.split("/"));
      await mkdir(join(dest, ".."), { recursive: true });
      await cp(join(REPO, ...rel.split("/")), dest);
    }
    const { execFileSync } = await import("node:child_process");
    const git = (args: string[]) => execFileSync("git", args, { cwd: fakeArm, stdio: "ignore" });
    git(["init", "-q"]);
    git(["-c", "user.email=t@e.st", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "an arm with no benchmarks"]);
    // The approved sha is the FAKE ARM's own, so the build binding is SATISFIED and
    // the run reaches the staging step. Otherwise the unit would refuse for the
    // build mismatch and this test would prove nothing about the case source.
    const fakeBuild = mod.armBuildIdentity(fakeArm);
    expect(fakeBuild.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    const root = await tempDir();
    const { record } = await runUnit({
      checkoutDir: fakeArm,
      approvedSourceSha: fakeBuild.sourceSha,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
    });
    expect(record.status).toBe("failed");
    // A missing arm input is an INFRASTRUCTURE failure: it says the checkout is
    // incomplete, not that the campaign's own plumbing refused. Either way it is a
    // failure and never a pass.
    expect(record.failureCategory).toBe("infrastructure");
    // The refusal names the ARM it searched, so the operator knows which checkout
    // is incomplete — and it proves the driver's tree was never consulted.
    expect(String(record.detail)).toContain(fakeArm);
    expect(String(record.detail)).toMatch(/not found/i);
    // It must NOT have executed anything: a fallback would have produced a real
    // verdict from the driver's own copy of the case.
    expect(String(record.detail)).not.toContain("verification_passed=");
    expect(record.caseSource ?? null).toBeNull();
  }, 120_000);
});

describe("R99 W9: failure text is redacted before it can reach a caller", () => {
  it("removes bearer tokens, provider keys, query credentials and URL userinfo", () => {
    const canary = "sk-live-CANARY0123456789abcdef";
    const text = mod.redact(
      `request to https://user:${canary}@api.example.com/v1?api_key=${canary}&x=1 failed: Authorization: Bearer ${canary}`,
    );
    expect(text).not.toContain(canary);
    expect(text).not.toContain("CANARY0123456789");
    // The structure survives, so the message is still diagnosable.
    expect(text).toContain("api.example.com");
  });

  it("walks a NESTED cause rather than stringifying the whole error", () => {
    const canary = "rk-nested-CANARY9876543210zyxwvu";
    const inner = new Error(`inner failed with key ${canary}`);
    const outer = new Error("outer failed", { cause: inner });
    const text = mod.redact(outer);
    expect(text).not.toContain(canary);
    expect(text).toContain("outer failed");
    expect(text).toContain("inner failed");
  });

  it("caps the message, so a huge provider payload cannot flood a report", () => {
    const text = mod.redact("x".repeat(5_000));
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it("exposes `redactFailureText` as the SAME function, not a second implementation", () => {
    expect(mod.redactFailureText).toBe(mod.redact);
  });
});

describe("R99 W10: the worker's report SURVIVES it, linked and hashed", () => {
  // Plan §T3 怎么做 1: "持久保存本次单例报告、必要事件和结果身份，不在 finally 中删除
  // 唯一证据." The previous worker deleted the arm's only report in `finally`
  // (finding N5), so after a campaign ended nothing on disk could substantiate a
  // verdict.
  //
  // Plan §T3 怎么验收: "worker 结束后原报告仍存在."

  it("leaves a real evidence file on disk after the worker returns", async () => {
    const { record, root } = await runUnit({ timeoutMs: 300_000 });

    // The unit really executed, so there IS a report to preserve.
    expect(record.detail).toContain("verification_passed=");
    expect(record.report).not.toBeNull();

    const link = (record as unknown as { evidence?: { path: string; sha256: string } | null }).evidence;
    expect(link, "a terminal unit must name the evidence its verdict rests on").toBeTruthy();
    expect(link!.path).toMatch(/^attempts\//);
    expect(link!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The file is there, and its bytes hash to exactly what the record claims.
    const abs = join(root, "ledger", ...link!.path.split("/"));
    expect(existsSync(abs), `the evidence file must still exist at ${abs}`).toBe(true);
    const bytes = await readFile(abs);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(link!.sha256);

    // ...and the file carries the SAME row the record reports, so the evidence
    // is the proof rather than a parallel copy that could drift.
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      unit: { caseId: string; arm: string };
      report: Record<string, unknown> | null;
      resultHash: string;
    };
    expect(envelope.unit.caseId).toBe(CASE_ID);
    expect(envelope.report!["task_id"]).toBe(record.report!.task_id);
    expect(envelope.report!["reportHash"]).toBe(record.report!.reportHash);
    // The record's resultHash IS the evidence's, so a validator can recompute it.
    expect(record.resultHash).toBe(envelope.resultHash);
  }, 300_000);

  it("keeps the staging scratch out of the evidence, and only the scratch", async () => {
    // The `finally` cleanup is still a cleanup: it removes the STAGED CASE, which
    // is a working copy, and nothing else. A worker that stopped cleaning up
    // would leave the campaign's evidence directory full of scratch trees.
    const { record, root } = await runUnit({ timeoutMs: 300_000 });
    const link = (record as unknown as { evidence?: { path: string } | null }).evidence;
    expect(link).toBeTruthy();
    // The attempt directory holds exactly the evidence file.
    const { readdir } = await import("node:fs/promises");
    const dir = join(root, "ledger", ...link!.path.split("/").slice(0, -1));
    expect(await readdir(dir)).toEqual([link!.path.split("/").pop()]);
  }, 300_000);

  it("the stored evidence row is REDACTED: no credential-shaped text reaches it", async () => {
    const { record, root } = await runUnit({ timeoutMs: 300_000 });
    const link = (record as unknown as { evidence?: { path: string } | null }).evidence;
    const bytes = await readFile(join(root, "ledger", ...link!.path.split("/")), "utf8");
    // No API-key shape, no Authorization header, no URL userinfo.
    expect(bytes).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/);
    expect(bytes).not.toMatch(/[Bb]earer\s+[A-Za-z0-9._-]{16,}/);
    expect(bytes).not.toMatch(/https?:\/\/[^/\s:@]+:[^/\s:@]+@/);
  }, 300_000);

  it("the TERMINAL RECORD is redacted too, and agrees with the evidence it links to", async () => {
    /**
     * MEASURED DEFECT (E4-R101-A / T6), found while fixing the forged-PASS hole.
     *
     * `r97-arm-worker.mjs` built the two verdict texts from DIFFERENT inputs:
     *   - the envelope:  `verdict: { detail: redact(verdict.detail) }`
     *   - the record:    `terminalDetail = \`${ARM_WORKER_VERSION} ${cat}: ${verdict.detail}\``
     *
     * The record used the RAW text. So a verdict detail that `redact()` rewrites
     * produced a record that (a) carried the credential in cleartext into
     * `execution-state.json`, and (b) DISAGREED with the hashed evidence it points
     * at. Measured with a secret-shaped caseId, whose "not found" refusal embeds the
     * caseId verbatim:
     *
     *   record   : "…infrastructure: E4-R98: the report holds no result for case sk-abc1234567890abcdef"
     *   evidence : "E4-R98: the report holds no result for case <redacted-key>"
     *
     * The leak is the security half; the disagreement is the integrity half, and it
     * matters because the campaign validator now binds the record's detail to the
     * evidence. An unredacted record would make that binding refuse an HONEST run.
     *
     * The property is stated directly: whatever text the record carries must be the
     * text the evidence hashes, and it must be redacted.
     */
    const SECRET = "sk-abc1234567890abcdef";
    const raw = { category: "infrastructure", detail: `E4-R98: the report holds no result for case ${SECRET}` };

    const terminal = mod.terminalDetailFor(raw);
    // (a) No credential-shaped text in the record's own text.
    expect(terminal, "the terminal record must not carry the raw credential").not.toContain(SECRET);
    expect(terminal).toMatch(/<redacted/);
    // (b) The record's remainder IS the evidence's text, so the validator's binding
    //     holds for honest runs.
    const evidenceText = mod.redact(raw.detail);
    expect(terminal).toBe(`${mod.ARM_WORKER_VERSION} ${raw.category}: ${evidenceText}`);
    // ...and the shape the driver's `unitCategoryOf` reads is preserved, so the
    // aggregate still classifies the unit instead of seeing "nothing".
    expect(terminal.startsWith(`${mod.ARM_WORKER_VERSION} ${raw.category}: `)).toBe(true);

    // The NEGATIVE CONTROL: an ordinary detail is passed through UNCHANGED. A
    // redactor that mangled every sentence would also satisfy the assertions above
    // while corrupting every verdict in every campaign.
    const plain = { category: "case_failed", detail: "case did not pass: verification_failed (verification_passed=false)" };
    expect(mod.terminalDetailFor(plain)).toBe(`${mod.ARM_WORKER_VERSION} case_failed: case did not pass: verification_failed (verification_passed=false)`);
  });

  it("the record's detail AGREES with its own evidence on a REAL unit", async () => {
    // The end-to-end form over a real run, reading the PERSISTED artifacts back off
    // disk — `execution-state.json` and the linked envelope — because those are
    // exactly what `r97-validate-campaign.mjs` reconciles.
    //
    // NOTE the distinction that this test exists to pin: `runArmUnit`'s RETURNED
    // `record.detail` is the bare verdict sentence, while the persisted terminal
    // record carries the `<version> <category>: ` prefix the driver's
    // `unitCategoryOf` reads. Only the persisted form is the validator's input, so
    // only the persisted form is asserted here.
    const { root } = await runUnit({ timeoutMs: 300_000 });
    const state = await readJson(join(root, "state", EXEC_FILE));
    const records = state!["records"] as Array<Record<string, unknown>>;
    expect(records, "a real unit persists exactly one terminal record").toHaveLength(1);
    const persisted = records[0]!;
    const link = persisted["evidence"] as { path: string } | null;
    expect(link, "the persisted record links its evidence").toBeTruthy();

    const envelope = JSON.parse(await readFile(join(root, "ledger", ...link!.path.split("/")), "utf8")) as {
      verdict: { category: string | null; detail: string };
    };

    const expected = `${mod.ARM_WORKER_VERSION} ${envelope.verdict.category ?? "passed"}: ${envelope.verdict.detail}`;
    expect(persisted["detail"], "the persisted record must carry the evidence's own verdict text").toBe(expected);
  }, 300_000);

  it("a REFUSED unit still records evidence, because its refusal is the result", async () => {
    // A unit refused before dispatch has no report — and that ABSENCE is the fact
    // its verdict rests on, so the envelope must record `report: null` rather
    // than being skipped. Otherwise "refused" and "the evidence was deleted"
    // would look the same to a validator.
    const { record, root } = await runUnit({ approvedSourceSha: "0".repeat(40), arm: "candidate" });
    expect(record.status).toBe("failed");
    // Refused BEFORE any state existed: there is no attempt, hence no evidence,
    // and the record says so by carrying no link rather than a dangling one.
    expect((record as unknown as { evidence?: unknown }).evidence ?? null).toBeNull();
    expect(existsSync(join(root, "state", EXEC_FILE))).toBe(false);
  }, 120_000);
});

/**
 * A PROTOCOL FIXTURE arm whose exported `runBenchmarkCommand` reproduces the
 * measured F1 shape: it consumes ONE non-terminal event from the injected
 * (budgeted) provider — so the request really left — and then DIES.
 *
 * This is labelled a protocol fixture deliberately: it is a synthetic arm
 * export, not a real frozen benchmark arm, and nothing here is evidence about
 * model quality or a benchmark score. What it measures is the CAMPAIGN's
 * budget bookkeeping on an exception path, which is the only thing A1 asserts.
 *
 * The synthetic model package is SELF-CONTAINED on purpose: a copied
 * `packages/model/dist` would need the workspace's `@ar/*` links, and linking
 * them would make this fixture depend on the machine's install layout rather
 * than on the worker's contract.
 */
const SYNTHETIC_MODEL = `export class ScriptedModelProvider {
  constructor(scripts) {
    this.scripts = scripts;
    this.calls = [];
    this.index = 0;
    this.id = "scripted";
  }
  async listModels() {
    return [{ id: "scripted-model", name: "Scripted" }];
  }
  createClient() {
    const p = this;
    return {
      generate: async function* () {
        const i = p.index;
        p.index += 1;
        p.calls.push(i);
        const script = p.scripts[i];
        if (script) yield* script;
      },
    };
  }
  static text(text) {
    return [
      { type: "started", timestamp: 0 },
      { type: "text_delta", text, timestamp: 0 },
      { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
    ];
  }
  static toolCall(name, args = {}) {
    const id = "tc-" + Math.random().toString(16).slice(2);
    return [
      { type: "started", timestamp: 0 },
      { type: "tool_call_delta", toolCall: { id, name, args }, timestamp: 0 },
      { type: "completed", result: { finishReason: "tool_calls", toolCalls: [{ id, name, args }] }, timestamp: 0 },
    ];
  }
}
`;

const SYNTHETIC_CLI = `import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SENTINEL = join(here, "synthetic-dispatch.log");

export { ScriptedModelProvider };

export async function runBenchmarkCommand(argv, providerOverride) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({ planDigest: null, providerId: "openai", modelId: "approved-model-x", endpointIdentity: null })],
    };
  }
  const client = providerOverride.createClient({ providerId: "openai", modelId: "approved-model-x" }, {});
  const controller = new AbortController();
  for await (const ev of client.generate({ messages: [{ role: "user", content: "r98" }] }, controller.signal)) {
    appendFileSync(SENTINEL, ev.type + "\\n");
    break;
  }
  throw new Error("E4-R98: synthetic arm CLI died after the request left");
}
`;

const SYNTHETIC_LOG = "synthetic-dispatch.log";

/**
 * The env var that tells the settlement-failure fixture WHERE the campaign ledger
 * is.
 *
 * The arm CLI is loaded INSIDE the child process (`r97-arm-child-runner.mjs` ->
 * `r97-arm-exec.mjs` -> the arm's own `runBenchmarkCommand`), and that child
 * inherits this process's environment (`runArmCaseAtBoundary` spawns it with
 * `env: process.env`). Handing the fixture the path through the environment is
 * therefore a real, inherited channel — the fixture never GUESSES the ledger's
 * location, and the test owns the path it passed to `runArmUnit`.
 */
const LEDGER_DELETE_ENV = "R97_TEST_LEDGER_TO_DELETE";

/**
 * The synthetic arm used by the SETTLEMENT-FAILURE test.
 *
 * It is the SAME shape as `SYNTHETIC_CLI` — it drives the injected provider, reads
 * ONE event, then dies — with one added step placed at the exact instant that
 * makes the failure land on the SETTLEMENT write rather than on the OPEN:
 *
 *   1. the child process OPENS the ledger with `mode: "resume"` (the file must
 *      still exist here, and it does — the parent bootstrapped it during
 *      `openR97Campaign`);
 *   2. the first `generate()` ADOPTS the pre-taken reservation and enters the
 *      inner provider (`dispatch.entered = true`), which is why an event is
 *      readable at all;
 *   3. the ledger FILE is deleted (`rmSync` — cross-platform; `chmod` is a no-op
 *      on Windows and is deliberately NOT used);
 *   4. `break` ends the generator, so the channel's `finally` runs `settle()`,
 *      which is a locked read-modify-write: `withLedger` calls `read()` INSIDE the
 *      lock BEFORE the mutation, and a DELETED ledger on an ESTABLISHED handle
 *      throws `BUDGET_STATE_MISSING`. The failure is therefore on the SETTLE, not
 *      on the open, and `settled` stays false while `entered` is true.
 *
 * Deleting in `beforeStageCopy` would NOT do: that hook runs before the child
 * opens, so the child would refuse at OPEN, no reservation would be taken and
 * nothing would be dispatched — a different branch entirely.
 */
const SYNTHETIC_SETTLEMENT_FAILURE_CLI = `import { appendFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SENTINEL = join(here, "synthetic-dispatch.log");
const LEDGER_TO_DELETE = process.env.R97_TEST_LEDGER_TO_DELETE ?? "";

export { ScriptedModelProvider };

export async function runBenchmarkCommand(argv, providerOverride) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({ planDigest: null, providerId: "openai", modelId: "approved-model-x", endpointIdentity: null })],
    };
  }
  const client = providerOverride.createClient({ providerId: "openai", modelId: "approved-model-x" }, {});
  const controller = new AbortController();
  for await (const ev of client.generate({ messages: [{ role: "user", content: "r98" }] }, controller.signal)) {
    appendFileSync(SENTINEL, ev.type + "\\n");
    // THE INJECTION POINT: the reservation is taken and the inner provider has
    // already been ENTERED (an event was yielded), and the channel's settlement
    // has NOT yet run (it runs when the consumer ends the generator). Deleting
    // here makes the settlement's locked read fail closed.
    if (LEDGER_TO_DELETE !== "") rmSync(LEDGER_TO_DELETE, { force: true });
    break;
  }
  throw new Error("E4-R98: synthetic arm CLI died after the request left");
}
`;

/** Build a loadable synthetic arm with a REAL build identity and ONE real case. */
async function syntheticArm(opts: { cli?: string } = {}): Promise<{ dir: string; sha: string }> {
  const dir = await tempDir();
  // Every artifact `armBuildIdentity` covers must EXIST (the digest is computed
  // over all of them), and the two the executor actually LOADS are the
  // synthetic ones written below.
  //
  // E4-R104 (A4): the covered set is the DERIVED closure, so the fixture copies the
  // closure the repo's own manifest derives — the five declared entries alone do
  // not resolve (`packages/model/dist/index.js` imports `./registry.js`). The two
  // synthetic overwrites below then REPLACE modules inside that closure, which can
  // only shrink what the walk reaches, never break it: every relative specifier
  // they keep still resolves inside the copied tree, and the bare specifiers the
  // copies name are recorded as externals.
  for (const rel of mod.armBuildClosurePaths(REPO)) {
    const dest = join(dir, ...rel.split("/"));
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(join(REPO, ...rel.split("/")), dest);
  }
  await writeFile(join(dir, "packages", "model", "dist", "index.js"), SYNTHETIC_MODEL, "utf8");
  await writeFile(join(dir, "apps", "cli", "dist", "benchmark-command.js"), opts.cli ?? SYNTHETIC_CLI, "utf8");
  await mkdir(join(dir, "benchmarks", "r98-fixtures"), { recursive: true });
  await cp(join(REPO, "benchmarks", "r98-fixtures", CASE_ID), join(dir, "benchmarks", "r98-fixtures", CASE_ID), {
    recursive: true,
  });
  const { execFileSync } = await import("node:child_process");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["-c", "user.email=t@e.st", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "synthetic arm"]);
  const build = mod.armBuildIdentity(dir);
  return { dir, sha: build.sourceSha! };
}

describe("R99 W11 (A1/F1): a DISPATCHED call is never refunded when the arm CLI dies afterwards", () => {
  it("grant=1, the consumer breaks mid-stream and the CLI throws: innerCalls=1, NOT abandoned, remaining=0, second reserve refused", async () => {
    // MEASURED DEFECT F1 (plan §0.2, P0):
    //   "inner generator 已进入 1 次；消费者读一个事件后 break，CLI 再抛错；worker
    //    consumed=0，reservation=`abandoned`，grant=1 时另一次 reserve 仍成功"
    //
    // `budgetStats` was only assigned on the executor's SUCCESSFUL return, so an
    // exception after a real dispatch left it `null` and the worker read that as
    // "nothing was sent" — refunding a call that really entered the provider.
    const arm = await syntheticArm();
    const root = await tempDir();
    const planDigest = "b".repeat(64);
    const record = await mod.runArmUnit({
      checkoutDir: arm.dir,
      repoRoot: REPO,
      caseId: CASE_ID,
      suite: "regression",
      arm: "baseline",
      repetition: 1,
      planDigest,
      approvedSourceSha: arm.sha,
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
      maxModelCalls: 1,
      campaignModelCalls: 1,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: 120_000,
    });

    // GROUND TRUTH: the request really entered the inner provider. The synthetic
    // arm appends one line per event it READ from the budgeted provider, so this
    // is a real side effect, not a self-reported counter.
    const sentinel = join(arm.dir, "apps", "cli", "dist", SYNTHETIC_LOG);
    expect(existsSync(sentinel), "the synthetic arm really drove the injected provider").toBe(true);
    expect((await readFile(sentinel, "utf8")).trim().split("\n")).toEqual(["started"]);

    // THE DISCRIMINATOR: the reservation is settled, NOT refunded.
    const ledgerOnDisk = JSON.parse(await readFile(join(root, "ledger", LEDGER_FILE), "utf8")) as {
      entries: Array<{ reservationId: string; status: string; consumed: number | null }>;
      campaignModelCalls: number;
    };
    expect(ledgerOnDisk.entries, "one reservation per real call").toHaveLength(1);
    expect(ledgerOnDisk.entries[0]!.reservationId).toBe(record.reservationId);
    expect(ledgerOnDisk.entries[0]!.status, "an ENTERED call is never refunded as abandoned").toBe("unknown");
    expect(viewOfR97Ledger(ledgerOnDisk as never).remaining, "the spent allowance is gone").toBe(0);

    // The unit is an honest FAILURE (the arm CLI died), but its spend is REAL.
    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("infrastructure");
    expect(record.consumed, "the channel measured ONE admitted logical call").toBe(1);
    expect(record.budget?.logicalCalls, "the live channel stats reach the caller even on the throw path").toBe(1);
    expect(record.reservationIds).toContain(record.reservationId);

    // And the SAME approval cannot spend a second call.
    const reopened = await openR97BudgetLedger(join(root, "ledger"), {
      planDigest,
      campaignModelCalls: 1,
      mode: "resume",
    });
    const second = await reopened.reserve("baseline", 1);
    expect(second.ok, "a spent allowance must not be re-granted").toBe(false);
  }, 180_000);

  /**
   * THE WORKER-LEVEL END-TO-END COVERAGE THE REPORT SAYS IS MISSING.
   *
   * `docs/E4-R99-R101-report.md:2370` records the residual gap verbatim:
   *
   *   "worker 级的 settlement-write-failure 分支未被端到端覆盖（只在 channel 层覆盖）"
   *
   * The channel's own suite drives `createLedgerBudgetedProvider` directly, so it
   * proves the `finally` settlement fails when the ledger write fails. It does NOT
   * prove what the WORKER does with that fact: that `runArmUnit`'s STEP 5 reads the
   * child's live dispatch record, takes the Case-3 branch
   * (`entered === true && settled !== true`) at `scripts/e4/r97-arm-worker.mjs:2731`,
   * folds a `budget` verdict over the boundary's `infrastructure` one, KEEPS the
   * allowance outstanding, and never refunds it.
   *
   * That is the branch measured here, through the REAL `runArmUnit` and the REAL
   * child process. The report's `:2317` note is the other half of the same gap.
   *
   * THE INJECTION IS A DELETED LEDGER FILE, chosen because `rm` is cross-platform
   * (Windows and Ubuntu) while `chmod` is a no-op on Windows. It is applied from
   * INSIDE the arm's own CLI, at the one instant that lands the failure on the
   * SETTLEMENT write: after the first event was read (so the reservation IS taken
   * and the inner provider IS entered) and before the consumer ends the generator
   * (so `settle()` has not run yet). Deleting earlier — in `beforeStageCopy`, say —
   * would make the child refuse at OPEN, with no reservation and no dispatch.
   */
  it("a SETTLEMENT write failure on an ENTERED call is refused as `budget` and the allowance is NOT refunded", async () => {
    const arm = await syntheticArm({ cli: SYNTHETIC_SETTLEMENT_FAILURE_CLI });
    const root = await tempDir();
    const planDigest = "c".repeat(64);
    const ledgerPath = join(root, "ledger", LEDGER_FILE);
    // The child inherits this environment (`runArmCaseAtBoundary` spawns it with
    // the parent's `process.env`), so the fixture learns the ledger's location
    // from the TEST rather than guessing it.
    process.env[LEDGER_DELETE_ENV] = ledgerPath;
    let record: ArmUnitRecord;
    try {
      record = await mod.runArmUnit({
        checkoutDir: arm.dir,
        repoRoot: REPO,
        caseId: CASE_ID,
        suite: "regression",
        arm: "baseline",
        repetition: 1,
        planDigest,
        approvedSourceSha: arm.sha,
        providerId: "openai",
        modelId: "approved-model-x",
        endpointBaseUrl: "http://127.0.0.1:9/v1",
        maxModelCalls: 1,
        campaignModelCalls: 1,
        executionStateDir: join(root, "state"),
        ledgerDir: join(root, "ledger"),
        outDir: join(root, "out"),
        timeoutMs: 120_000,
      });
    } finally {
      delete process.env[LEDGER_DELETE_ENV];
    }

    // ---- GROUND TRUTH: the call really ENTERED the inner provider. ----------
    //
    // The fixture appends one line per event it READ from the budgeted provider,
    // and it deletes the ledger only AFTER that read. So this sentinel is what
    // proves the injection happened at the settlement boundary rather than before
    // the open: a refusal at OPEN would have produced no event at all.
    const sentinel = join(arm.dir, "apps", "cli", "dist", SYNTHETIC_LOG);
    expect(existsSync(sentinel), "the synthetic arm really drove the injected provider").toBe(true);
    expect((await readFile(sentinel, "utf8")).trim().split("\n")).toEqual(["started"]);

    // ---- THE DISCRIMINATOR: ENTERED, NOT SETTLED. ---------------------------
    //
    // `entered === true` says the reservation was ADOPTED and a request was
    // admitted. `settled === false` with `settlement === null` says the terminal
    // ledger write did NOT land — measured, not inferred, which is exactly what
    // A1/F1 moved the settlement onto the live `stats` object for.
    const dispatches = record.budget?.dispatches ?? [];
    expect(dispatches, "one dispatch record per admitted call").toHaveLength(1);
    expect(dispatches[0]!.reservationId).toBe(record.reservationId);
    expect(dispatches[0]!.entered, "the call was ADMITTED before the ledger was deleted").toBe(true);
    expect(dispatches[0]!.settled, "the terminal write did NOT land").toBe(false);
    expect(dispatches[0]!.settlement).toBeNull();

    // ---- THE SETTLEMENT FAILURE IS NAMED, NOT SWALLOWED. -------------------
    expect(record.budget?.settlementFailures, "the channel counted the failed settle").toBe(1);
    expect(
      String(record.budget?.lastSettlementError),
      "the failure names the lost-state refusal, so the cause is diagnosable",
    ).toMatch(/BUDGET_STATE_MISSING/);

    // ---- THE WORKER'S VERDICT: `budget`, AND AN HONEST FAILURE. ------------
    //
    // Case 3 FOLDS a `budget` verdict (rank 1) over the boundary's
    // `infrastructure` one (rank 3), refuses to report a success, and keeps the
    // allowance outstanding. The pre-A1 behaviour — falling through to
    // `ledger.abandon(...)` — is the mutation `a1-worker-settlement-failure-refunded`
    // in `scripts/e4/r97-mutation-check.mjs`, which this test must catch.
    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("budget");
    expect(record.verifierPassed).toBe(false);
    expect(record.consumed, "the admitted call is charged").toBe(1);
    expect(record.detail ?? "").toMatch(/could not be settled/);
    // THE BRANCH ITSELF IS THE MEASUREMENT. Case 3 keeps the entry outstanding;
    // the refund path (the `else` that calls `ledger.abandon`) says something
    // different and would be taken for an entered-but-unsettled dispatch under the
    // pre-A1 behaviour. Naming the difference here is what makes the mutation
    // `a1-worker-settlement-failure-refunded` fail for the RIGHT reason rather than
    // by an unrelated accident.
    expect(record.detail ?? "", "an ENTERED call is never routed to the refund path").not.toMatch(
      /could not be returned/,
    );

    // ---- THE ALLOWANCE IS NOT RETURNED. ------------------------------------
    //
    // THE LOAD-BEARING ASSERTION: a refund would have to WRITE the ledger, and
    // every settle path fails closed at the READ because the handle is
    // `established`. So the file must still be ABSENT — the physical proof that no
    // refund write happened, and therefore that the spend is still outstanding
    // rather than silently re-granted.
    expect(existsSync(ledgerPath), "no refund write recreated the ledger").toBe(false);
  }, 180_000);
});

// ===========================================================================
// E4-R105 (A5 / F5) — AN IDENTITY REFUSAL IS A VERDICT, NOT A DETAIL THE NEXT
// SUCCESSFUL REPORT MAY OVERWRITE.
// ===========================================================================
//
// MEASURED DEFECT F5 (plan §A5):
//
//   "`runArmUnit` 已发现 executionIdentity.drift，但后续报告分类会覆盖它."
//
// The worker DID detect the drift and DID set a `harness` verdict — and then an
// INDEPENDENT `if/else` below it ran `classifyReport` and unconditionally
// assigned `record.verifierPassed = classified.passed === true`, so a report that
// merely CLAIMED `verification_passed=true` turned a refused unit into
// `status: "completed"`, `failureCategory: null`, `verifierPassed: true`.
//
// PLAN §A5 怎么做 2 states the required shape: "将 verdict 决策写成明确、互斥的状态
// 转换 … 不能后续无条件赋值覆盖。不要只在最后把 verifierPassed 置 false 而仍写
// completed/passed detail." The fix is a total, ordered VERDICT PRIORITY TABLE and a
// fold that applies it, so the FIRST blocking fact keeps its rank and every later
// fact is retained only as a diagnostic.
//
// ---- WHAT THESE ARMS ARE, AND WHAT THEY ARE NOT --------------------------
//
// The arms below are PROTOCOL FIXTURES: synthetic `apps/cli/dist/benchmark-command.js`
// exports written by this test, NOT the frozen benchmark arms. Nothing here is
// evidence about model quality, a benchmark score, or promotability. What they
// measure is the CAMPAIGN's verdict priority — which fact a terminal record is
// allowed to report when several hold at once. The one PASS they produce is a
// protocol-fixture pass and must never be counted into a real benchmark result.
//
// Every fact they assert is a SIDE EFFECT on disk (the client ref the fixture
// really handed to `createClient`, whether a dispatch happened at all), never a
// self-reported counter, so the tests cannot pass vacuously.

const APPROVED_MODEL = "approved-model";

/** What one protocol-fixture arm is told to do. */
interface IdentityFixtureSpec {
  /** What the arm's OWN dry-run plan declares. `null` = an unparseable plan. */
  declaredModelId: string | null;
  /** The dry run's exit code. Non-zero = the dry run FAILED. */
  dryRunExitCode: number;
  /** The model the REAL `createClient` is handed. `null` = a null identity. */
  runtimeModelId: string | null;
  /**
   * The report the arm writes, if any.
   *
   *   `"pass"`        — claims `verification_passed=true` (the synthetic PASS that
   *                     must NOT be allowed to outrank an identity refusal);
   *   `"case_failed"` — the LEGITIMATE NEGATIVE: the case ran and its own task
   *                     failed. Plan §A5 怎么做 7 requires this to stay a
   *                     `case_failed` and not be collapsed into an infrastructure
   *                     error by an over-broad refusal;
   *   `null`          — no report at all.
   */
  reportOutcome: "pass" | "case_failed" | null;
}

/**
 * The fixture arm's CLI source.
 *
 * `providerId` is deliberately held constant: plan §A5 怎么做 4 allows the
 * offline-substitute relationship ("离线 scripted 替身与批准 provider 的差异可按既有
 * offline-test 合同允许") but requires it to be MODELLED SEPARATELY rather than
 * generalised away — the worker records it as
 * `executingProviderId`/`providerIsOfflineSubstitute`. This fixture varies only the
 * MODEL, which is the fact the plan names ("createClient/generate 边界核对真实
 * modelRef").
 */
function identityFixtureCli(spec: IdentityFixtureSpec): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCH_LOG = join(here, "identity-fixture-dispatch.log");
const CLIENT_LOG = join(here, "identity-fixture-clients.json");

const DRY_RUN_EXIT = ${spec.dryRunExitCode};
const DECLARED_MODEL = ${JSON.stringify(spec.declaredModelId)};
const RUNTIME_MODEL = ${JSON.stringify(spec.runtimeModelId)};
const REPORT_OUTCOME = ${JSON.stringify(spec.reportOutcome)};
const CASE_ID = ${JSON.stringify(CASE_ID)};

export { ScriptedModelProvider };

function argOf(argv, flag) {
  const i = Array.isArray(argv) ? argv.indexOf(flag) : -1;
  return i >= 0 ? argv[i + 1] : null;
}

export async function runBenchmarkCommand(argv, providerOverride) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) {
    if (DRY_RUN_EXIT !== 0) {
      return { exitCode: DRY_RUN_EXIT, lines: ["synthetic identity fixture: the dry run FAILED"] };
    }
    if (DECLARED_MODEL === null) {
      return { exitCode: 0, lines: ["synthetic identity fixture: no plan to parse"] };
    }
    return {
      exitCode: 0,
      lines: [JSON.stringify({ planDigest: null, providerId: "openai", modelId: DECLARED_MODEL, endpointIdentity: null })],
    };
  }
  appendFileSync(DISPATCH_LOG, "dispatch\\n");
  writeFileSync(CLIENT_LOG, JSON.stringify(RUNTIME_MODEL === null ? [] : [{ providerId: "openai", modelId: RUNTIME_MODEL }]));
  try {
    const client = providerOverride.createClient({ providerId: "openai", modelId: RUNTIME_MODEL }, {});
    const controller = new AbortController();
    for await (const _ev of client.generate({ messages: [{ role: "user", content: "a5" }] }, controller.signal)) {
      // Drain the scripted stream.
    }
  } catch (err) {
    appendFileSync(DISPATCH_LOG, "refused: " + (err && err.message ? err.message : String(err)) + "\\n");
  }
  if (REPORT_OUTCOME !== null) {
    const out = argOf(argv, "--out");
    const suite = argOf(argv, "--suite") || "regression";
    mkdirSync(out, { recursive: true });
    // The two rows are DIFFERENT MEASUREMENTS, and the difference is the whole
    // point of the legitimate-negative control: a PASS row carries positive
    // verification evidence, a case_failed row carries none and names the
    // termination the case's own verifier produced.
    const row =
      REPORT_OUTCOME === "pass"
        ? {
            task_id: CASE_ID,
            suite: suite,
            success: true,
            actual_status: "completed",
            verification_passed: true,
            verification_failures: [],
            model_calls: 1,
            tool_calls: 0,
            termination_reason: "stop",
            failure_category: null,
          }
        : {
            task_id: CASE_ID,
            suite: suite,
            success: false,
            actual_status: "failed",
            verification_passed: false,
            verification_failures: ["the case's own check did not hold"],
            model_calls: 1,
            tool_calls: 0,
            termination_reason: "verification_failed",
            failure_category: null,
          };
    writeFileSync(
      join(out, suite === "regression" ? "baseline.json" : suite + ".json"),
      JSON.stringify({ results: [row] }, null, 2),
    );
  }
  return { exitCode: 0, lines: ["synthetic identity fixture: done"] };
}
`;
}

/** The derived closure is the same for every fixture arm, so it is copied once
 *  per spec but enumerated once per file. */
let CLOSURE_CACHE: string[] | null = null;
function closurePaths(): string[] {
  CLOSURE_CACHE ??= mod.armBuildClosurePaths(REPO);
  return CLOSURE_CACHE;
}

/**
 * Build one PROTOCOL FIXTURE arm: a real, loadable build with a real git HEAD and
 * ONE real case, whose CLI is the source above.
 *
 * The closure is COPIED rather than hand-written because `armBuildIdentity` hashes
 * the DERIVED closure (A4): a tree that is missing a reachable module is "not
 * established" and the unit would be refused before the facts under test.
 */
async function identityFixtureArm(spec: IdentityFixtureSpec): Promise<{
  dir: string;
  sha: string;
  dispatchLog: string;
  clientLog: string;
}> {
  const dir = await tempDir();
  for (const rel of closurePaths()) {
    const dest = join(dir, ...rel.split("/"));
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(join(REPO, ...rel.split("/")), dest);
  }
  await writeFile(join(dir, "packages", "model", "dist", "index.js"), SYNTHETIC_MODEL, "utf8");
  await writeFile(join(dir, "apps", "cli", "dist", "benchmark-command.js"), identityFixtureCli(spec), "utf8");
  await mkdir(join(dir, "benchmarks", "r98-fixtures"), { recursive: true });
  await cp(join(REPO, "benchmarks", "r98-fixtures", CASE_ID), join(dir, "benchmarks", "r98-fixtures", CASE_ID), {
    recursive: true,
  });
  const { execFileSync } = await import("node:child_process");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["-c", "user.email=t@e.st", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "identity fixture arm"]);
  const build = mod.armBuildIdentity(dir);
  return {
    dir,
    sha: build.sourceSha!,
    dispatchLog: join(dir, "apps", "cli", "dist", "identity-fixture-dispatch.log"),
    clientLog: join(dir, "apps", "cli", "dist", "identity-fixture-clients.json"),
  };
}

/** Drive ONE protocol-fixture unit with an explicitly APPROVED model. */
async function runFixtureUnit(spec: IdentityFixtureSpec) {
  const arm = await identityFixtureArm(spec);
  const root = await tempDir();
  const planDigest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  const record = await mod.runArmUnit({
    checkoutDir: arm.dir,
    repoRoot: REPO,
    caseId: CASE_ID,
    suite: "regression",
    arm: "baseline",
    repetition: 1,
    planDigest,
    approvedSourceSha: arm.sha,
    providerId: "openai",
    modelId: APPROVED_MODEL,
    // NO approved endpoint: `null` is a legitimate approval meaning "the
    // provider's built-in endpoint", and it keeps this fixture's only variable the
    // MODEL, which is the fact F5 is about.
    endpointBaseUrl: null,
    executionStateDir: join(root, "state"),
    ledgerDir: join(root, "ledger"),
    outDir: join(root, "out"),
    timeoutMs: 120_000,
  });
  return { record, root, arm, planDigest };
}

describe("R105 (A5/F5): an identity refusal outranks a report that claims a PASS", () => {
  it("PROTOCOL FIXTURE: the runtime's model ref disagrees with the approval, and the synthetic PASS report must not win", async () => {
    const { record, root, arm } = await runFixtureUnit({
      declaredModelId: APPROVED_MODEL,
      dryRunExitCode: 0,
      runtimeModelId: "unapproved-model",
      reportOutcome: "pass",
    });

    // ---- GROUND TRUTH, NOT A SELF-REPORT. --------------------------------
    //
    // The fixture wrote down the ref it really handed to `createClient`, so "the
    // runtime asked for another model" is a fact on disk. The dry run declared the
    // APPROVED model, so this drift is invisible in the arm's own plan: only the
    // runtime's actual `createClient` argument exposes it.
    expect(JSON.parse(await readFile(arm.clientLog, "utf8"))).toEqual([
      { providerId: "openai", modelId: "unapproved-model" },
    ]);
    const identity = record.executionIdentity as {
      approvedModelId?: string | null;
      declaredModelId?: string | null;
      runtimeModelId?: string | null;
      drift?: string[];
    } | null;
    expect(identity, "the worker must record the identity the unit executed under").not.toBeNull();
    expect(identity!.approvedModelId).toBe(APPROVED_MODEL);
    expect(identity!.declaredModelId, "the arm's own dry run declared the approved model").toBe(APPROVED_MODEL);
    expect(identity!.runtimeModelId, "the runtime really asked for another model").toBe("unapproved-model");
    expect((identity!.drift ?? []).join(" ")).toContain("unapproved-model");

    // ---- THE MEASURED DEFECT (F5). ---------------------------------------
    //
    // Before the fix this unit reported `status: "completed"`,
    // `failureCategory: null`, `verifierPassed: true` — a PASS under an identity
    // the plan never approved.
    expect(record.status, "a drifted unit is not a completed pass").toBe("failed");
    expect(record.failureCategory).toBe("harness");
    expect(record.verifierPassed).toBe(false);
    expect(record.detail ?? "").toMatch(/did not approve/i);
    expect(record.detail ?? "", "the terminal detail must not read as a pass").not.toMatch(
      /^e4-r\d+-arm-worker-v\d+ passed:/,
    );

    // ---- THE SYNTHETIC REPORT IS KEPT AS DIAGNOSTIC EVIDENCE. -----------
    //
    // Plan §A5 怎么做 6: "确保保存的 report 是诊断证据，不是覆盖身份失败的权威." The
    // row is NOT deleted and it still says `verification_passed=true` — which is
    // exactly why the verdict, not the row, has to be the authority.
    expect(record.report).not.toBeNull();
    expect(record.report!.verification_passed).toBe(true);

    // ---- THE BOUNDARY: NO REQUEST LEFT. --------------------------------
    //
    // Plan §A5 怎么验收 2: "实际 modelRef 与批准不同：inner generate 次数为 0." The
    // request is only recorded once the arm's provider is about to be driven, so an
    // empty list IS the measurement that the inner `generate` was never entered.
    expect(record.capturedRequests).toEqual([]);
    expect(await readFile(arm.dispatchLog, "utf8")).toMatch(/refused:[\s\S]*unapproved-model/);

    // ---- THE INDEPENDENT VALIDATOR SEES AN EVIDENCE-COMPLETE FAILURE. ---
    //
    // Plan §A5 怎么验收 6: the same refused result, checked by the evidence
    // validator, must be a FAILURE whose evidence is intact — never a task pass.
    const state = await readJson(join(root, "state", EXEC_FILE));
    const persisted = (state!["records"] as Array<Record<string, unknown>>)[0]!;
    expect(persisted["status"], "a refused unit is TERMINAL, so a resume skips it").toBe("failed");
    expect(String(persisted["detail"])).toMatch(/harness:/);
    const checked = await verifyUnitEvidence(join(root, "ledger"), {
      caseId: String(persisted["caseId"]),
      suite: String(persisted["suite"]),
      arm: String(persisted["arm"]),
      repetition: Number(persisted["repetition"]),
      attemptId: String(persisted["attemptId"]),
      resultHash: persisted["resultHash"] as string,
      evidence: persisted["evidence"] as never,
      detail: persisted["detail"] as string,
    });
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(checked.ok && checked.envelope.verdict.category).toBe("harness");
  }, 300_000);

  it("PROTOCOL FIXTURE: a NULL runtime model ref is a refusal, never 'no drift'", async () => {
    // Plan §A5 怎么做 3: "不能将 null 身份解释为'没有漂移'." The runtime handed
    // `createClient` a model ref with no `modelId`; the old drift test was
    // `runtimeModelId !== null && runtimeModelId !== approved`, so a NULL identity
    // skipped the comparison entirely and the synthetic PASS report was accepted.
    const { record } = await runFixtureUnit({
      declaredModelId: APPROVED_MODEL,
      dryRunExitCode: 0,
      runtimeModelId: null,
      reportOutcome: "pass",
    });
    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("harness");
    expect(record.verifierPassed).toBe(false);
    expect(record.detail ?? "").toMatch(/model/i);
    expect(record.capturedRequests).toEqual([]);
  }, 300_000);

  it("PROTOCOL FIXTURE: a FAILED dry run ends the unit BEFORE any dispatch", async () => {
    // Plan §A5 怎么做 3: "dry-run 未成功 … 在实际 dispatch 前结束." The old code read
    // the dry run's lines for an identity and never consulted its EXIT CODE, so a
    // failed dry run left `declaredPlan === null`, every `declared*` comparison
    // short-circuited, and the real case ran anyway.
    const { record, arm } = await runFixtureUnit({
      declaredModelId: APPROVED_MODEL,
      dryRunExitCode: 3,
      runtimeModelId: APPROVED_MODEL,
      reportOutcome: "pass",
    });
    expect(record.status).toBe("failed");
    expect(record.failureCategory).toBe("harness");
    expect(record.verifierPassed).toBe(false);
    // NOTHING was dispatched: the fixture only writes this log on its real path.
    expect(existsSync(arm.dispatchLog), "a failed dry run must not reach the real path").toBe(false);
    expect(record.capturedRequests).toEqual([]);
    expect(record.consumed, "nothing was dispatched, so nothing was charged").toBe(0);
  }, 300_000);

  it("PROTOCOL FIXTURE: an APPROVED-and-matching unit still reaches a verified PASS", async () => {
    // THE CONTROL. A priority table that refuses everything would satisfy the
    // three tests above and be useless, so the same fixture with a matching model
    // must still produce the pass its own report claims. This pass is a
    // PROTOCOL-FIXTURE pass and supports no claim about model capability.
    const { record } = await runFixtureUnit({
      declaredModelId: APPROVED_MODEL,
      dryRunExitCode: 0,
      runtimeModelId: APPROVED_MODEL,
      reportOutcome: "pass",
    });
    expect(record.status).toBe("completed");
    expect(record.failureCategory).toBeNull();
    expect(record.verifierPassed).toBe(true);
    expect(record.detail ?? "").toMatch(/verification_passed=true/);
  }, 300_000);

  it("PROTOCOL FIXTURE: a LEGITIMATE negative stays `case_failed`, not infrastructure", async () => {
    // Plan §A5 怎么做 7: "将通过、合法 case_failed、provider/harness/infrastructure 失败
    // 保持区分；本任务不能把所有低分案例都改成基础设施失败." A priority table that
    // turned every non-pass into a refusal would satisfy the three refusal tests
    // above while destroying the campaign's ability to tell "the case failed its
    // task" (a VALID NEGATIVE the driver deliberately excludes from `failures[]`)
    // from "the unit measured nothing".
    const { record } = await runFixtureUnit({
      declaredModelId: APPROVED_MODEL,
      dryRunExitCode: 0,
      runtimeModelId: APPROVED_MODEL,
      reportOutcome: "case_failed",
    });
    // The case RAN — its report is real and its own row was persisted as evidence.
    expect(record.report).not.toBeNull();
    expect(record.report!.success).toBe(false);
    expect(record.report!.verification_passed).toBe(false);
    // And its outcome is its OWN verifier's negative, not a harness refusal.
    expect(record.failureCategory).toBe("case_failed");
    expect(record.verifierPassed).toBe(false);
    expect(record.status, "a valid negative is a TERMINAL result, not a failed unit").toBe("completed");
    expect(record.detail ?? "").not.toMatch(/did not approve|infrastructure/i);
  }, 300_000);
});

describe("R105 P: the verdict priority table is a real, ordered contract", () => {
  it("ranks every failure category, and a PASS is the LOWEST priority", () => {
    expect(mod.R97_VERDICT_PRIORITY[0]).toBe("harness");
    expect(mod.R97_VERDICT_PRIORITY[mod.R97_VERDICT_PRIORITY.length - 1]).toBe("passed");
    for (const category of mod.FAILURE_CATEGORIES) {
      expect(mod.R97_VERDICT_PRIORITY, `${category} must have a rank`).toContain(category);
    }
  });

  it("never lets a later assignment overwrite a more blocking fact, in EITHER order", () => {
    const harness = { category: "harness", detail: "identity refused" };
    const pass = { category: null, detail: "verified: verification_passed=true" };
    const timeout = { category: "timeout", detail: "deadline expired" };
    const caseFailed = { category: "case_failed", detail: "case did not pass" };

    // The F5 shape, and its mirror: whichever ORDER the facts arrive in, the
    // blocking one wins and the other survives only as a diagnostic. This is what
    // makes the outcome independent of `if` statement order (plan §A5 怎么验收 7).
    const harnessThenPass = mod.foldR97Verdict(harness, pass);
    expect(harnessThenPass.category).toBe("harness");
    expect(harnessThenPass.detail).toContain("identity refused");
    expect(harnessThenPass.detail).toContain("verification_passed=true");

    const passThenHarness = mod.foldR97Verdict(pass, harness);
    expect(passThenHarness.category).toBe("harness");
    expect(passThenHarness.detail).toContain("identity refused");

    // identity vs timeout: ONE stable answer in both orders.
    expect(mod.foldR97Verdict(timeout, harness).category).toBe("harness");
    expect(mod.foldR97Verdict(harness, timeout).category).toBe("harness");

    // A legitimate negative is neither a pass nor an identity refusal, and the
    // table must not collapse the two (plan §A5 怎么做 7).
    expect(mod.foldR97Verdict(caseFailed, pass).category).toBe("case_failed");
    expect(mod.foldR97Verdict(pass, caseFailed).category).toBe("case_failed");

    // A pass is only a pass when nothing else was established.
    const onlyPass = mod.foldR97Verdict(null, pass);
    expect(onlyPass.category).toBeNull();
    expect(onlyPass.detail).toBe("verified: verification_passed=true");
  });
});

// ===========================================================================
// E4-R106 (A6 / F6) — A UNIT THAT HANGS IS REALLY TERMINATED, NOT MERELY
// OUTLIVED.
// ===========================================================================
//
// MEASURED DEFECT F6 (plan §A6):
//
//   "boundedStop 能杀进程，但实际 worker 改成进程内 `await runBenchmarkCommand`"
//   — a cancel at 40 ms still PASSes ~412 ms later; a unit timeout of 80 ms
//   returns ~421 ms later.
//
// `runArmCaseInProcess` awaits the ARM's exported `runBenchmarkCommand` INSIDE
// this process. `boundedStop` is never called on that await, so a dry run or a
// dispatch that simply never returns keeps the unit — and its reservation and the
// whole campaign — alive indefinitely. A `Promise.race` that abandons the hung
// promise would not help either: the hung code keeps running, keeps its
// `setInterval` alive and would keep writing files.
//
// This fixture is that hostile arm, and the assertions are about the
// IMPLEMENTATION ending it:
//
//   * the unit returns within the declared bound (not minutes later),
//   * the cause is the named `timeout`, with the deadline named in the detail,
//   * the reservation is NOT refunded if a call was dispatched,
//   * the hung code is REALLY STOPPED — the sentinel it writes on a timer gets no
//     further bytes after the unit returns.
//
// The sentinel is not simulated: `setInterval` + `appendFileSync` is exactly what
// a provider, a verifier or a tool that ignores `AbortSignal` looks like from the
// outside, and it is what the plan's anti-cheat rule is about ("仅返回 Promise 不算
// 通过").
const HANG_LOG = "a6-hang-sentinel.log";

/**
 * A PROTOCOL FIXTURE arm whose `runBenchmarkCommand` NEVER RETURNS.
 *
 * `hang: "dry-run"` hangs inside the arm's own dry run — before any request
 * exists. `hang: "dispatch"` completes the dry run and then hangs inside the
 * dispatch, AFTER the provider boundary has been crossed and one logical call
 * admitted.
 *
 * Both write the same sentinel on a 25 ms timer, so "did the hung code really
 * stop?" is a measurement rather than an inference, and both are OFFLINE: no
 * transport is constructed.
 */
function hangingArmCli(hang: "dry-run" | "dispatch"): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SENTINEL = join(here, ${JSON.stringify(HANG_LOG)});
const MODE = ${JSON.stringify(hang)};

export { ScriptedModelProvider };

function argOf(argv, flag) {
  const i = Array.isArray(argv) ? argv.indexOf(flag) : -1;
  return i >= 0 ? argv[i + 1] : null;
}

// The hung code is ALIVE and OBSERVABLE: it keeps appending on a timer. A unit
// that only stops WAITING for this leaves it running, and the test can see that.
function hangForever() {
  writeFileSync(SENTINEL, "hung\\n");
  setInterval(() => appendFileSync(SENTINEL, "still-here\\n"), 25);
  return new Promise(() => {});
}

export async function runBenchmarkCommand(argv, providerOverride) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) {
    if (MODE === "dry-run") return hangForever();
    return {
      exitCode: 0,
      lines: [JSON.stringify({ planDigest: null, providerId: "openai", modelId: "approved-model-x", endpointIdentity: null })],
    };
  }
  const out = argOf(argv, "--out");
  const suite = argOf(argv, "--suite") || "regression";
  if (MODE === "dispatch") {
    // ONE real admitted call, then the hang: this is what makes "dispatched then
    // killed must NOT be refunded" measurable rather than assumed.
    try {
      const client = providerOverride.createClient({ providerId: "openai", modelId: "approved-model-x" }, {});
      const controller = new AbortController();
      for await (const _ev of client.generate({ messages: [{ role: "user", content: "a6" }] }, controller.signal)) {
        break;
      }
    } catch (err) {
      appendFileSync(SENTINEL, "dispatch-error: " + (err && err.message ? err.message : String(err)) + "\\n");
    }
    return hangForever();
  }
  mkdirSync(out, { recursive: true });
  return { exitCode: 0, lines: [] , out, suite };
}
`;
}

/**
 * An arm whose CLI is the hanging fixture above, built out of THIS repo's real
 * derived closure.
 *
 * The closure is copied for the same reason `syntheticArm()` copies it (E4-R104):
 * the build identity is computed over the derived closure, and replacing the CLI
 * inside it can only shrink what the walk reaches. The arm is otherwise a real,
 * complete checkout, so the worker's identity, staging and staging-digest phases
 * all behave exactly as they do for a historical arm.
 */
/**
 * Write the arm's OWN `packages/model/dist/index.js`.
 *
 * The build closure is copied file-by-file, so the tree holds the repo's model
 * build — which re-exports modules importing the workspace package
 * `@ar/contracts`. That was invisible while the case ran IN-PROCESS (vitest's
 * resolver found the workspace package), and it breaks now that the case runs in
 * a CHILD process under plain Node ("Cannot find package '@ar/contracts'").
 *
 * Linking the real `node_modules` is NOT an option: the A4 identity walker
 * refuses a dependency that resolves outside the checkout root, so the arm's
 * `buildDigest` became `null` and the unit was refused before it could hang —
 * measured. The honest repair is to make the fixture SELF-CONTAINED, exactly as
 * it already does for `benchmark-command.js`: a scripted provider needs nothing
 * from the workspace, and the seam's only requirement is the documented shape
 * (`ScriptedModelProvider` with static `text`/`toolCall` and `createClient`).
 *
 * The shape below is the contract `r97-arm-exec.mjs` actually consumes:
 * `SP.text(...)`, `SP.toolCall(...)`, `new SP(events)`, a non-empty `id` that is
 * not a billed identity, no credentials, and `createClient().generate()`.
 */
function hangingArmModel(): string {
  return `export class ScriptedModelProvider {
  constructor(events) {
    this.events = Array.isArray(events) ? events : [];
    this.id = "offline-test";
  }
  static text(content) { return { kind: "text", content }; }
  static toolCall(name, args) { return { kind: "tool", name, args }; }
  createClient() {
    const events = this.events;
    return {
      async *generate() {
        for (const ev of events) {
          yield ev.kind === "tool"
            ? { type: "tool_call", name: ev.name, arguments: ev.args }
            : { type: "text", text: ev.content };
        }
        yield { type: "completed", stopReason: "end_turn" };
      },
    };
  }
}
`;
}

async function hangingArm(hang: "dry-run" | "dispatch"): Promise<{ dir: string; sha: string }> {
  const dir = await tempDir();
  for (const rel of mod.armBuildClosurePaths(REPO)) {
    const dest = join(dir, ...rel.split("/"));
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(join(REPO, ...rel.split("/")), dest);
  }
  await writeFile(join(dir, "apps", "cli", "dist", "benchmark-command.js"), hangingArmCli(hang), "utf8");
  await writeFile(join(dir, "packages", "model", "dist", "index.js"), hangingArmModel(), "utf8");
  await mkdir(join(dir, "benchmarks", "r98-fixtures"), { recursive: true });
  await cp(join(REPO, "benchmarks", "r98-fixtures", CASE_ID), join(dir, "benchmarks", "r98-fixtures", CASE_ID), {
    recursive: true,
  });
  const { execFileSync } = await import("node:child_process");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["-c", "user.email=t@e.st", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "hanging arm"]);
  const build = mod.armBuildIdentity(dir);
  return { dir, sha: build.sourceSha! };
}

/** Count the sentinel's lines, or 0 when it does not exist yet. */
async function sentinelLines(armDir: string, log: string): Promise<number> {
  const p = join(armDir, "apps", "cli", "dist", log);
  if (!existsSync(p)) return 0;
  const text = await readFile(p, "utf8");
  return text === "" ? 0 : text.trimEnd().split("\n").length;
}

describe("E4-R106 (A6/F6): a HANGING arm is really TERMINATED, within the declared bound", () => {
  it("a dry run that never returns is stopped by the unit deadline, and its code does NOT outlive the unit", async () => {
    // Plan §A6 怎么验收 3: "dry-run hang、provider 忽略 signal、工具/verifier hang、
    // 持续输出四类 fixture 都能通过实际 worker 路径被终止."
    //
    // The bound is small ON PURPOSE and the assertion is tight: plan §A6 says a
    // test may allow a scheduling margin, but may NOT hide an ineffective short
    // deadline behind a multi-minute timeout. 4 s is the unit cap; the walk to
    // RECOGNISE the deadline must fit inside grace + scheduling tolerance, so 20 s
    // is generous for CI and still refutes "it never stops".
    const arm = await hangingArm("dry-run");
    const root = await tempDir();
    const unitCapMs = 10_000;
    const unitFloorMs = 20_000;

    const started = Date.now();
    const record = await mod.runArmUnit({
      checkoutDir: arm.dir,
      repoRoot: REPO,
      caseId: CASE_ID,
      suite: "regression",
      arm: "baseline",
      repetition: 1,
      planDigest: "c".repeat(64),
      approvedSourceSha: arm.sha,
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
      maxModelCalls: 1,
      campaignModelCalls: 1,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: unitCapMs,
    });
    const elapsed = Date.now() - started;

    // ---- 1. THE BOUND. -------------------------------------------------
    expect(
      elapsed,
      `a ${unitCapMs}ms unit cap must end the unit; it returned after ${elapsed}ms, so the hung dry run was merely outlived`,
    ).toBeLessThan(unitFloorMs);

    // ---- 2. THE CAUSE IS THE NAMED ONE, NOT infrastructure. -------------
    //
    // Plan §A6 怎么做 9: "统一 timeout/cancelled/output_limit 的原因与证据. 异常发生
    // 在 deadline 之后也不能统统落入 infrastructure catch."
    expect(record.status).toBe("failed");
    expect(
      record.failureCategory,
      `a deadline stop is a \`timeout\`, never an \`infrastructure\` fault — detail=${String(record.detail)}`,
    ).toBe("timeout");
    expect(String(record.detail), "the detail must name the deadline that stopped it").toMatch(/deadline|timeout/i);

    // ---- 3. NOTHING WAS DISPATCHED, SO THE RESERVATION IS RELEASED. -----
    //
    // Plan §A6 怎么验收 6: "启动失败或明确未 dispatch：零调用，释放未使用预留".
    expect(record.consumed, "the hang was in the dry run, before any request existed").toBe(0);

    // ---- 4. THE HUNG CODE IS REALLY GONE. ------------------------------
    //
    // Plan §A6 怎么验收 4: "终止后父进程、子进程和孙进程均不继续写 sentinel 文件；
    // 仅返回 Promise 不算通过." A `Promise.race` that abandons the hung promise
    // leaves the `setInterval` appending forever, which this measures.
    const afterStop = await sentinelLines(arm.dir, HANG_LOG);
    expect(afterStop, "the hung arm must have STARTED (else this proves nothing about stopping it)").toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 400));
    const later = await sentinelLines(arm.dir, HANG_LOG);
    expect(
      later,
      `the hung arm wrote ${later - afterStop} more sentinel line(s) after the unit returned — the execution boundary did not stop it`,
    ).toBe(afterStop);
  }, 180_000);

  it("a DISPATCH that never returns is stopped too, and the admitted call is NOT refunded", async () => {
    // Plan §A6 怎么验收 6, second half: "已进入后被强制终止：预算不恢复."
    //
    // This is the case that separates an honest stop from a refund: the provider
    // boundary WAS crossed, one logical call was admitted, and the arm then hung.
    // The reservation must survive as spent/unknown, exactly as A1 required for a
    // dispatch that is followed by a different kind of death.
    const arm = await hangingArm("dispatch");
    const root = await tempDir();
    const unitCapMs = 6_000;
    const unitFloorMs = 25_000;

    const started = Date.now();
    const record = await mod.runArmUnit({
      checkoutDir: arm.dir,
      repoRoot: REPO,
      caseId: CASE_ID,
      suite: "regression",
      arm: "baseline",
      repetition: 1,
      planDigest: "d".repeat(64),
      approvedSourceSha: arm.sha,
      providerId: "openai",
      modelId: "approved-model-x",
      endpointBaseUrl: "http://127.0.0.1:9/v1",
      maxModelCalls: 1,
      campaignModelCalls: 1,
      executionStateDir: join(root, "state"),
      ledgerDir: join(root, "ledger"),
      outDir: join(root, "out"),
      timeoutMs: unitCapMs,
    });
    const elapsed = Date.now() - started;

    expect(elapsed, `a ${unitCapMs}ms unit cap must end a hung DISPATCH; it returned after ${elapsed}ms`).toBeLessThan(unitFloorMs);
    expect(record.status).toBe("failed");
    expect(
      record.failureCategory,
      `the unit's own deadline is the cause, even though the arm hung after dispatch — detail=${String(record.detail)}`,
    ).toBe("timeout");

    // The call really was admitted before the hang. The ledger's REAL filename is
    // `budget-ledger.json` (the module's `R97_LEDGER_FILENAME`); reading a guessed
    // `ledger.json` would make this assertion vacuous.
    const ledgerOnDisk = JSON.parse(await readFile(join(root, "ledger", "budget-ledger.json"), "utf8")) as {
      entries: Array<{ reservationId: string; status: string }>;
    };
    expect(ledgerOnDisk.entries.length, "one reservation for the one admitted call").toBe(1);
    expect(
      ledgerOnDisk.entries[0]!.status,
      "an ADMITTED call is never refunded just because the arm hung afterwards",
    ).not.toBe("abandoned");

    // And the hung dispatch is really gone.
    const afterStop = await sentinelLines(arm.dir, HANG_LOG);
    expect(afterStop).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(
      await sentinelLines(arm.dir, HANG_LOG),
      "the hung dispatch kept running after the unit returned",
    ).toBe(afterStop);
  }, 180_000);
});
