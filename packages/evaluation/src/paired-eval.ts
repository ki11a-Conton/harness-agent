/**
 * P21-3 — paired evaluation runner.
 *
 * A champion claim is only as good as its comparison: baseline and candidate
 * must run the SAME cases, and the outcome is reported per case (wins/losses/
 * ties), never as a bare aggregate. Every run is labelled with its mode:
 *
 *   - "stub"       : stub/fake provider — exercises the full mechanism path
 *                    (case loading, runtime loop, gates) but produces no real
 *                    model evidence.
 *   - "real-model" : an actual model provider.
 *
 * TRUTH RULE (plan.md P21-3): without real-model evidence you may say
 * "mechanism-real passed" — you may NOT say "the agent is stronger". The
 * claim generator enforces this wording mechanically.
 */

import type { EvalOutcome } from "./runner.js";

export type EvalMode = "stub" | "real-model";

/** Per-side per-case run metrics (all derived from the EvalOutcome). */
export interface CaseRun {
  passed: boolean;
  /** P19-1 verified-completion grade; "?" when the run carried none. */
  grade: string;
  securityViolations: number;
  toolCalls: number;
  tokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  recoveryCount: number;
  compactionCount: number;
}

export type PairedOutcome =
  | "baseline_win"
  | "candidate_win"
  | "tie"
  | "both_failed"
  | "baseline_only_passed"
  | "candidate_only_passed";

export interface PairedCaseResult {
  caseId: string;
  baseline: CaseRun;
  candidate: CaseRun;
  /** win/loss/tie per case — small-sample honesty beats fake precision. */
  outcome: PairedOutcome;
}

export interface PairedAggregate {
  cases: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  bothFailed: number;
  /** (candidate passed) - (baseline passed): positive = net gain. */
  netPassedDelta: number;
  /** Sum of per-case tool-call deltas (candidate - baseline). */
  toolCallsDelta: number;
  /** Sum of per-case token deltas (candidate - baseline). */
  tokensDelta: number;
  /** Sum of per-case cost deltas (candidate - baseline). */
  costUsdDelta: number;
  /** Candidate's verified-completion rate among its cases. */
  candidateVerifiedRate: number;
  /** Baseline's verified-completion rate among its cases. */
  baselineVerifiedRate: number;
  recoveryDelta: number;
  compactionDelta: number;
}

export interface PairedEvalReport {
  mode: EvalMode;
  cases: PairedCaseResult[];
  aggregated: PairedAggregate;
  /** Truth-rule-compliant claim text (generated, never hand-written). */
  claim: string;
}

/** Case outcome classification (per-case wins/losses/ties). */
export function classifyPaired(
  baseline: CaseRun,
  candidate: CaseRun,
): PairedOutcome {
  if (baseline.passed && candidate.passed) return "tie";
  if (!baseline.passed && !candidate.passed) return "both_failed";
  if (baseline.passed && !candidate.passed) return "baseline_only_passed";
  return "candidate_only_passed";
}

function runOf(outcome: EvalOutcome): CaseRun {
  const metrics = outcome.metrics;
  return {
    passed: outcome.status === "passed",
    grade: outcome.grade ?? "?",
    securityViolations: (outcome.violations ?? []).filter((v) =>
      /security|escape|denied|injection/i.test(v),
    ).length,
    toolCalls: metrics.tool_call_count,
    tokens: metrics.tokens_input + metrics.tokens_output,
    estimatedCostUsd: metrics.estimated_cost,
    latencyMs: metrics.duration_ms,
    recoveryCount: metrics.retry_count + outcome.events.filter((e) => e.type === "recovery.decided").length,
    compactionCount: metrics.compaction_count,
  };
}

/**
 * P21-3 — build the paired report from two SAME-CASE run sets. The baseline
 * run set defines the case order; a candidate run whose caseId has no
 * baseline twin is a hard error (never silently dropped).
 */
