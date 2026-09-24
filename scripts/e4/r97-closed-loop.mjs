#!/usr/bin/env node
/**
 * E4-R101-A (T6) — the OFFLINE CLOSED LOOP on a clean checkout: one command, on
 * Windows and on Ubuntu, with no bash, no WSL and no Docker.
 *
 * WHY THIS FILE EXISTS (plan §T6 怎么做 1, 2, 3; 怎么验收 1, 2)
 * -----------------------------------------------------------
 *   "将现有专用 job 改为跨平台矩阵，路径使用 runner.temp/Node 临时目录。Windows
 *    本机运行说明用 PowerShell/Node，不要求 bash、WSL 或 Docker."
 *   "setup 命令必须是仓库中真实存在的脚本。明确 setup-only/observe/run 的行为；
 *    构建失败是失败，缺 arm 不是 skip."
 *   "从干净 checkout 的命令能复现，用户无需手写临时脚本，也无需本机 Linux."
 *
 * The CI job this replaces was a 200-line bash script: `git worktree`, `${!var}`
 * indirection, `set -euo pipefail`, `tr`, `grep -cF`. None of that runs on a
 * Windows runner, so the Windows half of the plan's matrix was unreachable — and
 * an operator on Windows could not reproduce the job without translating it. The
 * whole sequence needs exactly three capabilities — spawn a process, read a file,
 * resolve a path — and all three are platform-neutral in Node.
 *
 * THE PHASES, AND WHAT EACH PROVES
 * --------------------------------
 *   `--setup-only`  creates the two arm worktrees at their FROZEN SHAs under a Node
 *                   temp directory and builds each one, by delegating to
 *                   `r97-observe-arms.mjs` — the ONE committed setup script. A
 *                   failure is a SETUP FAILURE and stops everything: a missing or
 *                   unbuildable arm is never a skip.
 *   `--acceptance`  drives the OFFICIAL entry (`r97-campaign-driver.mjs
 *                   --arm-worker`) over the frozen selection in each arm's OWN
 *                   build, then re-derives every verdict with the shipped
 *                   validator. This is where the real worker→benchmark execution
 *                   happens; it does NOT stop at the D6 dry run.
 *   `--suite`       runs the R97/R98 suites with the two arm directories in the
 *                   child's ENVIRONMENT, so the D6 test observes the REAL arms
 *                   rather than skipping. Writes a human log AND a vitest JSON
 *                   report.
 *   `--matrix`      asserts the plan's nine-row acceptance matrix against that JSON
 *                   report. A `skipped` or absent test FAILS its row, which is what
 *                   "关键场景没有 skip" means mechanically.
 *   `--identity`    writes the closed-loop identity record: SHAs, platform, and the
 *                   explicit statement that no paid execution happened.
 *
 * `--all` runs every phase in order. That single command is what CI runs and what
 * an operator types locally; there is no second, private recipe.
 *
 * THE ARM DIRECTORIES TRAVEL IN-PROCESS, NOT THROUGH A SHELL
 * ---------------------------------------------------------
 * `$GITHUB_ENV` is a shell FILE whose writer differs per shell (`>> "$GITHUB_ENV"`
 * in bash, `Add-Content` in PowerShell). This runner instead sets the variables on
 * the child vitest process's own `env`, so the D6 test sees them without any shell
 * participating.
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-closed-loop.mjs --all
 *   node scripts/e4/r97-closed-loop.mjs --all --out .ci/r97-r98 --arms-root D:/arms
 *   node scripts/e4/r97-closed-loop.mjs --setup-only
 *   node scripts/e4/r97-closed-loop.mjs --suite --arms-root <prepared root>
 *
 * Exit codes: 0 = every requested phase succeeded · 1 = a phase failed ·
 *             2 = usage/config error.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

export const CLOSED_LOOP_VERSION = "e4-r101-closed-loop-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

/**
 * The R97/R98 suites the closed loop runs, and the ONE place the list lives.
 *
 * Every file here measures something the plan's acceptance matrix names. The matrix
 * gate refuses a row whose test is absent from the report, so a file dropped from
 * this list shows up as an unsatisfied row rather than as a quietly smaller run —
 * and `r97-closed-loop.test.ts` additionally proves this list covers every file
 * that declares a matrix-named test, so the failure can never be invisible.
 */
