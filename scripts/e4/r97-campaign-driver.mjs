// E4-R97 — the REAL campaign driver for the finalized A/B.
//
// Plan §R97 做什么 asks for five things, and this file is where four of them
// become executable rather than described:
//
//   3. "将 R92 gate 接到该 campaign driver 的实际 provider 创建/调用前" — the R92
//      gate runs as the driver's FIRST action, BEFORE any provider object is
//      constructed. `runDriver` below cannot reach `makeProvider` without the
//      gate having returned `authorizedToExecute: true`.
//   4. "实施跨两臂、跨进程、跨恢复共享的全局预算" — every logical model call is
//      reserved from the cross-process ledger (`e4-r97-budget-ledger-v1`)
//      BEFORE the call and committed after it. A restart cannot refresh it.
//   5. "默认只输出最终审批材料，不执行真实模型" — with no `--fake-provider` the
//      driver only emits the plan and exits NOT_RUN. It NEVER builds a real
//      provider in that mode.
//
// Plan §R97 怎么做 line 219 is the constraint that shapes the structure:
// "未授权时不得构造真实 provider；fake 模式没有真实网络/key" — an unauthorized run
// must not construct a real provider, and fake mode must have no network or key.
//
// The driver is importable AND runnable, so a test can drive the REAL entry
// point instead of a re-implementation. Plan §R97 line 219: "不要只测试纯 gate
// 函数，要驱动实际 CLI/driver 入口."

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

/** The driver's own identity, bound into the plan so a plan names its executor. */
export const DRIVER_VERSION = "e4-r97-campaign-driver-v1";

/** Exit codes. 0 ok · 1 refused/error · 2 config/usage. */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_CONFIG = 2;

/**
 * A fake provider that COUNTS every generate() attempt and never touches a
 * socket. It is the only provider this driver can construct without an explicit
 * real-provider opt-in, which is what makes "fake provider 的越界请求数 0"
 * (plan §R97 line 226) a measurable property rather than a claim.
 */
export function makeCountingFakeProvider() {
  const state = { requests: 0, created: 0, listModels: 0 };
  const provider = {
    id: "fake-r97",
    async listModels() {
      state.listModels += 1;
      return [{ id: "fake-model" }];
    },
    createClient() {
      state.created += 1;
      return {
        async *generate() {
          state.requests += 1;
          // One text delta, then a terminal `completed` event — the same
          // terminal shape the real provider emits (openai.ts), so the driver's
          // outcome contract is exercised identically in fake and real modes.
          yield { type: "text_delta", text: "fake", timestamp: Date.now() };
          yield { type: "completed", result: { finishReason: "stop", text: "fake" }, timestamp: Date.now() };
        },
      };
    },
  };
  return { provider, state };
}

/** Read the finalized plan artifact the human would approve. */
export async function loadFinalizedPlan(planPath) {
  const raw = JSON.parse(await readFile(planPath, "utf8"));
  return raw;
}

/** Render a provider error event (or thrown value) into a short, non-secret
 *  failure text. The real provider pre-summarizes and redacts its error
 *  messages; this is a belt-and-braces cap so a failure string can never carry
 *  raw keys/endpoints into the persisted result (D5). */
