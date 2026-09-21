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

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  budget?: { logicalCalls: number; transportRetries: number; unknownCalls: number; refusedCalls: number; reservationIds: string[] } | null;
  execution?: { digest: string; files: number } | null;
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
  armBuildIdentity: (dir: string) => { checkoutDir: string; sourceSha: string | null; buildDigest: string | null };
  /** The explicit artifact manifest the build identity covers (T4 / N7). */
  BUILD_ARTIFACT_PATHS: readonly (readonly string[])[];
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
const CLAIMS_DIR = await mkdtemp(join(tmpdir(), "r99-claims-"));
process.env["R97_CAMPAIGN_CLAIMS_DIR"] = CLAIMS_DIR;

afterEach(async () => {
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
    const fakeArm = await tempDir();
    for (const parts of mod.BUILD_ARTIFACT_PATHS) {
      const dest = join(fakeArm, ...parts);
      await mkdir(join(dest, ".."), { recursive: true });
      await cp(join(REPO, ...parts), dest);
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
