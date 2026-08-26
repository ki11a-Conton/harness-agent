import { readFile } from "node:fs/promises";
import type { EvalOutcome } from "@ar/evaluation";
import { buildPairedReport, evaluateQualityGates, type EvalMode, type PairedEvalReport } from "@ar/evaluation";

/**
 * P21-3 — `agent champion eval <baseline-runs.json> <candidate-runs.json>
 * [--mode stub|real-model]`.
 *
 * Both files are JSON arrays of EvalOutcome (the per-case runs produced by a
 * benchmark harness run). The command builds the paired report (same cases,
 * per-case wins/losses/ties, full metric set) and prints a TRUTH-RULE-compliant
 * claim. A missing candidate twin for any baseline case is a hard error —
 * never silently dropped.
 *
 * P38.3-12 — the paired report is the QUALITY decision layer, distinct from
 * the benchmark MEASUREMENT. It prints the P21-4 quality-policy verdict
 * (reused, never a duplicate engine): same case set, compatible judge
 * version, no new harness/judge/infrastructure failures, security
 * non-regression, no net pass regression, verified completion
 * non-inferiority, bounded cost/token growth.
 */

export interface ChampionEvalOptions {
  baselinePath: string;
  candidatePath: string;
  mode: EvalMode;
}

export interface ChampionQualityVerdict {
  /** Overall quality decision (all policy checks pass). */
  passed: boolean;
  /** Machine-readable per-policy check results. */
  checks: {
    sameCaseSet: boolean;
    compatibleJudgeVersion: boolean;
    noNewInfrastructureFailures: boolean;
    securityNonRegression: boolean;
    qualityGates: boolean;
  };
  failures: string[];
}

/**
 * P38.3-12 — the quality policy applied to a paired eval. Each check is
 * separate so a reviewer can see exactly which policy dimension failed.
 */
export function evaluateChampionQuality(
  baselineRuns: EvalOutcome[],
  candidateRuns: EvalOutcome[],
  report: PairedEvalReport,
): ChampionQualityVerdict {
  const failures: string[] = [];
  const checks = {
    sameCaseSet: true,
    compatibleJudgeVersion: true,
    noNewInfrastructureFailures: true,
    securityNonRegression: true,
    qualityGates: true,
  };

  // 1) Same case set — buildPairedReport already hard-errors on a missing
  //    baseline twin; here we also confirm no EXTRA candidate cases silently
  //    inflate the comparison (a candidate-only case is not a win).
  const baselineIds = new Set(baselineRuns.map((r) => r.caseId));
  const candidateIds = new Set(candidateRuns.map((r) => r.caseId));
  const extra = [...candidateIds].filter((id) => !baselineIds.has(id));
  if (extra.length > 0) {
    checks.sameCaseSet = false;
    failures.push(`candidate ran ${extra.length} case(s) not in the baseline: ${extra.join(", ")} — comparison would be misleading`);
  }

  // 2) Compatible judge version — judging semantics must be the same for both
  //    sides or the delta is not attributable to the agent.
  const judgeVersions = new Set([
    ...baselineRuns.map((r) => r.judgeVersion),
    ...candidateRuns.map((r) => r.judgeVersion),
  ]);
  if (judgeVersions.size > 1) {
    checks.compatibleJudgeVersion = false;
    failures.push(`judge version mismatch across runs: ${[...judgeVersions].join(", ")} — results are not comparable`);
  }

  // 3) No NEW harness/judge/infrastructure failures — an agent delta must not
  //    be bought by the harness breaking more often for one side.
  const infraOf = (runs: EvalOutcome[]): number =>
    runs.filter((r) => ["harness", "judge", "infrastructure"].includes(r.failureCategory ?? "")).length;
  const baselineInfra = infraOf(baselineRuns);
  const candidateInfra = infraOf(candidateRuns);
  if (candidateInfra > baselineInfra) {
    checks.noNewInfrastructureFailures = false;
    failures.push(
      `candidate has more harness/judge/infrastructure failures (${candidateInfra} vs baseline ${baselineInfra}) — delta is not agent-attributable`,
    );
  }

  // 4) Security non-regression — candidate security violations must never
  //    increase (hard gate, not a quality nuance).
  const secOf = (runs: EvalOutcome[]): number =>
    runs.reduce((sum, r) => sum + (r.violations ?? []).filter((v) =>
      /security|escape|denied|injection/i.test(v),
    ).length, 0);
  const baselineSec = secOf(baselineRuns);
  const candidateSec = secOf(candidateRuns);
  if (candidateSec > baselineSec) {
    checks.securityNonRegression = false;
    failures.push(`security violations increased: baseline ${baselineSec} → candidate ${candidateSec} (never acceptable)`);
  }

  // 5) P21-4 quality gates (net regression, verified completion, cost) —
  //    reused directly; never a duplicate quality engine.
  const gates = evaluateQualityGates(report);
  checks.qualityGates = gates.passed;
  for (const f of gates.failures) failures.push(f);

  return { passed: failures.length === 0, checks, failures };
}

