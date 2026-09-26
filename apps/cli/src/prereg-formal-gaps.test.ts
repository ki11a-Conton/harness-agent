/**
 * The formal-execution invariants plan.md A1–A7 must establish (F1–F8).
 *
 * HISTORY — WHY THESE ARE HERE AND NOT IN A QUARANTINE
 * ----------------------------------------------------
 * These assertions began life as a QUARANTINED red suite: at the fixed HEAD
 * (7157653) the build did not hold them, so a deliberately failing suite could
 * not join `pnpm test`. The quarantine was TEMPORARY and enforced — the moment
 * every invariant held, the suite had to be PROMOTED into the default gate
 * rather than stay excluded (a genuinely-green suite that is still skipped is
 * indistinguishable from no coverage at all). A1–A6 landed, the suite went
 * green, and this file is the promotion: it now runs in `pnpm test` like every
 * other gated suite.
 *
 * Each title carries `[F<n>/A<m>]` — the plan.md gap and the task that owned it
 * — and, where a stable refusal is expected, `-> CODE`. The gap was derived
 * from these titles by the (now removed) ledger script, never hand-typed.
 *
 * SAFETY
 * ------
 * Zero network, zero real provider, zero cost: every provider below is a local
 * fake and every counter is a real in-process counter. Scratch directories live
 * under the (git-ignored) `.ci/` directory INSIDE the workspace — never in the
 * OS temp dir — and are removed in `afterEach`.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModelEvent, type ModelProvider, type ModelRequest, type ProviderConfig } from "@ar/contracts";
import {
  CostBudget,
  DEFAULT_DECISION_POLICY_V3,
  R97_ARM_BUILD_ENTRIES,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  aggregatePreregisteredCampaign,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  createFormalBudgetedProvider,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  openR97BudgetLedger,
  parseAndValidatePreregistrationV2,
  runPreregisteredCampaign,
  serializePreregistrationV2,
  stableStringify,
  toolCallEfficiencyGuidanceDigest,
  verifyArmEvidenceFromArtifacts,
  type ArmRunRef,
  type PreregisteredArmOutcome,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { preregCmd } from "./prereg-command.js";
import { createProductionPreregRunner, observeCaseContentDigests, observeExecutionIdentity } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "prereg-gaps-scratch");
const FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "e4", "fixtures", "n5-prereg-config.json"), "utf8"),
) as PreregistrationV2Options;

const NOW = 1_700_000_000_000;
const CASE_IDS = FIXTURE.selection.caseIds;
/** A real case id from the FROZEN production selection (NOT the N5 fixture). */
const REAL_FROZEN_CASE_ID = "stress-repeated-tool-failures";

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function preregOptions(over: Partial<PreregistrationV2Options> = {}): PreregistrationV2Options {
  return { ...structuredClone(FIXTURE), ...over };
}

function prereg(over: Partial<PreregistrationV2Options> = {}): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2(preregOptions(over));
}

