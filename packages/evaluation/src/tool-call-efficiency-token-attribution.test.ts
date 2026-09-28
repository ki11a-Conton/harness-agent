/**
 * R2 / F3 — the cost journal must attribute tokens PER REQUEST, PER ATTEMPT and
 * PER ARM, and the campaign aggregate must compute `candidate - baseline`.
 *
 * THE DEFECT (F3, P0)
 * -------------------
 * `aggregatePreregisteredCampaign` did:
 *
 *     const journalTokens = ledgerTotals.journalChargedTokens ?? null;
 *     const tokensDelta = journalTokens ?? 0;
 *
 * i.e. the campaign TOTAL was used as if it were the baseline→candidate
 * DIFFERENCE. On the current two-platform positive artifact the ledger total was
 * 248 and the reported `aggregateTokensDelta` was 248 — a ledger existing was
 * treated as proof that the two arms had been compared. It was not: summing one
 * total cannot produce a difference, and `tokensUncorroborated` stayed false
 * whenever the runner self-reported a delta of exactly 0.
 *
 * WHAT THESE TESTS PIN (behavioural, through the REAL aggregate entry point)
 * -------------------------------------------------------------------------
 *   - baseline 100 / candidate 40  => total 140, delta -60
 *   - baseline 100 / candidate 100 => total 200, delta 0
 *   - swapping the arms inverts the delta sign and leaves the total unchanged
 *   - the runner's self-reported `tokensUsed` cannot move the journal result
 *   - a resume does not re-charge the journal
 *   - two inputs of identical validity but different TRUE cost move the cost-gate
 *     verdict with the correct delta
 *   - a missing ledger / a legacy total-only ledger / a conservative reservation
 *     / a duplicate or mis-attributed request all leave the delta NOT_OBSERVED
 *     (`null`), never `0`, and can never reach ACCEPT
 *
 * The journal fixtures are REAL files: every campaign below is driven through
 * `openPreregisteredCampaignGate` + `runPreregisteredCampaign` with a fake
 * provider (zero network, zero key), and the aggregate is handed the ledger as
 * read back from disk by the REAL `readCostJournal` reader.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  PREREG_RUN_ACTIVATION_SCHEMA,
  PREREG_RUN_MANIFEST_SCHEMA,
  PREREG_RUN_SECURITY_SCHEMA,
  PREREG_RUN_VERIFIER_SCHEMA,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  aggregatePreregisteredCampaign,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  readCostJournal,
  runPreregisteredCampaign,
  serializePreregistrationV2,
  stableStringify,
  toolCallEfficiencyGuidanceDigest,
  type CostJournalView,
  type FormalRunAdmission,
  type PreregisteredAggregate,
  type PreregisteredArmContext,
  type PreregisteredArmEvidence,
  type PreregisteredArmRunner,
  type PreregisteredCampaignObservationV2,
  type PreregisteredCampaignRun,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../scripts/e4/fixtures/n5-prereg-config.json", import.meta.url), "utf8"),
) as PreregistrationV2Options;

const NOW = 1_700_000_000_000;
const EXECUTOR_ID = "r2-journal-executor";
const CASES = 5;
const REPS = 2;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function artifactFor(opts: { maxTokensDelta?: number; cases?: number } = {}): ToolCallEfficiencyPreregistrationV2 {
  const count = opts.cases ?? CASES;
  const base = structuredClone(FIXTURE);
  const catalog = base.catalog.slice(0, count);
  const decisionPolicy =
    opts.maxTokensDelta === undefined
      ? base.evaluation.decisionPolicy
      : { ...base.evaluation.decisionPolicy, maxTokensDelta: opts.maxTokensDelta };
  return buildToolCallEfficiencyPreregistrationV2({
    ...base,
    catalog,
    selection: { ...base.selection, caseIds: catalog.map((c) => c.caseId) },
    schedule: { ...base.schedule, repetitions: REPS },
    evaluation: { ...base.evaluation, decisionPolicy },
  });
}

function observationFor(
  artifact: ToolCallEfficiencyPreregistrationV2,
  over: Partial<PreregisteredCampaignObservationV2> = {},
): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  const eligibilityDigests: Record<string, string> = {};
  for (const c of artifact.dataset.cases) {
    caseContentDigests[c.caseId] = c.contentDigest;
    eligibilityDigests[c.caseId] = c.eligibilityDigest;
  }
  return {
    candidateSourceSha: artifact.subject.candidateSourceSha,
    cleanTree: true,
    baselineArmDigest: artifact.subject.baselineArmDigest,
    candidateArmDigest: artifact.subject.candidateArmDigest,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha256Hex(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: artifact.subject.runtimeConfigDigest,
    providerId: artifact.provider.providerId,
    modelId: artifact.provider.modelId,
    endpointDigest: captureEndpointIdentity(FIXTURE.provider.endpointBaseUrl ?? null)!,
    requestProfileDigest: sha256Hex(stableStringify(FIXTURE.provider.requestProfile)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: artifact.dataset.selectionProvenanceDigest,
    // The observation must carry the digest of the policy the ARTIFACT declares —
    // an override (e.g. a small `maxTokensDelta`) has to be re-observed, not assumed.
    decisionPolicyDigest: computeThresholdDigestV3(artifact.evaluation.decisionPolicy ?? DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: 0,
    endpointIsLoopback: false,
    ...over,
  };
}

/**
 * A DISTINCT approval id per campaign. The artifact is deterministic, so two
 * campaigns in one test would otherwise carry the same authorization digest and
 * the ledger would (correctly) refuse to open a second budget for one approval.
 */