export function buildPairedReport(
  baselineRuns: EvalOutcome[],
  candidateRuns: EvalOutcome[],
  mode: EvalMode,
): PairedEvalReport {
  const baselineByCase = new Map(baselineRuns.map((r) => [r.caseId, r]));
  const candidateByCase = new Map(candidateRuns.map((r) => [r.caseId, r]));

  const cases: PairedCaseResult[] = [];
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  let bothFailed = 0;
  let netPassed = 0;
  let toolCallsDelta = 0;
  let tokensDelta = 0;
  let costUsdDelta = 0;
  let recoveryDelta = 0;
  let compactionDelta = 0;
  let candidateVerified = 0;
  let baselineVerified = 0;

  for (const baseline of baselineRuns) {
    const candidate = candidateByCase.get(baseline.caseId);
    if (candidate === undefined) {
      throw new Error(
        `paired eval: candidate missing baseline twin for case ${baseline.caseId} — baseline and candidate must run the SAME cases`,
      );
    }
    const b = runOf(baseline);
    const c = runOf(candidate);
    const outcome = classifyPaired(b, c);
    cases.push({ caseId: baseline.caseId, baseline: b, candidate: c, outcome });

    switch (outcome) {
      case "candidate_only_passed": candidateWins += 1; netPassed += 1; break;
      case "baseline_only_passed": baselineWins += 1; netPassed -= 1; break;
      case "tie": ties += 1; break;
      case "both_failed": bothFailed += 1; break;
    }
    toolCallsDelta += c.toolCalls - b.toolCalls;
    tokensDelta += c.tokens - b.tokens;
    costUsdDelta += c.estimatedCostUsd - b.estimatedCostUsd;
    recoveryDelta += c.recoveryCount - b.recoveryCount;
    compactionDelta += c.compactionCount - b.compactionCount;
    if (c.grade === "verified_complete") candidateVerified += 1;
    if (b.grade === "verified_complete") baselineVerified += 1;
  }

  const n = cases.length;
  const aggregated: PairedAggregate = {
    cases: n,
    candidateWins,
    baselineWins,
    ties,
    bothFailed,
    netPassedDelta: netPassed,
    toolCallsDelta,
    tokensDelta,
    costUsdDelta,
    candidateVerifiedRate: n === 0 ? 0 : candidateVerified / n,
    baselineVerifiedRate: n === 0 ? 0 : baselineVerified / n,
    recoveryDelta,
    compactionDelta,
  };

  return {
    mode,
    cases,
    aggregated,
    claim: claimFor(mode, aggregated),
  };
}

/**
 * P21-3 TRUTH RULE — the claim is generated, never hand-written:
 *   - stub mode can only ever claim "mechanism-real passed".
 *   - real-model mode may claim a net gain, but never without per-case
 *     wins/losses/ties context and never for unbounded cost.
 */
export function claimFor(mode: EvalMode, agg: PairedAggregate): string {
  if (mode === "stub") {
    return (
      `mechanism-real passed (stub provider): ${agg.cases} paired cases, ` +
      `${agg.candidateWins} candidate-only passes, ${agg.baselineWins} baseline-only passes, ` +
      `${agg.ties} ties, ${agg.bothFailed} both-failed. ` +
      "No real-model evidence — this does NOT claim the agent is stronger."
    );
  }
  const verifiedDelta = agg.candidateVerifiedRate - agg.baselineVerifiedRate;
  const net =
    agg.netPassedDelta > 0
      ? `candidate net +${agg.netPassedDelta} passed cases (${agg.candidateWins}W/${agg.baselineWins}L/${agg.ties}T)`
      : agg.netPassedDelta < 0
        ? `baseline net +${-agg.netPassedDelta} passed cases (${agg.baselineWins}W/${agg.candidateWins}L/${agg.ties}T)`
        : `no net pass-rate change (${agg.ties} ties)`;
  const cost =
    agg.tokensDelta > 0 || agg.costUsdDelta > 0
      ? `cost ${agg.tokensDelta > 0 ? `+${agg.tokensDelta} tokens` : ""}${
          agg.tokensDelta > 0 && agg.costUsdDelta > 0 ? " / " : ""
        }${agg.costUsdDelta > 0 ? `+$${agg.costUsdDelta.toFixed(4)}` : ""} — needs success-rate justification (P21-4)`
      : "cost not increased";
  return (
    `real-model paired eval over ${agg.cases} same cases: ${net}; ` +
    `verified completion ${agg.baselineVerifiedRate.toFixed(3)} → ${agg.candidateVerifiedRate.toFixed(3)} (Δ ${verifiedDelta >= 0 ? "+" : ""}${verifiedDelta.toFixed(3)}); ${cost}.`
  );
}
