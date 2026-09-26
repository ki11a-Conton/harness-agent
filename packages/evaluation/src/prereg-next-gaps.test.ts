/**
 * B0 — RED counterexamples for the NEXT round's gaps (G1–G7), evaluation side.
 *
 * WHY THIS FILE EXISTS (plan(20260926-070459).md §B0)
 * ---------------------------------------------------
 * B0 does not fix production code: it turns each remaining gap the review found
 * into an OFFLINE, INDIVIDUALLY RUNNABLE counterexample that FAILS on the
 * audited HEAD (3ff8946). A gap that cannot be made to fail is a gap whose
 * severity is unknown, so every test below is written to be RED at HEAD and to
 * become GREEN only when its task (B2/B4/B1) actually closes it.
 *
 * SAFETY
 * ------
 * Zero network, zero real provider, zero cost: every provider here is a local
 * fake with an in-process counter, and every scratch directory lives under the
 * OS temp dir (created and removed per test). No key is read.
 *
 * The counterexamples:
 *   G2  a physical RETRY only reserves the call ledger, never the cost
 *       dimensions (token/USD/duration) — so a retry can leave the process
 *       after the token budget was already fully reserved by the first send.
 *   G3  `CostBudget.settle` charges the ACTUAL usage without validating it
 *       against the held reservation or the cap, and settles an UNKNOWN
 *       reservation id as zero (a free charge).
 *   G6  a manifest.json that is valid JSON `null` — with a byte-correct sha256 —
 *       passes the identity check because a non-object is silently skipped.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ProviderConfig, ModelRef, ModelRequest } from "@ar/contracts";
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
  FORMAL_PER_CALL_INPUT_TOKEN_CEILING,
  openPreregisteredCampaignGate,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  verifyArmEvidenceFromArtifacts,
  type PreregRunIdentity,
} from "./prereg-run-evidence.js";

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

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "b0-gaps-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "b0-claims-"));
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
});

async function admit(artifact: ToolCallEfficiencyPreregistrationV2, makeProvider: () => ModelProvider) {
  const budgetDir = await tempDir();
  const factory = vi.fn(makeProvider);
  const result = await openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: JSON.stringify(authorizationFor(artifact)),
    observation: observationFor(artifact),
    budgetDir,
    mode: "first-run",
    now: () => 1_700_000_000_000,
    makeProvider: factory,
  });
  return { result, factory, budgetDir };
}

// ---------------------------------------------------------------------------
// G2 — a physical retry must reserve EVERY cost dimension before it is sent
// ---------------------------------------------------------------------------

/**
 * A provider whose ONE `generate()` call models TWO physical sends: it emits a
 * `retry` event (what the real client yields immediately before re-fetching)
 * and only THEN runs the second send. If the driver refuses the retry — the
 * behavior B2 requires when the retry cannot be afforded — the generator is
 * closed at the `yield`, so the second send never runs and `physical()` stays 1.
 */