export const SUITE_FILES = [
  "packages/evaluation/src/r97-budget-ledger.test.ts",
  "packages/evaluation/src/r97-budget-channel.test.ts",
  // Plan §T1 怎么验收 5 names a FAILED DISK WRITE explicitly ("缺少预算 IPC/ledger、
  // 故障写盘、超过授权预算时，真实与离线模式都不会绕过检查"), and §T1 怎么验收 requires
  // the new budget integration test to run in T6. Without this entry the write-fault
  // counterexample existed but NO gate executed it — the "test exists, nothing runs
  // it" state the matrix gate exists to prevent.
  "packages/evaluation/src/r97-budget-write-fault.test.ts",
  "packages/evaluation/src/r97-campaign-lifecycle.test.ts",
  "packages/evaluation/src/r97-execution-state.test.ts",
  "packages/evaluation/src/r97-execution-state-ownership.test.ts",
  "packages/evaluation/src/r97-execution-identity.test.ts",
  "packages/evaluation/src/r97-campaign-evidence.test.ts",
  "packages/evaluation/src/r97-campaign-validator-cli.test.ts",
  "packages/evaluation/src/r97-arm-report-evidence.test.ts",
  "packages/evaluation/src/r97-plan.test.ts",
  "packages/evaluation/src/r97-arm-worker-contract.test.ts",
  "packages/evaluation/src/r97-bounded-stop.test.ts",
  "packages/evaluation/src/r97-offline-seam.test.ts",
  "packages/evaluation/src/r97-acceptance-matrix.test.ts",
  "packages/evaluation/src/r97-mutation-check.test.ts",
  "packages/evaluation/src/r97-closed-loop.test.ts",
  "packages/evaluation/src/r97-driver-closed-loop.test.ts",
  "packages/evaluation/src/r97-redaction.test.ts",
  "packages/evaluation/src/r98-fixture-cases.test.ts",
];

/**
 * The minimum number of tests the suite must report.
 *
 * A run that silently lost a file would still satisfy the matrix rows whose tests
 * it did run, so the total is floored as well. The value is a MEASUREMENT with
 * headroom rather than a guess: the listed files report 409 passing tests on the
 * tree this floor was set for, and the largest single file declares ~56, so 380
 * catches a dropped file while leaving room for an unrelated test being removed.
 */
export const SUITE_MIN_TESTS = 380;

/**
 * Run a node script, returning `{ code, stdout, stderr }`.
 *
 * A non-zero exit is DATA, not an exception: this runner has to report WHICH phase
 * failed and with what output. `shell` is left at its default `false`, so nothing
 * here depends on a shell existing.
 */
function runNode(script, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 3_600_000,
      env: opts.env ?? process.env,
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: "" };
  } catch (err) {
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      stdout: String(err?.stdout ?? ""),
      stderr: String(err?.stderr ?? err?.message ?? ""),
    };
  }
}

/**
 * Run the test suite through vitest's own JS entry.
 *
 * MEASURED: spawning the `pnpm.cmd` shim with `shell: false` fails with `EINVAL`
 * on Node 24 (the CVE-2024-27980 fix refuses to spawn a `.cmd`/`.bat` without a
 * shell), and `shell: true` would reintroduce exactly the platform dependency this
 * runner exists to remove. `node_modules/vitest/vitest.mjs` is the real entry the
 * `bin` field points at, and `process.execPath` is already the running Node, so
 * this spawns a plain `.mjs` — no shim, no shell, identical on both platforms.
 */
function runVitest(args, opts = {}) {
  const entry = resolve(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(entry)) {
    return { code: 1, stdout: "", stderr: `vitest is not installed at ${entry} — run pnpm install` };
  }
  try {
    const stdout = execFileSync(process.execPath, [entry, "run", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 3_600_000,
      env: opts.env ?? process.env,
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: "" };
  } catch (err) {
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      stdout: String(err?.stdout ?? ""),
      stderr: String(err?.stderr ?? err?.message ?? ""),
    };
  }
}

/** The last few non-empty lines of a child's output — enough to diagnose, bounded. */
function tail(text, lines = 30) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

