/**
 * N2 + N3 — the formal pre-registered execution boundary.
 *
 * Every refusal path PROVES `providerFactoryCalls === 0` (a spy factory must
 * never be invoked), which is stronger than `providerCalls === 0`. The admission
 * path proves the budget ledger is the real authority on the call ceiling.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  checkAuthorizationV2,
  openPreregisteredCampaignGate,
  parseAndValidateAuthorizationV2,
  type PreregisteredCampaignObservationV2,
  type ToolCallEfficiencyAuthorizationV2,
} from "./tool-call-efficiency-formal-run.js";

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

function preregOptions(): PreregistrationV2Options {
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
  };
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function observationFor(a: ToolCallEfficiencyPreregistrationV2, over: Partial<PreregisteredCampaignObservationV2> = {}): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  for (const c of a.dataset.cases) caseContentDigests[c.caseId] = c.contentDigest;
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
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    // A KNOWN, non-null price: the fixture is money-bounded, so a null price
    // would (correctly) be refused as PRICING_UNKNOWN before admission.
    usdMicrosPerCall: 0,
    ...over,
  };
}

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2, over: Partial<ToolCallEfficiencyAuthorizationV2> = {}): ToolCallEfficiencyAuthorizationV2 {
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
    ...over,
  };
}

/** A deterministic provider that reports usage and completes. */
function fakeProvider(opts: { retries?: number; tokens?: { input: number; output: number } } = {}): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    id: "fake",
    async listModels() {
      return [];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          calls += 1;
          for (let i = 0; i < (opts.retries ?? 0); i++) {
            yield {
              type: "retry",
              attempt: i + 1,
              error: { code: "MODEL_ERROR", message: "retry", retryable: true, safeToRetry: true },
              timestamp: 0,
            };
          }
          yield { type: "usage", usage: { inputTokens: opts.tokens?.input ?? 10, outputTokens: opts.tokens?.output ?? 5 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, calls: () => calls };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "n2n3-"));
  dirs.push(d);
  return d;
}

/**
 * The per-authorization CLAIM anchor lives OUTSIDE any single campaign
 * directory (machine-global, keyed by campaign id). This fixture reuses one
 * pre-registration digest across many fresh temp directories, so a durable
 * claim left by an earlier test — or by an earlier run on this machine — would
 * refuse an unrelated fresh directory with `CAMPAIGN_STATE_LOST`. That is the
 * guard working correctly; the FIXTURE was leaking. Redirect it at a FRESH
 * scratch directory PER TEST (the repo's established pattern), so each test
 * starts with an empty anchor namespace while a single test can still resume
 * its own campaign.
 */
const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;
beforeEach(async () => {
  claimsDir = await mkdtemp(join(tmpdir(), "n2n3-claims-"));
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = claimsDir;
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
  if (claimsDir !== null) {
    await rm(claimsDir, { recursive: true, force: true }).catch(() => undefined);
    claimsDir = null;
  }
});

async function gate(opts: {
  artifact: ToolCallEfficiencyPreregistrationV2;
  observation?: PreregisteredCampaignObservationV2;
  authorization?: ToolCallEfficiencyAuthorizationV2;
  json?: { prereg?: string; auth?: string };
  budgetDir?: string;
  mode?: "auto" | "first-run" | "resume";
  now?: number;
  makeProvider?: () => ModelProvider;
}) {
  const budgetDir = opts.budgetDir ?? (await tempDir());
  const factory = vi.fn(opts.makeProvider ?? (() => fakeProvider().provider));
  const result = await openPreregisteredCampaignGate({
    preregistrationJson: opts.json?.prereg ?? serializePreregistrationV2(opts.artifact),
    authorizationJson: opts.json?.auth ?? JSON.stringify(opts.authorization ?? authorizationFor(opts.artifact)),
    observation: opts.observation ?? observationFor(opts.artifact),
    budgetDir,
    mode: opts.mode,
    now: () => opts.now ?? 1_700_000_000_000,
    makeProvider: factory,
  });
  return { result, factory };
}