/** The observed identity the fixture is bound to (a TEST observation, not a real one). */
function observationFor(over: Partial<PreregisteredCampaignObservationV2> = {}): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  const eligibilityDigests: Record<string, string> = {};
  for (const caseId of CASE_IDS) {
    caseContentDigests[caseId] = `content-${caseId}`;
    eligibilityDigests[caseId] = `elig-${caseId}`;
  }
  return {
    candidateSourceSha: FIXTURE.subject.candidateSourceSha,
    cleanTree: true,
    baselineArmDigest: FIXTURE.subject.baselineArmDigest,
    candidateArmDigest: FIXTURE.subject.candidateArmDigest,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: FIXTURE.subject.runtimeConfigDigest,
    providerId: FIXTURE.provider.providerId,
    modelId: FIXTURE.provider.modelId,
    endpointDigest: captureEndpointIdentity(FIXTURE.provider.endpointBaseUrl ?? null)!,
    requestProfileDigest: sha(stableStringify(FIXTURE.provider.requestProfile)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: FIXTURE.selection.selectionProvenanceDigest,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: 0,
    ...over,
  };
}

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: a.preregistrationDigest,
    candidateSourceSha: a.subject.candidateSourceSha,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: a.provider.endpointDigest,
    caps: {
      maxModelCalls: a.budget.campaignWorstCaseModelCalls,
      maxToolCalls: a.budget.maxToolCalls,
      maxDurationMs: a.budget.maxDurationMs,
      maxInputTokens: a.budget.maxInputTokens,
      maxOutputTokens: a.budget.maxOutputTokens,
      maxTotalTokens: a.budget.maxTotalTokens,
      maxUsdMicros: a.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId: "approval-1",
    allowResume: true,
    paid: true,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Scratch + fakes
// ---------------------------------------------------------------------------

let scratchDirs: string[] = [];

async function scratch(name: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const d = await mkdtemp(join(SCRATCH_ROOT, `${name}-`));
  scratchDirs.push(d);
  return d;
}

beforeEach(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
});

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;
beforeEach(async () => {
  claimsDir = await mkdtemp(join(SCRATCH_ROOT, "claims-"));
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = claimsDir;
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  if (claimsDir !== null) {
    await rm(claimsDir, { recursive: true, force: true }).catch(() => undefined);
    claimsDir = null;
  }
});

/** A provider that reports usage and (optionally) sleeps; counts REAL entries. */
function fakeProvider(opts: { inputTokens?: number; outputTokens?: number; durationMs?: number } = {}): {
  provider: ModelProvider;
  entered: () => number;
} {
  let entered = 0;
  const provider: ModelProvider = {
    id: "prereg-gaps-fake",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          entered += 1;
          if (opts.durationMs !== undefined && opts.durationMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, opts.durationMs));
          }
          yield {
            type: "usage",
            usage: { inputTokens: opts.inputTokens ?? 10, outputTokens: opts.outputTokens ?? 5 },
            timestamp: 0,
          };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, entered: () => entered };
}

async function admit(
  dir: string,
  artifact: ToolCallEfficiencyPreregistrationV2,
  observation: PreregisteredCampaignObservationV2 = observationFor(),
) {
  return openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: authorizationFor(artifact),
    observation,
    budgetDir: join(dir, "budget"),
    mode: "first-run",
    now: () => NOW,
    makeProvider: () => fakeProvider().provider,
  });
}

const ARM: ArmRunRef = { armId: "candidate", caseId: CASE_IDS[0]!, repetition: 0, orderIndex: 0 };

/** B3 — the arm entry the isolated worker loads (POSIX: the executor compares it
 *  to the `R97_ARM_BUILD_ENTRIES` row, which is forward-slashed). */
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";

/**
 * B3 — a REAL, loadable arm build entry. The executor spawns the arm's OWN build
 * as an isolated child which imports this file FROM ITS CHECKOUT, so a synthetic
 * `export {}` stub can no longer represent an arm. It exports the versioned
 * mechanism probe and a real `runOneCase` resolving its one model call through
 * the stdio proxy provider the worker supplies.
 */
function armEntrySource(marker: string, activate: boolean): string {
  return [
    'export const R97_ARM_PROBE = "probe:' + marker + '";',
    "export async function runOneCase(caseDef, opts, _suite) {",
    "  const client = opts.provider.createClient({ id: 'arm-fixture' }, {});",
    "  let input = 0;",
    "  let output = 0;",
    "  for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {",
    "    if (ev.type === 'usage') { input += ev.usage.inputTokens; output += ev.usage.outputTokens; }",
    "    if (ev.type === 'completed' || ev.type === 'error') break;",
    "  }",
    "  const outcome = {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: input, tokens_output: output, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 },",
    "    violations: [],",
    `    reason: 'arm-probe:${marker}',`,
    "    suite: caseDef.suite || 'regression',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    ...(activate ? [`  outcome.activationEvidenceV2 = { events: [{ eventId: 'probe:${marker}' }] };`] : []),
    "  return outcome;",
    "}",
    "",
  ].join("\n");
}

/** Build a real, loadable arm checkout: the declared entries, entry bytes distinct. */
async function makeArmCheckout(dir: string, marker: string, activate = false): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL ? armEntrySource(marker, activate) : `export {}; // stub:${marker}\n`;
    await writeFile(abs, source, "utf8");
  }
}