/**
 * PHASE 1 — prepare the two arm checkouts.
 *
 * Delegates to `r97-observe-arms.mjs`. The arm directories are returned so every
 * later phase uses the SAME two trees: a second `mkdtemp` would prepare a different
 * pair and the suite would observe arms the campaign never ran.
 *
 * The post-condition is ASSERTED rather than inferred from the exit code: a zero
 * exit that left no built CLI is still a setup failure, and treating it as success
 * is the silent-skip defect in a new costume.
 */
export async function phaseSetup(opts) {
  const args = ["--root", opts.armsRoot];
  if (opts.baseline !== undefined) args.push("--baseline", opts.baseline);
  if (opts.candidate !== undefined) args.push("--candidate", opts.candidate);
  const res = runNode(join(here, "r97-observe-arms.mjs"), args);
  const baselineDir = join(opts.armsRoot, "baseline");
  const candidateDir = join(opts.armsRoot, "candidate");
  const built = [baselineDir, candidateDir].every((d) => existsSync(join(d, "apps", "cli", "dist", "main.js")));
  return {
    phase: "setup",
    ok: res.code === 0 && built,
    code: res.code,
    baselineDir,
    candidateDir,
    output: tail(`${res.stdout}\n${res.stderr}`),
  };
}

/**
 * PHASE 2 — the acceptance campaign, through the OFFICIAL entry.
 *
 * Runs `r97-offline-acceptance.mjs --all` with the arms this runner prepared, so the
 * campaign executes in each arm's OWN build and the shipped validator re-derives
 * every verdict. This is the phase that proves real worker→benchmark execution
 * happened; the D6 dry-run observation alone would not (plan §T6 怎么做 3).
 */
export async function phaseAcceptance(opts) {
  const args = [
    "--all",
    "--out", join(opts.outDir, "acceptance"),
    "--baseline-dir", opts.baselineDir,
    "--candidate-dir", opts.candidateDir,
  ];
  if (opts.provider !== undefined) args.push("--provider", opts.provider);
  if (opts.model !== undefined) args.push("--model", opts.model);
  if (opts.endpoint !== undefined) args.push("--endpoint", opts.endpoint);
  const res = runNode(join(here, "r97-offline-acceptance.mjs"), args, { timeout: opts.acceptanceTimeoutMs });
  let summary = null;
  try {
    summary = JSON.parse(await readFile(join(opts.outDir, "acceptance", "acceptance-summary.json"), "utf8"));
  } catch {
    summary = null;
  }
  const ok = res.code === 0 && summary !== null && summary.status === "OFFLINE_ACCEPTED";
  return {
    phase: "acceptance",
    ok,
    code: res.code,
    summaryPath: join(opts.outDir, "acceptance", "acceptance-summary.json"),
    status: summary?.status ?? null,
    campaign: summary?.campaign ?? null,
    ...(ok ? {} : { output: tail(`${res.stdout}\n${res.stderr}`) }),
  };
}

/**
 * PHASE 3 — the suites, with the REAL arm directories in the child's environment.
 *
 * The D6 test reads `R97_ARM_BASELINE_DIR` / `R97_ARM_CANDIDATE_DIR` and REFUSES to
 * skip when they are set but wrong; when unset it warns and returns, which is
 * exactly the silent-skip finding F7 this job exists to prevent. Setting them on the
 * child's `env` is what makes the D6 row real evidence on both platforms.
 *
 * Both reporters are enabled in ONE run: verbose for the human log the plan keeps as
 * auxiliary evidence, JSON for the structured matrix gate.
 */
