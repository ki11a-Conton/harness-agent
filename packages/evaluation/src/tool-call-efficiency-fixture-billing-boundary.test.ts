/**
 * R1 / F1 — a LOOPBACK ADDRESS IS NOT PROOF OF NON-BILLABLE (P0 security boundary).
 * plan(20260928-105425).md §R1 (F1); AGENTS.md Runtime Freeze P38.4-11 clause 2
 * (security vulnerability) is the sanctioned justification for the code change.
 *
 * THE DEFECT THIS FILE PINS (baseline a85db6dc, formal-run.ts:1187-1207)
 * ---------------------------------------------------------------------
 * The synthetic-fixture admission accepted `endpointIsLoopback === true` as proof
 * that its transport cannot bill, and therefore SKIPPED the paid branch's money
 * cap. A loopback address proves nothing about billing: the user's own local relay
 * (127.0.0.1:8317) is exactly a paid, forwarding, loopback endpoint. Any operator
 * could point `OPENAI_BASE_URL` at a loopback relay, declare `paid:false +
 * fixtureMode`, and turn the fixture class into a free, uncapped, unbounded path
 * to a real billed upstream.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * Two LOCAL counting HTTP servers simulate "loopback relay -> pretend billed
 * upstream" (no real model, no external endpoint, no credential):
 *
 *   relay   = 127.0.0.1:<random>  (forwards every request to `upstream`)
 *   upstream= 127.0.0.1:<random>  (the "pretend billed" side)
 *
 * For EVERY fixture-class scenario below (loopback address only, external
 * endpoint, local forwarding relay with a real-credential-SHAPED identity,
 * sentinel key + fixtureMode) the gate must REFUSE and BOTH counters must be 0.
 * The paired control proves the two counters are LIVE (a direct control request
 * makes both of them 1), so the zeros are measured, not vacuous.
 *
 * SAFETY: the only sockets are the two 127.0.0.1 counter servers this file
 * creates. No key is real (`TEST_ONLY-…` sentinel), no external host is ever
 * contacted, and `paid:true` here is a FAKE provider — nothing is billed.
 */

import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  openPreregisteredCampaignGate,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";

/** TEST-NET-2 (RFC 5737) — a documentation address that can never be reached. */
const EXTERNAL_ENDPOINT = "http://198.51.100.7:8317/v1";
const SENTINEL_KEY = "TEST_ONLY-not-a-real-credential";

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
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl,
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
    endpointIsLoopback: false,
    ...over,
  };
}

function authorizationFor(
  a: ToolCallEfficiencyPreregistrationV2,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
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
    approvalId: "r1-approval",
    allowResume: true,
    paid: true,
  };
  return { ...base, ...over } as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The two local counters: a loopback relay that FORWARDS to a pretend upstream
// ---------------------------------------------------------------------------

interface CountingRelay {
  relayUrl: string;
  upstreamUrl: string;
  relayHits: () => number;
  upstreamHits: () => number;
  reset: () => void;
  close: () => Promise<void>;
}

const openSockets = new Set<Server>();

async function listen(server: Server): Promise<number> {
  openSockets.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  return address.port;
}

async function startCountingRelay(): Promise<CountingRelay> {
  let upstreamHits = 0;
  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  let relayHits = 0;
  const relay = createServer((req, res) => {
    relayHits += 1;
    // A real forwarder: the "paid relay" shape this defect turns into free money.
    const proxied = httpRequest(
      `${upstreamUrl}${req.url ?? "/"}`,
      { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "text/plain" });
        up.pipe(res);
      },
    );
    proxied.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream unreachable");
    });
    req.pipe(proxied);
  });
  const relayPort = await listen(relay);
  return {
    relayUrl: `http://127.0.0.1:${relayPort}/v1`,
    upstreamUrl,
    relayHits: () => relayHits,
    upstreamHits: () => upstreamHits,
    reset: () => {
      relayHits = 0;
      upstreamHits = 0;
    },
    close: async () => {
      await Promise.all(
        [relay, upstream].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
      openSockets.delete(relay);
      openSockets.delete(upstream);
    },
  };
}

/**
 * A NETWORK-SHAPED fake provider: its transport really talks to `endpointBaseUrl`
 * (a loopback relay). Nothing is billed and nothing external is reachable; it
 * exists so that "a request left" would be OBSERVED at the counters rather than
 * inferred.
 */