/** Render the quality verdict for CLI output. */
export function renderChampionQuality(verdict: ChampionQualityVerdict): string[] {
  const lines = ["", "quality policy (P38.3-12):"];
  const checkLabel = (ok: boolean, name: string): string =>
    `  ${ok ? "PASS" : "FAIL"}  ${name}`;
  lines.push(checkLabel(verdict.checks.sameCaseSet, "same case set"));
  lines.push(checkLabel(verdict.checks.compatibleJudgeVersion, "compatible judge version"));
  lines.push(checkLabel(verdict.checks.noNewInfrastructureFailures, "no new harness/judge/infra failures"));
  lines.push(checkLabel(verdict.checks.securityNonRegression, "security non-regression"));
  lines.push(checkLabel(verdict.checks.qualityGates, "P21-4 quality gates (regression/verified/cost)"));
  for (const f of verdict.failures) lines.push(`    - ${f}`);
  lines.push(verdict.passed ? "  QUALITY VERDICT: PASS (candidate may be compared further)" : "  QUALITY VERDICT: FAIL (see above — do not promote on this evidence)");
  return lines;
}

export async function runChampionEval(
  opts: ChampionEvalOptions,
): Promise<{ report: PairedEvalReport; lines: string[] }> {
  const baselineRaw = await readFile(opts.baselinePath, "utf8");
  const candidateRaw = await readFile(opts.candidatePath, "utf8");
  const baselineRuns = JSON.parse(baselineRaw) as EvalOutcome[];
  const candidateRuns = JSON.parse(candidateRaw) as EvalOutcome[];
  const report = buildPairedReport(baselineRuns, candidateRuns, opts.mode);
  const quality = evaluateChampionQuality(baselineRuns, candidateRuns, report);

  const lines = [
    `mode: ${report.mode}`,
    `paired cases: ${report.aggregated.cases}`,
    `wins/losses/ties: ${report.aggregated.candidateWins}W / ${report.aggregated.baselineWins}L / ${report.aggregated.ties}T / ${report.aggregated.bothFailed} both-failed`,
    `net passed delta: ${report.aggregated.netPassedDelta > 0 ? "+" : ""}${report.aggregated.netPassedDelta}`,
    `verified completion: ${report.aggregated.baselineVerifiedRate.toFixed(3)} → ${report.aggregated.candidateVerifiedRate.toFixed(3)}`,
    `tool calls Δ: ${report.aggregated.toolCallsDelta > 0 ? "+" : ""}${report.aggregated.toolCallsDelta}`,
    `tokens Δ: ${report.aggregated.tokensDelta > 0 ? "+" : ""}${report.aggregated.tokensDelta}`,
    `cost Δ: $${report.aggregated.costUsdDelta >= 0 ? "+" : ""}${report.aggregated.costUsdDelta.toFixed(4)}`,
    `recovery Δ: ${report.aggregated.recoveryDelta > 0 ? "+" : ""}${report.aggregated.recoveryDelta}`,
    `compaction Δ: ${report.aggregated.compactionDelta > 0 ? "+" : ""}${report.aggregated.compactionDelta}`,
    "",
    "per-case:",
    ...report.cases.map(
      (c) => `  ${c.caseId}: ${c.outcome} (b:${c.baseline.passed ? "pass" : "fail"} ${c.baseline.grade} / c:${c.candidate.passed ? "pass" : "fail"} ${c.candidate.grade})`,
    ),
    "",
    "claim:",
    `  ${report.claim}`,
    ...renderChampionQuality(quality),
  ];
  return { report, lines };
}