export async function phaseSuite(opts) {
  await mkdir(opts.outDir, { recursive: true });
  const jsonPath = join(opts.outDir, "r97-r98.json");
  const logPath = join(opts.outDir, "r97-r98-suite.log");
  const env = {
    ...process.env,
    R97_ARM_BASELINE_DIR: opts.baselineDir,
    R97_ARM_CANDIDATE_DIR: opts.candidateDir,
  };
  const res = runVitest(
    ["--reporter=verbose", "--reporter=json", `--outputFile.json=${jsonPath}`, ...SUITE_FILES],
    { env, timeout: opts.suiteTimeoutMs },
  );
  // The verbose output IS the human log; it is written here rather than teed by a
  // shell, so no shell has to exist.
  await writeFile(logPath, `${res.stdout}\n${res.stderr}\n`, "utf8");
  let report = null;
  try {
    report = JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    report = null;
  }
  const total = Number(report?.numTotalTests ?? 0);
  const passed = Number(report?.numPassedTests ?? 0);
  const ok = res.code === 0 && report !== null && report.success === true && passed >= SUITE_MIN_TESTS;
  return {
    phase: "suite",
    ok,
    code: res.code,
    jsonPath,
    logPath,
    totalTests: total,
    passedTests: passed,
    ...(ok ? {} : { output: tail(`${res.stdout}\n${res.stderr}`) }),
  };
}

/**
 * PHASE 4 — the nine-row acceptance matrix, from the STRUCTURED report.
 *
 * Plan §T6 怎么做 5: "使用结构化测试结果/稳定断言验证关键场景执行。现有 verbose grep
 * 可以保留为辅助；不要继续为终端符号、相对路径和阈值写大量修补逻辑." The gate reads
 * vitest's JSON, where each test carries a `fullName` and a machine-readable
 * `status`, so a SKIPPED test fails its row instead of passing it.
 */
export async function phaseMatrix(opts) {
  const outPath = join(opts.outDir, "acceptance-matrix.json");
  const res = runNode(join(here, "r97-acceptance-matrix.mjs"), [
    "--report", join(opts.outDir, "r97-r98.json"),
    "--out", outPath,
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(outPath, "utf8"));
  } catch {
    parsed = null;
  }
  return {
    phase: "matrix",
    ok: res.code === 0 && parsed !== null && parsed.ok === true,
    code: res.code,
    reportPath: outPath,
    rowsSatisfied: parsed === null ? null : parsed.rows.filter((r) => r.ok).length,
    rowsTotal: parsed === null ? null : parsed.rows.length,
    // The closing plan's own M1–M9 table (plan §A7 怎么做 2). Recorded separately from
    // the acceptance rows because they answer different questions: the rows ask "was
    // this scenario measured", the M rows ask "does the plan's own table have a row
    // behind it, and did that row pass". A green run that left an M row unclaimed
    // would satisfy every acceptance row and still not cover the plan.
    planRowsSatisfied: parsed === null ? null : parsed.planRows.filter((p) => p.ok).length,
    planRowsTotal: parsed === null ? null : parsed.planRows.length,
    planRowsUncovered: parsed === null ? null : parsed.uncoveredPlanRows,
    ...(res.code === 0 ? {} : { output: tail(`${res.stdout}\n${res.stderr}`) }),
  };
}

/**
 * PHASE 5 — the closed-loop identity record.
 *
 * States the scope in FIELDS so a reader never has to infer it. In particular
 * `paidTwoVersionExperimentRan: false` and `providerCalls: 0`: the loop is offline
 * by construction, and "CI all-green" must never be reported as "the paid
 * experiment ran" (plan §T6 怎么验收 5).
 */
