/**
 * R1/F1 — the POSITIVE half: an EXPLICITLY INJECTED non-billable transport is
 * what admits the synthetic-fixture class, and the capability cannot be re-pointed
 * at another endpoint, another model, or a look-alike object.
 * plan(20260928-105425).md §R1 (F1).
 *
 * WHAT IS ASSERTED HERE (green-only: it uses the R1 capability)
 * ------------------------------------------------------------
 *   P1  fixtureMode + an injected non-billable transport bound to the OBSERVED
 *       endpoint/model is ADMITTED, the gate uses the capability's OWN provider
 *       (the operator's `makeProvider` is NEVER entered), and 0 requests leave.
 *   P2  a plain look-alike object (what env/JSON could carry) is REFUSED.
 *   P3  a capability issued for ANOTHER endpoint is REFUSED (cannot be re-pointed).
 *   P4  a capability issued for ANOTHER model/provider is REFUSED.
 *   P5  the operator's real-credential-shaped provider factory is never even
 *       constructed by a fixture admission: the factory call count stays 0.
 *
 * SAFETY: the only sockets are the two 127.0.0.1 counters; no key is real, and the
 * paid class is never billed (the provider is a fake and is not driven here).
 */

import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
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

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function preregOptions(endpointBaseUrl: string, over: Partial<PreregistrationV2Options> = {}): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: { providerId: "deepseek", modelId: "deepseek-v4-flash", endpointBaseUrl, requestProfile: REQUEST_PROFILE },
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
      maxUsdMicros: null,
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
    usdMicrosPerCall: null,
    endpointIsLoopback: true,
    ...over,
  };
}

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: ToolCallEfficiencyAuthorizationV2 = {
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
    approvalId: "r1-grant-approval",
    allowResume: true,
    paid: false,
    fixtureMode: FIXTURE_MODE_SYNTHETIC_OFFLINE,
  };
  return { ...base, ...over } as unknown as Record<string, unknown>;
}

const dirs: string[] = [];
const relays: Array<{ close: () => Promise<void> }> = [];

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r1-grant-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "r1-grant-claims-"));
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  await Promise.all(relays.splice(0).map((r) => r.close()));
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** Two loopback counters: a relay that forwards to a pretend billed upstream. */
async function countingEndpoints(): Promise<{ relayUrl: string; relayHits: () => number; upstreamHits: () => number }> {
  let upstreamHits = 0;
  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upAddr = upstream.address();
  if (upAddr === null || typeof upAddr === "string") throw new Error("no loopback port");
  const upstreamUrl = `http://127.0.0.1:${upAddr.port}`;

  let relayHits = 0;
  const relay = createServer((req, res) => {
    relayHits += 1;
    const proxied = httpRequest(`${upstreamUrl}${req.url ?? "/"}`, { method: req.method }, (up) => {
      res.writeHead(up.statusCode ?? 502, { "content-type": "text/plain" });
      up.pipe(res);
    });
    proxied.on("error", () => {
      res.writeHead(502);
      res.end("upstream unreachable");
    });
    req.pipe(proxied);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
  const relayAddr = relay.address();
  if (relayAddr === null || typeof relayAddr === "string") throw new Error("no loopback port");
  relays.push({
    close: async () => {
      await Promise.all([relay, upstream].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  });
  return { relayUrl: `http://127.0.0.1:${relayAddr.port}/v1`, relayHits: () => relayHits, upstreamHits: () => upstreamHits };
}

/** A provider whose transport WOULD talk to the relay — used for the capability. */
function stubProvider(id: string): ModelProvider {
  return {
    id,
    async listModels() {
      return [];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        // eslint-disable-next-line require-yield
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
          throw new Error("the non-billable stub is never driven by this file");
        },
      };
    },
  };
}

interface GateResult {
  status: string;
  code?: string;
  factoryCalls: number;
}

async function runGate(opts: {
  endpoint: string;
  observationOver?: Partial<PreregisteredCampaignObservationV2>;
  nonBillableTransport?: unknown;
  makeProvider?: () => ModelProvider;
}): Promise<{ result: GateResult; operatorFactoryCalls: () => number; relayHits: () => number; upstreamHits: () => number }> {
  const base = preregOptions(opts.endpoint);
  const artifact = buildToolCallEfficiencyPreregistrationV2(base);
  const counters = await countingEndpoints();
  const operatorFactory = vi.fn((): ModelProvider => {
    throw new Error("FORBIDDEN: the operator's credential-bearing factory was entered by a fixture admission");
  });
  let operatorFactoryCalls = 0;
  const wrappedFactory = () => {
    operatorFactoryCalls += 1;
    return (opts.makeProvider ?? operatorFactory)();
  };
  const result = await openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: JSON.stringify(authorizationFor(artifact)),
    observation: observationFor(artifact, opts.endpoint, opts.observationOver ?? {}),
    budgetDir: await tempDir(),
    mode: "first-run",
    now: () => 1_700_000_000_000,
    makeProvider: wrappedFactory,
    ...(opts.nonBillableTransport === undefined ? {} : { nonBillableTransport: opts.nonBillableTransport }),
  });
  return {
    result: { status: result.status, code: (result as { code?: string }).code, factoryCalls: result.providerFactoryCalls },
    operatorFactoryCalls: () => operatorFactoryCalls,
    relayHits: counters.relayHits,
    upstreamHits: counters.upstreamHits,
  };
}

