/**
 * N0 — RED behavior counterexamples for the NEXT round's gaps (N3/N4/N6),
 * evaluation side. plan(20260926-175819).md §N0.
 *
 * WHAT THIS FILE IS
 * -----------------
 * N0 does not fix production code. It turns the risks the plan lists into
 * OFFLINE, INDIVIDUALLY RUNNABLE counterexamples that FAIL on the audited HEAD
 * (`1299e5cb`) and become GREEN only when N3/N4/N6 actually close them. A gap
 * that cannot be made to fail is a gap whose severity is unknown.
 *
 * Every test here is BEHAVIOURAL: it calls the shipped function and asserts on
 * the value/exception it produces. No test asserts on source text, so a
 * refactor that keeps the defect cannot accidentally satisfy it.
 *
 * SAFETY
 * ------
 * Zero network, zero real provider, zero cost: the only provider is a local
 * factory function that must never be called, and every scratch directory lives
 * under the OS temp dir. No key is read. `paidExperimentRun` and
 * `championPromotion` stay NOT_RUN regardless of what these tests assert.
 *
 * THE COUNTEREXAMPLES
 * -------------------
 *   N3  a `paid:true` authorization whose caps carry `maxUsdMicros: null`,
 *       combined with an observation whose per-call price is UNKNOWN
 *       (`usdMicrosPerCall: null`), is still ADMITTED and constructs a provider.
 *       The money-bounded refusal only fires when `maxUsdMicros !== null`, so an
 *       unknown price can be admitted as if it were free.
 *   N4  `CostBudget.settle` validates token/USD actuals against the held
 *       pre-send reservation but NOT `toolCalls`; a settle can charge an
 *       arbitrarily larger tool-call count than was ever reserved.
 *   N6a a hand-written (fully forged) evidence directory whose digests are
 *       honestly recomputed over the forged bytes VERIFIES, because every check
 *       is either hash-of-bytes vs a caller-supplied digest or an artifact field
 *       vs the caller's own `declared` argument — there is no trusted anchor.
 *   N6b the aggregate's `tokensDelta` is summed from each arm's SELF-REPORTED
 *       `outcome.tokensUsed`, never from the durable cost journal, so a runner
 *       can report arbitrary token costs (or none) and change the cost gate.
 *   N6c a campaign in which a MAJORITY of arm runs are `error` is still scored
 *       as a clean ACCEPT: `rate()` deletes `error` records from its DENOMINATOR
 *       and `runtimeErrorSymmetry` only compares the two counts, so symmetric
 *       infrastructure collapse on BOTH arms reads as "no verified regression"
 *       and the surviving few records carry the decision. This is the false-green
 *       space the E2E `ok` predicate inherits (it filters
 *       `r.outcome.status !== "error"` before counting verified evidence).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRef, ModelRequest, ProviderConfig } from "@ar/contracts";
import { stableStringify } from "./manifest.js";
import { DEFAULT_DECISION_POLICY_V3, computeThresholdDigestV3 } from "./decision-policy-v3.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { toolCallEfficiencyGuidanceDigest } from "./mechanism-guidance.js";
import { captureEndpointIdentity } from "./provenance-v3.js";
import {
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  serializePreregistrationV2,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import {
  CostBudget,
  createDurableToolDispatchBudget,
  createFormalBudgetedProvider,
  openPreregisteredCampaignGate,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";
import { openR97BudgetLedger } from "./r97-budget-ledger.js";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  verifyArmEvidenceFromArtifacts,
  type PreregRunIdentity,
} from "./prereg-run-evidence.js";
import {
  aggregatePreregisteredCampaign,
  type PreregisteredRunRecord,
} from "./tool-call-efficiency-paired-campaign.js";
import { armRunIdOf, type OrderedArmRun } from "./paired-executor.js";

const SHA_A = "a".repeat(40);
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };
const ENDPOINT = "https://api.example.com/v1";

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function preregOptions(over: Partial<PreregistrationV2Options> = {}): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: { providerId: "deepseek", modelId: "deepseek-v4-flash", endpointBaseUrl: ENDPOINT, requestProfile: REQUEST_PROFILE },
    catalog: CATALOG,
    selection: { caseIds: [...CASE_IDS], selectionRule: "R87 frozen dev-set selection", selectionProvenanceDigest: "r87-selection-digest", holdoutPolicy: "holdout is never read" },
    suiteId: "tool-call-efficiency",
    suiteVersion: "1.0.0",
    evaluation: {
      judgeId: "judge-1",
      judgeDigest: "judge-digest",
      verifierDigest: "verifier-digest",
      scorerDigest: "scorer-digest",
      decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    },
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      maxUsdMicros: 5_000_000,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "process-exec",
      isolationStrength: "process",
      resumeStateSchema: "r97-execution-state-v1",
    },
    ...over,
  };
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function observationFor(a: ToolCallEfficiencyPreregistrationV2, over: Partial<PreregisteredCampaignObservationV2> = {}): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  const eligibilityDigests: Record<string, string> = {};
  for (const c of a.dataset.cases) {
    caseContentDigests[c.caseId] = c.contentDigest;
    eligibilityDigests[c.caseId] = c.eligibilityDigest;
  }
  return {
    candidateSourceSha: a.subject.candidateSourceSha,
    cleanTree: true,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: a.subject.runtimeConfigDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: captureEndpointIdentity(ENDPOINT)!,
    requestProfileDigest: sha(stableStringify(REQUEST_PROFILE)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: a.dataset.selectionProvenanceDigest,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: 0,
    endpointIsLoopback: false,
    ...over,
  };
}

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2): ToolCallEfficiencyAuthorizationV2 {
  return {
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
  };
}

/** A provider the gate must NEVER construct. It throws if entered, so a test
 *  that admits the artifact cannot pass by accident. */
