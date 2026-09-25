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

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider } from "@ar/contracts";
import { stableStringify } from "./manifest.js";
import { armRunIdOf, orderedArmRunsFlat, type OrderedArmRun } from "./paired-executor.js";
import type { ArmRunRef } from "./paired-plan.js";
import {
  PREREG_RUN_EVIDENCE_DIRNAME,
  verifyArmEvidenceFromArtifacts,
  type PreregRunIdentity,
} from "./prereg-run-evidence.js";
import {
  decideChampionV3,
  type ChampionDecisionEnvelopeV3,
  type DecisionGateInputV3,
} from "./champion-decision-v3.js";
import { DEFAULT_DECISION_POLICY_V3 } from "./decision-policy-v3.js";
import { PREREG_V2_MIN_REPETITIONS, type ToolCallEfficiencyPreregistrationV2 } from "./tool-call-efficiency-preregistration-v2.js";
import type { FormalRunAdmission } from "./tool-call-efficiency-formal-run.js";

export const PREREGISTERED_CAMPAIGN_SCHEMA = "tool-call-efficiency-paired-campaign-v1";

// ---------------------------------------------------------------------------
// Arm outcome (what a runner reports; identity is added by THIS module)
// ---------------------------------------------------------------------------

export type PreregisteredArmFailureCategory = "model" | "harness" | "judge" | "infrastructure";

/**
 * F2/S4 — the OBJECTIVE, per-run evidence a runner must return. The decision
 * layer derives `passed`/activation/security from THIS, never from a bare
 * runner boolean: a runner that only asserts "passed" (or "activated") without
 * an executor identity, a trace digest and a real verifier verdict cannot
 * produce an ACCEPT.
 *
 * (This raises the bar from "trust 32 booleans" to "every record must carry
 * auditable evidence"; binding that evidence to the trusted execution
 * manifest/ledger is the remaining S4 item and is NOT claimed here.)
 */
export interface PreregisteredArmEvidence {
  /** Identity of the executor that produced this run's result. */
  executorId: string;
  /** sha256 (64-hex) of the immutable per-run trace/artifact. */
  traceDigest: string;
  /** The REAL verifier's completion verdict for THIS run. A `passed` status is
   *  ignored unless this is true. */
  verifiedCompletion: boolean;
  /** Security events the executor observed for THIS run (>= 0). */
  securityViolations: number;
  /** Request-bound activation evidence digest. Non-null ONLY when this run
   *  observed the pre-registered mechanism activation (candidate) — and, for a
   *  baseline run, a non-null value means CONTAMINATION. */
  activationEvidenceDigest: string | null;
  /** Stall recoveries OBSERVED for this run (optional; offline adapters report 0). */
  recoveries?: number;
  /** Recoveries that succeeded (optional). */
  recovered?: number;
}

export interface PreregisteredArmOutcome {
  status: "passed" | "failed" | "error";
  /** Present for `status: "error"`. Infrastructure/harness/judge/model failures
   *  are excluded from the pair (never silently counted as a task failure). */
  failureCategory?: PreregisteredArmFailureCategory;
  /** Token cost of this arm run (for the bounded-cost gate). */
  tokensUsed?: number;
  /** Free-form, non-secret detail. */
  reason?: string;
  /** The DECLARED evidence for a non-error run. REQUIRED for `passed`/`failed`;
   *  absent for `error` (a failed infrastructure run has no verifier verdict).
   *  A6: every field here is corroborated against the raw artifacts the runner
   *  wrote into the driver-created evidence directory — an unsupported claim is
   *  UNVERIFIED, never trusted. */
  evidence?: PreregisteredArmEvidence;
}

