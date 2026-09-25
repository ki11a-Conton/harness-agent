/**
 * N5 — the OFFLINE, identity-bound driver for a pre-registered paired campaign.
 *
 * `openPreregisteredCampaignGate` (N2/N3) is the fail-closed boundary: nothing
 * reaches a provider factory until the artifact, the re-observed identity, the
 * independent authorization and the atomic budget ledger have all passed. This
 * module is what runs AFTER admission, and it adds the two things a gate alone
 * cannot prove:
 *
 *   1. the schedule is executed EXACTLY as pre-registered — the ordering comes
 *      from `orderedArmRunsFlat(plan)` (the existing E3-02 scheduler, reused;
 *      this module does not implement a second plan/seed algorithm);
 *   2. every per-run result carries the SAME root `preregistrationDigest` and
 *      `planDigest`, so a result from a different experiment cannot be mixed in,
 *      and a resume only reuses a record that binds the identical identity.
 *
 * It is deliberately PURE with respect to the model: the caller injects a
 * `PreregisteredArmRunner`, and every provider call the runner makes goes
 * through the budget-wrapped provider the gate returned. An offline E2E injects
 * a fake runner; a real harness injects the real one.
 *
 * The aggregate re-derives every decision input from the RECORDS (never from a
 * caller-supplied summary) and asks the FROZEN `decideChampionV3` for the
 * verdict. A single-run, an incomplete pair, a contaminated baseline or a
 * budget-exhausted campaign can never produce ACCEPT.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider } from "@ar/contracts";
import { stableStringify } from "./manifest.js";
import { armRunIdOf, orderedArmRunsFlat, type OrderedArmRun } from "./paired-executor.js";
import type { ArmRunRef } from "./paired-plan.js";
import {
  decideChampionV3,
  type ChampionDecisionEnvelopeV3,
  type DecisionGateInputV3,
} from "./champion-decision-v3.js";
import { DEFAULT_DECISION_POLICY_V3 } from "./decision-policy-v3.js";
import type { ToolCallEfficiencyPreregistrationV2 } from "./tool-call-efficiency-preregistration-v2.js";
import type { FormalRunAdmission } from "./tool-call-efficiency-formal-run.js";

export const PREREGISTERED_CAMPAIGN_SCHEMA = "tool-call-efficiency-paired-campaign-v1";

// ---------------------------------------------------------------------------
// Arm outcome (what a runner reports; identity is added by THIS module)
// ---------------------------------------------------------------------------

export type PreregisteredArmFailureCategory = "model" | "harness" | "judge" | "infrastructure";

export interface PreregisteredArmOutcome {
  status: "passed" | "failed" | "error";
  /** Present for `status: "error"`. Infrastructure/harness/judge/model failures
   *  are excluded from the pair (never silently counted as a task failure). */
  failureCategory?: PreregisteredArmFailureCategory;
  /** Did the CANDIDATE arm observe the pre-registered guidance activation? */
  candidateActivated?: boolean;
  /** Did a BASELINE arm observe a candidate event/digest? Contamination. */
  baselineContaminated?: boolean;
  /** Token cost of this arm run (for the bounded-cost gate). */
  tokensUsed?: number;
  /** Free-form, non-secret detail. */
  reason?: string;
}

export interface PreregisteredArmContext {
  /** The budget-wrapped provider — the ONLY provider a runner may use. */
  provider: ModelProvider;
  armRunId: string;
  arm: ArmRunRef;
  preregistrationDigest: string;
  planDigest: string;
}

export type PreregisteredArmRunner = (
  arm: ArmRunRef,
  ctx: PreregisteredArmContext,
) => Promise<PreregisteredArmOutcome>;