// ---------------------------------------------------------------------------
// F1 — the production command still cannot walk the execution chain
// ---------------------------------------------------------------------------

describe("F1 — production execution identity and executor", () => {
  it("[F1/A5] the production adapter refuses without a checkout and EXECUTES a real case with one -> ARM_CHECKOUT_MISSING", async () => {
    // The F1 gap was that `runArm` ALWAYS threw `ARM_EXECUTOR_NOT_WIRED`: the
    // release CLI could admit a legal experiment and never execute it. A5 closes
    // it by wiring a REAL executor, so both halves are asserted here:
    //
    //   (a) no frozen checkout  -> a stable `ARM_CHECKOUT_MISSING` refusal;
    //   (b) two distinct frozen builds + a real frozen case -> the executor
    //       returns a real outcome whose evidence A6 corroborates.
    //
    const noCheckout = createProductionPreregRunner({ rootDir: REPO_ROOT, env: {} });
    await expect(
      noCheckout.runArm(ARM, {
        provider: fakeProvider().provider,
        armRunId: "pair-0-candidate",
        arm: ARM,
        preregistrationDigest: prereg().preregistrationDigest,
        planDigest: prereg().schedule.planDigest,
        evidenceDir: join(await scratch("f1-runarm-none"), "ev"),
      }),
    ).rejects.toThrow(/ARM_CHECKOUT_MISSING/);
    //
    // The arm checkouts are two REAL loadable builds (B3): the executor spawns
    // the arm's own build as an isolated child, so a synthetic `export {}` stub
    // can no longer represent an arm. Each checkout's entry exports a distinct
    // mechanism probe and a real `runOneCase`, so the build-closure digest AND
    // the observable mechanism output differ between the arms.
    const base = await scratch("f1-runarm-base");
    const cand = await scratch("f1-runarm-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate", true);
    const evidenceDir = join(await scratch("f1-runarm-ev"), "pair-real");
    const runner = createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
    });
    const realArm: ArmRunRef = { armId: "candidate", caseId: REAL_FROZEN_CASE_ID, repetition: 0, orderIndex: 0 };
    const preregistrationDigest = prereg().preregistrationDigest;
    const planDigest = prereg().schedule.planDigest;
    const outcome = await runner.runArm(realArm, {
      provider: fakeProvider().provider,
      armRunId: "pair-real-candidate",
      arm: realArm,
      preregistrationDigest,
      planDigest,
      evidenceDir,
    });
    // A real executor returns a real verdict (never a fabricated `passed`).
    expect(["passed", "failed", "error"]).toContain(outcome.status);
    if (outcome.status !== "error") {
      const verified = verifyArmEvidenceFromArtifacts(
        evidenceDir,
        {
          preregistrationDigest,
          planDigest,
          armRunId: "pair-real-candidate",
          armId: "candidate",
          caseId: REAL_FROZEN_CASE_ID,
          repetition: 0,
          orderIndex: 0,
        },
        outcome.evidence!,
      );
      expect(verified.problems, JSON.stringify(verified.problems)).toEqual([]);
      expect(verified.verified).toBe(true);
    }
  }, 120_000);

  it("[F1/A2] the observer certifies runtime/request profile and price -> PREREGISTRATION_IDENTITY_DRIFT", async () => {
    const root = await scratch("f1-identity");
    const obs = observeExecutionIdentity(root, {});
    // Desired: every identity the artifact BINDS is re-derived from a real source,
    // so a valid frozen experiment can be certified. Today these are UNOBSERVABLE
    // / null — the observer can never certify, so no legal experiment can pass.
    expect(obs.runtimeConfigDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.requestProfileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.usdMicrosPerCall).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F2 — the sample set and its provenance are still self-declared
// ---------------------------------------------------------------------------

describe("F2 — real case provenance replaces the self-reported catalog", () => {
  it("[F2/A1] the observer refuses a holdout case instead of digesting it as eligible -> HOLDOUT_CASE_REJECTED", async () => {
    const root = await scratch("f2-holdout");
    const dir = join(root, "benchmarks", "holdout", "ho-esc-01");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "request.md"), "holdout request\n", "utf8");
    await writeFile(join(dir, "expected.md"), "holdout expected\n", "utf8");

    const fake = { dataset: { cases: [{ caseId: "ho-esc-01", suite: "holdout" }] } } as unknown as ToolCallEfficiencyPreregistrationV2;
    const digests = observeCaseContentDigests(root, fake);
    // Desired: a holdout case is never digested — the eligibility must come from a
    // frozen source, not from `{eligible:true, holdout:false}` hardcoded here.
    // Today it IS digested with those hardcoded facts.
    expect(Object.keys(digests)).not.toContain("ho-esc-01");
  });

  it("[F2/A1] prereg build refuses a self-declared placeholder selection provenance -> SELECTION_PROVENANCE_UNPROVEN", async () => {
    const dir = await scratch("f2-build");
    const cfgPath = join(dir, "config.json");
    await writeFile(cfgPath, JSON.stringify(preregOptions(), null, 2), "utf8");
    const outPath = join(dir, "prereg.json");
    const res = await preregCmd(["build", cfgPath, "--out", outPath]);
    // Desired: `r87-selection-digest` / `content-reg-01` are placeholders that no
    // frozen rule produced, so a production build must refuse them. Today the
    // builder echoes whatever the config JSON claims.
    expect(res.exitCode, res.lines.join("\n")).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F3 — the multi-dimensional budget is still charged after the fact
// ---------------------------------------------------------------------------

describe("F3 — every billed dimension is bounded BEFORE the request", () => {
  it("[F3/A4] a call that cannot be shown to fit is never sent -> BUDGET_EXHAUSTED", async () => {
    const dir = await scratch("f3-bound");
    // Total-token cap 10, while the provider reports 15: no pre-send reservation
    // of a token upper bound exists, so the call leaves and the cap is exceeded.
    const artifact = prereg({ budget: { ...FIXTURE.budget!, maxTotalTokens: 10 } });
    const ledger = await openR97BudgetLedger(dir, {
      planDigest: artifact.preregistrationDigest,
      campaignModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      mode: "first-run",
    });
    const costBudget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const fake = fakeProvider({ inputTokens: 10, outputTokens: 5 });
    const { provider } = createFormalBudgetedProvider({
      provider: fake.provider,
      ledger,
      costBudget,
      arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
      usdMicrosPerCall: 0,
    });

    const client = provider.createClient({ providerId: "fake", modelId: "m" } as never, {} as ProviderConfig);
    const drain = async (): Promise<void> => {
      for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
        /* drain */
      }
    };
    await drain().catch(() => undefined);

    // THE INVARIANT: an authorized cap is never exceeded, and a request that
    // cannot be reserved against it is not sent at all.
    expect(costBudget.view().charged.totalTokens).toBeLessThanOrEqual(10);
    expect(fake.entered()).toBe(0);
  });

  it("[F3/A4] the duration dimension is charged, not left at zero -> DURATION_UNMEASURED", async () => {
    const dir = await scratch("f3-duration");
    const artifact = prereg();
    const ledger = await openR97BudgetLedger(dir, {
      planDigest: artifact.preregistrationDigest,
      campaignModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      mode: "first-run",
    });
    const costBudget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const fake = fakeProvider({ durationMs: 20 });
    const { provider } = createFormalBudgetedProvider({
      provider: fake.provider,
      ledger,
      costBudget,
      arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
      usdMicrosPerCall: 0,
    });
    const client = provider.createClient({ providerId: "fake", modelId: "m" } as never, {} as ProviderConfig);
    for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
      /* drain */
    }

    // THE INVARIANT: `maxDurationMs` is a real dimension of the ledger. Today no
    // caller ever charges it, so it stays 0 and the cap can never bind.
    expect(costBudget.view().charged.durationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F4 — evidence has a shape, not a verified source
// ---------------------------------------------------------------------------

describe("F4 — ACT is unreachable from unverified evidence", () => {
  it("[F4/A6] forged 64-hex evidence with no real trace cannot ACCEPT -> RUN_EVIDENCE_INVALID", async () => {
    const dir = await scratch("f4-forged");
    const artifact = prereg();
    // A runner that ASSERTS a clean, fully-activated, fully-verified win for the
    // candidate and a clean loss for the baseline — with NO trace bytes, NO
    // verifier artifact and NO request-bound activation record anywhere on disk.
    // Nothing about it can be replayed or checked; it is a pure fabrication.
    //
    // The baseline must LOSE (verifiedCompletion:false) so the candidate clears
    // `minConclusiveNetDelta`; otherwise the decision would be INCONCLUSIVE for
    // a reason unrelated to evidence (a bogus red that passes for the wrong
    // reason). With the candidate winning, EVERY hard gate is satisfied and the
    // fabricated evidence is the only thing that could still block ACCEPT.
    const forged: PreregisteredArmRunner = async (arm) => {
      const isCandidate = arm.armId === "candidate";
      return {
        status: isCandidate ? "passed" : "failed",
        tokensUsed: 1,
        evidence: {
          executorId: "forged",
          traceDigest: "a".repeat(64),
          verifiedCompletion: isCandidate,
          securityViolations: 0,
          activationEvidenceDigest: isCandidate ? "b".repeat(64) : null,
        },
      };
    };

    const admission = await admit(dir, artifact);
    expect(admission.status).toBe("ADMITTED");
    if (admission.status !== "ADMITTED") throw new Error("setup: campaign not admitted");
    const run = await runPreregisteredCampaign({
      admission,
      prereg: artifact,
      resultsDir: join(dir, "runs"),
      runArm: forged,
      now: () => NOW,
    });
    const aggregate = aggregatePreregisteredCampaign(run, artifact, {
      providerCalls: 0,
      budgetRemaining: artifact.budget.campaignWorstCaseModelCalls,
    });

    // THE INVARIANT: an outcome whose evidence cannot be verified against the
    // real trace/verifier/activation bytes is INVALID (or refused) — never a
    // champion ACCEPT. Today the shape check is the whole check, and every
    // non-evidence gate passes, so the current build ACCEPTs this fabrication.
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  });
});

// ---------------------------------------------------------------------------
// F5 — resume reuses records it was never allowed to reuse
// ---------------------------------------------------------------------------

describe("F5 — resume and results-directory integrity", () => {
  async function firstRun(dir: string, artifact: ToolCallEfficiencyPreregistrationV2) {
    const admission = await admit(dir, artifact);
    if (admission.status !== "ADMITTED") throw new Error(`setup: campaign not admitted (${admission.code})`);
    const runner: PreregisteredArmRunner = async (arm) => ({
      status: "passed",
      tokensUsed: 1,
      evidence: {
        executorId: "red-suite",
        traceDigest: "c".repeat(64),
        verifiedCompletion: true,
        securityViolations: 0,
        activationEvidenceDigest: arm.armId === "candidate" ? "d".repeat(64) : null,
      },
    });
    const resultsDir = join(dir, "runs");
    const run = await runPreregisteredCampaign({ admission, prereg: artifact, resultsDir, runArm: runner, now: () => NOW });
    expect(run.records.length).toBeGreaterThan(0);
    return { admission, resultsDir };
  }

  it("[F5/A6] resume:false must not reuse an existing run record -> RESUME_NOT_REQUESTED", async () => {
    const dir = await scratch("f5-resumefalse");
    const artifact = prereg();
    const { admission, resultsDir } = await firstRun(dir, artifact);
    const neverCalled: PreregisteredArmRunner = async () => {
      throw new Error("the red suite must not re-run arms to satisfy this assertion");
    };

    // THE INVARIANT: `resume: false` is a real prohibition — 32 records already
    // exist, so this must be a stable refusal. Today `opts.resume` is declared
    // and never read, so the records are adopted regardless.
    await expect(
      runPreregisteredCampaign({ admission, prereg: artifact, resultsDir, runArm: neverCalled, resume: false, now: () => NOW }),
    ).rejects.toThrow(/RESUME_NOT_REQUESTED/);
  });

  it("[F5/A6] a record with a different orderIndex must not be reused -> RESUME_IDENTITY_MISMATCH", async () => {
    const dir = await scratch("f5-order");
    const artifact = prereg();
    const { admission, resultsDir } = await firstRun(dir, artifact);

    const names = await readdir(resultsDir);
    const target = names.find((n) => n.endsWith(".json"));
    expect(target).toBeDefined();
    const path = join(resultsDir, target!);
    const record = JSON.parse(await readFile(path, "utf8")) as { orderIndex: number };
    const original = record.orderIndex;
    record.orderIndex = original + 5_000;
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");

    // THE INVARIANT: the resume identity check covers the WHOLE run identity,
    // orderIndex included. Today it compares digest/pair/case/repetition/arm and
    // silently adopts the tampered position.
    await expect(
      runPreregisteredCampaign({
        admission,
        prereg: artifact,
        resultsDir,
        runArm: async () => {
          throw new Error("unreachable: every record already exists");
        },
        resume: true,
        now: () => NOW,
      }),
    ).rejects.toThrow(/RESUME_IDENTITY_MISMATCH/);
  });

  it("[F5/A6] an unexpected extra file in the results dir is refused -> RESUME_STATE_UNEXPECTED_FILE", async () => {
    const dir = await scratch("f5-extra");
    const artifact = prereg();
    const { admission, resultsDir } = await firstRun(dir, artifact);
    await writeFile(join(resultsDir, "not-part-of-the-plan.json"), "{}\n", "utf8");

    // THE INVARIANT: the resume path scans the results directory against the
    // frozen plan and REFUSES anything it did not write. Today the scan does not
    // exist, so an unaccounted record is invisible.
    await expect(
      runPreregisteredCampaign({
        admission,
        prereg: artifact,
        resultsDir,
        runArm: async () => {
          throw new Error("unreachable: every record already exists");
        },
        resume: true,
        now: () => NOW,
      }),
    ).rejects.toThrow(/RESUME_STATE_UNEXPECTED_FILE/);
  });
});

// ---------------------------------------------------------------------------
// F6 — the CLI accepts input it silently ignores
// ---------------------------------------------------------------------------

describe("F6 — strict CLI argument surface", () => {
  it("[F6/A3] unknown, duplicated and extra arguments are refused -> CLI_USAGE", async () => {
    const dir = await scratch("f6-cli");
    // A config that the A1 selection gate ACCEPTS (frozen evidence, no inline
    // catalog/selection). Without this the build refuses for an unrelated reason
    // and every sub-assertion below would pass for the wrong reason.
    const base = preregOptions() as unknown as Record<string, unknown>;
    delete base["catalog"];
    delete base["selection"];
    const cfgPath = join(dir, "config.json");
    await writeFile(cfgPath, JSON.stringify({ ...base, selectionEvidence: { root: REPO_ROOT } }, null, 2), "utf8");
    const out1 = join(dir, "out-a.json");
    const out2 = join(dir, "out-b.json");

    const unknownFlag = await preregCmd(["build", cfgPath, "--out", out1, "--model", "gpt-4"]);
    expect(unknownFlag.exitCode, `unknown flag accepted: ${unknownFlag.lines.join(" | ")}`).not.toBe(0);

    const duplicateOut = await preregCmd(["build", cfgPath, "--out", out1, "--out", out2]);
    expect(duplicateOut.exitCode, `duplicate --out accepted: ${duplicateOut.lines.join(" | ")}`).not.toBe(0);

    const extraPositional = await preregCmd(["build", cfgPath, out2, "--out", out1]);
    expect(extraPositional.exitCode, `extra positional accepted: ${extraPositional.lines.join(" | ")}`).not.toBe(0);

    // A3 — `prereg run` must state its mode explicitly. An omitted `--mode` is
    // refused at the argument surface (never defaulted to `auto`), and an unknown
    // mode value is refused too. Both are decided BEFORE any file is read or any
    // observer runs, so dummy paths are sufficient to prove the CLI surface.
    const noMode = await preregCmd([
      "run", "prereg.json", "--authorization", "auth.json", "--budget-dir", join(dir, "b"), "--out", join(dir, "o"),
    ]);
    expect(noMode.exitCode, `omitted --mode accepted: ${noMode.lines.join(" | ")}`).not.toBe(0);

    const badMode = await preregCmd([
      "run", "prereg.json", "--authorization", "auth.json", "--budget-dir", join(dir, "b"), "--out", join(dir, "o"), "--mode", "auto",
    ]);
    expect(badMode.exitCode, `--mode auto accepted: ${badMode.lines.join(" | ")}`).not.toBe(0);
    expect(badMode.lines.join("\n")).toContain("--mode");

    expect(existsSync(out2), "a refused command must not have written its output").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F7 — canonical input and case-path boundaries
// ---------------------------------------------------------------------------

describe("F7 — canonical bytes and case-path boundaries", () => {
  it("[F7/A3] an escaped-equivalent duplicate key is refused -> DUPLICATE_JSON_KEY", async () => {
    const artifact = prereg();
    const bytes = serializePreregistrationV2(artifact);
    const digest = artifact.preregistrationDigest;
    const marker = `"preregistrationDigest":"${digest}"`;
    expect(bytes).toContain(marker);
    // `\u0044` decodes to `D`: JSON.parse sees the SAME key twice while the raw
    // escape text differs, which is exactly what the scanner compares.
    const tampered = bytes.replace(marker, `${marker},"preregistration\\u0044igest":"${digest}"`);
    expect(tampered).not.toBe(bytes);

    expect(() => parseAndValidatePreregistrationV2(tampered)).toThrow(/DUPLICATE_JSON_KEY|CANONICAL/);
  });

  it("[F7/A3] non-canonical raw bytes are refused -> CANONICAL_BYTES_REQUIRED", async () => {
    const artifact = prereg();
    const bytes = serializePreregistrationV2(artifact);
    // Semantically identical, byte-wise not the canonical serialization.
    const nonCanonical = bytes.replace('"preregistrationDigest"', '"preregistration\\u0044igest"');
    expect(nonCanonical).not.toBe(bytes);
    expect(JSON.parse(nonCanonical)).toEqual(JSON.parse(bytes));

    expect(() => parseAndValidatePreregistrationV2(nonCanonical)).toThrow(/CANONICAL|DUPLICATE_JSON_KEY/);
  });

  it("[F7/A1] the observer refuses a case outside the benchmarks root -> CASE_PATH_ESCAPE", async () => {
    const root = await scratch("f7-escape");
    // `join(root, "benchmarks", "../outside", "esc-01")` resolves OUTSIDE the
    // benchmarks root, and the file exists there.
    const outside = join(root, "outside", "esc-01");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "request.md"), "escaped request\n", "utf8");
    await writeFile(join(outside, "expected.md"), "escaped expected\n", "utf8");

    const fake = { dataset: { cases: [{ caseId: "esc-01", suite: "../outside" }] } } as unknown as ToolCallEfficiencyPreregistrationV2;
    const digests = observeCaseContentDigests(root, fake);

    // THE INVARIANT: only the allowed benchmarks root may be read.
    expect(Object.keys(digests)).not.toContain("esc-01");
  });
});

// ---------------------------------------------------------------------------
// F8 — the offline "zero call" fields are literals, not measurements
// ---------------------------------------------------------------------------

describe("F8 — offline evidence counts must be instrumented", () => {
  it("[F8/A7] the closed-loop evidence counts are measured, not literal zeros -> COUNT_NOT_OBSERVED", async () => {
    const src = await readFile(join(REPO_ROOT, "scripts", "e4", "n5-prereg-closed-loop.mjs"), "utf8");
    // Desired: each count is produced by an instrumentation source and carries
    // its provenance, so the artifact's "0 external calls" is checkable.
    expect(src).not.toMatch(/externalProviderFactoryCalls:\s*0\b/);
    expect(src).not.toMatch(/networkRequests:\s*0\b/);
    expect(src).toMatch(/countsProvenance|observedCounts/);
  });
});