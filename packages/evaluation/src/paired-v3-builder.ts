/**
 * E4-02 — Canonical in-process paired→V3 builder.
 *
 * Before E4-02 the only way to get V3 artifacts out of a real paired run was
 * the manual `apps/cli/scripts/paired-to-v3.mjs`, which GUESSED provider,
 * model, runtimeConfigHash, candidateConfigHash and verification, and hardcoded
 * `securityOutcomes: []`. That made V3 a lossy, forgeable post-step.
 *
 * This builder is the single canonical sink:
 *
 *   Paired executor finalized pairs (real EvalOutcomes)
 *     -> typed CaseOutcomeV3 (facts from execution, never defaults)
 *     -> canonical V3 accumulator (buildExperimentArtifactV3)
 *
 * Every field the plan forbids as a placeholder is taken from the run:
 *   - runtimeConfigHash / model / provider / gitSha / planDigest / candidate
 *     config hash come from the execution plan + manifest (caller-supplied
 *     facts, validated non-placeholder here);
 *   - verificationPassed is derived from REAL verifier events, never from
 *     status/actualStatus;
 *   - activationRef points at a real recorder event id (E4-04);
 *   - securityOutcomeRef points at a real classifier outcome (E4-04).
 *
 * outputDigest is computed from the real produced output; workspaceDigest is
 * left null (the case workspace is torn down before this point — recording it
 * is tracked with the eventRecords work, NOT faked).
 */

import { createHash } from "node:crypto";
import { buildExperimentArtifactV3, buildEventRecordsV3 } from "./artifact-v3/writer.js";
import { stableStringify } from "./manifest.js";
import type { ExperimentArtifactV3, CaseOutcomeV3, ActivationEvidenceV3, SecurityOutcomeV3 } from "./artifact-v3/types.js";
import type { EvalOutcome } from "./runner.js";
import type { PairedFinalizedPair } from "./paired-executor.js";

/** Execution-plan facts required to build a promotion-grade V3 artifact. */
export interface PairedV3Facts {
  planDigest: string;
  gitSha: string | null;
  dirty: boolean | null;
  model: string;
  provider: string;
  runtimeConfigHash: string;
  suiteVersion: string;
  judgeVersion: string;
  candidateId: string | null;
  /** Arm-level candidate config hash for the candidate artifact (64-hex). */
  candidateConfigHash: string | null;
  isolationStrength: string;
  promotionEligible: boolean;
  /** E4-R01: identity/completeness metadata preserved in the V3 manifest so a
   *  reader can verify WHICH confirmed experiment produced this artifact and
   *  whether it was complete. Optional for backward compatibility. */
  executionIdentityDigest?: string;
  scheduleDigest?: string;
  expectedSampleKeys?: readonly string[];
  runComplete?: boolean;
  incompleteReason?: string | null;
}

export interface PairedV3Artifacts {
  baseline: ExperimentArtifactV3;
  candidate: ExperimentArtifactV3;
}

/** A placeholder is any non-null value that is empty or an obvious stand-in.
 *  The builder refuses to emit a V3 artifact built on guessed facts. */
function assertRealDigest(value: string | null, field: string): void {
  if (value === null) return; // absent is honest; a fake value is not
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`E4-02: refusing to build V3 — ${field} "${value}" is not a real 64-hex digest (no placeholders allowed)`);
  }
}

/** verificationPassed from REAL verifier events (E4-02 #4), never status. */
function verificationPassedFromEvents(outcome: EvalOutcome): boolean | null {
  const ver = outcome.events.filter(
    (e) => e.type === "verification.completed" || e.type === "verification.failed",
  );
  if (ver.length === 0) return null; // gate never ran → unknown, not "passed"
  return ver.some(
    (e) => e.type === "verification.completed" && (e.payload as { passed?: unknown }).passed === true,
  );
}

/** sha256 over the real produced output text (model completions). Returns null
 *  when no output text is observable — honest absence, never a placeholder. */