function relayProvider(endpointBaseUrl: string): { provider: ModelProvider; transportCalls: () => number } {
  let transportCalls = 0;
  const provider: ModelProvider = {
    id: "r1-relay-fake",
    async listModels() {
      return [];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
          transportCalls += 1;
          const res = await fetch(`${endpointBaseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fake", messages: [] }),
          });
          await res.text();
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, transportCalls: () => transportCalls };
}

const dirs: string[] = [];
const relays: CountingRelay[] = [];

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "r1-billing-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "r1-claims-"));
});
afterEach(async () => {
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  await Promise.all(relays.splice(0).map((r) => r.close()));
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

interface GateResult {
  status: string;
  code?: string;
  factoryCalls: number;
  transportCalls: number;
}

async function runGate(opts: {
  endpoint: string;
  observation: Partial<PreregisteredCampaignObservationV2>;
  auth: Record<string, unknown>;
  budgetOver?: Record<string, unknown>;
}): Promise<GateResult> {
  const base = preregOptions(opts.endpoint);
  const artifact = buildToolCallEfficiencyPreregistrationV2({
    ...base,
    budget: { ...base.budget!, ...(opts.budgetOver ?? {}) },
  });
  const relay = relayProvider(opts.endpoint);
  const result = await openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: JSON.stringify(authorizationFor(artifact, opts.auth)),
    observation: observationFor(artifact, opts.endpoint, opts.observation),
    budgetDir: await tempDir(),
    mode: "first-run",
    now: () => 1_700_000_000_000,
    makeProvider: () => relay.provider,
  });
  return {
    status: result.status,
    code: (result as { code?: string }).code,
    factoryCalls: result.providerFactoryCalls,
    transportCalls: relay.transportCalls(),
  };
}

function fixtureAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { paid: false, fixtureMode: FIXTURE_MODE_SYNTHETIC_OFFLINE, ...over };
}

describe("R1/F1 — a loopback address can never prove a transport is non-billable", () => {
  it("[F1-CONTROL] the two local counters are LIVE: the loopback relay really forwards to the pretend upstream", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    // A direct control request through the relay, exactly the path an admitted
    // fixture/billed call would take. Both counters MUST move, or every later
    // "0" assertion would be vacuous.
    const res = await fetch(`${relay.relayUrl}/chat/completions`, { method: "POST", body: "{}" });
    await res.text();
    expect(relay.relayHits()).toBe(1);
    expect(relay.upstreamHits()).toBe(1);
    relay.reset();
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.1][RED TARGET] fixtureMode over a LOOPBACK RELAY must be REFUSED with BOTH counters 0", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    const r = await runGate({
      endpoint: relay.relayUrl,
      // What the real observer computes for a 127.0.0.1 endpoint. On the audited
      // baseline this SINGLE boolean was accepted as proof of "cannot bill".
      observation: { endpointIsLoopback: true, usdMicrosPerCall: null },
      auth: fixtureAuth(),
      budgetOver: { maxUsdMicros: null },
    });
    expect(r.status, `code=${String(r.code)}`).toBe("REFUSED");
    expect(r.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.2] fixtureMode over an EXTERNAL endpoint must be REFUSED with BOTH counters 0", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    const r = await runGate({
      endpoint: EXTERNAL_ENDPOINT,
      observation: { endpointIsLoopback: false, usdMicrosPerCall: null },
      auth: fixtureAuth(),
      budgetOver: { maxUsdMicros: null },
    });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.3] fixtureMode over a LOCAL FORWARDING RELAY with a real-credential-shaped identity is REFUSED", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    // The real-credential SHAPE without any real credential: a real provider id,
    // a real model id, an unknown (proxy) price — i.e. the user's own paid local
    // relay, mislabelled as a fixture. Zero sentinel keys are placed on disk.
    const r = await runGate({
      endpoint: relay.relayUrl,
      observation: { endpointIsLoopback: true, usdMicrosPerCall: null, providerId: "deepseek", modelId: "deepseek-v4-flash" },
      auth: fixtureAuth({ providerId: "deepseek", modelId: "deepseek-v4-flash" }),
      budgetOver: { maxUsdMicros: null },
    });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.4] fixtureMode + a sentinel key over loopback is REFUSED (a key/port proves nothing about billing)", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    // `SENTINEL_KEY` is deliberately not a real credential; the point is that the
    // auth's OWN claims plus a loopback ADDRESS and a key-shaped value still
    // cannot upgrade the transport into the non-billable class.
    const r = await runGate({
      endpoint: relay.relayUrl,
      observation: { endpointIsLoopback: true, usdMicrosPerCall: null },
      auth: fixtureAuth({ approvalId: `sentinel-${SENTINEL_KEY}` }),
      budgetOver: { maxUsdMicros: null },
    });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.5][CONTROL] the SAME loopback relay is a legitimate BILLED endpoint — admitted as PAID only with a money cap, and nothing is sent", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    // The user's legitimate case, preserved: a paid local relay is a normal
    // billed endpoint. It is admitted only as the PAID class, which REQUIRES a
    // non-null maxUsdMicros and a known per-call price — never because its
    // address is loopback.
    const r = await runGate({
      endpoint: relay.relayUrl,
      observation: { endpointIsLoopback: true, usdMicrosPerCall: 2_500_000 },
      auth: { paid: true },
      budgetOver: { maxUsdMicros: 5_000_000 },
    });
    expect(r.status, `code=${String(r.code)}`).toBe("ADMITTED");
    // Admission constructs the provider but sends NOTHING: the money cap is the
    // control, not an address.
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);

  it("[F1.6] the same loopback relay WITHOUT a money cap is REFUSED for the paid class (no uncapped billed path)", async () => {
    const relay = await startCountingRelay();
    relays.push(relay);
    const r = await runGate({
      endpoint: relay.relayUrl,
      observation: { endpointIsLoopback: true, usdMicrosPerCall: null },
      auth: { paid: true },
      budgetOver: { maxUsdMicros: null },
    });
    expect(r.status).toBe("REFUSED");
    expect(r.code).toBe("PAID_WITHOUT_USD_CAP");
    expect(r.factoryCalls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 60_000);
});
