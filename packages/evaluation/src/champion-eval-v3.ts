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
import { validateExperimentArtifactV3FromBytes } from "./artifact-v3/loader.js";
import { stableStringify } from "./manifest.js";
import { classifyArtifact, parseExperimentArtifactV3 } from "./artifact-v3/schema.js";
import { evaluatePairing, pairKeyV3 } from "./paired-key.js";
import {
  DEFAULT_DECISION_POLICY_V3,
  computeThresholdDigestV3,
  validateDecisionPolicyV3,
  DECISION_POLICY_V3_VERSION,
  type DecisionPolicyV3,
} from "./decision-policy-v3.js";
import { parseExecutionPlan, crossBindExecutionPlan, computeExecutionPlanDigest, validatePromotionEligibility } from "./execution-plan.js";
import type { CaseOutcomeV3, ExperimentArtifactV3 } from "./artifact-v3/types.js";
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

/** Load two artifacts as a V3 pair through the SAME strict validation the
 *  file loader uses (E4-R02 #2/#3): bytes → parse → schema → contentDigest →
 *  refs → eventRecords → summary → provenance. A NON-V3 artifact (e.g. a legacy
 *  `{results: []}` report) is refused with LEGACY_NOT_PROMOTION_ELIGIBLE, and
 *  any tampered V3 is refused with the same SCHEMA error the loader gives —
 *  a promotion decision is never computed from bytes the loader would reject. */