export async function phaseIdentity(opts, phases) {
  const setup = phases.find((p) => p.phase === "setup");
  const acceptance = phases.find((p) => p.phase === "acceptance");
  const suite = phases.find((p) => p.phase === "suite");
  const matrix = phases.find((p) => p.phase === "matrix");
  const campaign = acceptance?.campaign ?? null;
  const identity = {
    schema: "e4-r101-closed-loop-identity-v1",
    closedLoopVersion: CLOSED_LOOP_VERSION,
    platform: process.platform,
    runnerOs: process.env.RUNNER_OS ?? null,
    nodeVersion: process.version,
    // The SHAs the arms were ACTUALLY prepared at: `r97-observe-arms.mjs` asserted
    // each arm's HEAD before returning, so these are the bound identities rather
    // than a restatement of a default.
    armBaselineDir: setup?.baselineDir ?? null,
    armCandidateDir: setup?.candidateDir ?? null,
    armBaselineSha: campaign === null ? null : opts.baseline,
    armCandidateSha: campaign === null ? null : opts.candidate,
    executionMode: campaign?.executionMode ?? null,
    // CUMULATIVE over the campaign's durable history, unioned by unit.
    verifiedPasses: campaign?.verifiedPasses ?? null,
    measuredUnits: campaign?.measuredUnits ?? null,
    logicalCalls: campaign?.logicalCalls ?? null,
    // HOW MUCH THOSE PASSES PROVE (T6 怎么做 5). A weak pass came from an artifact
    // verifier that checks only that a path exists and was touched.
    strongPasses: campaign?.strongPasses ?? null,
    weakPasses: campaign?.weakPasses ?? null,
    suiteTotalTests: suite?.totalTests ?? null,
    suitePassedTests: suite?.passedTests ?? null,
    matrixRowsSatisfied: matrix?.rowsSatisfied ?? null,
    matrixRowsTotal: matrix?.rowsTotal ?? null,
    // The closing plan's own M1–M9 behavior matrix (plan §A7 怎么做 2), recorded in
    // FIELDS rather than as prose so "the plan's table is covered" is a fact a reader
    // can check. `planRowsUncovered` is the list of M rows no acceptance row claimed.
    planRowsSatisfied: matrix?.planRowsSatisfied ?? null,
    planRowsTotal: matrix?.planRowsTotal ?? null,
    planRowsUncovered: matrix?.planRowsUncovered ?? null,
    // ---- THE HONEST SCOPE. ------------------------------------------------
    providerCalls: 0,
    paidAuthorizationPresentInWorkflow: false,
    paidTwoVersionExperimentRan: false,
    experimentKind: "offline_closed_loop",
    modelCapabilityClaim: "none — the offline provider is scripted, so no model-quality result exists",
    promotable: false,
    scopeNote:
      "Proves the offline two-checkout closed loop RUNS on a clean runner on this platform: two real arm builds, the official arm-worker entry, real tool and verifier execution, and a validator that re-derives the verdicts. Does NOT prove the paid two-version experiment ran, and supports no claim about model quality or promotion.",
  };
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, "closed-loop-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return { phase: "identity", ok: true, code: 0, identityPath: join(opts.outDir, "closed-loop-identity.json") };
}

