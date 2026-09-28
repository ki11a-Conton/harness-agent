/**
 * R2 / F3 — the RED→GREEN TARGET ASSERTION for the token-delta defect.
 *
 * This file is deliberately written so that it runs UNCHANGED against the
 * baseline `a85db6dc` (where it must FAIL) and against the fix (where it must
 * PASS). It builds the journal view ITSELF from the raw `cost-budget.json` bytes
 * and passes it in the new `journal` field while ALSO passing the legacy
 * `journalChargedTokens` — so:
 *
 *   on the BASELINE the `journal` field is ignored and the old code does
 *       `tokensDelta = journalChargedTokens ?? 0` → the TOTAL 140 is reported as
 *       the DELTA, and the assertion `tokensDelta === -60` FAILS;
 *   after the FIX the per-request attribution is used → `candidate - baseline`
 *       = -60, and the same assertion PASSES.
 *
 * The defect is a pure statistical-semantics error, so the target assertions are
 * about the two INDEPENDENT metrics (total vs delta) and about a missing ledger
 * never being read as a corroborated zero — not about any internal helper.
 *
 * Zero paid requests: a local fake provider only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  aggregatePreregisteredCampaign,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  runPreregisteredCampaign,
  serializePreregistrationV2,
  stableStringify,
  toolCallEfficiencyGuidanceDigest,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import { createHash } from "node:crypto";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../scripts/e4/fixtures/n5-prereg-config.json", import.meta.url), "utf8"),
) as PreregistrationV2Options;

const NOW = 1_700_000_000_000;
const REPS = 2;

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function artifactFor(): ToolCallEfficiencyPreregistrationV2 {
  const base = structuredClone(FIXTURE);
  const catalog = base.catalog.slice(0, 5);
  return buildToolCallEfficiencyPreregistrationV2({
    ...base,
    catalog,
    selection: { ...base.selection, caseIds: catalog.map((c) => c.caseId) },
    schedule: { ...base.schedule, repetitions: REPS },
  });
}

function observationFor(a: ToolCallEfficiencyPreregistrationV2): PreregisteredCampaignObservationV2 {
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
    endpointDigest: captureEndpointIdentity(FIXTURE.provider.endpointBaseUrl ?? null)!,
    requestProfileDigest: sha(stableStringify(FIXTURE.provider.requestProfile)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: a.dataset.selectionProvenanceDigest,
    decisionPolicyDigest: computeThresholdDigestV3(a.evaluation.decisionPolicy ?? DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: 0,
    endpointIsLoopback: false,
  };
}

function authorizationJsonFor(a: ToolCallEfficiencyPreregistrationV2): string {
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
    approvalId: "r2-red-probe",
    allowResume: true,
    paid: true,
  });
}

/**
 * The ledger as READ, built HERE from the raw bytes (never from a helper the fix
 * might introduce), so this file runs on the baseline unchanged.
 */
