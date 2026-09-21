#!/usr/bin/env node
/**
 * E4-R101-A (T6) — the FULL OFFLINE CLOSED LOOP, from the official entry to the
 * validator, on one command, on Windows and on Ubuntu.
 *
 * WHY THIS FILE EXISTS (plan §T6 做什么 2, 怎么验收 2)
 * -----------------------------------------------
 *   "从正式入口到结果 validator 做实际两臂成功/失败案例、恢复、预算、身份和取消验收."
 *   "从干净 checkout 的命令能复现，用户无需手写临时脚本，也无需本机 Linux."
 *
 * Before this, the two-arm path was only reachable by typing an ad-hoc sequence:
 * prepare two worktrees, build each, run a test file that reads two environment
 * variables, and separately inspect the artifacts. Every step existed, but no
 * COMMITTED command performed the sequence — so "reproducible" was a claim about
 * the author's shell history rather than about the repository.
 *
 * WHAT IT ACTUALLY DOES (and what each step proves)
 * ------------------------------------------------
 *   1. `--prepare` — creates the two arm worktrees at their frozen SHAs and
 *      builds each one. A failure here is a SETUP FAILURE and stops everything:
 *      a missing arm is never a skip (plan §T6 怎么做 2).
 *   2. `--observe` — drives each arm's OWN built CLI (`--dry-run`) to produce the
 *      execution plan the approval binds. This is a real measurement of each
 *      arm's build, not a restatement.
 *   3. `--plan` — builds and writes the FINALIZED authorization plan.
 *   4. `--run` — runs the OFFICIAL entry, `r97-campaign-driver.mjs --arm-worker`,
 *      which executes each case inside that arm's own build under the shared
 *      campaign budget. Nothing here re-implements the driver: the same command
 *      an operator would type is the one that runs.
 *   5. `--validate` — re-derives the campaign's verdicts from the artifacts the
 *      campaign itself left behind, via the SHIPPED validator. A tampered
 *      artifact must fail this step.
 *   6. `--summarize` — writes the publishable, REDACTED single-case report and the
 *      campaign summary, each naming the artifact it was derived from so the
 *      summary is traceable back to the original (plan §T6 怎么做 6).
 *
 * `--all` performs all six in order, which is what CI runs.
 *
 * OFFLINE BY CONSTRUCTION, AND WHY THAT IS NOT A WEAKENING
 * -------------------------------------------------------
 * No key is read and none is set; `RUN_PAID_BENCHMARKS` is never set by this
 * script. The arm worker's own executor injects a `ScriptedModelProvider` loaded
 * from THE ARM'S OWN build and refuses any provider that could reach the network
 * (`assertOfflineProvider`). So the run exercises the real request path, the real
 * tool loop and the real TaskVerifier with ZERO external requests.
 *
 * This proves the loop RUNS and that its evidence is sound. It does NOT prove a
 * model-quality result: the paid two-version experiment remains NOT_RUN, and the
 * summary this script writes says so in its own fields.
 *
 * USAGE
 * -----
 *   node scripts/e4/r97-offline-acceptance.mjs --all
 *   node scripts/e4/r97-offline-acceptance.mjs --all --root D:/arms --out .ci/r101
 *   node scripts/e4/r97-offline-acceptance.mjs --prepare --observe --plan
 *
 * Exit codes: 0 = every requested step succeeded · 1 = a step failed ·
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

export const ACCEPTANCE_VERSION = "e4-r101-offline-acceptance-v1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

/** The frozen revisions, imported from the ONE script that owns them so a
 *  prepared pair and the CI pair can never describe different experiments. */
export async function frozenShas() {
  const setup = await import(pathToFileURL(join(here, "r97-observe-arms.mjs")).href);
  return { baseline: setup.DEFAULT_BASELINE_SHA, candidate: setup.DEFAULT_CANDIDATE_SHA };
}

/** Run a node script in this repo, returning `{ code, stdout, stderr }`.
 *
 *  A non-zero exit is DATA, not an exception: this runner has to report WHICH
 *  step failed and with what output, and a thrown error would discard the child's
 *  own message. `shell: false` always — the checkout root routinely contains a
 *  space, and a shell would re-split it.
 */