export interface PreregisteredArmContext {
  /** The budget-wrapped provider — the ONLY provider a runner may use. */
  provider: ModelProvider;
  armRunId: string;
  arm: ArmRunRef;
  preregistrationDigest: string;
  planDigest: string;
  /** A6 — the driver-created directory this run's raw artifacts MUST be written
   *  to (manifest.json / verifier.json / activation.json / security.json). */
  evidenceDir: string;
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
  /** A6 — TRUE only when the raw artifacts in this run's evidence directory were
   *  read back and corroborate the declared evidence. Stamped by the DRIVER from
   *  bytes, never supplied by the runner; a forged claim is `false` → INVALID. */
  evidenceVerified: boolean;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export type PreregisteredCampaignErrorCode =
  | "RESUME_IDENTITY_MISMATCH"
  | "RESUME_STATE_CORRUPT"
  | "RESUME_STATE_UNEXPECTED_FILE"
  | "RESUME_NOT_REQUESTED"
  | "RUN_EVIDENCE_INVALID";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * F2/S4 — the problems that make a run's declared evidence well-formed. EMPTY
 * means the evidence is shaped correctly (an executor identity, a 64-hex trace
 * digest, a boolean verifier verdict, a non-negative security count and a
 * null-or-digest activation reference). An `error` outcome carries NO evidence,
 * so it has no shape problems (it is excluded from the pair, not judged).
 *
 * This is the SHAPE gate only; corroborating the shape against raw bytes is
 * A6's `verifyArmEvidenceFromArtifacts`.
 */
export function armEvidenceProblems(
  e: PreregisteredArmEvidence | undefined,
  status?: "passed" | "failed" | "error",
): string[] {
  if (status === "error") return [];
  if (e === undefined || typeof e !== "object") return ["evidence object is missing"];
  const problems: string[] = [];
  if (typeof e.executorId !== "string" || e.executorId.length === 0) problems.push("executorId must be a non-empty string");
  if (typeof e.traceDigest !== "string" || !SHA256_HEX.test(e.traceDigest)) problems.push("traceDigest must be a 64-hex sha256");
  if (typeof e.verifiedCompletion !== "boolean") problems.push("verifiedCompletion must be a boolean");
  if (!Number.isSafeInteger(e.securityViolations) || e.securityViolations < 0) problems.push("securityViolations must be a non-negative integer");
  if (e.activationEvidenceDigest !== null && (typeof e.activationEvidenceDigest !== "string" || !SHA256_HEX.test(e.activationEvidenceDigest))) {
    problems.push("activationEvidenceDigest must be null or a 64-hex sha256");
  }
  return problems;
}

function assertArmEvidence(e: PreregisteredArmEvidence | undefined, armRunId: string, status: "passed" | "failed" | "error"): void {
  const problems = armEvidenceProblems(e, status);
  if (problems.length > 0) {
    throw new PreregisteredCampaignError("RUN_EVIDENCE_INVALID", `run ${armRunId}: ${problems.join("; ")}`);
  }
}

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
  // F2/S4: a resumed record is only reusable if its EVIDENCE is still shaped
  // correctly — a tampered outcome must not be silently adopted. (A6 re-derives
  // whether the bytes behind it still corroborate the claim, in the caller.)
  assertArmEvidence(rec.outcome?.evidence, armRunId, rec.outcome?.status ?? "error");
  return rec;
}

/** The exact identity every artifact and record of a run must agree on. */
function identityOf(
  preregistrationDigest: string,
  planDigest: string,
  run: OrderedArmRun,
): PreregRunIdentity {
  return {
    preregistrationDigest,
    planDigest,
    armRunId: armRunIdOf(run.pairId, run.armId),
    armId: run.armId,
    caseId: run.caseId,
    repetition: run.repetition,
    orderIndex: run.orderIndex,
  };
}

/**
 * F5/A6 — the resume/state integrity scan. It runs BEFORE any arm is adopted or
 * executed and refuses the two cases a naive resume gets wrong:
 *
 *   - a results directory that already holds run records while the caller did
 *     NOT ask to resume (`RESUME_NOT_REQUESTED`) — a first run must not silently
 *     adopt someone else's records;
 *   - an entry the frozen plan did not write — a foreign/extra file
 *     (`RESUME_STATE_UNEXPECTED_FILE`), which would otherwise be invisible.
 */
async function assertResultsDirIntegrity(
  resultsDir: string,
  expectedFiles: ReadonlySet<string>,
  resume: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const recordFiles = entries.filter((e) => e.endsWith(".json"));
  if (!resume && recordFiles.length > 0) {
    throw new PreregisteredCampaignError(
      "RESUME_NOT_REQUESTED",
      `the results directory already holds ${recordFiles.length} run record(s) but this run did not request a resume — refusing to adopt them`,
    );
  }
  const allowed = new Set<string>([...expectedFiles, PREREG_RUN_EVIDENCE_DIRNAME]);
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      throw new PreregisteredCampaignError(
        "RESUME_STATE_UNEXPECTED_FILE",
        `the results directory holds "${entry}", which the frozen plan did not write — refusing to resume over unaccounted state`,
      );
    }
  }
}