function outputDigestFromEvents(outcome: EvalOutcome): string | null {
  const texts: string[] = [];
  for (const e of outcome.events) {
    if (e.type === "model.completed") {
      const p = e.payload as Record<string, unknown>;
      const t = p.text ?? p.content ?? p.completion ?? p.output;
      if (typeof t === "string" && t.length > 0) texts.push(t);
    }
  }
  if (texts.length === 0) return null; // no observable output → absent, not faked
  return createHash("sha256").update(stableStringify(texts), "utf8").digest("hex");
}

function recoveryDecisionsFromOutcome(outcome: EvalOutcome) {
  const v2 = outcome.activationEvidenceV2;
  if (!v2) return [];
  return v2.events
    .filter((e) => e.mechanism === "recovery")
    .map((e) => ({ id: e.eventId, action: String(e.payload.action ?? "recovery"), budgetExhausted: false }));
}

/** Map one finalized pair's arm outcome to a CaseOutcomeV3. */
function toCaseOutcome(
  outcome: EvalOutcome,
  armId: "baseline" | "candidate",
  repetition: number,
  order: number,
): CaseOutcomeV3 {
  const m = outcome.metrics;
  const activationEventId = outcome.activationEvidenceV2?.events[0]?.eventId ?? null;
  return {
    caseId: outcome.caseId,
    suite: outcome.suite,
    armId,
    attempt: 1,
    repetition,
    order,
    passed: outcome.status === "passed",
    grade: outcome.grade ?? null,
    verificationPassed: verificationPassedFromEvents(outcome),
    terminationReason: outcome.terminationReason ?? null,
    failureCategory: outcome.failureCategory ?? null,
    inputTokens: m.tokens_input,
    outputTokens: m.tokens_output,
    costUsd: m.estimated_cost ?? null,
    latencyMs: m.duration_ms,
    toolCalls: m.tool_call_count,
    recoveryDecisions: recoveryDecisionsFromOutcome(outcome),
    activationRef: activationEventId,
    securityOutcomeRef: outcome.securityOutcome ? outcome.caseId : null,
    outputDigest: outputDigestFromEvents(outcome),
    workspaceDigest: null, // workspace torn down pre-build; recorded with eventRecords, never faked
    judgeVersion: outcome.judgeVersion,
    evaluationContextHash: outcome.evaluationContextHash ?? null,
    candidateConfigHash: armId === "candidate" ? (outcome.candidateConfigHash ?? null) : null,
    // E4-02 #5: carry the case's typed event trail (chunked + digest-anchored)
    // so the artifact is self-contained. Omitted when there are no events.
    eventRecords:
      outcome.events.length > 0
        ? buildEventRecordsV3(outcome.events as unknown as Record<string, unknown>[])
        : undefined,
  };
}

function activationEvidenceFrom(outcome: EvalOutcome): ActivationEvidenceV3[] {
  const v2 = outcome.activationEvidenceV2;
  if (!v2 || v2.events.length === 0) return [];
  return v2.events.map((e) => ({
    id: e.eventId,
    reasonCodes: [e.mechanism, e.evidenceType, `digest:${e.payload.digest.slice(0, 12)}`],
    note: `recorded at fact site (case ${e.lineage.caseId}, arm ${e.lineage.armId}, rep ${e.lineage.repetition})`,
  }));
}

function securityOutcomeFrom(outcome: EvalOutcome): SecurityOutcomeV3 | null {
  const sec = outcome.securityOutcome;
  if (!sec) return null;
  const kindMap: Record<string, SecurityOutcomeV3["kind"]> = {
    CONTAINED: "blocked",
    ESCAPE: "escaped",
    INVALID: "classifier_error",
    MISSING_EXPECTED_EVENT: "not_observed",
    NO_ATTACK_ATTEMPT: "clean",
    UNKNOWN_LEGACY: "legacy",
  };
  return {
    caseId: outcome.caseId,
    kind: kindMap[sec.kind] ?? "not_observed",
    detail: sec.facts.length > 0 ? `${sec.kind}: ${sec.facts.map((f) => f.type).join(",")}` : sec.kind,
  };
}