describe("R1/F1 — only an injected, endpoint-bound non-billable transport admits the fixture class", () => {
  it("[P1] an injected non-billable transport is ADMITTED, uses its OWN provider, and sends nothing", async () => {
    const counters = await countingEndpoints();
    const base = preregOptions(counters.relayUrl);
    const artifact = buildToolCallEfficiencyPreregistrationV2(base);
    const grant = createNonBillableFixtureTransport({
      endpointBaseUrl: counters.relayUrl,
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      provider: stubProvider("r1-injected-nonbillable"),
    });
    const operatorFactory = vi.fn((): ModelProvider => {
      throw new Error("FORBIDDEN: the operator's factory must never be entered on the fixture path");
    });
    const result = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(artifact),
      authorizationJson: JSON.stringify(authorizationFor(artifact)),
      observation: observationFor(artifact, counters.relayUrl),
      budgetDir: await tempDir(),
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: operatorFactory,
      nonBillableTransport: grant,
    });
    expect(result.status, `code=${(result as { code?: string }).code}`).toBe("ADMITTED");
    // The injected provider is the one the gate wrapped — the operator's factory
    // (which would carry real credentials) was never called.
    expect(operatorFactory).not.toHaveBeenCalled();
    if (result.status === "ADMITTED") expect(result.provider.id).toBe("r1-injected-nonbillable");
    expect(counters.relayHits()).toBe(0);
    expect(counters.upstreamHits()).toBe(0);
  }, 60_000);

  it("[P2] a plain look-alike object (what env/JSON could carry) is REFUSED", async () => {
    const counters = await countingEndpoints();
    const r = await runGate({
      endpoint: counters.relayUrl,
      nonBillableTransport: {
        endpointBaseUrl: counters.relayUrl,
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        provider: stubProvider("forged"),
      },
    });
    expect(r.result.status).toBe("REFUSED");
    expect(r.result.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.result.factoryCalls).toBe(0);
    expect(r.operatorFactoryCalls()).toBe(0);
    expect(r.relayHits()).toBe(0);
    expect(r.upstreamHits()).toBe(0);
  }, 60_000);

  it("[P3] a capability issued for ANOTHER endpoint is REFUSED (it cannot be re-pointed)", async () => {
    const counters = await countingEndpoints();
    const base = preregOptions(counters.relayUrl);
    const artifact = buildToolCallEfficiencyPreregistrationV2(base);
    const grant = createNonBillableFixtureTransport({
      // Issued for a DIFFERENT (documentation-range) endpoint than the observation.
      endpointBaseUrl: "http://198.51.100.9:8317/v1",
      providerId: artifact.provider.providerId,
      modelId: artifact.provider.modelId,
      provider: stubProvider("r1-mispointed"),
    });
    const r = await runGate({ endpoint: counters.relayUrl, nonBillableTransport: grant });
    expect(r.result.status).toBe("REFUSED");
    expect(r.result.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.result.factoryCalls).toBe(0);
    expect(r.operatorFactoryCalls()).toBe(0);
    expect(r.relayHits()).toBe(0);
    expect(r.upstreamHits()).toBe(0);
  }, 60_000);

  it("[P4] a capability issued for ANOTHER model/provider is REFUSED", async () => {
    const counters = await countingEndpoints();
    const base = preregOptions(counters.relayUrl);
    const artifact = buildToolCallEfficiencyPreregistrationV2(base);
    const grant = createNonBillableFixtureTransport({
      endpointBaseUrl: counters.relayUrl,
      providerId: "some-other-provider",
      modelId: "some-other-model",
      provider: stubProvider("r1-other-model"),
    });
    const r = await runGate({ endpoint: counters.relayUrl, nonBillableTransport: grant });
    expect(r.result.status).toBe("REFUSED");
    expect(r.result.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.result.factoryCalls).toBe(0);
    expect(r.operatorFactoryCalls()).toBe(0);
    expect(r.relayHits()).toBe(0);
    expect(r.upstreamHits()).toBe(0);
  }, 60_000);
});