function ledgerFromFile(budgetDir: string): {
  exists: boolean;
  chargedTotalTokens: number | null;
  journalSchemaVersion: string | null;
  entries: unknown[] | null;
} {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(join(budgetDir, "cost-budget.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { exists: false, chargedTotalTokens: null, journalSchemaVersion: null, entries: null };
  }
  const charged = file["charged"] as { totalTokens?: unknown } | undefined;
  const total = charged?.totalTokens;
  const journal = file["journal"] as { schemaVersion?: unknown; entries?: unknown } | undefined;
  return {
    exists: true,
    chargedTotalTokens: typeof total === "number" && Number.isSafeInteger(total) ? total : null,
    journalSchemaVersion: journal !== undefined && typeof journal.schemaVersion === "string" ? journal.schemaVersion : null,
    entries: journal !== undefined && Array.isArray(journal.entries) ? journal.entries : null,
  };
}

const dirs: string[] = [];
const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
let claimsDir: string | null = null;
beforeEach(async () => {
  // Each test needs its OWN authorization claim registry: the artifact is
  // deterministic, so a shared registry would read the previous test's
  // (now deleted) budget directory as a lost campaign.
  claimsDir = await mkdtemp(join(tmpdir(), "r2-probe-claims-"));
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

interface ProbeCampaign {
  artifact: ToolCallEfficiencyPreregistrationV2;
  run: Awaited<ReturnType<typeof runPreregisteredCampaign>>;
  budgetDir: string;
  chargedTotalTokens: number | null;
  journal: ReturnType<typeof ledgerFromFile>;
}

/** One REAL campaign: `perRun` is the true usage each arm run reports. */
async function campaign(
  tag: string,
  perRun: { baseline: { input: number; output: number }; candidate: { input: number; output: number } },
  report: (armId: "baseline" | "candidate") => number,
): Promise<ProbeCampaign> {
  const dir = await mkdtemp(join(tmpdir(), `r2-probe-${tag}-`));
  dirs.push(dir);
  const artifact = artifactFor();
  const usage = { input: 0, output: 0 };
  const provider: ModelProvider = {
    id: "r2-probe-fake",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          yield { type: "usage", usage: { inputTokens: usage.input, outputTokens: usage.output }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  const runner: PreregisteredArmRunner = async (arm, ctx) => {
    const want = perRun[arm.armId];
    usage.input = want.input;
    usage.output = want.output;
    const client = ctx.provider.createClient({} as never, {} as never);
    for await (const _ev of client.generate({} as never, new AbortController().signal)) {
      // drained: the budget layer settles the reservation when the stream ends
    }
    return {
      status: arm.armId === "candidate" ? "passed" : "failed",
      tokensUsed: report(arm.armId),
      evidence: {
        executorId: "r2-probe",
        traceDigest: "a".repeat(64),
        verifiedCompletion: arm.armId === "candidate",
        securityViolations: 0,
        activationEvidenceDigest: arm.armId === "candidate" ? "b".repeat(64) : null,
      },
    };
  };
  const budgetDir = join(dir, "budget");
  const admission = await openPreregisteredCampaignGate({
    preregistrationJson: serializePreregistrationV2(artifact),
    authorizationJson: authorizationJsonFor(artifact),
    observation: observationFor(artifact),
    budgetDir,
    mode: "first-run",
    now: () => NOW,
    makeProvider: () => provider,
  });
  if (admission.status !== "ADMITTED") throw new Error(`setup: not admitted (${admission.code}: ${admission.reason})`);
  const run = await runPreregisteredCampaign({
    admission,
    prereg: artifact,
    resultsDir: join(dir, "runs"),
    runArm: runner,
    now: () => NOW,
  });
  const journal = ledgerFromFile(budgetDir);
  return { artifact, run, budgetDir, chargedTotalTokens: journal.chargedTotalTokens, journal };
}

describe("F3 RED→GREEN — campaign total is NOT the baseline→candidate delta", () => {
  it("[F3.a] baseline=100, candidate=40 => the delta the aggregate reports is -60, never the total 140", async () => {
    // 10 baseline runs x 10 tokens (8+2) = 100; 10 candidate runs x 4 (3+1) = 40.
    const c = await campaign("delta", { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } }, () => 0);
    const providerCalls = c.run.records.length;
    const aggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: c.chargedTotalTokens,
      journal: c.journal as never,
    });
    // The ledger's read-only TOTAL is 100 + 40.
    expect(c.chargedTotalTokens).toBe(140);
    // THE TARGET ASSERTION: the gate input must carry the DIFFERENCE.
    // Baseline `a85db6dc` reports 140 here (the F3 defect); the fix reports -60.
    expect(aggregate.decision.statistics.tokensDelta).toBe(-60);
  }, 180_000);

  it("[F3.b] a missing ledger with a self-reported delta of exactly 0 is NOT comparable", async () => {
    const c = await campaign("no-journal", { baseline: { input: 8, output: 2 }, candidate: { input: 8, output: 2 } }, () => 0);
    // No journal is passed at all: "no corroborated cost", not a measured zero.
    const aggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: 0,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
    });
    // THE TARGET ASSERTION: at the baseline the self-report delta of 0 hides the
    // missing ledger, so this gate stays true and the campaign looks comparable.
    expect(aggregate.decision.gates.provenanceComparable).toBe(false);
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  }, 180_000);
});
