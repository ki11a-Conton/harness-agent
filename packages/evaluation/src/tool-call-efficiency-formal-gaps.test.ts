/**
 * S0 — reproducers for the formal-execution gaps the plan names as F2 / F3 / F4.
 *
 * This file exists BECAUSE the N5 closed loop proved the offline plumbing runs,
 * not that a paid run is SAFE. Each test here pins ONE invariant that the
 * 1c9a848 source did NOT hold, and the invariants are exactly the ones a
 * "ready to spend money" claim depends on:
 *
 *   F2 — an ACCEPT must not be reachable from a runner SELF-REPORTING outcome
 *        booleans. Forging `{status:"passed", candidateActivated:true}` with no
 *        verifier / request-bound activation evidence must not produce ACCEPT.
 *        STILL OPEN: tracked as `it.fails` (see the F2 block for the S4 target).
 *   F3 — every billed physical attempt must reserve BEFORE it is sent. A
 *        provider-internal retry whose reservation is refused must not be
 *        allowed to continue; an unknown price must not be admitted as free.
 *        ENFORCED (the retry reservation throws; a money-bounded campaign with
 *        an unknown observed price is refused as PRICING_UNKNOWN).
 *   F4 — an authorization's `allowResume` must actually gate resuming, a
 *        campaign that already ESTABLISHED a budget in another live directory
 *        must not be silently re-opened on the paid path, and a resume must not
 *        mint a fresh cost allowance. ENFORCED.
 *
 * Zero provider calls: every provider here is a local fake. No network, no key.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorInfo, type ModelEvent, type ModelProvider, type ModelRequest, type ProviderConfig } from "@ar/contracts";
import {
  CostBudget,
  DEFAULT_DECISION_POLICY_V3,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  aggregatePreregisteredCampaign,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  createFormalBudgetedProvider,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  openR97BudgetLedger,
  parseAndValidateAuthorizationV2,
  runPreregisteredCampaign,
  serializePreregistrationV2,
  toolCallEfficiencyGuidanceDigest,
  type PreregisteredArmOutcome,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { stableStringify } from "@ar/evaluation";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../scripts/e4/fixtures/n5-prereg-config.json", import.meta.url), "utf8"),
) as PreregistrationV2Options;

const NOW = 1_700_000_000_000;
const CASE_IDS = FIXTURE.selection.caseIds;

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function preregOptions(over: Partial<PreregistrationV2Options> = {}): PreregistrationV2Options {
  return { ...structuredClone(FIXTURE), ...over };
}

function prereg(over: Partial<PreregistrationV2Options> = {}): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2(preregOptions(over));
}

function observationFor(over: Partial<PreregisteredCampaignObservationV2> = {}): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  for (const caseId of CASE_IDS) caseContentDigests[caseId] = `content-${caseId}`;
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
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    // A KNOWN, non-null price so a money-bounded campaign is not refused as
    // `PRICING_UNKNOWN`; the price-unknown test overrides this with `null`.
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

/** A provider that emits `retry` events and reports usage; never touches a network. */
function retryingProvider(opts: { retries: number }): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    id: "fake",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          calls += 1;
          for (let i = 0; i < opts.retries; i += 1) {
            yield {
              type: "retry",
              attempt: i + 1,
              error: errorInfo("MODEL_ERROR", "transient transport failure"),
              timestamp: 0,
            };
          }
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, calls: () => calls };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "s0-gaps-"));
  dirs.push(d);
  return d;
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;
beforeEach(async () => {
  claimsDir = await mkdtemp(join(tmpdir(), "s0-claims-"));
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

// ---------------------------------------------------------------------------
// F2 — ACCEPT must not be reachable from self-reported outcome booleans
// ---------------------------------------------------------------------------

describe("S0/F2 — a self-reported arm outcome cannot manufacture ACCEPT", () => {
  // KNOWN GAP (S4/F2): `aggregatePreregisteredCampaign` still trusts the
  // runner's `status`/`candidateActivated` booleans (and hardcodes
  // `digestValid: true`, `securityBreaches*: 0`, `recommendsRepetition: false`),
  // so a runner that returns `{status:"passed", candidateActivated:true}` with no
  // verifier / request-bound activation evidence reaches ACCEPT. This pins the
  // REQUIRED invariant and is `it.fails` until S4 derives the decision inputs
  // from real verifier/activation/ledger evidence — at which point it will start
  // passing and MUST be promoted to `it(...)` (vitest fails a stale `it.fails`).
  it.fails("refuses ACCEPT when the only evidence is 32 forged passed/activated outcomes", async () => {
    const dir = await tempDir();
    const artifact = prereg();
    const preregJson = serializePreregistrationV2(artifact);

    // The forged runner: no verifier, no request-bound activation evidence, no
    // per-run trace — it simply returns the booleans that today's aggregate
    // reads as truth.
    const forged: PreregisteredArmRunner = async (arm): Promise<PreregisteredArmOutcome> => ({
      status: arm.armId === "candidate" ? "passed" : "failed",
      candidateActivated: arm.armId === "candidate",
      baselineContaminated: false,
      tokensUsed: 1,
      reason: "forged",
    });

    const admission = await openPreregisteredCampaignGate({
      preregistrationJson: preregJson,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir: join(dir, "budget"),
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });
    expect(admission.status, "the forged campaign must at least reach admission").toBe("ADMITTED");
    if (admission.status !== "ADMITTED") return;

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

    // THE INVARIANT: booleans that no verifier produced cannot decide a champion.
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  });
});

// ---------------------------------------------------------------------------
// F3 — every billed physical attempt reserves BEFORE it is sent
// ---------------------------------------------------------------------------

describe("S0/F3 — a retry whose reservation is refused must not continue", () => {
  it("throws instead of silently continuing when the retry reservation is refused", async () => {
    const dir = await tempDir();
    const artifact = prereg();

    // Grant exactly ONE logical call: the first attempt fits, the retry does not.
    const ledger = await openR97BudgetLedger(dir, {
      planDigest: artifact.preregistrationDigest,
      campaignModelCalls: 1,
      mode: "first-run",
    });
    const costBudget = await CostBudget.open(dir, artifact, { allowCreate: true });
    const fake = retryingProvider({ retries: 1 });
    const { provider } = createFormalBudgetedProvider({
      provider: fake.provider,
      ledger,
      costBudget,
      arm: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
      usdMicrosPerCall: 0,
    });

    const consume = async (): Promise<ModelEvent[]> => {
      const out: ModelEvent[] = [];
      const client = provider.createClient({ providerId: "fake", modelId: "m" } as never, {} as ProviderConfig);
      for await (const ev of client.generate({} as ModelRequest, new AbortController().signal)) out.push(ev);
      return out;
    };

    // THE INVARIANT: the retry is a NEW physical request. If its reservation is
    // refused, the stream must STOP — not keep streaming an unbilled request.
    await expect(consume()).rejects.toThrow(/BUDGET|RETRY/i);
  });

  it("refuses to admit a paid campaign when the price is unknown", async () => {
    const dir = await tempDir();
    const artifact = prereg();
    expect(artifact.budget.maxUsdMicros, "the fixture is money-bounded").not.toBeNull();

    const admission = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(artifact),
      authorizationJson: authorizationFor(artifact),
      observation: observationFor({ usdMicrosPerCall: null }),
      budgetDir: join(dir, "budget"),
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
      // The OBSERVED price is null: pricing is unknown for this provider/model.
    });

    // THE INVARIANT: an unknown price on a money-bounded campaign is a refusal,
    // not a silent zero.
    expect(admission.status).toBe("REFUSED");
    if (admission.status === "REFUSED") expect(admission.code).toBe("PRICING_UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// F4 — resume + budget-state integrity
// ---------------------------------------------------------------------------

describe("S0/F4 — allowResume and budget-state integrity are enforced", () => {
  it("refuses mode=resume when the authorization sets allowResume=false", async () => {
    const dir = await tempDir();
    const artifact = prereg();
    const budgetDir = join(dir, "budget");
    const json = serializePreregistrationV2(artifact);

    // Establish the campaign first, so the ONLY reason a resume could be refused
    // is the authorization's own prohibition.
    const first = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir,
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });
    expect(first.status).toBe("ADMITTED");

    const admission = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact, { allowResume: false }),
      observation: observationFor(),
      budgetDir,
      mode: "resume",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });

    // THE INVARIANT: `allowResume: false` is a real prohibition.
    expect(admission.status).toBe("REFUSED");
    if (admission.status === "REFUSED") expect(admission.code).toBe("RESUME_NOT_ALLOWED");
  });

  it("refuses a re-open that would recreate a deleted cost budget", async () => {
    const dir = await tempDir();
    const artifact = prereg();
    const budgetDir = join(dir, "budget");
    const json = serializePreregistrationV2(artifact);

    // Establish the campaign: first run creates the ledger AND the cost budget.
    const first = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir,
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });
    expect(first.status).toBe("ADMITTED");
    if (first.status !== "ADMITTED") return;
    await first.costBudget.charge({ inputTokens: 111, outputTokens: 7, usdMicros: 42 });

    // Simulate a crash between `rm` and `rename` inside writeAtomic: the cost
    // budget file is GONE while the call ledger (a separate file) still exists.
    await rm(join(budgetDir, "cost-budget.json"), { force: true });

    const second = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir,
      // `auto` resolves to resume against the still-present call ledger, so the
      // missing cost budget must be a LOSS — never a fresh allowance.
      mode: "auto",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });

    // THE INVARIANT: a lost consumption record is a LOSS, not a fresh allowance.
    expect(second.status).toBe("REFUSED");
    if (second.status === "REFUSED") expect(second.code).toBe("BUDGET_STATE_REJECTED");
  });

  it("refuses to open a second live budget directory for the same paid campaign", async () => {
    const artifact = prereg();
    const json = serializePreregistrationV2(artifact);
    const dirA = join(await tempDir(), "budget-a");
    const dirB = join(await tempDir(), "budget-b");

    const a = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir: dirA,
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });
    expect(a.status).toBe("ADMITTED");

    const b = await openPreregisteredCampaignGate({
      preregistrationJson: json,
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(),
      budgetDir: dirB,
      mode: "auto",
      now: () => NOW,
      makeProvider: () => retryingProvider({ retries: 0 }).provider,
    });

    // THE INVARIANT: on the PAID v2 path, "this approval is still live elsewhere"
    // is a refusal — the generic ledger records it, the paid gate must not.
    expect(b.status).toBe("REFUSED");
    if (b.status === "REFUSED") expect(b.code).toBe("BUDGET_STATE_REJECTED");
  });

  it("parses an authorization without inventing allowResume/paid", async () => {
    const a = prereg();
    const parsed = parseAndValidateAuthorizationV2(authorizationFor(a, { allowResume: false, paid: true }));
    expect(parsed.allowResume).toBe(false);
    expect(parsed.paid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixture guard — the placeholder fixture must never masquerade as a real one
// ---------------------------------------------------------------------------

describe("S0 — the committed N5 fixture is TEST_ONLY and discloses it", () => {
  it("carries a placeholder source sha that a production observer must reject", () => {
    expect(FIXTURE.subject.candidateSourceSha).toBe("a".repeat(40));
    expect(FIXTURE.selection.selectionProvenanceDigest).toBe("r87-selection-digest");
  });
});