function forbiddenProvider(): ModelProvider {
  return {
    id: "forbidden",
    async listModels() {
      return [];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        // eslint-disable-next-line require-yield
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
          throw new Error("FORBIDDEN: the gate constructed a provider for an experiment it must refuse");
        },
      };
    },
  };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n0-gaps-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "n0-claims-"));
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
});

// ---------------------------------------------------------------------------
// N3 — an unknown price must not be admitted as free
// ---------------------------------------------------------------------------

describe("N0 RED — N3: a money-UNBOUNDED paid authorization admits an UNKNOWN price", () => {
  it("[N3] maxUsdMicros=null + usdMicrosPerCall=null must be REFUSED before any provider factory call", async () => {
    const base = preregOptions();
    const artifact = buildToolCallEfficiencyPreregistrationV2({
      ...base,
      budget: { ...base.budget!, maxUsdMicros: null },
    });
    const auth = authorizationFor(artifact);
    const budgetDir = await tempDir();
    const factory = vi.fn(() => forbiddenProvider());

    const result = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(artifact),
      authorizationJson: JSON.stringify({ ...auth, caps: { ...auth.caps, maxUsdMicros: null } }),
      // The OBSERVED per-call price is UNKNOWN. The pre-registration is paid and
      // unbounded, so refusing is the only honest answer: treating an unknown
      // price as free is precisely what `pricingUnknownPolicy: "refuse"` forbids.
      observation: observationFor(artifact, { usdMicrosPerCall: null }),
      budgetDir,
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: factory,
    });

    // N3 requires: an unknown price is NOT admission-compatible with a paid run.
    expect(result.status).toBe("REFUSED");
    expect(factory).not.toHaveBeenCalled();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// N4 — the tool-call dimension must be consumed, not merely recorded
// ---------------------------------------------------------------------------

describe("N0 RED — N4: CostBudget.settle never validates the tool-call actual", () => {
  it("[N4] settling a toolCalls actual ABOVE the held reservation must be refused", async () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifact, { allowCreate: true });
    // Reserve ONE tool call, then settle pretending NINE were used. The held
    // pre-send upper bound is supposed to DOMINATE the real cost.
    const r = await budget.reserve({ inputTokens: 0, outputTokens: 0, toolCalls: 1, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await expect(budget.settle(r.id, { toolCalls: 9 })).rejects.toThrow(/tool/i);
    // And the ledger must not silently absorb the overrun.
    expect(budget.view().charged.toolCalls).toBe(0);
  }, 60_000);

  it("[N4] a completed call that CARRIES tool calls must consume the maxToolCalls dimension", async () => {
    // The production budgeted provider reserves `toolCalls: 0` for every attempt
    // and never passes `toolCalls` to settle, so the dimension is inert: a run
    // can exceed `maxToolCalls` with no refusal at all. The measured witness is
    // the durable ledger's `charged.toolCalls` after a real completed tool-call
    // event.
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const ledger = await openR97BudgetLedger(dir, {
      planDigest: artifact.preregistrationDigest,
      campaignModelCalls: artifact.budget.campaignWorstCaseModelCalls,
      mode: "first-run",
    });
    const costBudget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const provider: ModelProvider = {
      id: "tool-call-fake",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(): AsyncGenerator<ModelEvent> {
            yield {
              type: "completed",
              result: {
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "c1", name: "read_file", args: {} },
                  { id: "c2", name: "read_file", args: {} },
                ] as never,
              },
              timestamp: 0,
            };
          },
        };
      },
    };
    const { provider: wrapped, stats } = createFormalBudgetedProvider({
      provider,
      ledger,
      costBudget,
      arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
      usdMicrosPerCall: 0,
    });
    const client = wrapped.createClient({ providerId: "tool-call-fake", modelId: "m" } as never, {} as ProviderConfig);
    for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
      // drain
    }
    // R3/F4 — UPDATED SEMANTICS (plan(20260928-105425).md §R3, F4). This test used
    // to require the DECLARATION to consume the dimension; that after-the-fact
    // tally was the defect (it charged tools that were never dispatched, and it
    // could throw after the model ledger had already committed). The declaration is
    // now a DIAGNOSTIC, and the dimension is consumed by the REAL dispatch point:
    // the durable pre-dispatch budget. The gate's INTENT is preserved — the tool
    // dimension is really consumed — with the consumption attributed correctly.
    expect(stats.declaredToolCalls).toBe(2);
    expect(costBudget.view().charged.toolCalls).toBe(0);
    const dispatch = createDurableToolDispatchBudget({
      costBudget,
      deadlineAtMs: costBudget.deadlineAtMs(),
      now: () => Date.now(),
    });
    for (const id of ["c1", "c2"]) {
      const r = await dispatch.reserve({ toolCallId: id, tool: "read_file", sessionId: "s", readOnly: true, sideEffectScope: "none" });
      expect(r.ok).toBe(true);
      if (r.ok) await r.settle("dispatched");
    }
    expect(costBudget.view().charged.toolCalls).toBe(2);
  }, 60_000);

  it("[N4] charge() must reject a NEGATIVE actual instead of writing it into the ledger", async () => {
    // `charge()` is a public budget API and performs no validation and no cap
    // check: a negative token charge would silently credit the campaign.
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifact, { allowCreate: true });
    await expect(budget.charge({ inputTokens: -5 })).rejects.toThrow();
    expect(budget.view().charged.inputTokens).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// N6a — a forged evidence directory must not verify
// ---------------------------------------------------------------------------

describe("N0 RED — N6a: a hand-written (forged) evidence directory VERIFIES", () => {
  it("[N6a] forged artifacts with honestly recomputed digests must be verified=false", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    const identity: PreregRunIdentity = {
      preregistrationDigest: "p".repeat(64),
      planDigest: "l".repeat(64),
      armRunId: "pair-1-candidate",
      armId: "candidate",
      caseId: "reg-01",
      repetition: 0,
      orderIndex: 1,
    };
    const executorId = "prereg-arm-executor-v1";
    // The arm never ran: every byte below was typed by a hostile runner, and
    // every digest is recomputed over exactly those bytes, so no hash check can
    // be what rejects it.
    const manifest = `${stableStringify({
      schemaVersion: PREREG_RUN_MANIFEST_SCHEMA,
      executorId,
      preregistrationDigest: identity.preregistrationDigest,
      planDigest: identity.planDigest,
      armRunId: identity.armRunId,
      armId: identity.armId,
      caseId: identity.caseId,
      repetition: identity.repetition,
      orderIndex: identity.orderIndex,
    })}\n`;
    const verifier = `${stableStringify({
      schemaVersion: PREREG_RUN_VERIFIER_SCHEMA,
      verifiedCompletion: true,
      status: "passed",
      grade: null,
      violations: [],
    })}\n`;
    const security = `${stableStringify({ schemaVersion: PREREG_RUN_SECURITY_SCHEMA, violations: 0 })}\n`;
    const activation = `${stableStringify({ schemaVersion: "never-checked-by-the-validator", requestId: "never-happened" })}\n`;
    await writeFile(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), manifest, "utf8");
    await writeFile(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.verifier), verifier, "utf8");
    await writeFile(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.security), security, "utf8");
    await writeFile(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.activation), activation, "utf8");

    const v = verifyArmEvidenceFromArtifacts(dir, identity, {
      executorId,
      traceDigest: sha(manifest),
      verifiedCompletion: true,
      securityViolations: 0,
      activationEvidenceDigest: sha(activation),
    });

    // N6 requires every decision input to be bound to a TRUSTED source the
    // runner cannot author (a trusted execution manifest / the durable cost
    // journal / request-bound activation). Nothing here is trusted, so a
    // hand-typed directory must not corroborate a completed run.
    expect(v.verified).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// N6b — the token delta must come from the durable journal, not self-reports