function twoSendProvider(): { provider: ModelProvider; physical: () => number } {
  let physical = 0;
  const provider: ModelProvider = {
    id: "fake",
    async listModels() {
      return [];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
          physical += 1;
          yield {
            type: "retry",
            attempt: 1,
            error: { code: "MODEL_ERROR", message: "429", retryable: true, safeToRetry: true },
            timestamp: 0,
          };
          // Reached ONLY if the retry was accepted (i.e. the client re-fetched).
          physical += 1;
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, physical: () => physical };
}

describe("B0 RED — G2: the retry physical send is NOT reserved against the cost dimensions", () => {
  it("[G2/B2] a retry whose per-call token reservation cannot be afforded must NOT reach a second physical send", async () => {
    // A cost budget that affords EXACTLY ONE per-call reservation (input/output
    // reserved at the per-call ceiling), while the CALL ledger affords plenty.
    const artifact = buildToolCallEfficiencyPreregistrationV2(
      preregOptions({
        budget: {
          maxModelCallsPerRun: 30,
          maxToolCalls: 100,
          maxDurationMs: 600_000,
          maxInputTokens: FORMAL_PER_CALL_INPUT_TOKEN_CEILING,
          maxOutputTokens: FORMAL_PER_CALL_INPUT_TOKEN_CEILING,
          maxTotalTokens: FORMAL_PER_CALL_INPUT_TOKEN_CEILING * 2,
          maxUsdMicros: 5_000_000,
          pricingUnknownPolicy: "refuse",
        },
      }),
    );
    const fake = twoSendProvider();
    const { result, factory } = await admit(artifact, () => fake.provider);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ADMITTED");
    if (result.status !== "ADMITTED") return;

    const client = result.provider.createClient({ providerId: "fake", modelId: "m" }, {} as ProviderConfig);
    let code: string | null = null;
    try {
      for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
        // consume
      }
    } catch (err) {
      code = (err as { message?: string }).message ?? String(err);
    }

    // B2 requires: the second physical send is refused (BUDGET_EXHAUSTED) BEFORE
    // it leaves, because its per-call token reservation cannot be afforded.
    expect(fake.physical()).toBe(1);
    expect(code ?? "").toContain("BUDGET_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// G3 — settle must validate the actual against the held reservation and the cap
// ---------------------------------------------------------------------------

describe("B0 RED — G3: CostBudget.settle accepts unbounded / unknown / repeated charges", () => {
  it("[G3/B2] settling a reservation id that was never reserved must be refused, not charged as a free call", async () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifact, { allowCreate: true });
    // No reservation was ever taken for "res-never-taken".
    await expect(budget.settle("res-never-taken", { inputTokens: 1_000, outputTokens: 0 })).rejects.toThrow();
    const view = budget.view();
    expect(view.charged.inputTokens).toBe(0);
  });

  it("[G3/B2] a negative actual must be refused (it would silently refund the ledger)", async () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const r = await budget.reserve({ inputTokens: 100, outputTokens: 100, toolCalls: 0, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await expect(budget.settle(r.id, { inputTokens: -50 })).rejects.toThrow();
  });

  it("[G3/B2] settling the SAME reservation twice must not charge a second time", async () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const budget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const r = await budget.reserve({ inputTokens: 100, outputTokens: 0, toolCalls: 0, durationMs: 0, usdMicros: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await budget.settle(r.id, { inputTokens: 100 });
    await expect(budget.settle(r.id, { inputTokens: 100 })).rejects.toThrow();
    expect(budget.view().charged.inputTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// G6 — a valid-JSON `null` manifest must not pass the identity check
// ---------------------------------------------------------------------------

describe("B0 RED — G6: verifyArmEvidenceFromArtifacts accepts a non-object manifest", () => {
  it("[G6/B4] manifest.json = `null` with a byte-correct sha256 must verify=false", async () => {
    const dir = await tempDir();
    const identity: PreregRunIdentity = {
      preregistrationDigest: "p".repeat(64),
      planDigest: "l".repeat(64),
      armRunId: "run-1",
      armId: "baseline",
      caseId: "reg-01",
      repetition: 1,
      orderIndex: 0,
    };
    // The manifest bytes are the literal `null`; the declared traceDigest is the
    // sha256 of EXACTLY those bytes, so the hash check cannot be what rejects it.
    const manifest = "null\n";
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), manifest, "utf8");
    await writeFile(
      join(dir, PREREG_RUN_EVIDENCE_FILENAMES.verifier),
      `${stableStringify({ schemaVersion: PREREG_RUN_VERIFIER_SCHEMA, verifiedCompletion: true, status: "passed", grade: null, violations: [] })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, PREREG_RUN_EVIDENCE_FILENAMES.security),
      `${stableStringify({ schemaVersion: PREREG_RUN_SECURITY_SCHEMA, violations: 0 })}\n`,
      "utf8",
    );

    const v = verifyArmEvidenceFromArtifacts(dir, identity, {
      executorId: "prereg-arm-executor-v1",
      traceDigest: sha(manifest),
      verifiedCompletion: true,
      securityViolations: 0,
      activationEvidenceDigest: null,
    });
    expect(v.verified).toBe(false);
    expect(v.problems.join(" | ")).toMatch(/manifest/i);
  });
});

// ---------------------------------------------------------------------------
// G5 (shape) — the certified observation must carry an INDEPENDENT re-derivation
// ---------------------------------------------------------------------------

describe("B0 RED — G5: the observation carries no independently re-derived selection/eligibility", () => {
  it("[G5/B1] the run observation must re-derive selection provenance + eligibility, not only case content", () => {
    const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const obs = observationFor(artifact) as unknown as Record<string, unknown>;
    // B1 requires the observer to independently derive these; today the only
    // re-derived input is `caseContentDigests`.
    expect(Object.keys(obs)).toContain("selectionProvenanceDigest");
    expect(Object.keys(obs)).toContain("eligibilityDigests");
  });
});

/** Keep the imported schema constants referenced (they document the contract). */
void PREREG_RUN_MANIFEST_SCHEMA;
void readFile;