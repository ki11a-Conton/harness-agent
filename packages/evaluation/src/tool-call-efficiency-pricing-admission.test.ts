/**
 * N3 — paid-amount admission and rate source. plan(20260926-175819).md §N3.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * The plan requires, for EVERY unknown / null-cap / proxy / unknown-model /
 * expired / zero-or-invalid-price scenario: `provider factory = 0` and
 * `physical requests = 0`. Every case below is BEHAVIOURAL — it calls the
 * shipped `openPreregisteredCampaignGate` and asserts on the refusal CODE it
 * returns plus the fact that the provider factory was never entered. No test
 * asserts on source text, so a refactor that keeps the defect cannot satisfy it.
 *
 * The two admission classes (N3):
 *   PAID                — `paid:true`; must be money-bounded (`maxUsdMicros`
 *                         non-null) AND priced (a KNOWN per-call price).
 *   SYNTHETIC FIXTURE   — `fixtureMode` + `paid:false` (plan §N2: separately
 *                         identified, never a paid-admission config); bills
 *                         nothing, so it must instead PROVE its transport is
 *                         non-billable.
 *
 * R1/F1 UPDATE (plan(20260928-105425).md §R1): "prove its transport is
 * non-billable" no longer means "the address is loopback" or "the declared price
 * is 0". A loopback address can carry PAID relay traffic, so the fixture class now
 * requires a test-host-injected, endpoint- and model-bound non-billable transport
 * (`createNonBillableFixtureTransport`). N3.10 pins the refusal of the old
 * loopback proof; N3.10b pins that the injected capability still admits.
 *
 * SAFETY
 * ------
 * Zero network, zero real provider, zero cost. The only provider is a factory
 * that THROWS if entered, so a case that admits what it must refuse cannot pass
 * by accident. Scratch dirs live under the OS temp dir and no key is read.
 * `paidExperimentRun` / `championPromotion` are NOT_RUN regardless.
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
  buildToolCallEfficiencyPreregistrationV2,
  serializePreregistrationV2,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "./tool-call-efficiency-preregistration-v2.js";
import {
  FIXTURE_MODE_SYNTHETIC_OFFLINE,
  createNonBillableFixtureTransport,
  openPreregisteredCampaignGate,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";

const SHA_A = "a".repeat(40);
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };
const FIRST_PARTY_ENDPOINT = "https://api.example.com/v1";
const LOOPBACK_ENDPOINT = "http://127.0.0.1:43119/v1";

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
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl: FIRST_PARTY_ENDPOINT,
      requestProfile: REQUEST_PROFILE,
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
    ...over,
  };
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function observationFor(
  a: ToolCallEfficiencyPreregistrationV2,
  endpoint: string,
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
    endpointDigest: captureEndpointIdentity(endpoint)!,
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

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n3-admission-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "n3-claims-"));
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

/**
 * Drive the shipped gate once. Every provider factory entry is counted, and the
 * returned provider THROWS if its transport is ever entered, so `factoryCalls`
 * and `transportCalls` are both hard evidence: either can only be non-zero if
 * the gate admitted a scenario it was supposed to refuse.
 */
async function runGate(opts: {
  budgetOver?: Record<string, unknown>;
  obsOver?: Partial<PreregisteredCampaignObservationV2>;
  authOver?: Record<string, unknown>;
  endpoint?: string;
  fixture?: boolean;
}): Promise<RunResult> {
  const endpoint = opts.endpoint ?? FIRST_PARTY_ENDPOINT;
  const base = preregOptions();
  const artifact = buildToolCallEfficiencyPreregistrationV2({
    ...base,
    provider: { ...base.provider!, endpointBaseUrl: endpoint },
    budget: { ...base.budget!, ...(opts.budgetOver ?? {}) },
  });
  const auth = authorizationFor(artifact);
  const authJson: Record<string, unknown> = { ...auth, ...(opts.authOver ?? {}) };
  if (opts.fixture === true) {
    authJson["paid"] = false;
    authJson["fixtureMode"] = FIXTURE_MODE_SYNTHETIC_OFFLINE;
  }
  const budgetDir = await tempDir();
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
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: JSON.stringify(authJson),
    observation: observationFor(artifact, endpoint, opts.obsOver ?? {}),
    budgetDir,
    mode: "first-run",
    now: () => 1_700_000_000_000,
    makeProvider: factory,
  });

  return { status: result.status, code: (result as { code?: string }).code, factoryCalls, transportCalls };
}