// ---------------------------------------------------------------------------

describe("N0 RED — N6b: tokensDelta is summed from self-reported outcome.tokensUsed", () => {
  it("[N6b] a zero-token durable journal must pin tokensDelta to 0 despite huge self-reports", async () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const budgetDir = await tempDir();
    // The DURABLE cost journal for this campaign. It witnessed exactly ZERO
    // tokens: no provider was ever billed.
    const costBudget = await CostBudget.open(budgetDir, artifact, { allowCreate: true });
    expect(costBudget.view().charged.totalTokens).toBe(0);

    const orderedRuns: OrderedArmRun[] = [];
    const records: PreregisteredRunRecord[] = [];
    let orderIndex = 0;
    for (let rep = 0; rep < artifact.schedule.repetitions; rep += 1) {
      for (const caseId of CASE_IDS) {
        const pairId = `pair-${caseId}-${rep}`;
        for (const armId of ["baseline", "candidate"] as const) {
          orderedRuns.push({ orderIndex, pairId, armId, caseId, repetition: rep });
          records.push({
            schemaVersion: "tool-call-efficiency-paired-campaign-v1",
            preregistrationDigest: artifact.preregistrationDigest,
            planDigest: "plan-digest",
            armRunId: armRunIdOf(pairId, armId),
            pairId,
            armId,
            caseId,
            repetition: rep,
            orderIndex,
            outcome: {
              status: armId === "candidate" ? "passed" : "failed",
              // SELF-REPORTED and bound to NO ledger: a million tokens per
              // candidate run while the durable journal holds zero.
              tokensUsed: armId === "candidate" ? 1_000_000 : 1,
              evidence: {
                executorId: "forged",
                traceDigest: "a".repeat(64),
                verifiedCompletion: armId === "candidate",
                securityViolations: 0,
                activationEvidenceDigest: armId === "candidate" ? "b".repeat(64) : null,
              },
            },
            evidenceVerified: true,
            completedAt: 1_700_000_000_000,
          });
          orderIndex += 1;
        }
      }
    }

    const aggregate = aggregatePreregisteredCampaign(
      {
        schemaVersion: "tool-call-efficiency-paired-campaign-v1",
        preregistrationDigest: artifact.preregistrationDigest,
        planDigest: "plan-digest",
        orderedRuns,
        records,
        resumedArmRunIds: [],
        complete: true,
        pairComplete: true,
      },
      artifact,
      { providerCalls: 0, budgetRemaining: artifact.budget.campaignWorstCaseModelCalls },
    );

    // N6 requires the cost gate to be driven by the durable journal. With zero
    // journal tokens the honest delta is 0, not 15_999_984.
    expect(aggregate.decision.statistics.tokensDelta).toBe(0);
    expect(aggregate.decision.gates.costBounded).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// N6c — a campaign of ONLY infrastructure errors must not look artifact-clean
// ---------------------------------------------------------------------------

describe("N0 RED — N6c: `error` runs are silently excluded from verification", () => {
  it("[N6c] a campaign whose EVERY arm run is an infrastructure error must NOT pass artifactIntegrity", async () => {
    // This is the exact record set the REAL driver stamps for a campaign whose
    // harness died on every arm:
    //   - `outcome.status === "error"` with NO `evidence` object at all;
    //   - `evidenceVerified: true`, because the driver short-circuits
    //     (`outcome.status === "error" ? true : verifyArmEvidenceFromArtifacts(...)`)
    //     without reading a single artifact;
    //   - `armEvidenceProblems(undefined, "error")` returns `[]`, so the
    //     aggregate's shape check is vacuously satisfied.
    // The N6 requirement is that `ACCEPT`/`REJECT` inputs come from verifiable
    // bytes: a campaign with no verifiable evidence anywhere must not be able to
    // claim artifact integrity. This is also the false-green space the E2E `ok`
    // predicate inherits (`records.filter((r) => r.outcome.status !== "error")`).
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());

    const orderedRuns: OrderedArmRun[] = [];
    const records: PreregisteredRunRecord[] = [];
    let orderIndex = 0;
    for (let rep = 0; rep < artifact.schedule.repetitions; rep += 1) {
      for (const caseId of CASE_IDS) {
        const pairId = `pair-${caseId}-${rep}`;
        for (const armId of ["baseline", "candidate"] as const) {
          orderedRuns.push({ orderIndex, pairId, armId, caseId, repetition: rep });
          records.push({
            schemaVersion: "tool-call-efficiency-paired-campaign-v1",
            preregistrationDigest: artifact.preregistrationDigest,
            planDigest: "plan-digest",
            armRunId: armRunIdOf(pairId, armId),
            pairId,
            armId,
            caseId,
            repetition: rep,
            orderIndex,
            outcome: {
              status: "error",
              failureCategory: "infrastructure",
              reason: "the arm's harness died before producing a verifier verdict",
              // NO `evidence` object — nothing was ever verified.
            },
            // What the driver stamps for an `error` run: true, without reading
            // any artifact.
            evidenceVerified: true,
            completedAt: 1_700_000_000_000,
          });
          orderIndex += 1;
        }
      }
    }

    const aggregate = aggregatePreregisteredCampaign(
      {
        schemaVersion: "tool-call-efficiency-paired-campaign-v1",
        preregistrationDigest: artifact.preregistrationDigest,
        planDigest: "plan-digest",
        orderedRuns,
        records,
        resumedArmRunIds: [],
        complete: true,
        // Honest for an all-error campaign: no pair has two live arms.
        pairComplete: false,
      },
      artifact,
      { providerCalls: 0, budgetRemaining: artifact.budget.campaignWorstCaseModelCalls },
    );

    // With no verifiable bytes anywhere, artifact integrity cannot be claimed.
    expect(aggregate.decision.gates.artifactIntegrity).toBe(false);
    // Context: the verified rates are vacuous (0/0 → 0), so `rate()`'s exclusion
    // of `error` records is what keeps a fully-collapsed campaign looking calm.
    expect(aggregate.decision.statistics.verifiedRates.baseline).toBe(0);
    expect(aggregate.decision.statistics.verifiedRates.candidate).toBe(0);
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  }, 60_000);
});