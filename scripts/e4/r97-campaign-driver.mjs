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
import { createHash } from "node:crypto";
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
 * Recover a unit's terminal category from the durable `detail` the worker wrote.
 *
 * The worker's terminal write is
 *
 *   `${ARM_WORKER_VERSION} ${verdict.category ?? "passed"}: ${verdict.detail}`
 *
 * so the category is the token between the version and the first colon. This is
 * the contract that lets a RESUME re-derive the campaign's aggregate from its own
 * history (plan §T3 怎么做 8): the record persists a verdict, and a later process
 * must be able to read it without the worker that wrote it.
 *
 * It returns `null` for a record it cannot parse — a foreign or hand-edited
 * record is NOT assumed to be a pass. That is deliberate: the aggregate must
 * never be improvable by corrupting the store.
 */
export function unitCategoryOf(detail) {
  if (typeof detail !== "string") return null;
  const m = /^(\S+)\s+([a-z_]+):/.exec(detail);
  if (m === null) return null;
  const category = m[2];
  // Only the categories the worker can actually write. Anything else is not a
  // verdict this driver understands, so it counts as nothing rather than as a
  // pass by default.
  return ["passed", "case_failed", "provider", "harness", "infrastructure", "budget", "timeout"].includes(category)
    ? category
    : null;
}

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
 *  failure text. Plan §R98 / F6 requires the text to be REDACTED, not merely
 *  truncated: the measured defect was that a synthetic `Bearer <canary>` and
 *  `sk-…` survived verbatim into the result. Redaction happens BEFORE the
 *  length cap, so a secret can never be half-printed. */
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
  return redactFailureText(text);
}

/**
 * Redact credentials and endpoint secrets from a failure string.
 *
 * Allowlist-by-construction is not possible for a free-form provider message, so
 * this removes the shapes that carry secrets: bearer tokens, `sk-`-style API
 * keys, URL userinfo, and query parameters that commonly hold keys. Anything
 * that could be a credential is replaced by a placeholder, then the result is
 * collapsed and capped.
 */
export function redactFailureText(raw) {
  let text = String(raw);
  // Authorization headers / bearer tokens (the measured canary shape).
  text = text.replace(/\b(Bearer|Token|ApiKey|Api-Key)\s+[^\s,;)"']+/gi, "$1 <redacted>");
  // Provider API keys (sk-…, rk-…, pk-…, and long base64-ish assignments).
  text = text.replace(/\b(sk|rk|pk|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{6,}/gi, "<redacted-key>");
  // Credentials embedded in the query string.
  text = text.replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|password|secret)=)[^&\s]+/gi, "$1<redacted>");
  // URL userinfo (user:password@host).
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Digest of the inputs that determined a unit's result: the plan's frozen case
 *  fingerprint plus the arm and observed build. A changed case content, arm
 *  build or model therefore changes the digest, so a resume cannot attribute an
 *  old result to new inputs (plan §R98 怎么做). */
export function inputDigestOf(plan, caseId) {
  const fingerprint = plan.authorization.caseFingerprints?.[caseId] ?? "unknown";
  return `case:${caseId}|fp:${fingerprint}|exec:${plan.observation?.executingSourceSha ?? "?"}|driver:${DRIVER_VERSION}`;
}

/** Digest of the stored result of one unit. The driver records what KIND of
 *  terminal outcome it was; the real per-case result artifacts are attached by
 *  the R99 execution path, which replaces this with the artifact hash. */
