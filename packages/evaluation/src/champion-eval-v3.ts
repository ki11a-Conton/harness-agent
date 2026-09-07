/**
 * E3-06 — V3 champion eval: derive DecisionGateInputV3 from canonical V3
 * artifacts and emit a DecisionArtifactV3.
 *
 * The V3 path is the ONLY strict promotion path. Legacy AR2 artifacts produce
 * INVALID with reason "LEGACY_NOT_PROMOTION_ELIGIBLE" — they cannot be used
 * for strict promotion.
 *
 * Every gate value is DERIVED from the artifact outcomes — no caller-supplied
 * booleans. The public entry accepts artifact PATHS only and returns a
 * content-addressed DecisionArtifactV3 bound to both artifact digests.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableStringify } from "./manifest.js";
import { classifyArtifact, parseExperimentArtifactV3 } from "./artifact-v3/schema.js";
import { evaluatePairing } from "./paired-key.js";
import {
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  validateDecisionPolicyV3,
  type DecisionPolicyV3,
} from "./decision-policy-v3.js";
import type { ExperimentArtifactV3 } from "./artifact-v3/types.js";
import {
  decideChampionV3,
  type DecisionGateInputV3,
  type ChampionDecisionEnvelopeV3,
} from "./champion-decision-v3.js";

export const CHAMPION_EVAL_V3_POLICY_VERSION = "e3-06-policy-v1";
export const DECISION_ARTIFACT_V3_SCHEMA_VERSION = "3.0.0";
/** E4-06 #4: identity of the pure evaluator that produced a DecisionArtifactV3.
 *  The promotion loader replays with THIS evaluator and rejects artifacts from
 *  a different one, so a decision cannot be laundered across an incompatible
 *  evaluator change. */
export const DECISION_EVALUATOR_VERSION = "e4-06-evaluator-v1";

// ---------------------------------------------------------------------------
// DecisionArtifactV3
// ---------------------------------------------------------------------------

export interface DecisionArtifactV3 {
  schemaVersion: string;
  policyVersion: string;
  /** E4-05 #5: sha256 over the applied DecisionPolicyV3 (thresholds). */
  thresholdDigest: string;
  /** E4-06 #4: the FULL applied policy, embedded so the promotion loader can
   *  replay the evaluator deterministically and verify thresholdDigest. */
  policy: DecisionPolicyV3;
  /** E4-06 #4: which pure evaluator produced this artifact. */
  evaluatorVersion: string;
  candidateId: string | null;
  /** Plan digest from the candidate artifact manifest (nullable). */
  planDigest: string | null;
  /** Baseline artifact content digest (sha256 of canonical on-disk text). */
  baselineArtifactDigest: string;
  /** Candidate artifact content digest. */
  candidateArtifactDigest: string;
  /** Artifact-level decision (ACCEPT/REJECT/INCONCLUSIVE/INVALID). */
  decision: string;
  reasonCodes: string[];
  gates: Record<string, boolean>;
  statistics: Record<string, unknown>;
  /** Per-repetition net-passed deltas (length must === repetitions). */
  perRepetitionDeltas: number[];
  repetitions: number;
  /** Content digest excludes self and generatedAtIso. */
  contentDigest: string;
  generatedAtIso: string;
}

function computeDecisionDigest(base: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(base), "utf8").digest("hex").slice(0, 24);
}

/**
 * E4-06 #1 — recompute a stored DecisionArtifactV3's content digest from its
 * own fields (self-excluding contentDigest + generatedAtIso), so a loader can
 * prove the artifact was not hand-edited. A present-but-wrong digest (the
 * pre-E4-06 loader only checked presence) is caught here.
 */
export function computeDecisionArtifactContentDigestV3(artifact: Record<string, unknown>): string {
  const { contentDigest: _c, generatedAtIso: _g, ...base } = artifact;
  return computeDecisionDigest(base as Record<string, unknown>);
}