/**
 * Execute the pre-registered schedule exactly, stamping every record with the
 * root identity. A record that exists but binds a DIFFERENT identity — including
 * a different `orderIndex` — is a refusal, never silently overwritten or reused.
 * Every freshly produced record is stamped with `evidenceVerified`, derived by
 * reading the run's raw artifacts; a forged claim is recorded as UNVERIFIED and
 * (through the aggregate) can never reach ACCEPT.
 */
export async function runPreregisteredCampaign(
  opts: RunPreregisteredCampaignOptions,
): Promise<PreregisteredCampaignRun> {
  const { admission, prereg, resultsDir, runArm } = opts;
  const resume = opts.resume === true;
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
  const evidenceRoot = join(resultsDir, PREREG_RUN_EVIDENCE_DIRNAME);
  const expectedFiles = new Set(orderedRuns.map((r) => `${armRunIdOf(r.pairId, r.armId)}.json`));
  await assertResultsDirIntegrity(resultsDir, expectedFiles, resume);

  const records: PreregisteredRunRecord[] = [];
  const resumedArmRunIds: string[] = [];

  for (const run of orderedRuns) {
    const armRunId = armRunIdOf(run.pairId, run.armId);
    const arm = armById.get(armRunId)!;
    const identity = identityOf(preregistrationDigest, planDigest, run);
    const evidenceDir = join(evidenceRoot, armRunId);
    const existing = await readRecord(resultsDir, armRunId);
    if (existing !== null) {
      if (
        existing.preregistrationDigest !== preregistrationDigest ||
        existing.planDigest !== planDigest ||
        existing.pairId !== run.pairId ||
        existing.caseId !== run.caseId ||
        existing.repetition !== run.repetition ||
        existing.armId !== run.armId ||
        existing.orderIndex !== run.orderIndex
      ) {
        throw new PreregisteredCampaignError(
          "RESUME_IDENTITY_MISMATCH",
          `run record ${armRunId} belongs to a different experiment (digest ${existing.preregistrationDigest.slice(0, 12)}… plan ${existing.planDigest.slice(0, 12)}…) — refusing to mix runs`,
        );
      }
      // A6 — a resumed record's evidence is re-derived from its raw artifacts,
      // with the SAME validator the fresh path uses; a deleted/tampered artifact
      // demotes the record to UNVERIFIED rather than adopting the old claim.
      const verified =
        existing.outcome.status === "error" || existing.outcome.evidence === undefined
          ? existing.outcome.status === "error"
          : verifyArmEvidenceFromArtifacts(evidenceDir, identity, existing.outcome.evidence).verified;
      records.push({ ...existing, evidenceVerified: verified });
      resumedArmRunIds.push(armRunId);
      continue;
    }
    const outcome = await runArm(arm, {
      provider: admission.provider,
      armRunId,
      arm,
      preregistrationDigest,
      planDigest,
      evidenceDir,
    });
    // F2/S4: refuse a result whose evidence is missing/malformed AT RECORD TIME,
    // so a bare-boolean outcome never even reaches the aggregate.
    assertArmEvidence(outcome.evidence, armRunId, outcome.status);
    // A6 — corroborate the claim by reading the raw artifacts back. An `error`
    // outcome has no evidence to verify; a non-error outcome with no artifacts
    // is stamped UNVERIFIED (never trusted).
    const evidenceVerified =
      outcome.status === "error"
        ? true
        : outcome.evidence !== undefined &&
          verifyArmEvidenceFromArtifacts(evidenceDir, identity, outcome.evidence).verified;
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
      evidenceVerified,
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

/**
 * A run only counts as PASSED when BOTH the runner's status and the REAL
 * verifier's completion verdict agree. A bare `status: "passed"` with
 * `verifiedCompletion: false` is counted as a failure (F2/S4) — the decision
 * layer never trusts the runner's own boolean.
 */
function verifiedPass(r: PreregisteredRunRecord): boolean {
  return r.outcome.status === "passed" && r.outcome.evidence?.verifiedCompletion === true;
}

function rate(records: PreregisteredRunRecord[]): number {
  const measured = records.filter((r) => r.outcome.status !== "error");
  if (measured.length === 0) return 0;
  return measured.filter(verifiedPass).length / measured.length;
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

  // F2/S4 — CONTAMINATION is a non-null activation-evidence digest on a
  // BASELINE record, not a self-reported flag.
  const contaminatedPairs = run.records
    .filter((r) => r.armId === "baseline" && (r.outcome.evidence?.activationEvidenceDigest ?? null) !== null)
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
      const bp = verifiedPass(b) ? 1 : 0;
      const cp = verifiedPass(c) ? 1 : 0;
      delta += cp - bp;
    }
    perRepetitionDeltas.push(delta);
  }
  const netPassedDelta = perRepetitionDeltas.reduce((a, b) => a + b, 0);

  // F2/S4 — activation is a request-bound evidence digest on a CANDIDATE record,
  // not a self-reported boolean.
  const eligibleCandidateRecords = candidate.filter((r) => r.outcome.status !== "error");
  const activated = eligibleCandidateRecords.filter((r) => (r.outcome.evidence?.activationEvidenceDigest ?? null) !== null).length;
  const activationCoverage = eligibleCandidateRecords.length === 0 ? null : activated / eligibleCandidateRecords.length;

  const infraFailuresBaseline = baseline.filter((r) => r.outcome.status === "error").length;
  const infraFailuresCandidate = candidate.filter((r) => r.outcome.status === "error").length;

  const tokensDelta =
    candidate.reduce((sum, r) => sum + (r.outcome.tokensUsed ?? 0), 0)
    - baseline.reduce((sum, r) => sum + (r.outcome.tokensUsed ?? 0), 0);

  const contaminated = contaminatedPairs.length > 0;

  // F2/S4 — every gate input is DERIVED from the records' evidence. Nothing here
  // is hardcoded to `true`/`0`: a single malformed evidence record makes the
  // whole campaign INVALID, a security event blocks ACCEPT, and the repetition
  // recommendation follows the pre-registered minimum.
  //
  // A6 — `digestValid` is NOT the shape check alone: the evidence must ALSO have
  // been corroborated against the raw artifacts the executor wrote
  // (`record.evidenceVerified`). A well-SHAPED forgery (`"a".repeat(64)` with no
  // manifest/verifier/activation bytes on disk) is stamped `false` by the driver,
  // so it fails `artifactIntegrity` → INVALID and can never reach ACCEPT.
  const digestValid = run.records.every(
    (r) => r.evidenceVerified && armEvidenceProblems(r.outcome.evidence, r.outcome.status).length === 0,
  );
  const securityBreachesCandidate = candidate.reduce((s, r) => s + (r.outcome.evidence?.securityViolations ?? 0), 0);
  const securityBreachesBaseline = baseline.reduce((s, r) => s + (r.outcome.evidence?.securityViolations ?? 0), 0);
  const recoveryCount = run.records.reduce((s, r) => s + (r.outcome.evidence?.recoveries ?? 0), 0);
  const recoveredCount = run.records.reduce((s, r) => s + (r.outcome.evidence?.recovered ?? 0), 0);

  const input: DecisionGateInputV3 = {
    digestValid,
    pairComplete: run.pairComplete && !contaminated,
    comparable: !contaminated,
    incomparabilityReasons: contaminated
      ? [`baseline arms observed a candidate event in ${contaminatedPairs.length} pair(s)`]
      : [],
    activationCoverage,
    activationEligibleCases: activated,
    minActivationEligibleCases: prereg.evaluation.minEligibleCases,
    minActivationCoverage: policy.minActivationCoverage,
    securityBreachesCandidate,
    securityBreachesBaseline,
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
    // Derived from the pre-registered repetition minimum (which the builder
    // enforces at >= PREREG_V2_MIN_REPETITIONS) — not a literal `false`.
    recommendsRepetition: repetitions < PREREG_V2_MIN_REPETITIONS,
    recoveryCount,
    recoveredCount,
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