describe("N2/N3 — the formal gate refuses every pre-provider violation", () => {
  const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());

  it("admits a fully-bound campaign and constructs the provider EXACTLY once", async () => {
    const { result, factory } = await gate({ artifact });
    expect(result.status).toBe("ADMITTED");
    if (result.status !== "ADMITTED") return;
    expect(result.preregistrationDigest).toBe(artifact.preregistrationDigest);
    expect(result.plan.totalLogicalRuns).toBe(32);
    expect(result.plan.planDigest).toBe(artifact.schedule.planDigest);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("refuses an invalid pre-registration without constructing a provider", async () => {
    const { result, factory } = await gate({ artifact, json: { prereg: "{not json" } });
    expect(result).toMatchObject({ status: "REFUSED", code: "PREREGISTRATION_INVALID" });
    expect(factory).toHaveBeenCalledTimes(0);
    if (result.status !== "REFUSED") return;
    expect(result.providerCalls).toBe(0);
    expect(result.providerFactoryCalls).toBe(0);
  });

  it("refuses a tampered pre-registration (root digest) with 0 factory calls", async () => {
    const obj = JSON.parse(serializePreregistrationV2(artifact)) as Record<string, unknown>;
    obj.preregistrationDigest = "f".repeat(64);
    const { result, factory } = await gate({ artifact, json: { prereg: JSON.stringify(obj) } });
    expect(result).toMatchObject({ status: "REFUSED", code: "PREREGISTRATION_INVALID" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  const drifts: Array<[string, Partial<PreregisteredCampaignObservationV2>]> = [
    ["a dirty worktree", { cleanTree: false }],
    ["a different source sha", { candidateSourceSha: "b".repeat(40) }],
    ["a different baseline arm", { baselineArmDigest: "other" }],
    ["a different candidate arm", { candidateArmDigest: "other" }],
    ["changed guidance bytes", { guidanceDigest: "other-guidance" }],
    ["a different mechanism contract", { contractDigest: "other-contract" }],
    ["a changed runtime config", { runtimeConfigDigest: "other-runtime" }],
    ["a different provider", { providerId: "other-provider" }],
    ["a different model", { modelId: "other-model" }],
    ["a different endpoint", { endpointDigest: captureEndpointIdentity("https://api.other.com/v1")! }],
    ["a changed request profile", { requestProfileDigest: "other-profile" }],
    ["a changed case content", { caseContentDigests: Object.fromEntries(CASE_IDS.map((id) => [id, id === "reg-01" ? "changed" : `content-${id}`])) }],
    ["a changed decision policy", { decisionPolicyDigest: "other-policy" }],
  ];
  it.each(drifts)("refuses %s before any provider exists", async (_label, over) => {
    const { result, factory } = await gate({ artifact, observation: observationFor(artifact, over) });
    expect(result).toMatchObject({ status: "REFUSED", code: "PREREGISTRATION_IDENTITY_DRIFT" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses authorization that binds a different digest with 0 factory calls", async () => {
    const { result, factory } = await gate({ artifact, authorization: authorizationFor(artifact, { preregistrationDigest: "0".repeat(64) }) });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_DIGEST_MISMATCH" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses authorization without the paid flag", async () => {
    const { result, factory } = await gate({ artifact, authorization: authorizationFor(artifact, { paid: false }) });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_NOT_PAID" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses an expired authorization", async () => {
    const { result, factory } = await gate({ artifact, authorization: authorizationFor(artifact, { issuedAtMs: 1, expiresAtMs: 2 }) });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_EXPIRED" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses a subject/provider mismatch", async () => {
    const { result, factory } = await gate({ artifact, authorization: authorizationFor(artifact, { modelId: "other-model" }) });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_SUBJECT_MISMATCH" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses a budget ONE call below the worst case", async () => {
    const auth = authorizationFor(artifact);
    auth.caps.maxModelCalls = artifact.budget.campaignWorstCaseModelCalls - 1;
    const { result, factory } = await gate({ artifact, authorization: auth });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_CAP_MISMATCH" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("refuses a budget ABOVE the pre-registered worst case", async () => {
    const auth = authorizationFor(artifact);
    auth.caps.maxModelCalls = artifact.budget.campaignWorstCaseModelCalls + 1;
    const { result } = await gate({ artifact, authorization: auth });
    expect(result).toMatchObject({ status: "REFUSED", code: "AUTHORIZATION_CAP_MISMATCH" });
  });

  it("refuses a resume whose stored budget belongs to a different digest", async () => {
    const dir = await tempDir();
    // Establish a campaign for a GENUINELY DIFFERENT artifact (a different order
    // seed changes the plan/digest), then try to resume OUR digest in the same
    // directory. The ledger's stored planDigest must not be adopted.
    const otherOpts = preregOptions();
    otherOpts.schedule = { repetitions: 2, orderSeed: 99 };
    const other = buildToolCallEfficiencyPreregistrationV2(otherOpts);
    expect(other.preregistrationDigest).not.toBe(artifact.preregistrationDigest);
    const first = await gate({ artifact: other, budgetDir: dir, mode: "first-run" });
    expect(first.result.status).toBe("ADMITTED");
    const { result, factory } = await gate({ artifact, budgetDir: dir, mode: "resume" });
    expect(result).toMatchObject({ status: "REFUSED", code: "BUDGET_STATE_REJECTED" });
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it("admits a resume of the SAME digest", async () => {
    const dir = await tempDir();
    const first = await gate({ artifact, budgetDir: dir, mode: "first-run" });
    expect(first.result.status).toBe("ADMITTED");
    const second = await gate({ artifact, budgetDir: dir, mode: "resume" });
    expect(second.result.status).toBe("ADMITTED");
  });
});

describe("N3 — the ledger is the real authority on the call ceiling", () => {
  it("derives the frozen worst case from the real per-run ceiling (8 × 2 × 2 × 30 = 960)", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    expect(a.schedule.logicalRuns).toBe(32);
    expect(a.budget.maxModelCallsPerRun).toBe(30);
    expect(a.budget.campaignWorstCaseModelCalls).toBe(960);
  });

  it("refuses a call the ledger cannot afford, before it reaches the provider", async () => {
    // A one-call grant, then try two calls.
    const small = buildToolCallEfficiencyPreregistrationV2(
      preregOptions(),
    );
    const dir = await tempDir();
    const fake = fakeProvider();
    const { result } = await gate({ artifact: small, budgetDir: dir, makeProvider: () => fake.provider });
    expect(result.status).toBe("ADMITTED");
    if (result.status !== "ADMITTED") return;
    const client = result.provider.createClient({ providerId: "fake", modelId: "m" }, {} as ProviderConfig);

    // Drain the whole grant.
    const total = small.budget.campaignWorstCaseModelCalls;
    for (let i = 0; i < total; i += 1) {
      for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
        // consume
      }
    }
    expect(fake.calls()).toBe(total);
    // The next call MUST be refused before the provider is entered.
    let refused = false;
    try {
      for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
        // consume
      }
    } catch (err) {
      refused = String(err).includes("BUDGET_EXHAUSTED");
    }
    expect(refused).toBe(true);
    expect(fake.calls()).toBe(total); // the provider was never entered again
  });

  it("bills provider-internal retries as further calls", async () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const fake = fakeProvider({ retries: 2 });
    const { result } = await gate({ artifact: a, budgetDir: dir, makeProvider: () => fake.provider });
    if (result.status !== "ADMITTED") throw new Error("not admitted");
    const client = result.provider.createClient({ providerId: "fake", modelId: "m" }, {} as ProviderConfig);
    for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
      // consume
    }
    // One logical call + two retry reservations = three admitted calls.
    expect(result.budgetStats.logicalCalls).toBe(3);
    expect(result.budgetStats.retries).toBe(2);
    const view = await result.ledger.view();
    expect(view.committed).toBe(3);
  });

  it("charges a dispatched-but-unobserved outcome and never refunds it", async () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const provider: ModelProvider = {
      id: "fake",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate(): AsyncGenerator<ModelEvent> {
            yield { type: "started", timestamp: 0 };
            throw new Error("stream died after dispatch");
          },
        };
      },
    };
    const { result } = await gate({ artifact: a, budgetDir: dir, makeProvider: () => provider });
    if (result.status !== "ADMITTED") throw new Error("not admitted");
    const client = result.provider.createClient({ providerId: "fake", modelId: "m" }, {} as ProviderConfig);
    await expect(async () => {
      for await (const _ev of client.generate({} as ModelRequest, new AbortController().signal)) {
        // consume
      }
    }).rejects.toThrow("stream died");
    expect(result.budgetStats.unknownCalls).toBe(1);
    const view = await result.ledger.view();
    expect(view.unknown).toBe(1);
    expect(view.remaining).toBe(a.budget.campaignWorstCaseModelCalls - 1);
  });

  it("does not reset the cost budget across an open", async () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const first = await CostBudget.open(dir, a, { allowCreate: true });
    await first.charge({ inputTokens: 100, outputTokens: 50, usdMicros: 7 });
    const second = await CostBudget.open(dir, a, { allowCreate: false });
    expect(second.view().charged.inputTokens).toBe(100);
    expect(second.view().charged.totalTokens).toBe(150);
    expect(second.view().charged.usdMicros).toBe(7);
  });

  it("refuses a resume with no cost budget on disk (a resume never creates allowance)", async () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    await expect(CostBudget.open(dir, a, { allowCreate: false })).rejects.toThrow(/missing/);
  });
});

describe("N3 — authorization artifact is read-only and strict", () => {
  const artifact = buildToolCallEfficiencyPreregistrationV2(preregOptions());

  it("round-trips a valid authorization", () => {
    const auth = authorizationFor(artifact);
    expect(parseAndValidateAuthorizationV2(JSON.stringify(auth))).toEqual(auth);
  });

  it("rejects an unknown field", () => {
    const auth = { ...authorizationFor(artifact), extraCap: 1 };
    expect(() => parseAndValidateAuthorizationV2(JSON.stringify(auth))).toThrow(/UNKNOWN_FIELD/);
  });

  it("rejects a wrong schema", () => {
    expect(() => parseAndValidateAuthorizationV2(JSON.stringify({ schemaVersion: "nope" }))).toThrow(/WRONG_SCHEMA/);
  });

  it("checkAuthorizationV2 agrees with the gate's verdict", () => {
    const auth = authorizationFor(artifact);
    expect(checkAuthorizationV2(auth, artifact, 1_700_000_000_000)).toEqual({ ok: true });
  });
});

describe("N4 — the preregistration captures the frozen experiment identity", () => {
  it("serializes the same artifact to identical bytes on every build", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const b = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    expect(serializePreregistrationV2(a)).toBe(serializePreregistrationV2(b));
  });

  it("keeps the endpoint out of the artifact bytes", async () => {
    const a = buildToolCallEfficiencyPreregistrationV2(preregOptions());
    const dir = await tempDir();
    const path = join(dir, "prereg.json");
    await writeFile(path, serializePreregistrationV2(a), "utf8");
    const bytes = await readFile(path, "utf8");
    expect(bytes).not.toContain(ENDPOINT);
    expect(bytes).not.toContain("api.example.com");
  });
});