/** N3's acceptance criterion for every refusal class: 0 factory, 0 physical. */
async function expectRefusedWithZeroRequests(p: Promise<RunResult>, code: string): Promise<void> {
  const r = await p;
  expect(r.status).toBe("REFUSED");
  expect(r.code).toBe(code);
  expect(r.factoryCalls).toBe(0);
  expect(r.transportCalls).toBe(0);
}

describe("N3 — a PAID admission must be money-bounded AND priced", () => {
  it("[N3.1] paid:true + maxUsdMicros=null is REFUSED (PAID_WITHOUT_USD_CAP) with 0 provider factory", async () => {
    await expectRefusedWithZeroRequests(
      runGate({ budgetOver: { maxUsdMicros: null }, obsOver: { usdMicrosPerCall: null } }),
      "PAID_WITHOUT_USD_CAP",
    );
  }, 60_000);

  it("[N3.2] a money-bounded paid campaign with an UNKNOWN price (unlisted model / proxy) is REFUSED (PRICING_UNKNOWN)", async () => {
    await expectRefusedWithZeroRequests(
      runGate({ obsOver: { usdMicrosPerCall: null } }),
      "PRICING_UNKNOWN",
    );
  }, 60_000);

  it("[N3.3] a NEGATIVE observed price is REFUSED (PRICING_UNKNOWN), never treated as free", async () => {
    await expectRefusedWithZeroRequests(
      runGate({ obsOver: { usdMicrosPerCall: -1 } }),
      "PRICING_UNKNOWN",
    );
  }, 60_000);

  it("[N3.4] a NON-INTEGER observed price is REFUSED (PRICING_UNKNOWN)", async () => {
    await expectRefusedWithZeroRequests(
      runGate({ obsOver: { usdMicrosPerCall: 1.5 } }),
      "PRICING_UNKNOWN",
    );
  }, 60_000);
});

