/**
 * R4-wiring (F5) — the pricing BASIS is bound into the pre-registration, the
 * authorization and the resume key, and a swapped basis is refused BEFORE any
 * provider factory call.
 *
 * WHAT THIS FILE PROVES (plan(20260928-105425).md §R4 #3)
 * -------------------------------------------------------
 * `budget.maxUsdMicros` is only the CAP. Two pricing bases with the SAME per-call
 * amount but a different source level / source / endpoint / currency / ceiling /
 * validity window are different execution identities, so comparing the amount
 * alone lets a swapped rate inherit an old approval. Each case below is
 * BEHAVIOURAL: it builds a real pre-registration, drives the shipped
 * `openPreregisteredCampaignGate`, and asserts on the refusal CODE plus the
 * counted factory/transport entries (a factory that THROWS if entered).
 *
 * OFFLINE: no network, no key, no real provider. Scratch dirs are under the OS
 * temp dir. The actual provider cost is NOT_OBSERVED — only a declared ceiling is
 * ever involved.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  assertFormalExecutionPreregistration,
  buildToolCallEfficiencyPreregistrationV2,
  serializePreregistrationV2,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import {
  observationViolationsV2,
  openPreregisteredCampaignGate,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";

const SHA_A = "a".repeat(40);
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };
const ENDPOINT = "https://api.example.com/v1";

/** Two DIFFERENT pricing bases with the SAME per-call amount — the exact shape
 *  `maxUsdMicros` alone cannot distinguish. */
const BASIS_A = sha("declared basis A: relay rate card, window 2026-09..2026-10");
const BASIS_B = sha("declared basis B: same amount, different source/window");
const AMOUNT = 1_000_000;

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function preregOptions(
  pricing: { pricingDigest?: string; usdMicrosPerCall?: number | null } = {},
): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl: ENDPOINT,
      requestProfile: REQUEST_PROFILE,
      ...pricing,
    },
    catalog: CATALOG,
    selection: {
      caseIds: [...CASE_IDS],
      selectionRule: "R87 frozen dev-set selection",
      selectionProvenanceDigest: "r87-selection-digest",
      holdoutPolicy: "holdout is never read",
    },
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
  };
}

function observationFor(
  a: ToolCallEfficiencyPreregistrationV2,
  over: Partial<PreregisteredCampaignObservationV2> = {},
): PreregisteredCampaignObservationV2 {
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
    usdMicrosPerCall: a.provider.usdMicrosPerCall ?? 0,
    endpointIsLoopback: false,
    // The observer always attaches the pricing digest of a PRICED basis.
    ...(a.provider.pricingDigest !== undefined ? { pricingDigest: a.provider.pricingDigest } : {}),
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
  const d = await mkdtemp(join(tmpdir(), "r4-wiring-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "r4-wiring-claims-"));
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

interface RunResult {
  status: string;
  code?: string;
  factoryCalls: number;
  transportCalls: number;
}

/** Drive the shipped gate once, counting every provider factory/transport entry. */
async function runGate(opts: {
  artifact: ToolCallEfficiencyPreregistrationV2;
  authorization?: string;
  observation?: PreregisteredCampaignObservationV2;
}): Promise<RunResult> {
  let factoryCalls = 0;
  let transportCalls = 0;
  const factory = vi.fn((): ModelProvider => {
    factoryCalls += 1;
    return {
      id: "forbidden",
      async listModels() {
        return [];
      },
      createClient(_m: ModelRef, _c: ProviderConfig) {
        transportCalls += 1;
        return {
          // eslint-disable-next-line require-yield
          async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
            throw new Error("FORBIDDEN: the gate constructed a provider for a campaign it must refuse");
          },
        };
      },
    };
  });
  const result = await openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(opts.artifact),
    authorizationJson: opts.authorization ?? JSON.stringify(authorizationFor(opts.artifact)),
    observation: opts.observation ?? observationFor(opts.artifact),
    budgetDir: await tempDir(),
    mode: "first-run",
    now: () => 1_700_000_000_000,
    makeProvider: factory,
  });
  return { status: result.status, code: (result as { code?: string }).code, factoryCalls, transportCalls };
}

function withBasis(basis: string, amount = AMOUNT): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2(
    preregOptions({ pricingDigest: basis, usdMicrosPerCall: amount }),
  );
}