let approvalSeq = 0;

function authorizationFor(a: ToolCallEfficiencyPreregistrationV2): string {
  approvalSeq += 1;
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
    approvalId: `r2-journal-approval-${approvalSeq}`,
    allowResume: true,
    paid: true,
  });
}

// ---------------------------------------------------------------------------
// A fake provider whose reported usage is set by the RUNNER for each arm run
// ---------------------------------------------------------------------------

interface Usage {
  input: number;
  output: number;
}

function usageProvider(usage: Usage): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  const provider: ModelProvider = {
    id: "r2-fake-usage",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          calls += 1;
          yield { type: "usage", usage: { inputTokens: usage.input, outputTokens: usage.output }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, calls: () => calls };
}

async function drain(provider: ModelProvider): Promise<void> {
  const client = provider.createClient({} as never, {} as never);
  for await (const _ev of client.generate({} as never, new AbortController().signal)) {
    // every event is consumed; the budget layer settles the reservation on end
  }
}

/**
 * Write the RAW artifacts `verifyArmEvidenceFromArtifacts` re-reads, so a record
 * can be genuinely `evidenceVerified` (an unverified record makes the whole
 * campaign INVALID and the cost gate untestable).
 */
async function writeRunArtifacts(
  ctx: PreregisteredArmContext,
  verifiedCompletion: boolean,
  activated: boolean,
): Promise<PreregisteredArmEvidence> {
  await mkdir(ctx.evidenceDir, { recursive: true });
  const manifestText = `${JSON.stringify({
    schemaVersion: PREREG_RUN_MANIFEST_SCHEMA,
    executorId: EXECUTOR_ID,
    preregistrationDigest: ctx.preregistrationDigest,
    planDigest: ctx.planDigest,
    armRunId: ctx.armRunId,
    armId: ctx.arm.armId,
    caseId: ctx.arm.caseId,
    repetition: ctx.arm.repetition,
    orderIndex: ctx.arm.orderIndex,
  })}\n`;
  await writeFile(join(ctx.evidenceDir, "manifest.json"), manifestText, "utf8");
  await writeFile(
    join(ctx.evidenceDir, "verifier.json"),
    `${JSON.stringify({ schemaVersion: PREREG_RUN_VERIFIER_SCHEMA, verifiedCompletion })}\n`,
    "utf8",
  );
  await writeFile(
    join(ctx.evidenceDir, "security.json"),
    `${JSON.stringify({ schemaVersion: PREREG_RUN_SECURITY_SCHEMA, violations: 0 })}\n`,
    "utf8",
  );
  let activationEvidenceDigest: string | null = null;
  if (activated) {
    const activationText = `${JSON.stringify({
      schemaVersion: PREREG_RUN_ACTIVATION_SCHEMA,
      caseId: ctx.arm.caseId,
      armId: ctx.arm.armId,
      repetition: ctx.arm.repetition,
      orderIndex: ctx.arm.orderIndex,
      events: [{ type: "tool-call-efficiency-guidance-injected", requestId: `${ctx.armRunId}:r1` }],
    })}\n`;
    await writeFile(join(ctx.evidenceDir, "activation.json"), activationText, "utf8");
    activationEvidenceDigest = sha256Hex(activationText);
  }
  return {
    executorId: EXECUTOR_ID,
    traceDigest: sha256Hex(manifestText),
    verifiedCompletion,
    securityViolations: 0,
    activationEvidenceDigest,
  };
}