describe("N3 — the SYNTHETIC FIXTURE class can never widen a paid approval", () => {
  it("[N3.6] fixtureMode together with paid:true is REFUSED at the parser (AUTHORIZATION_INVALID)", async () => {
    // NOTE: set BOTH keys explicitly — the `fixture` helper would overwrite `paid`,
    // and this case exists precisely to send the forbidden combination.
    const r = await runGate({ authOver: { paid: true, fixtureMode: FIXTURE_MODE_SYNTHETIC_OFFLINE } });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("AUTHORIZATION_INVALID");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
  }, 60_000);

  it("[N3.7] an unrecognized fixtureMode value is REFUSED (AUTHORIZATION_INVALID)", async () => {
    const r = await runGate({ authOver: { paid: false, fixtureMode: "totally-legit-v9" } });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("AUTHORIZATION_INVALID");
    expect(r.factoryCalls).toBe(0);
  }, 60_000);

  it("[N3.8] paid:false WITHOUT the fixture marker is still REFUSED (AUTHORIZATION_NOT_PAID)", async () => {
    const r = await runGate({ authOver: { paid: false } });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("AUTHORIZATION_NOT_PAID");
    expect(r.factoryCalls).toBe(0);
  }, 60_000);

  it("[N3.9] a fixture admission over a BILLABLE transport is REFUSED (FIXTURE_TRANSPORT_NOT_NON_BILLABLE)", async () => {
    await expectRefusedWithZeroRequests(
      runGate({ fixture: true, obsOver: { usdMicrosPerCall: 2_500_000, endpointIsLoopback: false } }),
      "FIXTURE_TRANSPORT_NOT_NON_BILLABLE",
    );
  }, 60_000);

  it("[N3.10] R1/F1: a LOOPBACK address is NOT proof of non-billable — refused with 0 factory / 0 transport", async () => {
    // R1/F1 (P0, plan(20260928-105425).md §R1). The baseline accepted
    // `endpointIsLoopback === true` as PROOF that the transport could not bill and
    // therefore skipped the paid branch's money cap. A loopback address proves
    // nothing about billing: a user's own local relay is a paid forwarding
    // loopback endpoint. The fixture class now requires a test-host-injected
    // non-billable transport, so this exact shape must be REFUSED.
    await expectRefusedWithZeroRequests(
      runGate({
        fixture: true,
        endpoint: LOOPBACK_ENDPOINT,
        budgetOver: { maxUsdMicros: null },
        obsOver: { usdMicrosPerCall: null, endpointIsLoopback: true },
      }),
      "FIXTURE_TRANSPORT_NOT_NON_BILLABLE",
    );
  }, 60_000);

  it("[N3.10b] R1/F1 POSITIVE CONTROL: an INJECTED non-billable transport is still ADMITTED", async () => {
    // Without this control the refusal above could be satisfied by a gate that
    // refuses everything. The fixture class is real — it is reachable ONLY through
    // the explicitly injected, endpoint-bound, provider-carrying capability, and
    // `makeProvider` (the operator's credential-bearing factory) is never entered.
    const endpoint = LOOPBACK_ENDPOINT;
    const base = preregOptions();
    const artifact = buildToolCallEfficiencyPreregistrationV2({
      ...base,
      provider: { ...base.provider!, endpointBaseUrl: endpoint },
      budget: { ...base.budget!, maxUsdMicros: null },
    });
    const authJson: Record<string, unknown> = authorizationFor(artifact) as unknown as Record<string, unknown>;
    authJson["paid"] = false;
    authJson["fixtureMode"] = FIXTURE_MODE_SYNTHETIC_OFFLINE;
    let transportCalls = 0;
    const grant = createNonBillableFixtureTransport({
      endpointBaseUrl: endpoint,
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      provider: {
        id: "n3-injected-nonbillable",
        async listModels() {
          return [];
        },
        createClient() {
          transportCalls += 1;
          return {
            // eslint-disable-next-line require-yield
            async *generate(): AsyncGenerator<ModelEvent> {
              throw new Error("the injected non-billable stub is never driven here");
            },
          };
        },
      },
    });
    const operatorFactory = vi.fn((): ModelProvider => {
      throw new Error("FORBIDDEN: a fixture admission must never enter the operator's factory");
    });
    const result = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(artifact),
      authorizationJson: JSON.stringify(authJson),
      observation: observationFor(artifact, endpoint, { usdMicrosPerCall: null, endpointIsLoopback: true }),
      budgetDir: await tempDir(),
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: operatorFactory,
      nonBillableTransport: grant,
    });
    expect(result.status, `code=${(result as { code?: string }).code}`).toBe("ADMITTED");
    expect(operatorFactory).not.toHaveBeenCalled();
    // Admission constructs the provider LATER; no transport may have been entered.
    expect(transportCalls).toBe(0);
  }, 60_000);

  it("[N3.11] the fixture class does NOT relax the money bound: a BOUNDED prereg with an unknown price is REFUSED", async () => {
    await expectRefusedWithZeroRequests(
      runGate({
        fixture: true,
        endpoint: LOOPBACK_ENDPOINT,
        obsOver: { usdMicrosPerCall: null, endpointIsLoopback: true },
      }),
      "PRICING_UNKNOWN",
    );
  }, 60_000);
});