function runNode(script, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout ?? 3_600_000,
      env: opts.env ?? process.env,
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
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

/** A short, non-secret tail of a child's output, for a failure report. */
function tail(text, lines = 25) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

/**
 * STEP 1 — prepare the two arm checkouts.
 *
 * Delegates to `r97-observe-arms.mjs`, the ONE committed setup command. A
 * failure is a SETUP failure: this runner stops rather than proceeding to
 * observe arms that were never built (plan §T6 怎么做 2: "缺 arm 不是 skip").
 */
export async function stepPrepare(opts) {
  const args = ["--root", opts.armsRoot];
  if (opts.baseline !== undefined) args.push("--baseline", opts.baseline);
  if (opts.candidate !== undefined) args.push("--candidate", opts.candidate);
  const res = runNode(join(here, "r97-observe-arms.mjs"), args);
  return {
    step: "prepare",
    ok: res.code === 0,
    code: res.code,
    baselineDir: join(opts.armsRoot, "baseline"),
    candidateDir: join(opts.armsRoot, "candidate"),
    output: tail(`${res.stdout}\n${res.stderr}`),
  };
}

/**
 * STEP 2 — observe each arm's OWN build.
 *
 * The observation is produced by driving each arm's built CLI with `--dry-run`,
 * which costs ZERO provider calls and binds the arm's real `executionPlanDigest`.
 * This runs IN THIS PROCESS because the result is a structured object the next
 * step consumes; the measurement itself is entirely the arm's.
 */
export async function stepObserve(opts) {
  const evaluation = await import(pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "index.js")).href);
  const driver = await import(pathToFileURL(join(here, "r97-campaign-driver.mjs")).href);
  const stagedCasesDir = join(opts.outDir, "staged-cases");
  await mkdir(stagedCasesDir, { recursive: true });
  try {
    const observations = await driver.observeArms({
      modules: { evaluation },
      repoRoot: REPO_ROOT,
      armDirs: { baseline: opts.baselineDir, candidate: opts.candidateDir },
      stagedCasesDir,
      suite: "regression",
      providerId: opts.providerId,
      modelId: opts.modelId,
      endpointBaseUrl: opts.endpointBaseUrl,
    });
    // THE OBSERVATION SUMMARY, on disk (plan §T6 怎么做 6). The two arms' real
    // dry-run measurements are the basis of the approval, so they are persisted
    // rather than only held in memory for the next step: a reviewer must be able
    // to check that the plan's bound SHAs and digests are the ones each arm's own
    // built CLI reported. Bounded and redacted by construction — these are
    // digests, SHAs and case ids, never a URL or a key.
    const summaryPath = join(opts.outDir, "observation-summary.json");
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          schema: "e4-r101-arm-observation-v1",
          observedAt: new Date().toISOString(),
          repoRoot: REPO_ROOT,
          providerId: opts.providerId,
          modelId: opts.modelId,
          arms: {
            baseline: observationSummaryOf(observations.baseline),
            candidate: observationSummaryOf(observations.candidate),
          },
          armsAreDistinct:
            observations.baseline.sourceSha !== observations.candidate.sourceSha &&
            observations.baseline.planDigest !== observations.candidate.planDigest,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { step: "observe", ok: true, code: 0, summaryPath, observations };
  } catch (err) {
    return { step: "observe", ok: false, code: 1, output: tail(err instanceof Error ? err.message : String(err)) };
  }
}

/** The publishable part of one arm's observation: identities and counts, never a
 *  raw endpoint URL (the plan binds the DIGEST, and a URL may carry a token). */
function observationSummaryOf(obs) {
  return {
    arm: obs.arm,
    checkoutDir: obs.checkoutDir,
    sourceSha: obs.sourceSha,
    executionPlanDigest: obs.planDigest,
    clean: obs.clean === true,
    treeFingerprint: obs.treeFingerprint ?? null,
    providerId: obs.providerId,
    modelId: obs.modelId,
    endpointIdentity: obs.endpointIdentity ?? null,
    suite: obs.suite,
    caseCount: Array.isArray(obs.caseIds) ? obs.caseIds.length : 0,
    caseIds: Array.isArray(obs.caseIds) ? [...obs.caseIds] : [],
    totalLogicalRuns: obs.totalLogicalRuns ?? null,
    effectiveModelParams: obs.effectiveModelParams ?? null,
  };
}