// ---------------------------------------------------------------------------
// Harness: one real campaign over real per-arm token usage
// ---------------------------------------------------------------------------

interface Campaign {
  dir: string;
  artifact: ToolCallEfficiencyPreregistrationV2;
  admission: FormalRunAdmission;
  budgetDir: string;
  resultsDir: string;
  run: PreregisteredCampaignRun;
  journal: CostJournalView;
  aggregate: PreregisteredAggregate;
  physicalCalls: number;
}

const dirs: string[] = [];
const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
});

/**
 * Give the NEXT campaign its own authorization-claim registry. Tests that compare
 * two campaigns of one artifact are running two INDEPENDENT experiments, which in
 * production would be two separate invocations; without this, the ledger's
 * "one approval, one live budget directory" guard (correctly) refuses the second.
 * The production CLI never does this.
 */
async function freshClaimsRegistry(): Promise<void> {
  const d = await mkdtemp(join(tmpdir(), "r2-claims-"));
  dirs.push(d);
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = d;
}

async function tempDir(tag: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `r2-${tag}-`));
  dirs.push(d);
  return d;
}

/**
 * Run ONE real paired campaign. `perRun` sets the token usage each arm run
 * reports to the budgeted provider; `report` sets the runner's SELF-REPORTED
 * `tokensUsed` (which must never influence the journal result).
 */
async function runCampaign(
  tag: string,
  opts: {
    perRun: { baseline: Usage; candidate: Usage };
    maxTokensDelta?: number;
    report?: (armId: "baseline" | "candidate") => number;
    existing?: Campaign;
  },
): Promise<Campaign> {
  const dir = opts.existing?.dir ?? (await tempDir(tag));
  const artifact = opts.existing?.artifact ?? artifactFor({ maxTokensDelta: opts.maxTokensDelta });
  const usage: Usage = { input: 0, output: 0 };
  const fake = usageProvider(usage);
  const budgetDir = opts.existing?.budgetDir ?? join(dir, "budget");
  const resultsDir = opts.existing?.resultsDir ?? join(dir, "runs");

  const runner: PreregisteredArmRunner = async (arm, ctx) => {
    const want = opts.perRun[arm.armId];
    usage.input = want.input;
    usage.output = want.output;
    await drain(ctx.provider);
    const passed = arm.armId === "candidate";
    const evidence = await writeRunArtifacts(ctx, passed, passed);
    return {
      status: passed ? "passed" : "failed",
      tokensUsed: opts.report?.(arm.armId) ?? 0,
      evidence,
    };
  };

  let admission: FormalRunAdmission;
  if (opts.existing !== undefined) {
    admission = opts.existing.admission;
  } else {
    await freshClaimsRegistry();
    const opened = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(artifact),
      authorizationJson: authorizationFor(artifact),
      observation: observationFor(artifact),
      budgetDir,
      mode: "first-run",
      now: () => NOW,
      makeProvider: () => fake.provider,
    });
    if (opened.status !== "ADMITTED") throw new Error(`setup: campaign not admitted (${opened.code}: ${opened.reason})`);
    admission = opened;
  }

  const run = await runPreregisteredCampaign({
    admission,
    prereg: artifact,
    resultsDir,
    runArm: runner,
    resume: opts.existing !== undefined,
    now: () => NOW,
  });
  const journal = await readCostJournal(budgetDir);
  const ledgerView = await admission.ledger.view();
  const aggregate = aggregatePreregisteredCampaign(run, artifact, {
    providerCalls: ledgerView.committed,
    budgetRemaining: ledgerView.remaining,
    journalChargedTokens: journal.chargedTotalTokens,
    journal,
  });
  return { dir, artifact, admission, budgetDir, resultsDir, run, journal, aggregate, physicalCalls: fake.calls() };
}