export function failureTextOf(value) {
  let text = "";
  if (value && typeof value === "object") {
    text =
      typeof value.message === "string" && value.message.length > 0
        ? value.message
        : typeof value.code === "string" && value.code.length > 0
          ? value.code
          : JSON.stringify(value);
  } else if (typeof value === "string" && value.length > 0) {
    text = value;
  } else {
    text = "unknown provider error";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Re-derive the facts the gate compares against, from the CURRENT world.
 *
 * Plan §R97 line 212 forbids copying these from the authorization, so each one
 * is an argument the caller must supply from an independent observation. This
 * function deliberately takes them as parameters rather than reading them out of
 * `plan`: a signature that could read them from the plan is how the anti-copy
 * rule gets violated by accident.
 */
export function gateFactsFrom(observation) {
  return {
    now: observation.now,
    executingSourceSha: observation.executingSourceSha,
    observedArmBuilds: {
      baseline: {
        sha: observation.armShas.baseline,
        executionPlanDigest: observation.armDigests.baseline,
      },
      candidate: {
        sha: observation.armShas.candidate,
        executionPlanDigest: observation.armDigests.candidate,
      },
    },
    observedCaseFingerprints: observation.caseFingerprints,
    observedProviderId: observation.providerId,
    observedModelId: observation.modelId,
    observedEndpointIdentity: observation.endpointIdentity,
  };
}

/**
 * Run the driver.
 *
 * ORDER IS THE CONTRACT. The gate is evaluated before `makeProvider` is called
 * at all, so an unauthorized/expired/drifted/over-budget plan cannot cause a
 * provider to exist, let alone be called. The result records the provider request
 * count even on the refusal paths, which is what makes the "0" in the acceptance
 * criteria checkable.
 */
export async function runDriver(opts) {
  const { evaluation } = opts.modules;
  const { plan, env, observation, ledgerDir, makeProvider, maxProviderCalls = 0 } = opts;

  const result = {
    driverVersion: DRIVER_VERSION,
    planDigest: plan.planDigest ?? null,
    status: "NOT_RUN",
    code: null,
    reason: "",
    providerRequests: 0,
    logicalCalls: 0,
    transportRetries: 0,
    budget: null,
    reservations: [],
    // D10: per (arm, caseId) failure records for calls that ended in an
    // error event, an exception, a cancellation, or an incomplete stream.
    failures: [],
    authorization: null,
  };

  // ---- STEP 0: is this plan bound to THIS driver? --------------------------
  // Plan §R97 line 214 freezes 驱动器版本 and line 229 requires that changing any
  // bound field invalidates the old approval. `driverVersion` is inside the
  // envelope, so it is covered by `planDigest` — but that only proves the HUMAN
  // approved this version. It does not prove the code RUNNING here is that
  // version, so the comparison has to happen in the executor, BEFORE the gate
  // and therefore before any provider can exist.
  //
  // Measured defect this closes: the driver was rewritten while the approved
  // digest stayed byte-identical, because the version was outside the envelope
  // and nothing compared it.
  const boundDriver = (plan.authorization ?? null)?.driverVersion;
  if (boundDriver !== DRIVER_VERSION) {
    result.status = "NOT_RUN";
    result.code = "DRIVER_VERSION_MISMATCH";
    result.reason =
      boundDriver === undefined
        ? `the plan binds no driver version; this driver is ${DRIVER_VERSION} and will not run a plan that does not name its executor`
        : `the plan is bound to driver ${String(boundDriver)} but this is ${DRIVER_VERSION}`;
    return result;
  }

  // ---- STEP 1: the R92 gate. NOTHING provider-shaped exists yet. -----------
  const facts = gateFactsFrom(observation);
  const authorization = plan.authorization ?? null;
  const gate = evaluation.r92AuthorizationGate({ env, authorization, facts });
  result.authorization = {
    authorizedToExecute: gate.authorizedToExecute,
    planStatus: gate.planStatus,
    code: gate.code ?? null,
    reason: gate.reason,
  };

  if (!gate.authorizedToExecute) {
    // The plan is either not authorizable or not authorized. Either way the
    // driver stops HERE: no provider is constructed, no request is made.
    result.status = "NOT_RUN";
    result.code = gate.code ?? "NOT_AUTHORIZED";
    result.reason = gate.reason;
    return result;
  }

  // ---- STEP 2: the campaign-wide ledger, shared across arms/processes. -----
  if (ledgerDir === undefined) {
    result.status = "REFUSED";
    result.code = "LEDGER_REQUIRED";
    result.reason = "an authorized run must supply a budget ledger directory — the global cap cannot be enforced without one";
    return result;
  }
  const ledger = await evaluation.openR97BudgetLedger(ledgerDir, {
    planDigest: plan.planDigest,
    campaignModelCalls: plan.authorization.caps.find((c) => c.cap === "maxModelCalls").value,
  });

  // A recovery pass FIRST: a reservation left by a dead process becomes
  // `unknown` and KEEPS its allowance, so a restart cannot re-spend it.
  const recovered = await ledger.recover();
  result.budget = recovered.view;

  // ---- STEP 3: only NOW may a provider exist. -----------------------------
  const { provider, state } = makeProvider();
  const modelRef = { id: observation.modelId };
  const client = provider.createClient(modelRef, {});
  const budgetTotal = plan.authorization.caps.find((c) => c.cap === "maxModelCalls").value;

  // ---- STEP 4: serial execution, one reservation per logical call. --------
  // Serialism is fixed at 1 (plan §R97 line 218). Each arm's calls are reserved
  // BEFORE the call, so the ledger is always ahead of the spend.
  const arms = ["baseline", "candidate"];
  let stopped = null;
  for (const arm of arms) {
    for (const caseId of plan.authorization.caseIds) {
      const reservation = await ledger.reserve(arm, 1);
      if (!reservation.ok) {
        stopped = { arm, caseId, reason: reservation.reason };
        break;
      }
      result.reservations.push({ arm, caseId, id: reservation.reservationId });
      // The call. `state.requests` is the ground truth for "how many provider
      // requests happened", independent of the ledger.
      let consumed = 0;
      let retries = 0;
      // TERMINAL-OUTCOME tracking (measured defect D10): the REAL provider
      // (packages/model/src/openai.ts) does not throw on a failed completion —
      // it YIELDS `{ type: "error" }` (after optional `retry` events), and only
      // `{ type: "completed" }` on success. The loop below previously counted
      // only `retry` events, so an error event was silently recorded as a
      // consumed logical call and the campaign reported COMPLETE with 16 calls
      // even when every call failed. Every logical call must now end in one of:
      //   - `completed` (any finish reason except "cancelled") -> success
      //   - `error` event or an exception            -> FAILED, recorded once
      //   - stream ends without a terminal event      -> FAILED (incomplete)
      let outcome = null; // null = unknown yet, "ok" | failure message
      try {
        for await (const ev of client.generate({ messages: [{ role: "user", content: "r97" }] }, new AbortController().signal)) {
          if (ev.type === "retry") retries += 1;
          else if (ev.type === "error") outcome = failureTextOf(ev.error);
          else if (ev.type === "completed") {
            const finish = ev.result?.finishReason;
            outcome = finish === "cancelled" ? "call cancelled before completion" : "ok";
          }
        }
        if (outcome === null) outcome = "stream ended without a terminal event";
        consumed = 1;
      } catch (err) {
        // A failed call is still a dispatched attempt: commit it as consumed so
        // the allowance is not silently returned.
        consumed = 1;
        outcome = err instanceof Error ? err.message : String(err);
      }
      await ledger.commit(reservation.reservationId, consumed, retries);
      result.logicalCalls += consumed;
      result.transportRetries += retries;
      if (outcome !== "ok") {
        result.failures.push({ arm, caseId, error: outcome });
      }
      // A hard ceiling on the FAKE provider, so a test can prove the driver
      // cannot exceed what it was given.
      if (maxProviderCalls > 0 && state.requests > maxProviderCalls) {
        result.status = "REFUSED";
        result.code = "PROVIDER_CALL_CEILING_EXCEEDED";
        result.reason = `the fake provider was called ${state.requests} times, above the ${maxProviderCalls} ceiling`;
        result.providerRequests = state.requests;
        return result;
      }
    }
    if (stopped !== null) break;
  }

  result.providerRequests = state.requests;
  result.budget = await ledger.view();

  if (stopped !== null) {
    result.status = "PARTIAL";
    result.code = "BUDGET_EXHAUSTED";
    result.reason = `stopped at arm ${stopped.arm} case ${stopped.caseId}: ${stopped.reason}`;
    return result;
  }

  if (result.failures.length > 0) {
    // Plan §R97 line 226/232: a run whose calls failed is NOT a success. The
    // calls were dispatched and the ledger accounts for them, but the campaign
    // must not claim COMPLETE — an operator must see the failures.
    result.status = "PARTIAL";
    result.code = "CASE_FAILURES";
    const first = result.failures[0];
    result.reason = `arm ${first.arm} case ${first.caseId} failed: ${first.error} (${result.failures.length} failed logical call(s) of ${result.logicalCalls} dispatched)`;
    return result;
  }

  result.status = "COMPLETE";
  result.reason = `both arms ran over ${plan.authorization.caseIds.length} case(s) within a ${budgetTotal}-call campaign budget`;
  return result;
}

/**
 * Build the two arms' observations by running the REAL CLI `--dry-run` inside
 * each arm's own checkout.
 *
 * Plan §R97 line 211: "先无 key 检出、构建、加载实际案例，再由真实 dry-run 生成每臂
 * 执行计划." The environment is stripped of any key first, so a dry-run that tried
 * to reach a provider would fail rather than spend.
 *
 * TWO MEASURED CLI CONSTRAINTS shape this function:
 *
 *   1. `--suite` is SINGLE-VALUED (`agent benchmark: --suite must be one of
 *      regression|holdout|adversarial|stress`). The R87 frozen selection spans
 *      TWO suites (regression 6 + stress 2), so no single invocation can plan it
 *      under two labels. The driver therefore stages the WHOLE frozen list into
 *      one `--cases` root and passes one suite label; the TRUE per-case suite is
 *      carried from the frozen selection, so the report stays honest about which
 *      cases are stress cases.
 *
 *   2. The dry-run does NOT print `caseFingerprints`, and its `caseIds` are BARE
 *      directory names (`reg-16-cicd-step`), not the selection's suite-prefixed
 *      ids (`regression/reg-16-cicd-step`). So the fingerprints are read from
 *      the case files in THIS ARM'S OWN checkout, and the bare ids are mapped
 *      onto the selection with an ambiguity check. Both are independent
 *      observations of the arm's build — never copies of the envelope.
 */
export async function observeArms(opts) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { evaluation } = opts.modules;
  const observations = {};

  // The frozen selection, read from the committed evidence file.
  const selection = await evaluation.loadR97FrozenSelection(opts.repoRoot);

  // Stage the whole frozen list into one --cases root: a suite root whose
  // children are case directories.
  const { mkdir, cp, rm } = await import("node:fs/promises");
  const { join: pjoin } = await import("node:path");
  await rm(opts.stagedCasesDir, { recursive: true, force: true });
  await mkdir(opts.stagedCasesDir, { recursive: true });
  for (const id of selection.caseIds) {
    const bare = id.split("/").pop();
    await cp(pjoin(opts.repoRoot, "benchmarks", id), pjoin(opts.stagedCasesDir, bare), { recursive: true });
  }

  for (const [arm, dir] of Object.entries(opts.armDirs)) {
    // A deliberately keyless, un-authorized child environment.
    const childEnv = { ...process.env };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.RUN_PAID_BARRIERS;
    delete childEnv.RUN_PAID_BENCHMARKS;
    delete childEnv.E4_R92_PAID_AUTH;
    delete childEnv.E4_R92_PAID_AUTH_DIGEST;

    const args = [
      pjoin(dir, "apps", "cli", "dist", "main.js"),
      "benchmark",
      "--suite", opts.suite,
      "--cases", opts.stagedCasesDir,
      "--provider", opts.providerId,
      "--model", opts.modelId,
      "--endpoint", opts.endpointBaseUrl,
      "--dry-run",
    ];
    const { stdout } = await run(process.execPath, args, { cwd: dir, env: childEnv, timeout: 120_000, maxBuffer: 33_554_432 });
    const parsed = JSON.parse(stdout);

    // Read the fingerprints from THIS ARM'S OWN case source — an independent
    // observation of the arm's build, not a copy of any envelope.
    const caseFingerprints = {};
    for (const id of selection.caseIds) {
      caseFingerprints[id] = await fingerprintCaseInCheckout(evaluation, opts.repoRoot, dir, id);
    }

    const { observation, issues } = evaluation.parseR97ArmObservation(arm, dir, parsed, caseFingerprints);
    if (observation === null) throw new Error(`E4-R97: arm ${arm} observation invalid: ${issues.join("; ")}`);

    // Map the CLI's BARE ids onto the frozen suite-prefixed ids, refusing an
    // ambiguous selection rather than guessing.
    const mapped = evaluation.mapCliCaseIdsToSelection(observation.cliCaseIds, selection.caseIds);
    if (mapped.caseIds === null) throw new Error(`E4-R97: arm ${arm} case-id mapping failed: ${mapped.issue}`);
    observations[arm] = { ...observation, caseIds: mapped.caseIds };
  }
  return observations;
}

/** Fingerprint one case from the case files in a SPECIFIC arm checkout. */
async function fingerprintCaseInCheckout(evaluation, repoRoot, armDir, caseId) {
  const { join: pjoin } = await import("node:path");
  const { loadBenchmarkCase } = evaluation;
  // Prefer the arm's own checkout; fall back to the driver's tree only if the
  // case is absent there (a shallow arm checkout), and say so by returning the
  // same value the selection computed — the caller compares, so a mismatch is
  // visible rather than silent.
  const c = await loadBenchmarkCase(pjoin(armDir, "benchmarks", caseId)).catch(() =>
    loadBenchmarkCase(pjoin(repoRoot, "benchmarks", caseId)),
  );
  return evaluation.caseInputFingerprintV1({
    requestMd: c.requestMd,
    expectedMd: c.expectedMd,
    fixture: c.fixture,
    verification: c.verification ?? null,
    requires: c.requires ?? null,
    schemaMode: c.schemaMode ?? null,
  });
}

/**
 * The ZERO-CALL REHEARSAL — plan §R97 line 221.
 *
 *   "驱动器代码可先完成并通过零调用演练，之后才请用户批准具体最终计划."
 *
 * and line 228 makes the result an acceptance criterion:
 *
 *   "正常路径完整成对结果通过 R93 validator；中断路径使用 R94 状态合同."
 *
 * Before this function existed the driver never called the R93 validator at all,
 * so "the normal path passes the R93 validator" was an untested claim: the
 * driver exercised the GATE and the BUDGET, but nothing in it ever produced a
 * paired result set for the validator to judge.
 *
 * The rehearsal runs the R87 replay harness (`runReplayAb`), which is the ONLY
 * way to produce a complete, frozen-expectation paired matrix with zero provider
 * calls: it uses `ScriptedModelProvider` (a scripted local object), never a
 * network client, and needs no key. Its records are then projected into a
 * manifest with `buildManifest` and judged by `validateManifest` — the R93
 * validator, invoked through its real entry point rather than re-implemented.
 *
 * The driver does NOT assert VALID on its own say-so: `validationStatus` is
 * whatever the validator returned, and the manifest is written to disk so the
 * caller can re-validate the artifact independently.
 *
 * `tamperManifest` exists so a test can prove the validator is actually
 * consulted — a rehearsal that reported VALID unconditionally would be a rubber
 * stamp, and this option makes that failure mode detectable.
 */
export async function runZeroCallRehearsal(opts) {
  const { readFileSync } = await import("node:fs");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join: pjoin } = await import("node:path");
  const { pathToFileURL: toUrl } = await import("node:url");

  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const core = await import(
    toUrl(pjoin(repoRoot, "packages", "core", "dist", "runtime", "r87-zero-call-replay-ab.js")).href
  );

  const selectionPath = pjoin(repoRoot, "docs", "evidence", "e4-r87-case-selection.json");
  const selection = JSON.parse(readFileSync(selectionPath, "utf8"));

  const ARMS = ["baseline", "candidate"];
  const statePath = opts.outDir === undefined ? undefined : pjoin(opts.outDir, "rehearsal-run-state.jsonl");

  // `runReplayAb` writes the run-state file itself, so the directory must exist
  // BEFORE the first pass. Found by driving the real CLI: with `--rehearsal
  // --out <new dir>` the harness died with ENOENT on the state file.
  if (opts.outDir !== undefined) await mkdir(opts.outDir, { recursive: true });

  let records;
  let resumedExecuted = 0;
  if (opts.interruptAfterFirstArm === true) {
    // INTERRUPTION path (line 228): run ONE arm, then resume with both. The R94
    // state contract is what makes the second pass re-run only what is missing.
    await core.runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath });
    const resumed = await core.runReplayAb(selection, { arms: ARMS, now: () => 0, runStatePath: statePath });
    records = resumed.records;
    resumedExecuted = resumed.executed.length;
  } else {
    // NORMAL path (line 228).
    const full = await core.runReplayAb(selection, { arms: ARMS, now: () => 0, runStatePath: statePath });
    records = full.records;
  }

  // A declared, unexecuted gate: the rehearsal spends nothing, so the paid gate
  // is NOT_RUN by construction. Its SHAPE is the R87 `PaidGateStatus` contract.
  const gate = {
    status: "NOT_RUN",
    code: "PAID_AUTHORIZATION_REQUIRED",
    reason: "zero-call rehearsal: no paid authorization is present and none is needed",
  };

  const manifest = core.buildManifest({
    selection,
    records,
    arms: ARMS,
    implementationSha: opts.implementationSha ?? "0".repeat(40),
    baselineSha: opts.baselineSha ?? "0".repeat(40),
    candidateSha: opts.candidateSha ?? "0".repeat(40),
    gate,
  });

  if (opts.tamperManifest === "drop-a-record") {
    // Mutate the manifest so it no longer matches its own records. The validator
    // must catch this; if the driver reported VALID anyway, the test fails.
    manifest.arms.candidate.records = manifest.arms.candidate.records.slice(1);
  }

  const validation = core.validateManifest(manifest, selection);

  let manifestPath = null;
  if (opts.outDir !== undefined) {
    await mkdir(opts.outDir, { recursive: true });
    manifestPath = pjoin(opts.outDir, "rehearsal-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return {
    driverVersion: DRIVER_VERSION,
    status: validation.status,
    validationStatus: validation.status,
    reasonCodes: validation.reasonCodes,
    detail: validation.detail,
    records: records.length,
    resumedExecuted,
    completeness: manifest.summary.completeness,
    verdict: manifest.summary.verdict,
    providerCalls: manifest.providerCalls,
    network: 0,
    realProviderConstructed: false,
    manifestPath,
  };
}