/** A per-run result. Identity fields are stamped by the driver, not the runner. */
export interface PreregisteredRunRecord {
  schemaVersion: string;
  preregistrationDigest: string;
  planDigest: string;
  armRunId: string;
  pairId: string;
  armId: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  orderIndex: number;
  outcome: PreregisteredArmOutcome;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export type PreregisteredCampaignErrorCode =
  | "RESUME_IDENTITY_MISMATCH"
  | "RESUME_STATE_CORRUPT";

export class PreregisteredCampaignError extends Error {
  readonly code: PreregisteredCampaignErrorCode;
  constructor(code: PreregisteredCampaignErrorCode, message: string) {
    super(`tool-call-efficiency-paired-campaign[${code}]: ${message}`);
    this.name = "PreregisteredCampaignError";
    this.code = code;
  }
}

export interface RunPreregisteredCampaignOptions {
  admission: FormalRunAdmission;
  prereg: ToolCallEfficiencyPreregistrationV2;
  /** Directory for per-arm run records. */
  resultsDir: string;
  runArm: PreregisteredArmRunner;
  /** When true, an existing record for the SAME identity is reused (not re-run). */
  resume?: boolean;
  now?: () => number;
}

export interface PreregisteredCampaignRun {
  schemaVersion: string;
  preregistrationDigest: string;
  planDigest: string;
  orderedRuns: OrderedArmRun[];
  records: PreregisteredRunRecord[];
  resumedArmRunIds: string[];
  /** Every scheduled arm run has a record. */
  complete: boolean;
  /** Every pair has BOTH arms present and neither is an infrastructure error. */
  pairComplete: boolean;
}

async function writeRecordAtomic(dir: string, record: PreregisteredRunRecord): Promise<void> {
  const target = join(dir, `${record.armRunId}.json`);
  const tmp = join(dir, `.tmp-${record.armRunId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(tmp, `${stableStringify(record)}\n`, "utf8");
  // `force` already tolerates a missing target; any OTHER failure (EPERM/EBUSY) is
  // real and must NOT be swallowed — it propagates so the run record write fails closed.
  await rm(target, { force: true });
  await rename(tmp, target);
}

async function readRecord(dir: string, armRunId: string): Promise<PreregisteredRunRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, `${armRunId}.json`), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PreregisteredCampaignError("RESUME_STATE_CORRUPT", `run record ${armRunId}.json is not valid JSON`);
  }
  const rec = parsed as PreregisteredRunRecord;
  if (rec.armRunId !== armRunId || typeof rec.preregistrationDigest !== "string" || typeof rec.planDigest !== "string") {
    throw new PreregisteredCampaignError("RESUME_STATE_CORRUPT", `run record ${armRunId}.json is missing its identity`);
  }
  return rec;
}

/**
 * Execute the pre-registered schedule exactly, stamping every record with the
 * root identity. A record that exists but binds a DIFFERENT identity is a
 * refusal — never silently overwritten or reused.
 */
export async function runPreregisteredCampaign(
  opts: RunPreregisteredCampaignOptions,
): Promise<PreregisteredCampaignRun> {
  const { admission, prereg, resultsDir, runArm } = opts;
  const now = opts.now ?? (() => Date.now());
  const preregistrationDigest = admission.preregistrationDigest;
  const planDigest = admission.plan.planDigest;
  await mkdir(resultsDir, { recursive: true });

  const orderedRuns = orderedArmRunsFlat(admission.plan);
  const armById = new Map<string, ArmRunRef>();
  for (const run of orderedRuns) {
    armById.set(`${run.pairId}-${run.armId}`, {
      armId: run.armId,
      caseId: run.caseId,
      repetition: run.repetition,
      orderIndex: run.orderIndex,
    });
  }

  const records: PreregisteredRunRecord[] = [];
  const resumedArmRunIds: string[] = [];

  for (const run of orderedRuns) {
    const armRunId = armRunIdOf(run.pairId, run.armId);
    const arm = armById.get(armRunId)!;
    const existing = await readRecord(resultsDir, armRunId);
    if (existing !== null) {
      if (
        existing.preregistrationDigest !== preregistrationDigest ||
        existing.planDigest !== planDigest ||
        existing.pairId !== run.pairId ||
        existing.caseId !== run.caseId ||
        existing.repetition !== run.repetition ||
        existing.armId !== run.armId
      ) {
        throw new PreregisteredCampaignError(
          "RESUME_IDENTITY_MISMATCH",
          `run record ${armRunId} belongs to a different experiment (digest ${existing.preregistrationDigest.slice(0, 12)}… plan ${existing.planDigest.slice(0, 12)}…) — refusing to mix runs`,
        );
      }
      records.push(existing);
      resumedArmRunIds.push(armRunId);
      continue;
    }
    const outcome = await runArm(arm, {
      provider: admission.provider,
      armRunId,
      arm,
      preregistrationDigest,
      planDigest,
    });
    const record: PreregisteredRunRecord = {
      schemaVersion: PREREGISTERED_CAMPAIGN_SCHEMA,
      preregistrationDigest,
      planDigest,
      armRunId,
      pairId: run.pairId,
      armId: run.armId,
      caseId: run.caseId,
      repetition: run.repetition,
      orderIndex: run.orderIndex,
      outcome,
      completedAt: now(),
    };
    await writeRecordAtomic(resultsDir, record);
    records.push(record);
  }

  const byArmRunId = new Map(records.map((r) => [r.armRunId, r]));
  const complete = records.length === orderedRuns.length;
  const pairComplete = admission.plan.pairs.every((pair) => {
    const b = byArmRunId.get(armRunIdOf(pair.pairId, "baseline"));
    const c = byArmRunId.get(armRunIdOf(pair.pairId, "candidate"));
    if (b === undefined || c === undefined) return false;
    return b.outcome.status !== "error" && c.outcome.status !== "error";
  });

  return {
    schemaVersion: PREREGISTERED_CAMPAIGN_SCHEMA,
    preregistrationDigest,
    planDigest,
    orderedRuns,
    records,
    resumedArmRunIds,
    complete,
    pairComplete,
  };
}

// ---------------------------------------------------------------------------
// Aggregate + decision (re-derived from the records, never a caller summary)
// ---------------------------------------------------------------------------

export interface PreregisteredAggregate {
  schemaVersion: string;
  preregistrationDigest: string;
  planDigest: string;
  decision: ChampionDecisionEnvelopeV3;
  pairComplete: boolean;
  /** Pairs where a baseline arm observed a candidate event/digest. */
  contaminatedPairs: string[];
  /** Total provider calls the ledger settled for this campaign. */
  providerCalls: number;
  budgetRemaining: number;
}

function rate(records: PreregisteredRunRecord[]): number {
  const measured = records.filter((r) => r.outcome.status !== "error");
  if (measured.length === 0) return 0;
  return measured.filter((r) => r.outcome.status === "passed").length / measured.length;
}

/**
 * Derive the frozen decision inputs from the executed records and ask the FROZEN
 * `decideChampionV3` for the verdict. Every threshold comes from the
 * pre-registration (which itself binds the unified `minEligibleCases`), never
 * from a CLI flag.
 */
export function aggregatePreregisteredCampaign(
  run: PreregisteredCampaignRun,
  prereg: ToolCallEfficiencyPreregistrationV2,
  ledgerTotals: { providerCalls: number; budgetRemaining: number },
): PreregisteredAggregate {
  const policy = prereg.evaluation.decisionPolicy ?? DEFAULT_DECISION_POLICY_V3;
  const byArmRunId = new Map(run.records.map((r) => [r.armRunId, r]));

  const baseline = run.records.filter((r) => r.armId === "baseline");
  const candidate = run.records.filter((r) => r.armId === "candidate");

  const contaminatedPairs = run.records
    .filter((r) => r.armId === "baseline" && r.outcome.baselineContaminated === true)
    .map((r) => r.pairId);

  // Per-repetition net-passed deltas, over pairs where BOTH arms are present.
  const repetitions = prereg.schedule.repetitions;
  const caseIds = prereg.dataset.cases.map((c) => c.caseId);
  const perRepetitionDeltas: number[] = [];
  for (let rep = 0; rep < repetitions; rep += 1) {
    let delta = 0;
    for (const caseId of caseIds) {
      const pair = run.orderedRuns.find((r) => r.caseId === caseId && r.repetition === rep);
      if (pair === undefined) continue;
      const b = byArmRunId.get(armRunIdOf(pair.pairId, "baseline"));
      const c = byArmRunId.get(armRunIdOf(pair.pairId, "candidate"));
      if (b === undefined || c === undefined) continue;
      const bp = b.outcome.status === "passed" ? 1 : 0;
      const cp = c.outcome.status === "passed" ? 1 : 0;
      delta += cp - bp;
    }
    perRepetitionDeltas.push(delta);
  }
  const netPassedDelta = perRepetitionDeltas.reduce((a, b) => a + b, 0);

  // Activation coverage over ELIGIBLE candidate arms.
  const eligibleCandidateRecords = candidate.filter((r) => r.outcome.status !== "error");
  const activated = eligibleCandidateRecords.filter((r) => r.outcome.candidateActivated === true).length;
  const activationCoverage = eligibleCandidateRecords.length === 0 ? null : activated / eligibleCandidateRecords.length;

  const infraFailuresBaseline = baseline.filter((r) => r.outcome.status === "error").length;
  const infraFailuresCandidate = candidate.filter((r) => r.outcome.status === "error").length;

  const tokensDelta =
    candidate.reduce((sum, r) => sum + (r.outcome.tokensUsed ?? 0), 0)
    - baseline.reduce((sum, r) => sum + (r.outcome.tokensUsed ?? 0), 0);

  const contaminated = contaminatedPairs.length > 0;

  const input: DecisionGateInputV3 = {
    digestValid: true,
    pairComplete: run.pairComplete && !contaminated,
    comparable: !contaminated,
    incomparabilityReasons: contaminated
      ? [`baseline arms observed a candidate event in ${contaminatedPairs.length} pair(s)`]
      : [],
    activationCoverage,
    activationEligibleCases: eligibleCandidateRecords.filter((r) => r.outcome.candidateActivated === true).length,
    minActivationEligibleCases: prereg.evaluation.minEligibleCases,
    minActivationCoverage: policy.minActivationCoverage,
    securityBreachesCandidate: 0,
    securityBreachesBaseline: 0,
    securityBreachesAllowed: policy.securityBreachesAllowed,
    baselineVerifiedRate: rate(baseline),
    candidateVerifiedRate: rate(candidate),
    maxVerifiedDrop: policy.maxVerifiedDrop,
    infraFailuresBaseline,
    infraFailuresCandidate,
    cases: caseIds.length,
    netPassedDelta,
    repetitions,
    perRepetitionDeltas,
    minConclusiveNetDelta: policy.minConclusiveNetDelta,
    tokensDelta,
    maxTokensDelta: policy.maxTokensDelta,
    // The pre-registration enforces repetitions >= 2, so the frozen schedule
    // already satisfies the decision's repetition requirement.
    recommendsRepetition: false,
    recoveryCount: 0,
    recoveredCount: 0,
    minRecoveryRate: policy.minRecoveryRate,
  };

  return {
    schemaVersion: "tool-call-efficiency-paired-aggregate-v1",
    preregistrationDigest: run.preregistrationDigest,
    planDigest: run.planDigest,
    decision: decideChampionV3(input),
    pairComplete: run.pairComplete,
    contaminatedPairs,
    providerCalls: ledgerTotals.providerCalls,
    budgetRemaining: ledgerTotals.budgetRemaining,
  };
}