export function resultHashOf(arm, caseId, outcome) {
  return createHash("sha256").update(`${arm}|${caseId}|${outcome}`).digest("hex");
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
    // R98 (F2): units found already terminal in the durable execution state.
    skippedUnits: 0,
    // R98 (F2): in-flight units a crashed process left behind, now quarantined.
    recoveredUnits: 0,
    // R98-B: units left `running` by an owner on ANOTHER HOST. They cannot be
    // judged dead, so they are conservatively left alone and reported here
    // rather than silently quarantined or re-dispatched.
    foreignOwnerUnits: 0,
    // R98 (F2): terminal units in the durable state after this run.
    completedUnits: 0,
    // R99: which executor ran the units, and — in arm-worker mode — what the
    // worker actually did. Plan §R99 做什么 5 requires the run's COMPLETENESS,
    // the task PASS RATE and any MECHANISM improvement to be separate fields, so
    // a per-unit record set is kept instead of a single scalar.
    executionMode: "provider",
    workerUnits: 0,
    workerConsumedCalls: 0,
    unitResults: [],
    // R99: run completeness vs task pass rate, kept as SEPARATE fields. A
    // `case_failed` unit reached a verdict (measured) without passing, so
    // `measuredUnits` and `verifiedPasses` answer different questions.
    verifiedPasses: 0,
    measuredUnits: 0,
    // R100: the approved case→TRUE-suite inventory, and the distinct suites it
    // covers. A mixed-suite campaign must be visible AS mixed rather than
    // summarised under the CLI's single-valued `--suite` label.
    suiteInventory: [],
    suitesPresent: [],
    // R100: the execution-boundary re-observation's verdict (null when the run
    // stopped before reaching it, e.g. at the R92 gate).
    executionObservation: null,
    // R98-A (N2): which campaign root this run resolved to, and whether any
    // OTHER directory claims the same authorization.
    campaign: null,
    // R98-B: units an operator re-opened with an explicit `retry`.
    reopenedForRetryUnits: 0,
    // ---- R99-A: NEW work vs CUMULATIVE history (plan §T3 怎么做 8). ---------
    // `new*` fields describe THIS process only; the cumulative fields describe the
    // whole campaign, read from durable state. They are separate so a resume that
    // dispatched nothing cannot be mistaken for a campaign that has no history.
    newCalls: 0,
    newUnits: 0,
    // The evidence-chain outcome, filled by the arm-worker resume.
    evidence: null,
    newFailures: 0,
    newMeasuredUnits: 0,
    cumulativeCalls: 0,
    cumulativeUnits: 0,
    historicalFailures: 0,
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

  // ---- STEP 1b: RE-OBSERVE IDENTITY AT THE EXECUTION BOUNDARY (E4-R100). ---
  //
  // Plan §R100 做什么 #1: "分开计划期观测快照和执行期新观测；快照可用于审阅，不能充当
  // 当前事实." The driver NEVER reads `plan.planObservation`: the facts it checks
  // come from the caller's INDEPENDENT `observation` (a fresh arm dry-run plus
  // fresh case fingerprints) together with two values THIS PROCESS derives —
  // its own build digest over its own bytes, and the envelope digest as
  // expanded NOW.
  //
  // WHY IT RUNS AFTER THE GATE rather than before: the R92 gate already refuses
  // the identity drifts it owns (`IDENTITY_DRIFT`, `AUTHORIZATION_*`), and its
  // named codes are the operator-facing vocabulary for those. This check adds
  // what the gate does NOT do — the driver's own build digest, and the
  // agreement between the envelope's stored digest label and its body — so it
  // runs second and its codes are the more specific ones. Ordering it first
  // would relabel every existing gate refusal, which would be a vocabulary
  // change masquerading as a new check.
  //
  // Plan §R100 怎么验收: "计划生成后修改实际case、构建文件、模型参数、endpoint、
  // driver字节，而保留旧observation：每项均在首个外部请求前失败." Every one of
  // those is caught before `makeProvider`, so no request can leave.
  //
  // `driverBuildDigest` is recomputed from the artifact list rather than read
  // from the plan: a plan that named a digest while its executor's bytes changed
  // must be refused, and reading the bound value back would compare the plan
  // against itself.
  if (authorization !== null) {
    let driverBuildDigest;
    try {
      driverBuildDigest = await evaluation.computeDriverBuildDigestV1(opts.repoRoot ?? REPO_ROOT);
    } catch (err) {
      result.status = "REFUSED";
      result.code = "DRIVER_BUILD_UNREADABLE";
      result.reason = redactFailureText(err instanceof Error ? err.message : String(err));
      return result;
    }
    const executionObservation = {
      now: observation.now,
      armShas: { baseline: observation.armShas?.baseline ?? null, candidate: observation.armShas?.candidate ?? null },
      armDigests: { baseline: observation.armDigests?.baseline ?? null, candidate: observation.armDigests?.candidate ?? null },
      caseFingerprints: observation.caseFingerprints ?? {},
      providerId: observation.providerId,
      modelId: observation.modelId,
      endpointIdentity: observation.endpointIdentity,
      driverBuildDigest,
      expandedPlanDigest: evaluation.computeR92AuthorizationDigestV1(authorization),
    };
    const execCheck = evaluation.checkExecutionObservationV1({ plan, observed: executionObservation });
    result.executionObservation = { ok: execCheck.ok, codes: execCheck.codes, issues: execCheck.issues };
    if (!execCheck.ok) {
      // The refusal names every drifted field, so an operator sees WHICH fact
      // moved rather than only that something did.
      result.status = "REFUSED";
      result.code = execCheck.codes[0] ?? "EXECUTION_OBSERVATION_DRIFT";
      result.reason = execCheck.issues.join("; ");
      return result;
    }
  }

  // ---- STEP 2: the campaign-wide ledger, shared across arms/processes. -----
  if (ledgerDir === undefined) {
    result.status = "REFUSED";
    result.code = "LEDGER_REQUIRED";
    result.reason = "an authorized run must supply a budget ledger directory — the global cap cannot be enforced without one";
    return result;
  }

  // Durable state that cannot be trusted is a STRUCTURED refusal, not an
  // exception: a resume whose ledger or case state is missing/corrupt/foreign
  // must surface as a non-COMPLETE result an operator (or CI) can read, and it
  // must happen here — before `makeProvider` — so no provider is ever built.
  // Plan §R98 怎么验收: "修改 grant、planDigest 或结果hash，恢复非零退出，不给出
  // COMPLETE."
  let ledger;
  let execState;
  let campaign = null;
  try {
    // ---- STEP 2a: the CAMPAIGN LIFECYCLE (plan T1 / finding N2). -----------
    //
    // MEASURED DEFECT N2: the driver opened the ledger with NO mode, so it took
    // the ambiguous `"auto"` default and could CREATE a fresh full allowance
    // whenever the file was absent — including on a restart whose ledger had
    // been deleted. `duplicateCampaignDirs` was computed and then never read, so
    // a second directory claiming the same authorization was recorded and
    // ignored.
    //
    // `openR97Campaign` fixes both: it keeps a DURABLE header inside the campaign
    // root (so a lost ledger is BUDGET_STATE_MISSING, never a fresh grant, and a
    // relocated copy is CAMPAIGN_ROOT_MISMATCH), and it ENFORCES the
    // cross-directory conflict instead of only reporting it. `mode: "auto"` is
    // now fail-closed because the header — not a guess — decides whether this is
    // a creation or a recovery.
    campaign = await evaluation.openR97Campaign(ledgerDir, {
      planDigest: plan.planDigest,
      campaignModelCalls: plan.authorization.caps.find((c) => c.cap === "maxModelCalls").value,
      mode: "auto",
      // Test seam: process liveness is not observable deterministically from
      // inside a test process, so a caller may inject the probe. Production
      // callers pass nothing and the real `process.kill(pid, 0)` probe is used.
      ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
    });
    ledger = campaign.ledger;
    result.campaign = {
      mode: campaign.mode,
      campaignId: campaign.campaignId,
      rootDir: campaign.dir,
      duplicateCampaignDirs: [...campaign.duplicateCampaignDirs],
    };
    // A resumed campaign that is ALSO claimed elsewhere is reported, so the
    // conflict reaches the run result rather than staying on an unused handle.
    if (campaign.duplicateCampaignDirs.length > 0) {
      result.status = "REFUSED";
      result.code = "CAMPAIGN_DIR_CONFLICT";
      result.reason = `this authorization is also claimed by ${campaign.duplicateCampaignDirs.join(", ")} — one approval must not be spent in two roots`;
      return result;
    }

    // A recovery pass FIRST: a reservation left by a dead process becomes
    // `unknown` and KEEPS its allowance, so a restart cannot re-spend it.
    const recovered = await ledger.recover();
    result.budget = recovered.view;

    // ---- STEP 2b: the durable case×arm×repetition state (plan §R98 / F2). --
    // The ledger answers "how many calls may still be made"; this answers "which
    // units are already finished". Without it a second run of the SAME plan
    // committed another 2N calls (measured: 16 then 16 = 32).
    //
    // It comes from the CAMPAIGN HANDLE, not a second open (finding N2/N3). The
    // lifecycle created it in the same ordered step as the header and the ledger,
    // so "established" means all three artifacts exist and a missing state file
    // is unambiguously a DELETION rather than a campaign that never got that far.
    // Opening it separately here would reintroduce exactly that ambiguity.
    execState = campaign.execState;
    // A unit left `running` by a process that is PROVABLY GONE is quarantined as
    // outcome_unknown: it is neither skipped as a success nor silently
    // re-dispatched. A unit whose owner is still alive is left alone, so a
    // second process cannot steal a running unit (finding N3).
    const inFlight = await execState.recoverInFlight(
      opts.isAlive === undefined ? {} : { isAlive: opts.isAlive },
    );
    result.recoveredUnits = inFlight.unknown;
    result.foreignOwnerUnits = inFlight.foreign;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = "REFUSED";
    result.code = /CAMPAIGN_DIR_CONFLICT/.test(message)
      ? "CAMPAIGN_DIR_CONFLICT"
      : /CAMPAIGN_HEADER_CORRUPT/.test(message)
        ? "CAMPAIGN_HEADER_CORRUPT"
        : /CAMPAIGN_HEADER_MISSING/.test(message)
          ? "CAMPAIGN_HEADER_MISSING"
          : /CAMPAIGN_ROOT_MISMATCH/.test(message)
            ? "CAMPAIGN_ROOT_MISMATCH"
            : /BUDGET_STATE_MISSING/.test(message)
              ? "BUDGET_STATE_MISSING"
              : /BUDGET_STATE_CORRUPT|not valid JSON|damaged/.test(message)
                ? "BUDGET_STATE_CORRUPT"
                : /BUDGET_STATE_MISMATCH|different plan|different experiment|different authorization/.test(message)
                  ? "BUDGET_STATE_MISMATCH"
                  : "DURABLE_STATE_UNAVAILABLE";
    result.reason = redactFailureText(message);
    return result;
  }

  // ---- STEP 3: only NOW may a provider exist. -----------------------------
  const budgetTotal = plan.authorization.caps.find((c) => c.cap === "maxModelCalls").value;

  // TWO EXECUTION MODES, and the difference is stated in the result rather than
  // left for a reader to infer (plan §R99 做什么 5: "明确运行完整度、任务通过率和
  // 机制改善是不同字段").
  //
  //   "provider" (default) — the caller's provider drives ONE logical call per
  //      unit. This is the zero-call fake/rehearsal mode the R97 tests use.
  //   "arm-worker"         — each unit is executed by `scripts/e4/
  //      r97-arm-worker.mjs` inside ITS OWN arm checkout, which dispatches that
  //      arm's OWN built CLI and reads the report its verifier produced.
  //
  // Plan §R99 做什么 1 replaces the fixed `content: "r97"` placeholder with real
  // per-case work; plan §R99 怎么做 states the split explicitly: "父 driver 排序/
  // 预算/授权/持久化，arm worker 在对应 checkout 的构建里执行 case."
  const armWorker = opts.armWorker ?? null;
  const executionMode = armWorker === null ? "provider" : "arm-worker";

  // ---- THE SUITE INVENTORY (plan §R100 怎么做, line 205). ------------------
  //
  // The CLI's `--suite` is SINGLE-VALUED, but the frozen selection spans TWO
  // suites (regression 6 + stress 2). The plan already records each case's TRUE
  // suite in `authorization.caseInventory` so the adaptation cannot be passed off
  // as "the same experiment under one label". The driver must USE that inventory
  // rather than re-derive a suite from the case id's prefix, because the prefix
  // is a naming convention and the inventory is the approved fact.
  //
  // Plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄将
  // stress 全重标 regression 再宣称完全相同实验."
  const inventoryByCase = new Map();
  for (const entry of authorization?.caseInventory ?? []) {
    if (entry !== null && typeof entry === "object" && typeof entry.caseId === "string") {
      inventoryByCase.set(entry.caseId, entry);
    }
  }
  /** The TRUE suite of a case, from the approved inventory when it is present. */
  const trueSuiteOf = (caseId) => inventoryByCase.get(caseId)?.suite ?? caseId.split("/")[0] ?? "regression";
  result.suiteInventory = [...inventoryByCase.values()].map((e) => ({
    caseId: e.caseId,
    suite: e.suite,
    plannedUnderSuite: e.plannedUnderSuite,
    relabelled: e.relabelled === true,
  }));
  // The suites the campaign actually covers, so a reader can see a mixed-suite
  // run is mixed rather than trusting a single `--suite` label.
  result.suitesPresent = [...new Set(result.suiteInventory.map((e) => e.suite))].sort();

  // In `provider` mode a provider is constructed HERE — still after the gate and
  // after the ledger, so the R97 ordering guarantee is unchanged. In
  // `arm-worker` mode the driver constructs NO provider at all: each unit's own
  // CLI resolves its own transport, which is what makes "两臂均加载自身构建"
  // mechanically true instead of asserted.
  let provider = null;
  let providerState = null;
  let client = null;
  if (armWorker === null) {
    const made = makeProvider();
    provider = made.provider;
    providerState = made.state;
    client = provider.createClient({ id: observation.modelId }, {});
  }

  // ---- STEP 4: serial execution, one reservation per logical call. --------
  // Serialism is fixed at 1 (plan §R97 line 218). Each arm's calls are reserved
  // BEFORE the call, so the ledger is always ahead of the spend.
  const arms = ["baseline", "candidate"];
  let stopped = null;
  for (const arm of arms) {
    for (const caseId of plan.authorization.caseIds) {
      const suite = trueSuiteOf(caseId);
      const unitKey = {
        experimentId: plan.planDigest,
        caseId,
        suite,
        arm,
        repetition: 1,
      };
      // RESUME SKIP: a unit with a terminal record is not re-run, so a resumed
      // campaign spends nothing on work it already finished.
      if (await execState.isDone(unitKey)) {
        result.skippedUnits += 1;
        continue;
      }
      if (await execState.mustNotRetry(unitKey)) {
        result.failures.push({ arm, caseId, error: "outcome_unknown: the previous attempt may have been billed and requires an explicit reconciliation" });
        continue;
      }

      // ---- ARM-WORKER MODE: the unit owns its own reserve/begin/commit. ----
      // The worker performs the SAME ordered protocol (reserve → begin →
      // dispatch → commit → terminal write) against the SAME ledger and state
      // directories, so the driver must NOT also reserve for this unit: doing
      // both would charge one case twice. The driver's job here is ordering,
      // skip decisions and reporting — exactly the split plan §R99 做什么 3 asks
      // for.
      if (armWorker !== null) {
        const dir = armWorker.armDirs?.[arm];
        if (typeof dir !== "string" || dir === "") {
          result.status = "REFUSED";
          result.code = "ARM_DIRECTORY_REQUIRED";
          result.reason = `arm-worker mode needs the ${arm} arm's checkout directory, so the unit can run that arm's OWN build`;
          return result;
        }
        let record;
        try {
          record = await armWorker.runArmUnit({
            checkoutDir: dir,
            repoRoot: opts.repoRoot ?? REPO_ROOT,
            caseId,
            suite,
            arm,
            repetition: 1,
            // The ENVELOPE digest binds the ledger and the execution state; the
            // arm's approved SOURCE SHA binds the build that may execute. They
            // are different kinds of value and are passed separately so neither
            // can be silently used as the other.
            planDigest: plan.planDigest,
            approvedSourceSha: plan.authorization.arms?.[arm]?.sha ?? null,
            // THE CAMPAIGN GRANT, not the per-unit call allowance. The worker
            // opens the SAME ledger file the driver already opened, and the
            // ledger refuses any process that declares a different allowance
            // (`BUDGET_STATE_MISMATCH`: "a process must never re-grant itself a
            // different allowance"). Passing the worker's own per-unit maximum
            // here made EVERY unit refuse with a budget error — measured — so the
            // value must be the one the authorization granted.
            campaignModelCalls: budgetTotal,
            executionStateDir: ledgerDir,
            ledgerDir,
            outDir: armWorker.outDir ?? join(ledgerDir, "units"),
            timeoutMs: armWorker.timeoutMs,
            allowRealProvider: armWorker.allowRealProvider === true,
            now: opts.now,
          });
        } catch (err) {
          // A worker that THROWS is a caller/contract defect (a bad identity, an
          // unknown suite). It is reported as a failure rather than swallowed,
          // and it never becomes a pass.
          record = {
            status: "failed",
            failureCategory: "harness",
            detail: `E4-R98: the arm worker threw for ${arm}/${caseId}: ${redactFailureText(err instanceof Error ? err.message : String(err))}`,
            consumed: 0,
            reservationId: "",
            resultHash: "",
          };
        }
        result.workerUnits += 1;
        result.workerConsumedCalls += Number(record.consumed ?? 0);
        result.logicalCalls += Number(record.consumed ?? 0);
        if (record.reservationId) result.reservations.push({ arm, caseId, id: record.reservationId });
        result.unitResults.push({
          arm,
          caseId,
          suite,
          status: record.status,
          failureCategory: record.failureCategory ?? null,
          verifierPassed: record.verifierPassed === true,
          resultHash: record.resultHash ?? "",
          build: record.build ?? null,
          detail: record.detail ?? null,
        });
        // THE VERDICT MAPPING, and it is the plan's own distinction rather than
        // a convenience: `COMPLETE 表示预定单位都有终态，passed/failed 表示验证
        // 结果`, and "不要让'模型 error'被当有效评分，也不要让合法的低分结果与基础
        // 设施失败混淆."
        //
        //   null        → the verifier PASSED: a terminal result.
        //   case_failed → the case RAN and failed its task: a VALID NEGATIVE, a
        //                 terminal result, and NOT a campaign failure.
        //   anything else (provider/timeout/harness/infrastructure/budget) →
        //                 the unit measured NOTHING, so it is a failure and the
        //                 campaign cannot be COMPLETE.
        if (record.failureCategory !== null && record.failureCategory !== "case_failed") {
          result.failures.push({ arm, caseId, error: record.detail ?? String(record.failureCategory) });
        }
        continue;
      }

      const reservation = await ledger.reserve(arm, 1);
      if (!reservation.ok) {
        stopped = { arm, caseId, reason: reservation.reason };
        break;
      }
      result.reservations.push({ arm, caseId, id: reservation.reservationId });
      // Persist `running` BEFORE the request is allowed to leave (plan §R98:
      // "先持久化 running/reservation，再允许请求发出").
      //
      // `begin` can REFUSE (finding N3): another attempt still owns this unit
      // (EXEC_BUSY), or a finished unit's inputs have drifted (EXEC_INPUT_DRIFT).
      // Both mean "do not dispatch", so the reservation is abandoned — nothing
      // left this process, so returning the allowance is correct — and the run
      // stops with a named code instead of an uncaught exception.
      let attemptId;
      try {
        attemptId = await execState.begin(unitKey, {
          reservationId: reservation.reservationId,
          inputDigest: inputDigestOf(plan, caseId),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ledger.abandon(reservation.reservationId, `begin refused: ${redactFailureText(message)}`);
        result.status = "REFUSED";
        result.code = /EXEC_BUSY/.test(message)
          ? "UNIT_ALREADY_RUNNING"
          : /EXEC_INPUT_DRIFT/.test(message)
            ? "UNIT_INPUT_DRIFT"
            : "UNIT_BEGIN_REFUSED";
        result.reason = `unit ${arm}/${caseId} could not be started: ${redactFailureText(message)}`;
        result.budget = await ledger.view();
        return result;
      }
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
        outcome = redactFailureText(err instanceof Error ? err.message : String(err));
      }
      await ledger.commit(reservation.reservationId, consumed, retries);
      result.logicalCalls += consumed;
      result.transportRetries += retries;
      if (outcome !== "ok") {
        result.failures.push({ arm, caseId, error: outcome });
        // A failed unit is TERMINAL too: it is recorded so a resume does not
        // silently re-bill a call that already produced a result (of failure).
        await execState.fail(attemptId, { resultHash: resultHashOf(arm, caseId, outcome), detail: outcome });
      } else {
        await execState.complete(attemptId, { resultHash: resultHashOf(arm, caseId, "ok") });
      }
      // A hard ceiling on the FAKE provider, so a test can prove the driver
      // cannot exceed what it was given.
      if (maxProviderCalls > 0 && providerState.requests > maxProviderCalls) {
        result.status = "REFUSED";
        result.code = "PROVIDER_CALL_CEILING_EXCEEDED";
        result.reason = `the fake provider was called ${providerState.requests} times, above the ${maxProviderCalls} ceiling`;
        result.providerRequests = providerState.requests;
        return result;
      }
    }
    if (stopped !== null) break;
  }

  // `providerRequests` is the number of requests the DRIVER'S OWN provider saw.
  // In arm-worker mode the driver constructs no provider, so this stays 0 and is
  // NOT a claim that no model call happened: the units' calls are counted
  // separately in `workerConsumedCalls`, and each arm's child CLI resolves its
  // own transport. Reporting 0 here while units ran would be a false negative
  // dressed as a safety property, so `executionMode` travels with it.
  result.providerRequests = providerState === null ? 0 : providerState.requests;
  result.executionMode = executionMode;
  result.budget = await ledger.view();
  // The campaign's durable history, read ONCE and used for every aggregate below.
  // Reading it repeatedly would let the numbers describe different snapshots.
  const history = await execState.records();
  // TERMINAL units: those that reached a verdict of their own. A unit an
  // operator reconciled for a RETRY is deliberately NOT counted here, because
  // `isDone` reports it as still pending (finding N3) — counting it as finished
  // would let a run claim more completed work than it actually has.
  result.completedUnits = history.filter(
    (r) => (r.status === "completed" || r.status === "failed") && r.reconciledForRetry !== true,
  ).length;
  // Units an operator re-opened: counted separately so "how much of this
  // campaign is settled?" is answerable without subtracting two other numbers.
  result.reopenedForRetryUnits = history.filter((r) => r.reconciledForRetry === true).length;
  // ---- AGGREGATION: history + this run, kept apart (plan §T3 怎么做 8). -----
  //
  // MEASURED DEFECT N4 (plan §0.2, §0.3): "driver 汇总只看本次新增结果" — the summary
  // was computed from `unitResults`, which holds ONLY the units THIS process
  // dispatched. A resume therefore reported its own empty list as the campaign's
  // state, and the probe caught exactly that:
  //
  //   "provider 失败后恢复 | 首次 PARTIAL / 2 failures；第二次 COMPLETE / 0 failures /
  //    0 measuredUnits / 0 新调用"
  //
  // A resume that dispatched nothing ERASED the first run's failures and reported
  // success. The fix is to read the DURABLE per-unit records — the campaign's own
  // history — and aggregate over history plus this run, while still exposing this
  // run's own numbers separately so "what did this run do?" stays answerable.
  // Only units that reached a verdict of their own count. A unit an operator
  // reconciled for a RETRY is deliberately excluded: `isDone` reports it as still
  // pending, and counting it as settled would claim more finished work than the
  // campaign has.
  const settled = history.filter(
    (r) => (r.status === "completed" || r.status === "failed") && r.reconciledForRetry !== true,
  );
  // This run's OWN numbers, named so they can never be mistaken for the totals.
  result.newCalls = result.logicalCalls;
  result.newUnits = result.unitResults.length;
  // The campaign totals, derived from durable state rather than from memory.
  result.cumulativeCalls = result.budget.committed;
  result.cumulativeUnits = settled.length;

  // ---- THE EVIDENCE CHAIN (plan §T3 怎么做 4/7, 怎么验收 5). ----------------
  //
  // "修改/删除任意已关联原始报告或 resultHash，恢复及独立 validator 都非零退出."
  //
  // The skip decision above rests on the DURABLE record, and a record is only
  // worth trusting if the report behind it is still there and still the report
  // that produced it. Without this pass, deleting the evidence changed nothing
  // observable: the resume would skip the unit and report COMPLETE over a
  // verdict nothing substantiates — which is exactly the state finding N5 left
  // the campaign in.
  //
  // The check runs ONLY in arm-worker mode, because that is the only mode that
  // produces evidence: the "provider" rehearsal path drives a fake provider and
  // has no arm report to link.
  if (executionMode === "arm-worker") {
    const verified = await evaluation.verifyCampaignEvidence(ledgerDir, settled);
    result.evidence = {
      ok: verified.ok,
      checked: verified.checked,
      failures: verified.failures,
    };
    if (!verified.ok) {
      result.status = "REFUSED";
      result.code = "EVIDENCE_CHAIN_BROKEN";
      result.reason = verified.detail;
      return result;
    }
  }

  // HISTORICAL FAILURES. A record's terminal detail already encodes the category
  // it was written with (`<workerVersion> <category>: <detail>`), so the category
  // is recoverable without a second store. Only a unit that measured NOTHING is a
  // failure: `completed` is a terminal result and `case_failed` is a VALID
  // negative, exactly as the live path distinguishes them.
  //
  // The failure list is rebuilt from history rather than appended to, so a resume
  // cannot double-count a failure that this run happened to re-observe.
  const historicalFailures = settled
    .filter((r) => r.status === "failed")
    .map((r) => ({
      arm: r.arm,
      caseId: r.caseId,
      error: r.detail ?? "a previous attempt failed without recording a detail",
      historical: true,
    }));
  // Failures observed by THIS run (already collected above), marked so a consumer
  // can tell a fresh failure from an inherited one.
  const newFailures = result.failures.map((f) => ({ ...f, historical: false }));
  result.newFailures = newFailures.length;
  result.historicalFailures = historicalFailures.length;
  // The union, keyed by unit so one unit contributes exactly one failure entry.
  const failureByUnit = new Map();
  for (const f of [...historicalFailures, ...newFailures]) {
    failureByUnit.set(`${f.arm}|${f.caseId}`, f);
  }
  result.failures = [...failureByUnit.values()];

  // HOW MANY UNITS THE VERIFIER ACTUALLY PASSED. Computed over HISTORY plus this
  // run, so a resume reports the campaign's pass count rather than zero.
  //
  // The category is recovered from the durable terminal `detail`, whose prefix
  // the worker writes as `<workerVersion> <category|passed>: <detail>` — see
  // `unitCategoryOf`. That prefix IS the contract between the two scripts, and
  // it is the only place a historical verdict survives: the report row is kept
  // as evidence but is not a category, and `resultHash` is deliberately not
  // invertible.
  result.verifiedPasses =
    settled.filter((r) => unitCategoryOf(r.detail) === "passed").length +
    result.unitResults.filter((u) => u.verifierPassed === true).length;
  // Units that reached a verifier verdict at all. `completed` is exactly that
  // status in BOTH execution modes: the worker maps a pass AND a valid negative
  // (`case_failed`) to `completed`, and maps provider/harness/infrastructure
  // failures to `failed`. So the status alone is the run-completeness figure, and
  // reading it from HISTORY is what keeps a resume from reporting zero.
  // Plan §R99 asks this to stay apart from the task pass rate.
  result.measuredUnits = settled.filter((r) => r.status === "completed").length;
  // The same figures restricted to THIS run, so the two are never conflated.
  result.newMeasuredUnits = result.unitResults.filter(
    (u) => u.failureCategory === null || u.failureCategory === "case_failed",
  ).length;

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
    // The unit count is the honest denominator in arm-worker mode: a unit that
    // was refused before dispatch consumed no logical call, so dividing by
    // `logicalCalls` alone would understate how much of the campaign was
    // attempted. The sentence names the units, and the calls are reported
    // separately.
    result.reason =
      executionMode === "arm-worker"
        ? `arm ${first.arm} case ${first.caseId} failed: ${first.error} (${result.failures.length} of ${result.workerUnits} unit(s) measured nothing; ${result.workerConsumedCalls} logical call(s) consumed)`
        : `arm ${first.arm} case ${first.caseId} failed: ${first.error} (${result.failures.length} failed logical call(s) of ${result.logicalCalls} dispatched)`;
    return result;
  }

  result.status = "COMPLETE";
  const caseCount = plan.authorization.caseIds.length;
  // COMPLETE means every scheduled unit reached a TERMINAL state — it does NOT
  // mean the cases passed. Plan §R99 怎么验收: "COMPLETE 表示预定单位都有终态，
  // passed/failed 表示验证结果." In arm-worker mode the two are reported apart,
  // and the verified pass count is stated so a reader cannot mistake completeness
  // for task success. (`verifiedPasses`/`measuredUnits` are computed above, on
  // every exit path, so this branch does not re-derive them.)
  if (executionMode === "arm-worker") {
    result.reason =
      `both arms covered ${caseCount} case(s) within a ${budgetTotal}-call campaign budget — ` +
      `${result.workerUnits} unit(s) reached a terminal state (${result.skippedUnits} already terminal and NOT re-executed), ` +
      `${result.workerConsumedCalls} logical call(s) consumed; ` +
      // Deliberately NOT phrased as a pass rate: a `case_failed` unit ran
      // correctly and failed its task, and the offline stub cannot pass at all.
      `verifier passes: ${result.verifiedPasses}/${result.workerUnits} (${result.measuredUnits} unit(s) reached a verifier verdict). ` +
      "COMPLETE describes RUN COMPLETENESS, not task success or mechanism improvement.";
    return result;
  }
  result.reason =
    result.skippedUnits > 0
      ? `both arms covered ${caseCount} case(s) within a ${budgetTotal}-call campaign budget — ${result.skippedUnits} unit(s) were already terminal and were NOT re-executed (${result.logicalCalls} new logical call(s))`
      : `both arms ran over ${caseCount} case(s) within a ${budgetTotal}-call campaign budget`;
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

/**
 * Fingerprint one case from the case files in a SPECIFIC arm checkout.
 *
 * Plan §R100 怎么做 (line 204) forbids the fallback that used to live here:
 * "删除 fingerprintCaseInCheckout 中静默 fallback。shallow clone 缺历史不等于缺当前
 * checkout 文件；缺文件或读失败要 NOT_READY，不能拿 driver 副本冒充."
 *
 * WHAT WAS WRONG: the previous version did
 *
 *     await loadBenchmarkCase(join(armDir, …)).catch(() => loadBenchmarkCase(join(repoRoot, …)))
 *
 * so a case MISSING from an arm was silently fingerprinted from the DRIVER's own
 * tree. The observation then claimed to describe the arm's build while actually
 * describing a different one — and because both arms would fall back to the same
 * tree, the two "independent" observations could agree by construction. That is
 * exactly the "one harness run twice" failure the whole round exists to remove,
 * and it also defeats the R100 acceptance criterion "缺 arm 文件不会回退".
 *
 * NOW: a case that cannot be read FROM THAT ARM is a named `NOT_READY` refusal.
 * The error quotes the arm directory and the case, so an operator can see which
 * checkout is incomplete rather than receiving a fingerprint that means nothing.
 *
 * EXPORTED so a test can drive this exact rule with a synthetic arm directory,
 * without needing a built CLI in it. The R100 acceptance criterion is about THIS
 * function's fallback ("缺 arm 文件不会回退"), and the previous fallback lived
 * only here — so testing it directly is testing the whole rule, at a fraction of
 * the cost of a full arm build.
 */
export async function fingerprintCaseInCheckout(evaluation, repoRoot, armDir, caseId) {
  const { join: pjoin } = await import("node:path");
  const { loadBenchmarkCase } = evaluation;
  const armCasePath = pjoin(armDir, "benchmarks", caseId);
  let c;
  try {
    c = await loadBenchmarkCase(armCasePath);
  } catch (err) {
    // NO fallback. `repoRoot` is deliberately not consulted: a fingerprint taken
    // from another tree is not an observation of this arm.
    throw new Error(
      `E4-R97: NOT_READY: case ${caseId} could not be loaded from arm checkout ${armDir} (${armCasePath}): ` +
        `${err instanceof Error ? err.message : String(err)} — a missing arm case is NOT_READY, never a fingerprint borrowed from ${repoRoot}`,
    );
  }
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