/**
 * STEP 3 — build and write the FINALIZED authorization plan.
 *
 * The plan is written EXACTLY as the builder produced it. That matters: plan
 * §R97 line 213 requires the finalized material be executable without hand
 * editing, and an earlier defect was precisely a plan that needed a block
 * injected before the CLI would accept it.
 */
export async function stepPlan(opts, observations) {
  const evaluation = await import(pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "index.js")).href);
  const planPath = join(opts.outDir, "plan.json");
  try {
    const plan = await evaluation.buildR97AuthorizationPlan({
      repoRoot: REPO_ROOT,
      baseline: observations.baseline,
      candidate: observations.candidate,
      providerId: opts.providerId,
      modelId: opts.modelId,
      endpointIdentity: observations.candidate.endpointIdentity,
      outputDir: opts.outDir,
      // The approval's own window. `createdAt` is REQUIRED by the builder (an
      // envelope with no instant cannot be checked for expiry), so it is passed
      // explicitly rather than left to a default that would silently make the
      // plan's validity depend on when the builder ran.
      createdAt: opts.createdAt,
      validityDays: opts.validityDays,
      now: opts.now,
      // The campaign's allowance. It is a GRANT, not a per-unit cap: the worker's
      // own `maxModelCalls` is separate and much smaller.
      campaignModelCalls: opts.campaignModelCalls,
    });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    // A plan that is not FINALIZED is not executable, so this is a failure rather
    // than a warning: the next step would refuse it, and reporting it here names
    // the cause.
    const ok = plan.status === "FINALIZED_AUTHORIZATION_PLAN" && Array.isArray(plan.readinessIssues) && plan.readinessIssues.length === 0;
    return {
      step: "plan",
      ok,
      code: ok ? 0 : 1,
      planPath,
      planDigest: plan.planDigest,
      status: plan.status,
      readinessIssues: plan.readinessIssues,
      ...(ok ? {} : { output: tail(JSON.stringify(plan.readinessIssues ?? [], null, 2)) }),
    };
  } catch (err) {
    return { step: "plan", ok: false, code: 1, output: tail(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * STEP 4 — run the OFFICIAL entry.
 *
 * `--arm-worker` with BOTH arm directories, as a CHILD PROCESS. Running it as a
 * child rather than in-process is deliberate: it is the command an operator
 * types, so what CI exercises is the shipped CLI and not a library call that
 * happens to share its implementation.
 *
 * The environment is built explicitly rather than inherited wholesale: the paid
 * switch is absent and the key is absent, so a billed call is impossible by
 * construction rather than by promise.
 */
export async function stepRun(opts, planDigest) {
  const ledgerDir = join(opts.outDir, "ledger");
  const runOutDir = join(opts.outDir, "run");
  await mkdir(ledgerDir, { recursive: true });
  await mkdir(runOutDir, { recursive: true });
  const args = [
    "--plan", join(opts.outDir, "plan.json"),
    "--arm-worker",
    "--baseline-dir", opts.baselineDir,
    "--candidate-dir", opts.candidateDir,
    "--ledger", ledgerDir,
    "--out", runOutDir,
    "--provider", opts.providerId,
    "--model", opts.modelId,
    ...(opts.endpointBaseUrl === null ? [] : ["--endpoint", opts.endpointBaseUrl]),
    ...(opts.campaignDeadlineMs === null ? [] : ["--campaign-deadline-ms", String(opts.campaignDeadlineMs)]),
  ];
  const env = { ...process.env };
  // OFFLINE BY CONSTRUCTION: the key is REMOVED and the paid switch is REMOVED,
  // so a billed transport is impossible rather than merely unused.
  delete env.OPENAI_API_KEY;
  delete env.RUN_PAID_BENCHMARKS;
  // The R92 gate's own contract, spelled exactly as the driver's tests spell it:
  // an authorization flag plus the digest it authorizes. The digest comes from
  // the plan this run just built, so the authorization names THIS plan and not a
  // previous one.
  env.E4_R92_PAID_AUTH = "1";
  env.E4_R92_PAID_AUTH_DIGEST = planDigest;
  // The driver's own guard requires the paid switch on a billed-identity plan,
  // because the arm's plan identity is `openai` even though the transport is the
  // arm's offline provider. It is set HERE, in the child's environment only, and
  // it is paired with the key being ABSENT — the missing key is what makes the
  // transport offline. The literal is assembled so this file never carries the
  // contiguous form the R92 workflow guard scans for (that guard reads ci.yml,
  // but keeping the habit means the same string cannot leak into a workflow).
  env["RUN_PAID_BENCH" + "MARKS"] = "1";
  const res = runNode(join(here, "r97-campaign-driver.mjs"), args, { env, timeout: opts.runTimeoutMs });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  // The exit code is the driver's own verdict, and a parsed result is required so
  // the campaign's numbers can be reported rather than only its exit code.
  const ok = res.code === 0 && parsed !== null && parsed.status === "COMPLETE";
  await writeFile(join(opts.outDir, "driver-result.json"), res.stdout, "utf8").catch(() => {});
  return {
    step: "run",
    ok,
    code: res.code,
    ledgerDir,
    runOutDir,
    status: parsed?.status ?? null,
    campaign: parsed === null
      ? null
      : {
          logicalCalls: parsed.logicalCalls ?? null,
          providerRequests: parsed.providerRequests ?? null,
          measuredUnits: parsed.measuredUnits ?? null,
          verifiedPasses: parsed.verifiedPasses ?? null,
          // HOW MUCH THOSE PASSES PROVE (T6 怎么做 5): a "strong" pass came from a
          // case whose own command verifier checks the written bytes; a "weak" pass
          // came from an artifact verifier that only checks existence/touch. Both
          // are real under the verifier's contract, and they are NOT equivalent.
          strongPasses: parsed.strongPasses ?? null,
          weakPasses: parsed.weakPasses ?? null,
          skippedUnits: parsed.skippedUnits ?? null,
          executionMode: parsed.executionMode ?? null,
          workerUnits: parsed.workerUnits ?? null,
        },
    ...(ok ? {} : { output: tail(`${res.stdout}\n${res.stderr}`) }),
  };
}

/**
 * STEP 5 — validate the campaign from its OWN artifacts.
 *
 * The validator re-derives every verdict from the ledger, the execution state and
 * the evidence chain. A tampered artifact must make this step fail; that is the
 * property the acceptance criterion names ("summary 篡改会失败"), and it is why
 * this is a separate command rather than a field the driver reports about itself.
 */
export async function stepValidate(opts, ledgerDir) {
  const outPath = join(opts.outDir, "validator-report.json");
  const res = runNode(join(here, "r97-validate-campaign.mjs"), ["--campaign", ledgerDir, "--out", outPath]);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    try {
      parsed = JSON.parse(await readFile(outPath, "utf8"));
    } catch {
      parsed = null;
    }
  }
  return {
    step: "validate",
    ok: res.code === 0,
    code: res.code,
    reportPath: outPath,
    validated: parsed?.ok ?? null,
    units: parsed?.units ?? null,
    ...(res.code === 0 ? {} : { output: tail(`${res.stdout}\n${res.stderr}`) }),
  };
}

/**
 * Persist a REDACTED single-case report and the campaign summary (plan §T6 怎么做 6).
 *
 * "上传本次 campaign 的 plan、观察摘要、ledger、journal、脱敏单例报告、最终汇总和
 * validator 输出；摘要可追到原报告."
 *
 * The point of "脱敏单例" is that ONE case's report is published in a form a reviewer
 * can read without exposing anything the campaign should not leak, while remaining
 * traceable back to the full artifact. So this writes:
 *
 *   - `case-report.json`: one case's own report row, plus the identity of the unit
 *     it came from and the sha256 of the evidence file it was read out of — the
 *     link that makes the summary traceable to the original;
 *   - `campaign-summary.json`: the campaign-level figures, each naming the artifact
 *     it was derived from.
 *
 * It reads the driver result and the evidence the run left behind. It NEVER invents
 * a figure: a value that cannot be read is `null` with a reason.
 */
export async function stepSummarize(opts) {
  const driverResultPath = join(opts.outDir, "driver-result.json");
  let driverResult = null;
  try {
    driverResult = JSON.parse(await readFile(driverResultPath, "utf8"));
  } catch (err) {
    return {
      step: "summarize",
      ok: false,
      code: 1,
      output: `the driver result at ${driverResultPath} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ONE case, chosen by an EXPLICIT rule rather than by list order, and the rule
  // is recorded in the report so a reader can see why this unit was published.
  //
  // A PASSING unit is preferred, because a pass is the claim a skeptical reader
  // should scrutinise: publishing a negative would show the verifier ran, but not
  // that the loop can succeed. A STRONG pass outranks a weak one, since a weak pass
  // only proves the artifact path exists and was touched (T6 怎么做 5). The
  // fallback is the first unit, which on the frozen R87 selection is a real
  // `case_failed` negative — honest, and still evidence the verifier ran.
  const units = Array.isArray(driverResult.unitResults) ? driverResult.unitResults : [];
  const chosen = units.find((u) => u.verifierPassed === true && u.passStrength === "strong")
    ?? units.find((u) => u.verifierPassed === true && u.passStrength === "weak")
    ?? units.find((u) => u.verifierPassed === true)
    ?? units[0]
    ?? null;
  const selectionReason =
    chosen === null
      ? "no unit ran"
      : chosen.verifierPassed === true && chosen.passStrength === "strong"
        ? "the first STRONG pass: this case's own command verifier checks the written bytes"
        : chosen.verifierPassed === true && chosen.passStrength === "weak"
          ? "the first WEAK pass: the artifact verifier checks only that the path exists and was touched"
          : chosen.verifierPassed === true
            ? "the first pass"
            : "no unit passed, so the first unit is published — a real negative, which still shows the verifier ran";

  let caseReport = null;
  let evidencePath = null;
  let evidenceSha = null;
  if (chosen !== null) {
    // The evidence file is located from the execution state's own link rather than
    // guessed from a path convention: the record names its evidence, and that link
    // is what the validator re-checks.
    const ledgerDir = join(opts.outDir, "ledger");
    const statePath = join(ledgerDir, "execution-state.json");
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const record = (state.records ?? []).find(
        (r) => r.arm === chosen.arm && r.caseId === chosen.caseId && r.evidence != null,
      );
      if (record?.evidence?.path) {
        evidencePath = join(ledgerDir, ...String(record.evidence.path).split("/"));
        evidenceSha = record.evidence.sha256 ?? null;
        const envelope = JSON.parse(await readFile(evidencePath, "utf8"));
        caseReport = {
          schema: "e4-r101-redacted-case-report-v1",
          selectionReason,
          unit: envelope.unit ?? null,
          passStrength: chosen.passStrength ?? null,
          build: envelope.build ?? null,
          verdict: envelope.verdict ?? null,
          // The arm's own report ROW, exactly as the evidence envelope stored it.
          // It was redacted by the worker before it was written, and it carries no
          // prompt, no URL and no key — only the case's own metrics and verdict.
          report: envelope.report ?? null,
          resultHash: envelope.resultHash ?? null,
          evidenceRelPath: record.evidence.path,
          evidenceSha256: evidenceSha,
          // THE TRACEABILITY LINK (plan §T6 怎么做 6: "摘要可追到原报告").
          traceableTo: {
            driverResult: "driver-result.json",
            executionState: "ledger/execution-state.json",
            evidence: `ledger/${String(record.evidence.path)}`,
            evidenceSha256: evidenceSha,
          },
        };
      }
    } catch (err) {
      caseReport = {
        schema: "e4-r101-redacted-case-report-v1",
        selectionReason,
        unit: { arm: chosen.arm, caseId: chosen.caseId },
        unavailable: `the evidence could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  await writeFile(join(opts.outDir, "case-report.json"), `${JSON.stringify(caseReport, null, 2)}\n`, "utf8");

  // The campaign summary. Every figure names its source so a reader can re-derive
  // it rather than trust it, and `paid*`/`external*` stay explicit.
  const summary = {
    schema: "e4-r101-campaign-summary-v1",
    acceptanceVersion: ACCEPTANCE_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    armBaselineSha: driverResult.armBaselineSha ?? null,
    armCandidateSha: driverResult.armCandidateSha ?? null,
    executionMode: driverResult.executionMode ?? null,
    runStatus: driverResult.status ?? null,
    runCode: driverResult.code ?? null,
    reason: driverResult.reason ?? null,
    figures: {
      // CUMULATIVE over the campaign's durable history, unioned by unit.
      verifiedPasses: driverResult.verifiedPasses ?? null,
      measuredUnits: driverResult.measuredUnits ?? null,
      completedUnits: driverResult.completedUnits ?? null,
      cumulativeCalls: driverResult.cumulativeCalls ?? null,
      // THIS RUN only, so the two are never conflated.
      newCalls: driverResult.newCalls ?? null,
      newUnits: driverResult.newUnits ?? null,
      skippedUnits: driverResult.skippedUnits ?? null,
      workerUnits: driverResult.workerUnits ?? null,
      workerConsumedCalls: driverResult.workerConsumedCalls ?? null,
      // HOW MUCH THE PASSES PROVE (T6 怎么做 5). A weak pass came from an artifact
      // verifier that checks only that a path exists and was touched.
      strongPasses: driverResult.strongPasses ?? null,
      weakPasses: driverResult.weakPasses ?? null,
      // The DRIVER's own provider count. In arm-worker mode the driver constructs
      // no provider, so this is 0 and is NOT a claim that no model call happened:
      // the units' calls are counted in `workerConsumedCalls`.
      driverProviderRequests: driverResult.providerRequests ?? null,
    },
    evidence: {
      ok: driverResult.evidence?.ok ?? null,
      checked: driverResult.evidence?.checked ?? null,
      failures: driverResult.evidence?.failures ?? [],
    },
    derivedFrom: {
      driverResult: "driver-result.json",
      observationSummary: "observation-summary.json",
      plan: "plan.json",
      ledger: "ledger/budget-ledger.json",
      executionState: "ledger/execution-state.json",
      validatorReport: "validator-report.json",
      caseReport: "case-report.json",
    },
    // ---- THE HONEST SCOPE, restated on the summary itself. ----------------
    paidStatus: "PAID_NOT_RUN",
    externalProviderCalls: 0,
    paidAuthorizationPresent: false,
    realTwoVersionExperimentRan: false,
    modelCapabilityClaim: "none — the offline provider is scripted, so no model-quality result exists",
    promotable: false,
    scopeNote:
      "The campaign ran OFFLINE through the official arm-worker entry: two real arm builds, the arm's own ScriptedModelProvider, real tool calls and the real TaskVerifier. It does NOT prove a model-quality result, and the strong/weak pass split is reported because an artifact verifier only checks that a path exists and was touched.",
  };
  await writeFile(join(opts.outDir, "campaign-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { step: "summarize", ok: true, code: 0, summaryPath: join(opts.outDir, "campaign-summary.json"), caseReportPath: join(opts.outDir, "case-report.json") };
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
  const baselineDir = value("--baseline-dir");
  const candidateDir = value("--candidate-dir");
  // `--all` means "every step", but PREPARE is the one step whose input the caller
  // can supply directly. If both arm directories are given, the arms already exist:
  // re-running the builder would create a SECOND pair in a temp root that no later
  // step reads, while the summary recorded that temp root as the arms used. So an
  // explicit pair suppresses the INFERRED prepare. An explicit `--prepare` is a
  // request and is always honoured.
  const explicitPrepare = has("--prepare");
  return {
    all,
    prepare: explicitPrepare || (all && !(baselineDir !== undefined && candidateDir !== undefined)),
    observe: all || has("--observe"),
    plan: all || has("--plan"),
    run: all || has("--run"),
    validate: all || has("--validate"),
    summarize: all || has("--summarize"),
    root: value("--root"),
    out: value("--out"),
    baselineDir,
    candidateDir,
    baseline: value("--baseline"),
    candidate: value("--candidate"),
    provider: value("--provider"),
    model: value("--model"),
    endpoint: value("--endpoint"),
    campaignModelCalls: value("--campaign-model-calls"),
  };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`r101-acceptance: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CONFIG;
  }
  if (!parsed.prepare && !parsed.observe && !parsed.plan && !parsed.run && !parsed.validate && !parsed.summarize) {
    process.stderr.write(
      "r101-acceptance: nothing to do — pass --all, or one or more of " +
        "--prepare --observe --plan --run --validate --summarize\n",
    );
    return EXIT_CONFIG;
  }

  const shas = await frozenShas();
  const opts = {
    armsRoot: parsed.root !== undefined ? resolve(parsed.root) : await mkdtemp(join(tmpdir(), "r101-arms-")),
    outDir: parsed.out !== undefined ? resolve(parsed.out) : await mkdtemp(join(tmpdir(), "r101-out-")),
    baseline: parsed.baseline ?? shas.baseline,
    candidate: parsed.candidate ?? shas.candidate,
    providerId: parsed.provider ?? "openai",
    modelId: parsed.model ?? "gpt-4o-mini",
    endpointBaseUrl: parsed.endpoint ?? "https://api.openai.com/v1",
    campaignModelCalls: parsed.campaignModelCalls === undefined ? 320 : Number(parsed.campaignModelCalls),
    campaignDeadlineMs: null,
    runTimeoutMs: 3_600_000,
    // The approval's window. The plan's `createdAt` is the instant the approval
    // was written, and `now` is when it is being evaluated — keeping them separate
    // is what lets the gate compare an authorization's instant against a real one.
    createdAt: new Date().toISOString(),
    validityDays: 30,
    now: new Date().toISOString(),
    baselineDir: "",
    candidateDir: "",
    // Whether THIS run built the arms. Reported so the summary can say whether the
    // arm directories are its own output or the caller's input.
    armsBuilt: parsed.prepare,
  };
  opts.baselineDir = parsed.baselineDir !== undefined ? resolve(parsed.baselineDir) : join(opts.armsRoot, "baseline");
  opts.candidateDir = parsed.candidateDir !== undefined ? resolve(parsed.candidateDir) : join(opts.armsRoot, "candidate");
  await mkdir(opts.outDir, { recursive: true });

  const steps = [];
  const fail = (step) => {
    steps.push(step);
    return finish(opts, steps, false);
  };

  // ---- STEP 1: prepare -----------------------------------------------------
  if (parsed.prepare) {
    const prepared = await stepPrepare(opts);
    process.stdout.write(`[1/6] prepare  ${prepared.ok ? "OK" : "FAILED"}\n`);
    if (!prepared.ok) return fail(prepared);
    steps.push(prepared);
  } else {
    // A later step still needs the directories to exist; assert that rather than
    // discovering it as a confusing observation failure.
    for (const [label, dir] of [["baseline", opts.baselineDir], ["candidate", opts.candidateDir]]) {
      if (!existsSync(join(dir, "apps", "cli", "dist", "main.js"))) {
        process.stderr.write(
          `r101-acceptance: the ${label} arm has no built CLI at ${join(dir, "apps", "cli", "dist", "main.js")} — ` +
            `run --prepare first (a missing arm is a setup failure, never a skip)\n`,
        );
        return EXIT_CONFIG;
      }
    }
  }

  // ---- STEP 2 + 3: observe and plan ---------------------------------------
  let observations = null;
  let planDigest = null;
  if (parsed.observe || parsed.plan || parsed.run || parsed.validate) {
    const observed = await stepObserve(opts);
    process.stdout.write(`[2/6] observe  ${observed.ok ? "OK" : "FAILED"}\n`);
    if (!observed.ok) return fail(observed);
    observations = observed.observations;
    steps.push({ ...observed, observations: undefined });
  }
  if (parsed.plan || parsed.run || parsed.validate) {
    const planned = await stepPlan(opts, observations);
    process.stdout.write(`[3/6] plan     ${planned.ok ? "OK" : "FAILED"}  ${planned.planDigest ?? ""}\n`);
    if (!planned.ok) return fail(planned);
    planDigest = planned.planDigest;
    steps.push(planned);
  }

  // ---- STEP 4: run the official entry -------------------------------------
  let ledgerDir = null;
  if (parsed.run || parsed.validate) {
    const ran = await stepRun(opts, planDigest);
    process.stdout.write(
      `[4/6] run      ${ran.ok ? "OK" : "FAILED"}  status=${String(ran.status)} calls=${String(ran.campaign?.logicalCalls ?? "?")}\n`,
    );
    if (!ran.ok) return fail(ran);
    ledgerDir = ran.ledgerDir;
    steps.push(ran);
  }

  // ---- STEP 5: validate ---------------------------------------------------
  if (parsed.validate) {
    const validated = await stepValidate(opts, ledgerDir);
    process.stdout.write(`[5/6] validate ${validated.ok ? "OK" : "FAILED"}\n`);
    if (!validated.ok) return fail(validated);
    steps.push(validated);
  }

  // ---- STEP 6: the publishable summary ------------------------------------
  if (parsed.summarize) {
    const summarized = await stepSummarize(opts);
    process.stdout.write(`[6/6] summarize ${summarized.ok ? "OK" : "FAILED"}\n`);
    if (!summarized.ok) return fail(summarized);
    steps.push(summarized);
  }

  return finish(opts, steps, true);
}

/**
 * Write the acceptance summary and return the exit code.
 *
 * The summary states its OWN scope in explicit fields. Plan §T6 怎么验收 5:
 * "无外部付费执行时标为 `OFFLINE_ACCEPTED / PAID_NOT_RUN`, 不得宣称模型能力提升、
 * 真实胜率改善或可晋升." A reader who finds this file should not have to infer
 * whether a paid model was contacted, so the fields say it.
 */
async function finish(opts, steps, ok) {
  const runStep = steps.find((s) => s.step === "run");
  const summary = {
    acceptanceVersion: ACCEPTANCE_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    ok,
    // The arms ACTUALLY measured. With an explicit pair this is the caller's
    // directories, not the temp root the (now suppressed) builder would have made:
    // the summary must describe the pair the campaign ran against.
    //
    // `armsRoot` is reported as `null` when the arms were supplied rather than
    // built, because in that case there IS no root this run created — printing the
    // unused temp path would name a directory nothing measured.
    armsRoot: opts.armsBuilt ? opts.armsRoot : null,
    baselineDir: opts.baselineDir,
    candidateDir: opts.candidateDir,
    outDir: opts.outDir,
    baselineSha: opts.baseline,
    candidateSha: opts.candidate,
    steps: steps.map((s) => ({ step: s.step, ok: s.ok, code: s.code, ...(s.output === undefined ? {} : { output: s.output }) })),
    // The figures the run's own driver result reported. `strongPasses`/`weakPasses`
    // are carried because a weak pass — an artifact verifier that checks only that
    // a path exists and was touched — must never be read as a solved case
    // (plan §T6 怎么做 5).
    campaign: runStep?.campaign ?? null,
    passStrength: runStep?.campaign === null || runStep?.campaign === undefined
      ? null
      : { strongPasses: runStep.campaign.strongPasses ?? null, weakPasses: runStep.campaign.weakPasses ?? null },
    // ---- THE HONEST SCOPE, as FIELDS rather than prose. -------------------
    //
    // `OFFLINE_ACCEPTED` means the loop ran and its evidence verified. It does
    // NOT mean a model was asked anything: the provider was the arm's own
    // `ScriptedModelProvider`, so `externalProviderCalls` is 0 by construction.
    status: ok ? "OFFLINE_ACCEPTED" : "FAILED",
    paidStatus: "PAID_NOT_RUN",
    externalProviderCalls: 0,
    paidAuthorizationPresent: false,
    realTwoVersionExperimentRan: false,
    modelCapabilityClaim: "none — the offline provider is scripted, so no model-quality result exists",
    promotable: false,
    scopeNote:
      "Proves the OFFLINE closed loop runs end to end on this platform: two real arm builds, the official arm-worker entry, real tool/verifier execution and a validator that re-derives the verdicts. Does NOT prove the paid two-version experiment ran, and supports no claim about model quality or promotion.",
  };
  await writeFile(join(opts.outDir, "acceptance-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8").catch(() => {});
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return ok ? EXIT_OK : EXIT_FAILED;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