export function buildDecisionArtifactV3(
  envelope: ChampionDecisionEnvelopeV3,
  baselineDigest: string,
  candidateDigest: string,
  candidateId: string | null,
  planDigest: string | null,
  perRepetitionDeltas: number[],
  policy: DecisionPolicyV3 = DEFAULT_DECISION_POLICY_V3,
): DecisionArtifactV3 {
  const base: Omit<DecisionArtifactV3, "contentDigest" | "generatedAtIso"> = {
    schemaVersion: DECISION_ARTIFACT_V3_SCHEMA_VERSION,
    policyVersion: policy.version,
    thresholdDigest: computeThresholdDigestV3(policy),
    policy,
    evaluatorVersion: DECISION_EVALUATOR_VERSION,
    candidateId,
    planDigest,
    baselineArtifactDigest: baselineDigest,
    candidateArtifactDigest: candidateDigest,
    decision: envelope.decision,
    reasonCodes: envelope.reasonCodes,
    gates: envelope.gates as unknown as Record<string, boolean>,
    statistics: envelope.statistics as unknown as Record<string, unknown>,
    perRepetitionDeltas,
    repetitions: envelope.statistics.repetitions,
  };
  return {
    ...base,
    generatedAtIso: envelope.generatedAtIso,
    contentDigest: computeDecisionDigest(base as unknown as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// V3 artifact pair loader (paths only — never caller booleans)
// ---------------------------------------------------------------------------

export interface V3ArtifactPair {
  baseline: ExperimentArtifactV3;
  candidate: ExperimentArtifactV3;
  /** sha256 of the canonical on-disk content. */
  baselineDigest: string;
  candidateDigest: string;
}

/** Load two artifacts as a V3 pair. If either is not V3, throws
 *  LEGACY_NOT_PROMOTION_ELIGIBLE. */
export async function loadV3ArtifactPair(
  baselinePath: string,
  candidatePath: string,
): Promise<V3ArtifactPair> {
  const rawBase = await readFile(baselinePath, "utf8");
  const rawCand = await readFile(candidatePath, "utf8");
  const baseParsed = JSON.parse(rawBase) as unknown;
  const candParsed = JSON.parse(rawCand) as unknown;
  const baseClass = classifyArtifact(baseParsed);
  const candClass = classifyArtifact(candParsed);
  if (baseClass.kind !== "v3" || candClass.kind !== "v3") {
    throw new Error(
      `LEGACY_NOT_PROMOTION_ELIGIBLE: baseline=${baseClass.kind} candidate=${candClass.kind} — V3 artifacts required for strict promotion`,
    );
  }
  const baseline = parseExperimentArtifactV3(baseParsed);
  const candidate = parseExperimentArtifactV3(candParsed);
  const baselineDigest = createHash("sha256").update(rawBase.trim(), "utf8").digest("hex");
  const candidateDigest = createHash("sha256").update(rawCand.trim(), "utf8").digest("hex");
  return { baseline, candidate, baselineDigest, candidateDigest };
}

/** Provenance refs comparability (E3-06: derived from the artifact itself).
 *  Both refs must be fully known (no nulls) and identical on the fields that
 *  must match: gitSha/dirty/model/provider/runtimeConfigHash. Unknown identity
 *  is never comparable. */
export function provenanceRefsComparableV3(
  baseline: ExperimentArtifactV3,
  candidate: ExperimentArtifactV3,
): { comparable: boolean; reasons: string[] } {
  const b = baseline.provenance;
  const c = candidate.provenance;
  const reasons: string[] = [];
  const known = (p: { gitSha: string | null; model: string | null; provider: string | null; runtimeConfigHash: string | null }) =>
    p.gitSha !== null && p.model !== null && p.provider !== null && p.runtimeConfigHash !== null;
  if (!known(b)) reasons.push("baseline provenance UNKNOWN_IDENTITY (null fields)");
  if (!known(c)) reasons.push("candidate provenance UNKNOWN_IDENTITY (null fields)");
  if (b.gitSha !== c.gitSha) reasons.push("gitSha mismatch");
  if (b.model !== c.model) reasons.push("model mismatch");
  if (b.provider !== c.provider) reasons.push("provider mismatch");
  if (b.runtimeConfigHash !== c.runtimeConfigHash) reasons.push("runtimeConfigHash mismatch");
  if (reasons.length > 0) return { comparable: false, reasons };
  return { comparable: true, reasons };
}

// ---------------------------------------------------------------------------
// Gate derivation from V3 artifacts
// ---------------------------------------------------------------------------

export interface V3ChampionEvalResult {
  /** The decision envelope. */
  envelope: ChampionDecisionEnvelopeV3;
  /** The derived gate inputs (for audit/recomputability). */
  derivedInputs: DecisionGateInputV3;
  /** The content-addressed decision artifact. */
  decisionArtifact: DecisionArtifactV3;
}

/**
 * E3-06: derive DecisionGateInputV3 from a loaded V3 pair and run the
 * decision. Every gate is derived from the artifact outcomes — no caller
 * booleans.
 */
export function deriveV3Decision(
  pair: V3ArtifactPair,
  candidateId: string | null,
  planDigest: string | null,
  policy: DecisionPolicyV3 = DEFAULT_DECISION_POLICY_V3,
): V3ChampionEvalResult {
  const { baseline, candidate } = pair;

  // 1. Integrity: both artifacts were loaded via the strict V3 loader, which
  //    already validated schema + summary + contentDigest binding.
  const digestValid = true;

  // 2. Provenance comparability (artifact-derived).
  const prov = provenanceRefsComparableV3(baseline, candidate);
  const incomparabilityReasons = prov.comparable ? [] : prov.reasons;

  // 3. E4-05: EXACT pairing on canonical (suite, caseId, repetition) keys.
  //    Duplicate / missing / extra PairKeys and out-of-range repetitions are
  //    violations (never a silent Map<caseId> overwrite). All deltas below are
  //    computed over PAIRED keys only — a missing twin is never 0-filled.
  const pairing = evaluatePairing(baseline.outcomes, candidate.outcomes);

  // 3b. E4-05 #4/#5: thresholds come from the pre-registered policy. The
  //     manifest's recorded thresholdDigest must match the policy actually
  //     applied (tamper detection), and manifest.repeat must match the observed
  //     repetitions (three-way plan / manifest / outcome consistency). Any
  //     mismatch is a protocol violation → not pair-complete → INVALID.
  const thresholdDigest = computeThresholdDigestV3(policy);
  const policyViolations: string[] = [];
  const manifestThresholdDigest = candidate.manifest["thresholdDigest"];
  if (typeof manifestThresholdDigest === "string" && manifestThresholdDigest !== thresholdDigest) {
    policyViolations.push(
      `manifest.thresholdDigest ${manifestThresholdDigest} != applied policy digest ${thresholdDigest} (thresholds tampered or policy not from the plan)`,
    );
  }
  const manifestRepeat = candidate.manifest["repeat"];
  if (typeof manifestRepeat === "number" && manifestRepeat !== pairing.repetitions) {
    policyViolations.push(
      `manifest.repeat ${manifestRepeat} != observed repetitions ${pairing.repetitions} (plan/manifest/outcome disagree)`,
    );
  }
  const pairComplete = pairing.pairComplete && policyViolations.length === 0;

  // 4. Activation coverage: fraction of candidate cases carrying an
  //    activationRef (real activation evidence payload).
  const activated = candidate.outcomes.filter((o) => o.activationRef !== null).length;
  const totalCases = candidate.outcomes.length;
  const activationCoverage = totalCases > 0 ? activated / totalCases : null;

  // 5. Security breaches: typed security outcomes that escaped or breached.
  const breachKinds = new Set(["escaped", "attack_attempted", "unauthorized_effect"]);
  const securityBreachesCandidate = candidate.securityOutcomes.filter((s) => breachKinds.has(s.kind)).length;
  const securityBreachesBaseline = baseline.securityOutcomes.filter((s) => breachKinds.has(s.kind)).length;

  // 6. Verified-completion rates.
  const baselineVerified = baseline.outcomes.filter((o) => o.verificationPassed === true).length;
  const candidateVerified = candidate.outcomes.filter((o) => o.verificationPassed === true).length;
  const baselineVerifiedRate = baseline.outcomes.length > 0 ? baselineVerified / baseline.outcomes.length : 0;
  const candidateVerifiedRate = candidate.outcomes.length > 0 ? candidateVerified / candidate.outcomes.length : 0;

  // 7. Infra/runtime asymmetry.
  const infraFailuresBaseline = baseline.outcomes.filter((o) => o.failureCategory === "infrastructure").length;
  const infraFailuresCandidate = candidate.outcomes.filter((o) => o.failureCategory === "infrastructure").length;

  // 8-10. E4-05: paired net-passed delta, repetitions, and per-repetition
  //       deltas all come from the exact pairing (paired keys only, no 0-fill;
  //       per-repetition computed over the same case set at each rep).
  const netPassedDelta = pairing.netPassedDelta;
  const repetitions = pairing.repetitions;
  const perRepetitionDeltas = pairing.perRepetitionDeltas;

  // 11. Token delta.
  const sumTokens = (os: { inputTokens: number; outputTokens: number }[]) =>
    os.reduce((s, o) => s + o.inputTokens + o.outputTokens, 0);
  const tokensDelta = sumTokens(candidate.outcomes) - sumTokens(baseline.outcomes);

  const inputs: DecisionGateInputV3 = {
    digestValid,
    pairComplete,
    comparable: prov.comparable,
    incomparabilityReasons,
    activationCoverage,
    activationEligibleCases: activated,
    minActivationEligibleCases: policy.minActivationEligibleCases,
    minActivationCoverage: policy.minActivationCoverage,
    securityBreachesCandidate,
    securityBreachesBaseline,
    securityBreachesAllowed: policy.securityBreachesAllowed,
    baselineVerifiedRate,
    candidateVerifiedRate,
    maxVerifiedDrop: policy.maxVerifiedDrop,
    infraFailuresBaseline,
    infraFailuresCandidate,
    cases: pairing.cases,
    netPassedDelta,
    repetitions,
    perRepetitionDeltas,
    pairingViolations: [...pairing.violations, ...policyViolations],
    minConclusiveNetDelta: policy.minConclusiveNetDelta,
    tokensDelta,
    maxTokensDelta: policy.maxTokensDelta,
    recommendsRepetition: repetitions < 2,
  };

  // E3-06 acceptance #3: repetitions must match per-repetition delta length.
  // Derived values ALWAYS satisfy this, but a defensive check keeps it true
  // even if a future caller bypasses the derivation.
  if (inputs.perRepetitionDeltas.length !== inputs.repetitions) {
    inputs.digestValid = false;
  }

  const envelope = decideChampionV3(inputs);
  const decisionArtifact = buildDecisionArtifactV3(
    envelope,
    pair.baselineDigest,
    pair.candidateDigest,
    candidateId,
    planDigest,
    perRepetitionDeltas,
    policy,
  );

  return { envelope, derivedInputs: inputs, decisionArtifact };
}

/**
 * E4-06 #4/#5 — replay the pure evaluator on the strict-loaded V3 pair and
 * compare the FULL decision payload to the stored DecisionArtifact. A hand-
 * forged `{"decision":"ACCEPT"}` over a pair that actually fails a hard gate
 * (security breach, incomparability, incomplete pairing) is caught here, as is
 * a tampered thresholdDigest (must equal the digest of the embedded policy).
 * Returns violation strings (empty when the replay reproduces the stored
 * decision exactly).
 */
export function verifyDecisionArtifactReplayV3(
  baseline: ExperimentArtifactV3,
  candidate: ExperimentArtifactV3,
  stored: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  if (stored["evaluatorVersion"] !== DECISION_EVALUATOR_VERSION) {
    violations.push(`stored evaluatorVersion ${String(stored["evaluatorVersion"])} != current ${DECISION_EVALUATOR_VERSION} (decision not reproducible by this evaluator)`);
  }
  let policy: DecisionPolicyV3;
  try {
    policy = validateDecisionPolicyV3(stored["policy"]);
  } catch (err) {
    violations.push(`stored decision policy invalid: ${err instanceof Error ? err.message : String(err)}`);
    return violations;
  }
  if (stored["thresholdDigest"] !== computeThresholdDigestV3(policy)) {
    violations.push(`stored thresholdDigest ${String(stored["thresholdDigest"])} != digest(embedded policy) (thresholds tampered)`);
  }
  const candidateId = typeof stored["candidateId"] === "string" ? (stored["candidateId"] as string) : null;
  const planDigest = typeof stored["planDigest"] === "string" ? (stored["planDigest"] as string) : null;
  const pair: V3ArtifactPair = {
    baseline,
    candidate,
    baselineDigest: String(stored["baselineArtifactDigest"] ?? ""),
    candidateDigest: String(stored["candidateArtifactDigest"] ?? ""),
  };
  const replay = deriveV3Decision(pair, candidateId, planDigest, policy);
  const da = replay.decisionArtifact;
  const eq = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
  if (da.decision !== stored["decision"]) {
    violations.push(`replayed decision ${da.decision} != stored ${String(stored["decision"])}`);
  }
  if (!eq(da.reasonCodes, stored["reasonCodes"])) violations.push("replayed reasonCodes != stored");
  if (!eq(da.gates, stored["gates"])) violations.push("replayed gates != stored");
  if (!eq(da.statistics, stored["statistics"])) violations.push("replayed statistics != stored");
  if (!eq(da.perRepetitionDeltas, stored["perRepetitionDeltas"])) violations.push("replayed perRepetitionDeltas != stored");
  if (da.repetitions !== stored["repetitions"]) {
    violations.push(`replayed repetitions ${da.repetitions} != stored ${String(stored["repetitions"])}`);
  }
  return violations;
}

/** Full public entry: accepts artifact PATHS only and returns the decision
 *  artifact + human report lines. Never accepts caller-supplied gates. */
export async function runV3ChampionEval(opts: {
  baselinePath: string;
  candidatePath: string;
  candidateId?: string | null;
}): Promise<V3ChampionEvalResult> {
  const pair = await loadV3ArtifactPair(opts.baselinePath, opts.candidatePath);
  const planDigest = (pair.candidate.manifest["planDigest"] as string | undefined) ?? null;
  // E4-05 #6: the evaluator receives the FULL validated policy object from the
  // plan (manifest.decisionPolicy), not just a planDigest string. Absent → the
  // versioned default (byte-identical to the pre-E4-05 thresholds).
  const rawPolicy = pair.candidate.manifest["decisionPolicy"];
  const policy = rawPolicy !== undefined ? validateDecisionPolicyV3(rawPolicy) : DEFAULT_DECISION_POLICY_V3;
  return deriveV3Decision(pair, opts.candidateId ?? pair.candidate.arm.candidateId ?? null, planDigest, policy);
}