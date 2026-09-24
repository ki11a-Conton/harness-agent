/**
 * E1-07 — strict provenance V2: comparison-level comparability judgement.
 *
 * P38.4-7 defined the per-case hashes; E1-07 turns them into a hard gate that
 * decides whether a baseline/candidate pair is EVEN COMPARABLE, independent
 * of pass/fail deltas. A comparison that is not attributable (context hash
 * differs, config hash same, or candidate never activated) must be judged
 * INCOMPARABLE — never promoted, never presented as a win/loss.
 *
 * This is the comparability layer the promotion gate (E1-14) and champion eval
 * (E1-08) share. It operates on LOADED runs (E1-06 canonical loader) so the
 * same rules apply to committed reports and live run files alike.
 */

import type { EvalOutcome } from "./runner.js";
import { activationSatisfied, activationContractFor, aggregateActivation, type ActivationCoverageSummary } from "./activation-evidence.js";

export const PROVENANCE_V2_SCHEMA_VERSION = "2.0.0";

/** Why a pair is not comparable (fail-closed classification). */
export type IncomparabilityReason =
  | "missing_context_hash"
  | "context_hash_mismatch"
  | "candidate_config_hash_same"
  | "candidate_not_activated"
  | "case_mismatch"
  | "judge_version_mismatch"
  | "legacy_no_activation_evidence";

export interface PairComparabilityVerdict {
  schemaVersion: string;
  /** Overall: comparable for strict promotion judgement. */
  comparable: boolean;
  reasons: IncomparabilityReason[];
  /** Per-case context hash status. */
  contextHashStatus: "matched" | "mismatched" | "absent";
  /** Candidate activation coverage summary (empty for baseline). */
  activation: ActivationCoverageSummary | null;
}

/** Collect the per-case evaluation context hashes for a run. */
function contextHashOf(run: EvalOutcome[]): Map<string, string | undefined> {
  return new Map(run.map((r) => [r.caseId, r.evaluationContextHash]));
}

/**
 * Judge comparability of a baseline/candidate pair. Strict by default:
 * any absent or mismatched provenance field fails closed. `strict` can be
 * relaxed ONLY for historical/legacy review (E1-12), never for promotion.
 */
export function judgePairComparability(
  baseline: EvalOutcome[],
  candidate: EvalOutcome[],
  opts: { strict?: boolean; candidateId?: string | null } = {},
): PairComparabilityVerdict {
  const strict = opts.strict ?? true;
  const reasons: IncomparabilityReason[] = [];

  // 1. Same case set.
  const baselineIds = new Set(baseline.map((r) => r.caseId));
  const candidateIds = new Set(candidate.map((r) => r.caseId));
  const sameSet = baselineIds.size === candidateIds.size
    && [...baselineIds].every((id) => candidateIds.has(id));
  if (!sameSet) reasons.push("case_mismatch");

  // 2. Judge version consistency.
  const bJudge = new Set(baseline.map((r) => r.judgeVersion).filter(Boolean));
  const cJudge = new Set(candidate.map((r) => r.judgeVersion).filter(Boolean));
  const judgesEqual = bJudge.size > 0 && cJudge.size > 0
    && bJudge.size === 1 && cJudge.size === 1
    && [...bJudge][0] === [...cJudge][0];
  if (!judgesEqual) reasons.push("judge_version_mismatch");

  // 3. Per-case evaluation context hash must MATCH (same fixture + judge +
  //    tool policy + environment). A candidate that changes the context is not
  //    a single-variable comparison.
  const bCtx = contextHashOf(baseline);
  const cCtx = contextHashOf(candidate);
  let anyCtxAbsent = false;
  let anyCtxMismatch = false;
  for (const id of baselineIds) {
    const bh = bCtx.get(id);
    const ch = cCtx.get(id);
    if (bh === undefined || ch === undefined || bh === "" || ch === "") {
      anyCtxAbsent = true;
    } else if (bh !== ch) {
      anyCtxMismatch = true;
    }
  }
  if (anyCtxMismatch) reasons.push("context_hash_mismatch");
  else if (anyCtxAbsent) reasons.push("missing_context_hash");
  const contextHashStatus: "matched" | "mismatched" | "absent" =
    anyCtxMismatch ? "mismatched" : (anyCtxAbsent ? "absent" : "matched");

  // 4. Candidate config hash must DIFFER from baseline (at least one case).
  const bCfg = new Set(baseline.map((r) => r.candidateConfigHash).filter(Boolean));
  const cCfg = new Set(candidate.map((r) => r.candidateConfigHash).filter(Boolean));
  const anyDifferent = [...cCfg].some((ch) => !bCfg.has(ch));
  if (!anyDifferent) reasons.push("candidate_config_hash_same");

  // 5. Activation evidence: candidate must have actually activated (E1-04).
  const candidateEvidence = candidate.map((r) => r.activationEvidence).filter((e) => e !== undefined);
  const activation = aggregateActivationOf(candidate, opts.candidateId);
  if (strict) {
    const contract = (opts.candidateId !== undefined && opts.candidateId !== null)
      ? activationContractFor(opts.candidateId!)
      : undefined;
    const satisfied = contract !== undefined && activation !== null
      && activationSatisfied(contract, activation);
    if (!satisfied) {
      reasons.push(
        candidateEvidence.length === 0 ? "legacy_no_activation_evidence" : "candidate_not_activated",
      );
    }
  }

  return {
    schemaVersion: PROVENANCE_V2_SCHEMA_VERSION,
    comparable: reasons.length === 0,
    reasons,
    contextHashStatus,
    activation,
  };
}

/** Aggregate per-case activation evidence from a run (null when absent). */
export function aggregateActivationOf(
  run: EvalOutcome[],
  candidateId?: string | null,
): ActivationCoverageSummary | null {
  const evidence = run.map((r) => r.activationEvidence).filter((e) => e !== undefined);
  if (evidence.length === 0) return null;
  return aggregateActivation(evidence);
}