describe("R4-wiring/F5 — the pricing BASIS is bound, not just its amount", () => {
  it("W1: the SAME amount with a DIFFERENT basis yields a different root preregistrationDigest", () => {
    const a = withBasis(BASIS_A);
    const b = withBasis(BASIS_B);
    // Same cap, same per-call amount — only the basis identity differs.
    expect(a.budget.maxUsdMicros).toBe(b.budget.maxUsdMicros);
    expect(a.provider.usdMicrosPerCall).toBe(b.provider.usdMicrosPerCall);
    // ...and that alone changes the identity an authorization/resume is keyed by.
    expect(a.preregistrationDigest).not.toBe(b.preregistrationDigest);
  });

  it("W2: a swapped pricing basis is REFUSED (PREREGISTRATION_IDENTITY_DRIFT) with 0 provider factory / 0 transport", async () => {
    const built = withBasis(BASIS_A);
    // The approved basis is A; the run now observes B (same amount).
    const swapped = observationFor(built, { pricingDigest: BASIS_B });
    const result = await runGate({ artifact: built, observation: swapped });
    expect(result.status).toBe("REFUSED");
    expect(result.code).toBe("PREREGISTRATION_IDENTITY_DRIFT");
    expect(result.factoryCalls).toBe(0);
    expect(result.transportCalls).toBe(0);
    // The refusal names the pricing basis.
    expect(observationViolationsV2(built, swapped).join("; ")).toMatch(/pricingDigest/i);
  });

  it("W2b: the refusal is specifically the BASIS — the amount is unchanged", async () => {
    const built = withBasis(BASIS_A);
    const swapped = observationFor(built, { pricingDigest: BASIS_B, usdMicrosPerCall: AMOUNT });
    const violations = observationViolationsV2(built, swapped);
    // Only the digest drifts: an amount-only comparison would have admitted this.
    expect(violations.every((v) => /pricingDigest/i.test(v))).toBe(true);
    expect(violations.some((v) => /usdMicrosPerCall/i.test(v))).toBe(false);
  });

  it("W3: a MISSING observed pricing digest against a BOUND artifact is refused (fail closed)", async () => {
    const built = withBasis(BASIS_A);
    const observation = observationFor(built);
    delete (observation as { pricingDigest?: string }).pricingDigest;
    const result = await runGate({ artifact: built, observation });
    expect(result.status).toBe("REFUSED");
    expect(result.code).toBe("PREREGISTRATION_IDENTITY_DRIFT");
    expect(result.factoryCalls).toBe(0);
  });

  it("W4: an authorization bound to the OLD basis does not admit the NEW basis", async () => {
    const oldArtifact = withBasis(BASIS_A);
    const newArtifact = withBasis(BASIS_B);
    // The operator's approval was issued for basis A; the plan now binds B.
    const result = await runGate({
      artifact: newArtifact,
      authorization: JSON.stringify(authorizationFor(oldArtifact)),
    });
    expect(result.status).toBe("REFUSED");
    expect(result.code).toMatch(/AUTHORIZATION/);
    expect(result.factoryCalls).toBe(0);
    expect(result.transportCalls).toBe(0);
  });

  it("W5 (control): the SAME basis is not pricing drift and is not refused for identity drift", async () => {
    const built = withBasis(BASIS_A);
    expect(observationViolationsV2(built, observationFor(built))).toEqual([]);
    const result = await runGate({ artifact: built });
    expect(result.code).not.toBe("PREREGISTRATION_IDENTITY_DRIFT");
  });

  it("W6 (compat control): a legacy artifact/observation pair (neither binds a basis) is not spurious drift", () => {
    const legacy = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    expect(legacy.provider.pricingDigest).toBeUndefined();
    expect(observationViolationsV2(legacy, observationFor(legacy))).toEqual([]);
  });

  it("W7: the strict loader preserves a bound basis and refuses a tampered digest", () => {
    const json = serializePreregistrationV2(withBasis(BASIS_A));
    const reloaded = assertFormalExecutionPreregistration(json);
    expect(reloaded.provider.pricingDigest).toBe(BASIS_A);
    expect(reloaded.provider.usdMicrosPerCall).toBe(AMOUNT);
    // An unknown field is still refused (the schema allowlist was widened, not loosened).
    const tampered = JSON.parse(json) as { provider: Record<string, unknown> };
    tampered.provider["pricingDigest"] = "not-a-sha256";
    expect(() => assertFormalExecutionPreregistration(JSON.stringify(tampered))).toThrow(/pricingDigest/);
    const extra = JSON.parse(json) as { provider: Record<string, unknown> };
    extra.provider["pricingBasisSwapped"] = BASIS_B;
    expect(() => assertFormalExecutionPreregistration(JSON.stringify(extra))).toThrow(/UNKNOWN_FIELD/);
  });
});