export async function loadV3ArtifactPair(
  baselinePath: string,
  candidatePath: string,
): Promise<V3ArtifactPair> {
  const rawBase = await readFile(baselinePath, "utf8");
  const rawCand = await readFile(candidatePath, "utf8");
  const baseClass = classifyArtifact(JSON.parse(rawBase) as unknown);
  const candClass = classifyArtifact(JSON.parse(rawCand) as unknown);
  if (baseClass.kind !== "v3" || candClass.kind !== "v3") {
    throw new Error(
      `LEGACY_NOT_PROMOTION_ELIGIBLE: baseline=${baseClass.kind} candidate=${candClass.kind} — V3 artifacts required for strict promotion`,
    );
  }
  // Both are V3 now — run the FULL strict read (digest, refs, eventRecords,
  // summary, provenance). A tampered V3 is rejected here exactly as the file
  // loader rejects it.
  const strictBase = validateExperimentArtifactV3FromBytes(rawBase, baselinePath);
  const strictCand = validateExperimentArtifactV3FromBytes(rawCand, candidatePath);
  const baseline = strictBase.artifact;
  const candidate = strictCand.artifact;
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

  // 3c. E4-R03 (F05): when the CONFIRMED plan's grid is carried in the manifest,
  //     BOTH arms must equal it EXACTLY. Two arms that merely match each other
  //     while missing half the confirmed grid (or carrying an unplanned sample)
  //     are a protocol violation -> INVALID, never ACCEPT.
  //     E4-R14 (N06/N09): completeness is a hard contract — a declared-but-empty
  //     grid, runComplete=false, duplicate grid keys, or a promotion-eligible
  //     artifact without the full R13 execution plan are ALL protocol
  //     violations. The old "no grid → self-consistency only" path can never
  //     promote an artifact that claims promotion eligibility.
  const manifestPromotionEligible = candidate.manifest["promotionEligible"] === true;
  const runComplete = candidate.manifest["runComplete"];
  const expectedGridRaw = candidate.manifest["expectedSampleKeys"];
  const executionPlanRaw = candidate.manifest["executionPlan"];

  if (runComplete === false) {
    policyViolations.push("manifest.runComplete=false — the experiment was not completed; evidence cannot be promoted");
  }
  if (Array.isArray(expectedGridRaw) && expectedGridRaw.length === 0) {
    policyViolations.push("manifest.expectedSampleKeys is EMPTY — a declared sample grid cannot be empty");
  }
  if (manifestPromotionEligible) {
    if (typeof executionPlanRaw !== "object" || executionPlanRaw === null || Array.isArray(executionPlanRaw)) {
      policyViolations.push("promotion-eligible artifact lacks the confirmed execution plan (manifest.executionPlan) — legacy artifacts cannot be promotion-eligible");
    } else {
      // E4-R22 (F02): parse + cross-bind the plan via the SHARED protocol. An
      // empty {} (or any lossy object) previously satisfied "typeof object" and
      // could still ACCEPT — now the plan is validated, its digest recomputed
      // and cross-bound to the manifest's recorded planDigest, the derived grid
      // (manifest.expectedSampleKeys is corroboration), the applied policy
      // digest, the manifest threshold, and the run-time provenance.
      const parsed = parseExecutionPlan(executionPlanRaw);
      if (parsed.plan === null) {
        for (const issue of parsed.issues) policyViolations.push(issue);
      } else {
        // The plan's own digest must equal the manifest's recorded planDigest.
        const recomputedDigest = computeExecutionPlanDigest(parsed.plan);
        if (typeof candidate.manifest["planDigest"] === "string" && candidate.manifest["planDigest"] !== recomputedDigest) {
          policyViolations.push(
            `manifest.planDigest ${String(candidate.manifest["planDigest"])} != recomputed execution plan digest ${recomputedDigest} (plan content does not match the confirmed digest)`,
          );
        }
        // Cross-bind to the surrounding artifact facts.
        const bindingViolations = crossBindExecutionPlan(parsed.plan, {
          manifest: candidate.manifest as Record<string, unknown>,
          provenance: candidate.provenance as { provider?: string | null; model?: string | null; gitSha?: string | null },
          otherArmPlanDigest: baseline.manifest["planDigest"],
          appliedThresholdDigest: thresholdDigest,
          candidateId: candidate.arm.candidateId,
        });
        for (const v of bindingViolations) policyViolations.push(v);
        // E4-R27 (G01): field consistency is NOT eligibility. A plan whose
        // fields agree with each other yet declare an insecure/none isolation
        // posture (or an unknown source/backend/candidate) while claiming
        // promotionEligible=true is a protocol self-contradiction. The shared
        // semantic validator rejects it HERE, at the evaluator boundary, so the
        // decision can never be ACCEPT.
        for (const v of validatePromotionEligibility(parsed.plan)) {
          policyViolations.push(`${v.code}: ${v.detail}`);
        }
      }
    }
    if (!Array.isArray(expectedGridRaw) || expectedGridRaw.length === 0) {
      policyViolations.push("promotion-eligible artifact lacks a non-empty expected sample grid (manifest.expectedSampleKeys)");
    }
    if (runComplete !== true) {
      policyViolations.push("promotion-eligible artifact must record manifest.runComplete=true");
    }
  }
  const expectedGrid = Array.isArray(expectedGridRaw) ? (expectedGridRaw as unknown[]) : null;
  if (expectedGrid !== null) {
    const seen = new Set<string>();
    for (const k of expectedGrid) {
      if (typeof k !== "string" || k.length === 0 || seen.has(k)) {
        policyViolations.push("manifest.expectedSampleKeys must contain unique non-empty strings (duplicate/malformed key)");
        break;
      }
      seen.add(k);
    }
  }
  if (expectedGrid !== null && expectedGrid.length > 0) {
    const expected = new Set(expectedGrid as string[]);
    const bKeys = new Set(baseline.outcomes.map((o) => pairKeyV3(o)));
    const cKeys = new Set(candidate.outcomes.map((o) => pairKeyV3(o)));
    for (const k of expected) {
      if (!bKeys.has(k)) policyViolations.push(`baseline missing confirmed sample ${JSON.stringify(k)} (grid mismatch)`);
      if (!cKeys.has(k)) policyViolations.push(`candidate missing confirmed sample ${JSON.stringify(k)} (grid mismatch)`);
    }
    for (const k of bKeys) {
      if (!expected.has(k)) policyViolations.push(`baseline has UNPLANNED sample ${JSON.stringify(k)} (grid mismatch)`);
    }
    for (const k of cKeys) {
      if (!expected.has(k)) policyViolations.push(`candidate has UNPLANNED sample ${JSON.stringify(k)} (grid mismatch)`);
    }
  }
  // E4-R14 (N06): the applied policy must be the SAME across both arms — a
  // baseline whose recorded thresholdDigest differs from the applied policy
  // was evaluated under a different policy than the candidate.
  const baselineThresholdDigest = baseline.manifest["thresholdDigest"];
  if (typeof baselineThresholdDigest === "string" && baselineThresholdDigest !== thresholdDigest) {
    policyViolations.push(
      `baseline manifest.thresholdDigest ${baselineThresholdDigest} != applied policy digest ${thresholdDigest} (policy mismatch across arms)`,
    );
  }

  // 4. E4-R14 (N07): activation coverage over UNIQUE cases — a case is
  //    activated only when EVERY repetition's candidate outcome carries an
  //    activationRef that RESOLVES to a real activationEvidence record.
  //    Repetitions of one case never inflate the eligible-case count, and a
  //    dangling ref is not eligibility.
  const caseGroups = new Map<string, CaseOutcomeV3[]>();
  for (const o of candidate.outcomes) {
    const caseKey = `${o.suite}\u0000${o.caseId}`;
    const list = caseGroups.get(caseKey) ?? [];
    list.push(o);
    caseGroups.set(caseKey, list);
  }
  const uniqueCases = caseGroups.size;
  const activationIds = new Set(candidate.activationEvidence.map((e) => e.id));
  const danglingActivations = candidate.outcomes.filter((o) => o.activationRef !== null && !activationIds.has(o.activationRef!));
  if (danglingActivations.length > 0) {
    policyViolations.push(`${danglingActivations.length} candidate outcome(s) carry a dangling activationRef — a ref to nothing is not eligibility`);
  }
  const activatedCases = [...caseGroups.values()].filter((list) =>
    list.length > 0 && list.every((o) => o.activationRef !== null && activationIds.has(o.activationRef!)),
  ).length;
  const activationCoverage = uniqueCases > 0 ? activatedCases / uniqueCases : null;

  // 5. Security breaches: typed security outcomes that escaped or breached, PLUS
  //    unknown/absent security evidence (E4-R03 F06). `not_observed` and
  //    `classifier_error` are NEVER clean: a case that owed a security
  //    observation and produced none (or whose correlation failed) counts as a
  //    security failure — it cannot be diluted to a pass by other clean reps.
  //    E4-R14 (N08): for promotion-eligible artifacts EVERY planned sample on
  //    BOTH arms must carry a security evidence record that RESOLVES — missing
  //    records and dangling refs are INVALID evidence, never silently counted
  //    as 0 breaches.
  const breachKinds = new Set(["escaped", "attack_attempted", "unauthorized_effect", "not_observed", "classifier_error"]);
  const securityBreachesCandidate = candidate.securityOutcomes.filter((s) => breachKinds.has(s.kind)).length;
  const securityBreachesBaseline = baseline.securityOutcomes.filter((s) => breachKinds.has(s.kind)).length;
  if (manifestPromotionEligible) {
    const cSecIds = new Set(candidate.securityOutcomes.map((s) => s.caseId));
    const cMissing = candidate.outcomes.filter((o) => o.securityOutcomeRef === null || !cSecIds.has(o.securityOutcomeRef!));
    if (cMissing.length > 0) {
      policyViolations.push(`${cMissing.length} candidate sample(s) lack a resolving security evidence record — missing security evidence is never clean`);
    }
    const bSecIds = new Set(baseline.securityOutcomes.map((s) => s.caseId));
    const bMissing = baseline.outcomes.filter((o) => o.securityOutcomeRef === null || !bSecIds.has(o.securityOutcomeRef!));
    if (bMissing.length > 0) {
      policyViolations.push(`${bMissing.length} baseline sample(s) lack a resolving security evidence record`);
    }
  }

  // E4-R14: pair completeness is decided AFTER every protocol violation has
  // been collected (grid, plan, runComplete, policy, activation, security) —
  // a violation discovered in ANY section makes the pair INVALID.
  const pairComplete = pairing.pairComplete && policyViolations.length === 0;

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

  // 12. E4-R03 (F07): recovery capability from the artifact's REAL recovery
  //      decisions. A sample is recovery-eligible when it carries >= 1 recovery
  //      decision; it counts as recovered when verification passed AND none of
  //      its decisions was budget-exhausted. minRecoveryRate comes from the
  //      CONFIRMED policy (never a silently chosen default).
  const recoveryDecisionsOf = (o: CaseOutcomeV3): ReadonlyArray<{ budgetExhausted?: boolean }> =>
    (o.recoveryDecisions ?? []) as ReadonlyArray<{ budgetExhausted?: boolean }>;
  const candidateRecoverySamples = candidate.outcomes.filter((o) => recoveryDecisionsOf(o).length > 0);
  const recoveryCount = candidateRecoverySamples.length;
  const recoveredCount = candidateRecoverySamples.filter(
    (o) => o.verificationPassed === true && !recoveryDecisionsOf(o).some((d) => d.budgetExhausted === true),
  ).length;

  const inputs: DecisionGateInputV3 = {
    digestValid,
    pairComplete,
    comparable: prov.comparable,
    incomparabilityReasons,
    activationCoverage,
    activationEligibleCases: activatedCases,
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
    cases: uniqueCases,
    netPassedDelta,
    repetitions,
    perRepetitionDeltas,
    pairingViolations: [...pairing.violations, ...policyViolations],
    minConclusiveNetDelta: policy.minConclusiveNetDelta,
    tokensDelta,
    maxTokensDelta: policy.maxTokensDelta,
    recommendsRepetition: repetitions < 2,
    recoveryCount,
    recoveredCount,
    minRecoveryRate: policy.minRecoveryRate,
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
  /** E4-R04 (F09): digests of the ACTUAL BYTES that were read, not the stored
   *  strings. When provided, the replay's pair carries these, and the stored
   *  digests must equal them. When omitted (legacy callers), the replay pair
   *  carries the stored strings and a mismatch is not asserted here. */
  actualBaselineDigest?: string,
  actualCandidateDigest?: string,
): string[] {
  const violations: string[] = [];

  // E4-R04 #4: strict version support — unknown values are UNSUPPORTED, a
  // non-empty string is never enough.
  if (stored["schemaVersion"] !== DECISION_ARTIFACT_V3_SCHEMA_VERSION) {
    violations.push(
      `stored schemaVersion ${JSON.stringify(stored["schemaVersion"])} != supported ${DECISION_ARTIFACT_V3_SCHEMA_VERSION} (unknown decisions are never trusted)`,
    );
  }
  if (stored["evaluatorVersion"] !== DECISION_EVALUATOR_VERSION) {
    violations.push(`stored evaluatorVersion ${String(stored["evaluatorVersion"])} != current ${DECISION_EVALUATOR_VERSION} (decision not reproducible by this evaluator)`);
  }

  // E4-R04 (F09): the digests the replay pair uses MUST come from the actual
  // bytes read off disk. If the caller supplied them, the stored DecisionArtifact
  // must agree; a forger who rewrites the stored digest fields and recomputes the
  // outer digest is caught by the mismatch against the real bytes.
  const baselineDigest = actualBaselineDigest ?? String(stored["baselineArtifactDigest"] ?? "");
  const candidateDigest = actualCandidateDigest ?? String(stored["candidateArtifactDigest"] ?? "");
  if (actualBaselineDigest !== undefined && stored["baselineArtifactDigest"] !== baselineDigest) {
    violations.push(
      `stored baselineArtifactDigest ${JSON.stringify(stored["baselineArtifactDigest"])} != digest of the ACTUAL bytes read (${baselineDigest})`,
    );
  }
  if (actualCandidateDigest !== undefined && stored["candidateArtifactDigest"] !== candidateDigest) {
    violations.push(
      `stored candidateArtifactDigest ${JSON.stringify(stored["candidateArtifactDigest"])} != digest of the ACTUAL bytes read (${candidateDigest})`,
    );
  }

  let policy: DecisionPolicyV3;
  try {
    policy = validateDecisionPolicyV3(stored["policy"]);
  } catch (err) {
    violations.push(`stored decision policy invalid: ${err instanceof Error ? err.message : String(err)}`);
    return violations;
  }
  // E4-R04 #4: strict version support — a non-empty string is never enough.
  // `policyVersion` on the DecisionArtifact is `policy.version`; it must be a
  // KNOWN supported policy version and internally consistent.
  if (policy.version !== DECISION_POLICY_V3_VERSION) {
    violations.push(
      `policy.version ${JSON.stringify(policy.version)} != supported ${DECISION_POLICY_V3_VERSION} (unknown policy version is never trusted)`,
    );
  }
  if (typeof stored["policyVersion"] === "string" && stored["policyVersion"] !== policy.version) {
    violations.push(
      `stored policyVersion ${JSON.stringify(stored["policyVersion"])} != embedded policy.version ${JSON.stringify(policy.version)}`,
    );
  }
  if (stored["thresholdDigest"] !== computeThresholdDigestV3(policy)) {
    violations.push(`stored thresholdDigest ${String(stored["thresholdDigest"])} != digest(embedded policy) (thresholds tampered)`);
  }
  const candidateId = typeof stored["candidateId"] === "string" ? (stored["candidateId"] as string) : null;
  const planDigest = typeof stored["planDigest"] === "string" ? (stored["planDigest"] as string) : null;

  // E4-R04 (F10): role/identity cross-binding — the candidate role in the
  // artifact must be the SAME candidate the DecisionArtifact names, and the
  // config hash must line up. Baseline role likewise: arms must not be swapped.
  if (candidate.arm.armId !== "candidate") {
    violations.push(`candidate artifact armId=${JSON.stringify(candidate.arm.armId)} is not "candidate" (roles swapped?)`);
  }
  if (baseline.arm.armId !== "baseline") {
    violations.push(`baseline artifact armId=${JSON.stringify(baseline.arm.armId)} is not "baseline" (roles swapped?)`);
  }
  if (candidateId !== null && candidate.arm.candidateId !== candidateId) {
    violations.push(`stored candidateId ${JSON.stringify(candidateId)} != candidate.arm.candidateId ${JSON.stringify(candidate.arm.candidateId)}`);
  }
  // E4-R04 #5: the candidate's CONFIG identity must be present — a run without a
  // config identity cannot be promoted (missing promotion-required info is
  // rejected, never skipped). arm.candidateConfigHash and
  // manifest.runtimeConfigHash are DIFFERENT facts (candidate config vs runtime
  // config); each must exist, but they are not cross-required to be equal.
  if (candidate.arm.candidateConfigHash === null || candidate.arm.candidateConfigHash === "") {
    violations.push("candidate arm lacks candidateConfigHash (candidate config identity unknown)");
  }
  if (typeof candidate.manifest["runtimeConfigHash"] !== "string" || candidate.manifest["runtimeConfigHash"] === "") {
    violations.push("candidate manifest lacks runtimeConfigHash (runtime config identity unknown)");
  }

  const pair: V3ArtifactPair = {
    baseline,
    candidate,
    baselineDigest,
    candidateDigest,
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