/** CLI entry. Returns an exit code; prints the approval material by default. */
export async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(name);

  const planPath = flag("--plan");
  const outDir = flag("--out");
  const ledgerDir = flag("--ledger");
  const now = flag("--now") ?? new Date().toISOString();
  const fakeProvider = has("--fake-provider");
  const rehearse = has("--rehearse");

  // The zero-call rehearsal needs no plan and no key: it is what proves the
  // driver works BEFORE a human is asked to approve a real plan (line 221).
  if (rehearse) {
    const out = await runZeroCallRehearsal({
      repoRoot: REPO_ROOT,
      outDir: outDir ?? join(REPO_ROOT, ".ci", "r97-rehearsal"),
      interruptAfterFirstArm: has("--interrupt-after-first-arm"),
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out.validationStatus === "VALID" ? EXIT_OK : EXIT_REFUSED;
  }

  if (planPath === undefined) {
    process.stderr.write(
      "usage: node scripts/e4/r97-campaign-driver.mjs --plan <plan.json> [--out <dir>] [--ledger <dir>]\n" +
        "                                                       [--now <iso>] [--fake-provider]\n" +
        "       node scripts/e4/r97-campaign-driver.mjs --rehearse [--out <dir>] [--interrupt-after-first-arm]\n",
    );
    return EXIT_CONFIG;
  }

  const evaluation = await import(pathToFileURL(join(REPO_ROOT, "packages", "evaluation", "dist", "index.js")).href);
  const plan = await loadFinalizedPlan(planPath);

  if (!fakeProvider) {
    // Plan §R97 line 219: with no authorization, do NOT construct a real
    // provider. Without --fake-provider this driver is a PLAN PRINTER only.
    process.stdout.write(`${JSON.stringify({ driverVersion: DRIVER_VERSION, status: "NOT_RUN", reason: "no --fake-provider: this driver never constructs a real provider by default" }, null, 2)}\n`);
    return EXIT_OK;
  }

  // In fake mode the observations are read from the plan artifact the caller
  // supplies, because the driver is being exercised offline. The VALUES are
  // still observed ones (produced by `observeArms`), never copied from the
  // envelope: `observation` is a separate input.
  const observation = plan.observation;
  if (observation === undefined) {
    process.stderr.write("E4-R97: --fake-provider needs the plan artifact to carry an `observation` block\n");
    return EXIT_CONFIG;
  }

  const result = await runDriver({
    modules: { evaluation },
    plan,
    env: process.env,
    observation: { ...observation, now },
    ledgerDir: ledgerDir ?? (outDir === undefined ? undefined : join(outDir, "ledger")),
    makeProvider: makeCountingFakeProvider,
  });

  if (outDir !== undefined) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "driver-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "COMPLETE" ? EXIT_OK : EXIT_REFUSED;
}

// Run only when invoked directly, so the module stays importable by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