/** Read one campaign's REAL `cost-budget.json` bytes, mutate, write to a fresh dir, read back. */
async function journalWith(
  tag: string,
  source: Campaign,
  mutate: (file: Record<string, unknown>) => void,
): Promise<CostJournalView> {
  const dir = await tempDir(tag);
  const file = JSON.parse(readFileSync(join(source.budgetDir, "cost-budget.json"), "utf8")) as Record<string, unknown>;
  mutate(file);
  await writeFile(join(dir, "cost-budget.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return readCostJournal(dir);
}

// ---------------------------------------------------------------------------
// F3.1-F3.3 — total and delta are two INDEPENDENT metrics
// ---------------------------------------------------------------------------

describe("F3 — per-arm token attribution through the real aggregate", () => {
  it("[F3.1] baseline=100, candidate=40 => total 140, delta -60", async () => {
    const c = await runCampaign("100-40", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    // 10 baseline runs x 10 tokens = 100; 10 candidate runs x 4 tokens = 40.
    expect(c.run.records.length).toBe(CASES * REPS * 2);
    expect(c.physicalCalls).toBe(CASES * REPS * 2);

    expect(c.aggregate.cost.basis).toBe("JOURNAL_PER_ARM");
    expect(c.aggregate.cost.totalTokens).toBe(140);
    expect(c.aggregate.cost.baselineTokens).toBe(100);
    expect(c.aggregate.cost.candidateTokens).toBe(40);
    expect(c.aggregate.cost.deltaTokens).toBe(-60);
    expect(c.aggregate.cost.problems).toEqual([]);
    // The frozen gate input receives the DIFFERENCE, not the total.
    expect(c.aggregate.decision.statistics.tokensDelta).toBe(-60);
    expect(c.aggregate.decision.gates.costBounded).toBe(true);
  }, 120_000);

  it("[F3.2] baseline=100, candidate=100 => total 200, delta 0", async () => {
    const c = await runCampaign("100-100", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 8, output: 2 } },
    });
    expect(c.aggregate.cost.basis).toBe("JOURNAL_PER_ARM");
    expect(c.aggregate.cost.totalTokens).toBe(200);
    expect(c.aggregate.cost.baselineTokens).toBe(100);
    expect(c.aggregate.cost.candidateTokens).toBe(100);
    expect(c.aggregate.cost.deltaTokens).toBe(0);
    expect(c.aggregate.decision.statistics.tokensDelta).toBe(0);
  }, 120_000);

  it("[F3.3] swapping the arms inverts the delta sign and leaves the total unchanged", async () => {
    const forward = await runCampaign("swap-fwd", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    const swapped = await runCampaign("swap-rev", {
      perRun: { baseline: { input: 3, output: 1 }, candidate: { input: 8, output: 2 } },
    });
    expect(forward.aggregate.cost.deltaTokens).toBe(-60);
    expect(swapped.aggregate.cost.deltaTokens).toBe(60);
    expect(swapped.aggregate.cost.deltaTokens).toBe(-forward.aggregate.cost.deltaTokens!);
    expect(swapped.aggregate.cost.totalTokens).toBe(forward.aggregate.cost.totalTokens);
    expect(swapped.aggregate.cost.totalTokens).toBe(140);
  }, 180_000);

  // -------------------------------------------------------------------------
  // F3.4-F3.5 — the runner's word and the resume path
  // -------------------------------------------------------------------------

  it("[F3.4] the runner's self-reported tokens cannot change the journal-derived result", async () => {
    const claimed = await runCampaign("self-report", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
      // The candidate claims a million tokens; the baseline claims none.
      report: (armId) => (armId === "candidate" ? 1_000_000 : 0),
    });
    // The candidate claims a million tokens on EACH of its 10 runs; the journal
    // witnessed 140 tokens in total, and the per-arm result ignores the claim.
    expect(claimed.aggregate.cost.selfReportedDelta).toBe(10_000_000);
    expect(claimed.aggregate.cost.totalTokens).toBe(140);
    expect(claimed.aggregate.cost.deltaTokens).toBe(-60);
    expect(claimed.aggregate.decision.statistics.tokensDelta).toBe(-60);
    expect(claimed.aggregate.cost.problems).toEqual([]);
  }, 120_000);

  it("[F3.5] a resume consumes no new budget and does not re-charge the journal", async () => {
    const first = await runCampaign("resume", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    const before = first.journal.entries?.length ?? -1;
    expect(before).toBe(CASES * REPS * 2);

    // A second driver pass over the SAME results directory with `resume: true`:
    // every record already exists, so NO arm is re-run and nothing is re-charged.
    const resumed = await runPreregisteredCampaign({
      admission: first.admission,
      prereg: first.artifact,
      resultsDir: first.resultsDir,
      runArm: async () => {
        throw new Error("resume must not execute an arm that already has a record");
      },
      resume: true,
      now: () => NOW,
    });
    expect(resumed.resumedArmRunIds.length).toBe(CASES * REPS * 2);
    expect(resumed.records.length).toBe(CASES * REPS * 2);

    const journal = await readCostJournal(first.budgetDir);
    expect(journal.entries?.length).toBe(before);
    expect(journal.chargedTotalTokens).toBe(140);
    const ledgerView = await first.admission.ledger.view();
    const aggregate = aggregatePreregisteredCampaign(resumed, first.artifact, {
      providerCalls: ledgerView.committed,
      budgetRemaining: ledgerView.remaining,
      journalChargedTokens: journal.chargedTotalTokens,
      journal,
    });
    expect(aggregate.cost.totalTokens).toBe(140);
    expect(aggregate.cost.deltaTokens).toBe(-60);
    expect(aggregate.cost.problems).toEqual([]);
  }, 120_000);

  // -------------------------------------------------------------------------
  // F3.6 — identical validity, different TRUE cost, moves the cost gate
  // -------------------------------------------------------------------------

  it("[F3.6] two campaigns of identical validity and different true cost move the verdict with the correct delta", async () => {
    // The SAME artifact (maxTokensDelta 50) and the SAME evidence-producing
    // runner; only the true token cost differs.
    const cheap = await runCampaign("gate-cheap", {
      maxTokensDelta: 50,
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 8, output: 2 } },
    });
    const costly = await runCampaign("gate-costly", {
      maxTokensDelta: 50,
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 16, output: 4 } },
    });

    expect(cheap.aggregate.cost.deltaTokens).toBe(0);
    expect(costly.aggregate.cost.deltaTokens).toBe(100);
    expect(costly.aggregate.cost.totalTokens).toBe(300);

    expect(cheap.aggregate.decision.decision).toBe("ACCEPT");
    expect(costly.aggregate.decision.decision).toBe("REJECT");
    expect(costly.aggregate.decision.reasonCodes).toContain("COST_CEILING_EXCEEDED");
    expect(cheap.aggregate.decision.gates.costBounded).toBe(true);
    expect(costly.aggregate.decision.gates.costBounded).toBe(false);

    // IDENTICAL VALIDITY: every gate except the cost bound agrees, so the verdict
    // moved because of the DELTA, not because the two inputs differ in quality.
    const differing = Object.keys(cheap.aggregate.decision.gates).filter(
      (k) => (cheap.aggregate.decision.gates as Record<string, unknown>)[k] !== (costly.aggregate.decision.gates as Record<string, unknown>)[k],
    );
    expect(differing).toEqual(["costBounded"]);
    expect(cheap.aggregate.decision.gates.provenanceComparable).toBe(true);
    expect(costly.aggregate.decision.gates.provenanceComparable).toBe(true);
  }, 180_000);

  // -------------------------------------------------------------------------
  // No ledger / legacy ledger / reservation / tampering
  // -------------------------------------------------------------------------

  it("[F3.7] no ledger is NOT cost-safe even when the outcome delta is 0", async () => {
    const c = await runCampaign("no-journal", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 8, output: 2 } },
      report: () => 0, // the runner self-reports a delta of exactly 0
    });
    const none = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: 0,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
    });
    expect(none.cost.basis).toBe("NO_JOURNAL");
    expect(none.cost.totalTokens).toBeNull();
    expect(none.cost.baselineTokens).toBeNull();
    expect(none.cost.candidateTokens).toBeNull();
    expect(none.cost.deltaTokens).toBeNull();
    expect(none.decision.gates.provenanceComparable).toBe(false);
    expect(none.decision.decision).not.toBe("ACCEPT");

    // A legacy caller that passes only a total describes a LEGACY ledger: the
    // total is readable, the per-arm delta is NOT (and is not fabricated).
    const legacyZero = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: 0,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: 0,
    });
    expect(legacyZero.cost.basis).toBe("LEGACY_TOTAL_ONLY");
    expect(legacyZero.cost.totalTokens).toBe(0);
    expect(legacyZero.cost.deltaTokens).toBeNull();
    expect(legacyZero.decision.gates.provenanceComparable).toBe(false);
    expect(legacyZero.decision.decision).not.toBe("ACCEPT");
  }, 120_000);

  it("[F3.8] a legacy total-only ledger shows its total read-only and fabricates no arm attribution", async () => {
    const c = await runCampaign("legacy", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    // Strip the per-request journal from the REAL ledger bytes: what remains is a
    // legacy ledger with a truthful total of 140.
    const legacy = await journalWith("legacy-stripped", c, (file) => {
      delete file["journal"];
    });
    expect(legacy.exists).toBe(true);
    expect(legacy.chargedTotalTokens).toBe(140);
    expect(legacy.entries).toBeNull();

    const aggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: c.physicalCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: legacy.chargedTotalTokens,
      journal: legacy,
    });
    expect(aggregate.cost.basis).toBe("LEGACY_TOTAL_ONLY");
    expect(aggregate.cost.totalTokens).toBe(140);
    // The old code reported 140 here as `tokensDelta` — the total used as a delta.
    expect(aggregate.cost.deltaTokens).toBeNull();
    expect(aggregate.decision.statistics.tokensDelta).not.toBe(140);
    expect(aggregate.decision.gates.provenanceComparable).toBe(false);
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  }, 120_000);

  it("[F3.9] a conservative reservation is never presented as measured consumption", async () => {
    const c = await runCampaign("reserved", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    // Replace ONE candidate MEASURED entry with the conservative bound the budget
    // layer charges when an attempt's real usage was never observed.
    const reserved = await journalWith("reserved-tamper", c, (file) => {
      const journal = file["journal"] as { entries: Array<Record<string, unknown>> };
      const target = journal.entries.find((e) => e["arm"] === "candidate" && e["basis"] === "MEASURED")!;
      target["basis"] = "RESERVED_UPPER_BOUND";
      target["reservedInputTokens"] = 32_000;
      target["reservedOutputTokens"] = 32_000;
      target["outcomeUnknown"] = true;
      delete target["inputTokens"];
      delete target["outputTokens"];
      target["chargedTotalTokens"] = 64_000;
      const charged = file["charged"] as { totalTokens: number };
      charged.totalTokens = 140 - 4 + 64_000;
    });
    const aggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: c.physicalCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: reserved.chargedTotalTokens,
      journal: reserved,
    });
    expect(aggregate.cost.deltaTokens).toBeNull();
    expect(aggregate.cost.baselineTokens).toBeNull();
    expect(aggregate.cost.candidateTokens).toBeNull();
    // The bound is reported AS a bound, and the total still counts it as consumption.
    expect(aggregate.cost.reservedUpperBound.candidate).toBe(64_000);
    expect(aggregate.cost.totalTokens).toBe(140 - 4 + 64_000);
    expect(aggregate.cost.problems.join(" ")).toMatch(/bound is not measured consumption/i);
    expect(aggregate.decision.gates.provenanceComparable).toBe(false);
    expect(aggregate.decision.decision).not.toBe("ACCEPT");
  }, 120_000);

  it("[F3.10] duplicate and cross-arm request attribution is refused", async () => {
    const c = await runCampaign("tamper", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    // (a) the SAME physical reservation attributed to the OTHER arm as well.
    const crossArm = await journalWith("tamper-cross", c, (file) => {
      const journal = file["journal"] as { entries: Array<Record<string, unknown>> };
      const other: Record<string, unknown> = { ...journal.entries.find((e) => e["arm"] === "baseline")! };
      other["arm"] = "candidate";
      other["armRunId"] = journal.entries.find((e) => e["arm"] === "candidate")!["armRunId"];
      other["caseId"] = journal.entries.find((e) => e["arm"] === "candidate")!["caseId"];
      other["repetition"] = journal.entries.find((e) => e["arm"] === "candidate")!["repetition"];
      other["requestId"] = "dup-cross-arm";
      other["attemptId"] = 9;
      other["costReservationId"] = "dup-cost-res";
      journal.entries.push(other);
    });
    const crossAggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: c.physicalCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: crossArm.chargedTotalTokens,
      journal: crossArm,
    });
    expect(crossAggregate.cost.deltaTokens).toBeNull();
    expect(crossAggregate.cost.basis).toBe("UNKNOWN_ATTRIBUTION");
    expect(crossAggregate.cost.problems.join(" ")).toMatch(/never to two arms/i);
    expect(crossAggregate.decision.decision).not.toBe("ACCEPT");

    // (b) a request attributed to an arm run this campaign never scheduled.
    const foreign = await journalWith("tamper-foreign", c, (file) => {
      const journal = file["journal"] as { entries: Array<Record<string, unknown>> };
      journal.entries[0]!["armRunId"] = "pair-not-scheduled-candidate";
    });
    const foreignAggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: c.physicalCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: foreign.chargedTotalTokens,
      journal: foreign,
    });
    expect(foreignAggregate.cost.deltaTokens).toBeNull();
    expect(foreignAggregate.cost.problems.join(" ")).toMatch(/never scheduled/i);

    // (c) TAMPERED token totals: the entries no longer reconcile with the ledger.
    const inflated = await journalWith("tamper-total", c, (file) => {
      const charged = file["charged"] as { totalTokens: number };
      charged.totalTokens = charged.totalTokens + 1;
    });
    const inflatedAggregate = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: c.physicalCalls,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: inflated.chargedTotalTokens,
      journal: inflated,
    });
    expect(inflatedAggregate.cost.deltaTokens).toBeNull();
    expect(inflatedAggregate.cost.problems.join(" ")).toMatch(/unattributed consumption/i);
    expect(inflatedAggregate.decision.decision).not.toBe("ACCEPT");
  }, 120_000);

  it("[F3.11] a genuine zero needs independent zero evidence; a missing request is never 0", async () => {
    const c = await runCampaign("zero", {
      perRun: { baseline: { input: 8, output: 2 }, candidate: { input: 3, output: 1 } },
    });
    // (a) REAL zero: no call, no charge, no entry, and the durable call ledger
    // agrees — the plan allows this 0 because it is corroborated, not assumed.
    const zeroFile = await journalWith("zero-evidence", c, (file) => {
      const journal = file["journal"] as { entries: unknown[] };
      journal.entries = [];
      const charged = file["charged"] as { totalTokens: number };
      charged.totalTokens = 0;
    });
    const zero = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: 0,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: zeroFile.chargedTotalTokens,
      journal: zeroFile,
    });
    expect(zero.cost.basis).toBe("JOURNAL_ZERO_EVIDENCE");
    expect(zero.cost.totalTokens).toBe(0);
    expect(zero.cost.deltaTokens).toBe(0);

    // (b) The SAME empty journal, but the call ledger says calls WERE made: the
    // attribution is missing, so the delta is NOT_OBSERVED — never 0.
    const missing = aggregatePreregisteredCampaign(c.run, c.artifact, {
      providerCalls: 20,
      budgetRemaining: c.artifact.budget.campaignWorstCaseModelCalls,
      journalChargedTokens: zeroFile.chargedTotalTokens,
      journal: zeroFile,
    });
    expect(missing.cost.basis).toBe("UNKNOWN_ATTRIBUTION");
    expect(missing.cost.deltaTokens).toBeNull();
    expect(missing.cost.problems.join(" ")).toMatch(/missing request is never 0/i);
    expect(missing.decision.gates.provenanceComparable).toBe(false);
    expect(missing.decision.decision).not.toBe("ACCEPT");
  }, 120_000);
});