/** Read `--flag value` pairs, refusing a flag with no value. */
export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  const has = (name) => argv.includes(name);
  const all = has("--all");
  return {
    all,
    setup: all || has("--setup") || has("--setup-only"),
    setupOnly: has("--setup-only"),
    acceptance: all || has("--acceptance"),
    suite: all || has("--suite"),
    matrix: all || has("--matrix"),
    identity: all || has("--identity"),
    out: value("--out"),
    armsRoot: value("--arms-root"),
    baseline: value("--baseline"),
    candidate: value("--candidate"),
    provider: value("--provider"),
    model: value("--model"),
    endpoint: value("--endpoint"),
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r101-closed-loop: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  if (!parsed.setup && !parsed.acceptance && !parsed.suite && !parsed.matrix && !parsed.identity) {
    process.stderr.write(
      "r101-closed-loop: nothing to do — pass --all, or one or more of " +
        "--setup-only --acceptance --suite --matrix --identity\n",
    );
    return EXIT_CONFIG;
  }

  const setup = await import(pathToFileURL(join(here, "r97-observe-arms.mjs")).href);
  const opts = {
    // A Node temp directory by default, never a hard-coded drive path: `tmpdir()`
    // resolves to a real writable directory on Windows and on Linux alike.
    armsRoot: parsed.armsRoot !== undefined ? resolve(parsed.armsRoot) : await mkdtemp(join(tmpdir(), "r101-arms-")),
    outDir: parsed.out !== undefined ? resolve(parsed.out) : join(REPO_ROOT, ".ci", "r97-r98"),
    baseline: parsed.baseline ?? setup.DEFAULT_BASELINE_SHA,
    candidate: parsed.candidate ?? setup.DEFAULT_CANDIDATE_SHA,
    provider: parsed.provider,
    model: parsed.model,
    endpoint: parsed.endpoint,
    baselineDir: "",
    candidateDir: "",
    acceptanceTimeoutMs: 3_600_000,
    suiteTimeoutMs: 3_600_000,
  };
  opts.baselineDir = join(opts.armsRoot, "baseline");
  opts.candidateDir = join(opts.armsRoot, "candidate");
  await mkdir(opts.outDir, { recursive: true });

  const phases = [];
  const fail = async (phase) => {
    phases.push(phase);
    return finish(opts, phases, false);
  };

  // ---- PHASE 1: setup -------------------------------------------------------
  if (parsed.setup) {
    const prepared = await phaseSetup(opts);
    process.stdout.write(`[1/5] setup      ${prepared.ok ? "OK" : "FAILED"}  ${opts.armsRoot}\n`);
    if (!prepared.ok) return fail(prepared);
    phases.push(prepared);
    // `--setup-only` exists so the plan's "明确 setup-only/observe/run 的行为" is
    // answerable: a caller prepares the arms and stops, without a second recipe.
    if (parsed.setupOnly) return finish(opts, phases, true);
  } else {
    // A missing arm is a SETUP FAILURE, never a skip. Finding F7 was a test that
    // passed by not running; the runner must be unable to produce that state.
    for (const [label, dir] of [["baseline", opts.baselineDir], ["candidate", opts.candidateDir]]) {
      if (!existsSync(join(dir, "apps", "cli", "dist", "main.js"))) {
        process.stderr.write(
          `r101-closed-loop: the ${label} arm has no built CLI at ${join(dir, "apps", "cli", "dist", "main.js")} — ` +
            "run --setup-only first (a missing arm is a setup failure, never a skip)\n",
        );
        return EXIT_CONFIG;
      }
    }
    phases.push({
      phase: "setup",
      ok: true,
      code: 0,
      baselineDir: opts.baselineDir,
      candidateDir: opts.candidateDir,
      output: "reused a prepared arm pair",
    });
  }

  // ---- PHASE 2: the acceptance campaign ------------------------------------
  if (parsed.acceptance) {
    const acceptance = await phaseAcceptance(opts);
    process.stdout.write(
      `[2/5] acceptance ${acceptance.ok ? "OK" : "FAILED"}  status=${String(acceptance.status)} ` +
        `passes=${String(acceptance.campaign?.verifiedPasses ?? "?")}/${String(acceptance.campaign?.workerUnits ?? "?")}\n`,
    );
    if (!acceptance.ok) return fail(acceptance);
    phases.push(acceptance);
  }

  // ---- PHASE 3: the suites -------------------------------------------------
  if (parsed.suite) {
    const suite = await phaseSuite(opts);
    process.stdout.write(
      `[3/5] suite      ${suite.ok ? "OK" : "FAILED"}  ${String(suite.passedTests)}/${String(suite.totalTests)} test(s)\n`,
    );
    if (!suite.ok) return fail(suite);
    phases.push(suite);
  }

  // ---- PHASE 4: the acceptance matrix --------------------------------------
  if (parsed.matrix) {
    const matrix = await phaseMatrix(opts);
    process.stdout.write(
      `[4/5] matrix     ${matrix.ok ? "OK" : "FAILED"}  ${String(matrix.rowsSatisfied)}/${String(matrix.rowsTotal)} row(s)\n`,
    );
    if (!matrix.ok) return fail(matrix);
    phases.push(matrix);
  }

  // ---- PHASE 5: the identity record ---------------------------------------
  if (parsed.identity) {
    const identity = await phaseIdentity(opts, phases);
    process.stdout.write(`[5/5] identity   OK  ${identity.identityPath}\n`);
    phases.push(identity);
  }

  return finish(opts, phases, true);
}

/** Write the run's own summary and return the exit code. */
async function finish(opts, phases, ok) {
  const summary = {
    schema: "e4-r101-closed-loop-run-v1",
    closedLoopVersion: CLOSED_LOOP_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    ok,
    armsRoot: opts.armsRoot,
    outDir: opts.outDir,
    phases: phases.map((p) => ({
      phase: p.phase,
      ok: p.ok,
      code: p.code,
      ...(p.output === undefined ? {} : { output: p.output }),
    })),
    identityPath: phases.find((p) => p.phase === "identity")?.identityPath ?? null,
  };
  await writeFile(join(opts.outDir, "closed-loop-run.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8").catch(
    () => {},
  );
  return ok ? EXIT_OK : EXIT_FAILED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