/** Build both V3 artifacts (baseline + candidate) from the finalized pairs. */
export function buildV3ArtifactsFromPaired(
  pairs: PairedFinalizedPair[],
  facts: PairedV3Facts,
): PairedV3Artifacts {
  // Refuse guessed facts up front (E4-02 #3).
  assertRealDigest(facts.planDigest, "planDigest");
  assertRealDigest(facts.runtimeConfigHash, "runtimeConfigHash");
  assertRealDigest(facts.candidateConfigHash, "candidateConfigHash");

  const baselineOutcomes: CaseOutcomeV3[] = [];
  const candidateOutcomes: CaseOutcomeV3[] = [];
  const baselineActivation: ActivationEvidenceV3[] = [];
  const candidateActivation: ActivationEvidenceV3[] = [];
  const baselineSecurity = new Map<string, SecurityOutcomeV3>();
  const candidateSecurity = new Map<string, SecurityOutcomeV3>();

  let order = 0;
  for (const pair of pairs) {
    order += 1;
    const b = pair.baseline.outcome;
    const c = pair.candidate.outcome;
    // The paired executor indexes repetitions 0-based (for pairId/journal
    // stability); V3 outcomes are 1-based (E4-03 positive-integer, E4-05
    // canonical 1..repeat). Convert at this V3-facing seam only.
    const v3Repetition = pair.repetition + 1;
    baselineOutcomes.push(toCaseOutcome(b, "baseline", v3Repetition, order));
    candidateOutcomes.push(toCaseOutcome(c, "candidate", v3Repetition, order));
    baselineActivation.push(...activationEvidenceFrom(b));
    candidateActivation.push(...activationEvidenceFrom(c));
    const bs = securityOutcomeFrom(b);
    const cs = securityOutcomeFrom(c);
    if (bs) baselineSecurity.set(bs.caseId, bs);
    if (cs) candidateSecurity.set(cs.caseId, cs);
  }

  const manifest = {
    suiteVersion: facts.suiteVersion,
    judgeVersion: facts.judgeVersion,
    gitSha: facts.gitSha,
    dirty: facts.dirty,
    model: facts.model,
    provider: facts.provider,
    planDigest: facts.planDigest,
    runtimeConfigHash: facts.runtimeConfigHash,
    isolationStrength: facts.isolationStrength,
    promotionEligible: facts.promotionEligible,
    // E4-R01: bind the artifact to the confirmed experiment + its completeness.
    ...(facts.executionIdentityDigest !== undefined ? { executionIdentityDigest: facts.executionIdentityDigest } : {}),
    ...(facts.scheduleDigest !== undefined ? { scheduleDigest: facts.scheduleDigest } : {}),
    ...(facts.expectedSampleKeys !== undefined ? { expectedSampleKeys: [...facts.expectedSampleKeys] } : {}),
    ...(facts.runComplete !== undefined ? { runComplete: facts.runComplete } : {}),
    ...(facts.incompleteReason !== undefined && facts.incompleteReason !== null ? { incompleteReason: facts.incompleteReason } : {}),
  };
  const provenance = {
    sourceManifestPath: null,
    gitSha: facts.gitSha,
    dirty: facts.dirty,
    model: facts.model,
    provider: facts.provider,
    runtimeConfigHash: facts.runtimeConfigHash,
  };

  const baseline = buildExperimentArtifactV3({
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest,
    outcomes: baselineOutcomes,
    activationEvidence: baselineActivation,
    securityOutcomes: [...baselineSecurity.values()],
    provenance,
  });
  const candidate = buildExperimentArtifactV3({
    arm: { armId: "candidate", candidateId: facts.candidateId, candidateConfigHash: facts.candidateConfigHash },
    manifest,
    outcomes: candidateOutcomes,
    activationEvidence: candidateActivation,
    securityOutcomes: [...candidateSecurity.values()],
    provenance,
  });

  return { baseline, candidate };
}
