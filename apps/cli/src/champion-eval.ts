import type { EvalOutcome } from "@ar/evaluation";
import { loadRunsFromArtifact, buildPairedReport, evaluateQualityGates, type EvalMode, type PairedEvalReport } from "@ar/evaluation";
import { countSecurityViolations } from "@ar/evaluation";

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
  /** E1-08: strict provenance + activation gate (default true). */
  strict?: boolean;
  /** E1-08: candidate id for the activation contract (default null). */
  candidateId?: string | null;
}

export interface ChampionQualityVerdict {
  /** Overall quality decision (all policy checks pass). */
  passed: boolean;
  /** Machine-readable per-policy check results. */
  checks: {
    sameCaseSet: boolean;
    compatibleJudgeVersion: boolean;
    compatibleEvaluationContext: boolean;
    candidateActuallyDiffers: boolean;
    controlledDifferenceDeclared: boolean;
    noNewInfrastructureFailures: boolean;
    securityNonRegression: boolean;
    qualityGates: boolean;
  };
  failures: string[];
  /** P38.4-8: informational notes about partial provenance (legacy runs).
   *  These do NOT fail the verdict but are visible to the reviewer. */
  warnings: string[];
}

/**
 * P38.3-12 + P38.4-8 — the quality policy applied to a paired eval. Each check
 * is separate so a reviewer can see exactly which policy dimension failed.
 * P38.4-8 adds provenance checks: compatible evaluation context, candidate
 * actually differs, and controlled difference declared.
 */
export function evaluateChampionQuality(
  baselineRuns: EvalOutcome[],
  candidateRuns: EvalOutcome[],
  report: PairedEvalReport,
  opts?: { strictPromotion?: boolean },
): ChampionQualityVerdict {
  const strict = opts?.strictPromotion ?? false;
  const failures: string[] = [];
  const warnings: string[] = [];
  const checks = {
    sameCaseSet: true,
    compatibleJudgeVersion: true,
    compatibleEvaluationContext: true,
    candidateActuallyDiffers: true,
    controlledDifferenceDeclared: true,
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

  // P38.4-8 (INV-P38.4-010): compatible evaluation context — for every paired
  // case, baseline.evaluationContextHash must equal candidate.evaluationContextHash.
  // If not, the delta is NOT attributable to the candidate configuration and the
  // comparison must fail closed. Legacy runs without the field are allowed but
  // are only "informational" (never a strong promotion basis).
  {
    const ctxOf = (r: EvalOutcome): string | undefined => r.evaluationContextHash;
    const baselineByCase = new Map(baselineRuns.map((r) => [r.caseId, ctxOf(r)]));
    const mismatches: string[] = [];
    let missing = 0;
    for (const cand of candidateRuns) {
      if (!baselineByCase.has(cand.caseId)) continue; // extra candidate case already flagged
      const b = baselineByCase.get(cand.caseId);
      const c = ctxOf(cand);
      // Legacy: either side lacks the provenance field — informational.
      if (b === undefined || c === undefined) {
        missing += 1;
        continue;
      }
      if (b !== c) {
        mismatches.push(
          `case ${cand.caseId} evaluation context mismatch: baseline=${b.slice(0, 8)}… candidate=${c.slice(0, 8)}… — results are not attributable to candidate configuration`,
        );
      }
    }
    if (mismatches.length > 0) {
      checks.compatibleEvaluationContext = false;
      failures.push(...mismatches);
    } else if (strict && missing > 0) {
      // Strict promotion mode: provenance missing on either side cannot support
      // a strong promotion verdict.
      checks.compatibleEvaluationContext = false;
      failures.push(`strict promotion: ${missing} paired case(s) lack evaluationContextHash (legacy provenance) — promotion requires full provenance`);
    }
    if (missing > 0 && mismatches.length === 0) {
      // Informational note — present even in non-strict mode so the reviewer
      // knows the comparison provenance is partial. Does NOT fail the verdict.
      warnings.push(`${missing} paired case(s) lack evaluationContextHash (legacy provenance) — comparison is informational, not fully attributable`);
    }
  }

  // P38.4-8 (INV-P38.4-010): candidateActuallyDiffers — a challenger claim must
  // have at least one candidateConfigHash differing from baseline. Without it,
  // the "challenger vs baseline" comparison is meaningless. If BOTH sides have
  // no candidateConfigHash (legacy), treat as informational (passes only in
  // non-strict mode; strict promotion fails).
  {
    const cfgOf = (r: EvalOutcome): string | undefined => r.candidateConfigHash;
    const baselineById = new Map(baselineRuns.map((r) => [r.caseId, cfgOf(r)]));
    let differing = 0;
    let missing = 0;
    for (const cand of candidateRuns) {
      if (!baselineById.has(cand.caseId)) continue; // extra candidate case already flagged
      const b = baselineById.get(cand.caseId);
      const c = cfgOf(cand);
      if (b === undefined || c === undefined) {
        missing += 1;
        continue;
      }
      if (b !== c) differing += 1;
    }
    if (differing === 0) {
      if (missing === baselineRuns.length && baselineRuns.length > 0) {
        // All legacy — informational unless strict.
        if (strict) {
          checks.candidateActuallyDiffers = false;
          failures.push("strict promotion: no candidateConfigHash present (legacy provenance) — cannot prove the challenger differs from baseline");
        }
      } else {
        checks.candidateActuallyDiffers = false;
        failures.push("candidate config identical to baseline for every paired case — challenger claim has no material difference (no candidateConfigHash differs)");
      }
    }
  }

  // P38.4-8 (INV-P38.4-010): controlledDifferenceDeclared — a promotion-quality
  // comparison must declare the intended mechanism difference. Legacy runs
  // without metadata are informational (non-strict); strict promotion fails.
  {
    const declared = candidateRuns
      .map((r) => r.controlledDifference)
      .filter((d) => d !== undefined && d.length > 0);
    const anyDeclared = declared.length > 0;
    const anyField = candidateRuns.some((r) => r.controlledDifference !== undefined);
    if (!anyDeclared) {
      if (strict) {
        checks.controlledDifferenceDeclared = false;
        failures.push("strict promotion: challenger did not declare a controlledDifference (intended mechanism change) — no attributable experiment");
      } else if (anyField) {
        checks.controlledDifferenceDeclared = false;
        failures.push("challenger declared an empty controlledDifference — no intended mechanism change is identified");
      }
      // Non-strict + no field at all: legacy — informational, passes (historical
      // runs must not be broken, but they are not strong promotion evidence).
    }
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
  //    increase (hard gate, not a quality nuance). E1-09: typed taxonomy —
  //    only genuine security-relevant violations count (forbidden command/
  //    network/read attempts, side effects, denial breaches); judge-quality
  //    violations (e.g. "verification did not pass") are NOT security.
  const secOf = (runs: EvalOutcome[]): number =>
    runs.reduce((sum, r) => sum + countSecurityViolations(r.violations ?? []), 0);
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

  return { passed: failures.length === 0, checks, failures, warnings };
}

/** Render the quality verdict for CLI output. */
export function renderChampionQuality(verdict: ChampionQualityVerdict): string[] {
  const lines = ["", "quality policy (P38.3-12 + P38.4-8):"];
  const checkLabel = (ok: boolean, name: string): string =>
    `  ${ok ? "PASS" : "FAIL"}  ${name}`;
  lines.push(checkLabel(verdict.checks.sameCaseSet, "same case set"));
  lines.push(checkLabel(verdict.checks.compatibleJudgeVersion, "compatible judge version"));
  lines.push(checkLabel(verdict.checks.compatibleEvaluationContext, "compatible evaluation context (attributable)"));
  lines.push(checkLabel(verdict.checks.candidateActuallyDiffers, "candidate actually differs"));
  lines.push(checkLabel(verdict.checks.controlledDifferenceDeclared, "controlled difference declared"));
  lines.push(checkLabel(verdict.checks.noNewInfrastructureFailures, "no new harness/judge/infra failures"));
  lines.push(checkLabel(verdict.checks.securityNonRegression, "security non-regression"));
  lines.push(checkLabel(verdict.checks.qualityGates, "P21-4 quality gates (regression/verified/cost)"));
  for (const f of verdict.failures) lines.push(`    - ${f}`);
  for (const w of verdict.warnings) lines.push(`    ⚠ ${w}`);
  lines.push(verdict.passed ? "  QUALITY VERDICT: PASS (candidate may be compared further)" : "  QUALITY VERDICT: FAIL (see above — do not promote on this evidence)");
  return lines;
}

export async function runChampionEval(
  opts: ChampionEvalOptions,
): Promise<{ report: PairedEvalReport; lines: string[]; decision?: import("./promotion-decision.js").ChampionEvalDecision }> {
  const baseline = await loadRunsFromArtifact(opts.baselinePath);
  const candidate = await loadRunsFromArtifact(opts.candidatePath);
  const baselineRuns = baseline.runs;
  const candidateRuns = candidate.runs;
  const report = buildPairedReport(baselineRuns, candidateRuns, opts.mode);
  // Quality policy verdict keeps its legacy default (informational for legacy
  // runs); the E1-08 DECISION layer below is where strict fail-closed applies.
  const quality = evaluateChampionQuality(baselineRuns, candidateRuns, report, {
    strictPromotion: opts.strict ?? false,
  });

  // E1-08: single decision (state machine) on top of the quality policy.
  const { evaluateChampionDecision } = await import("./promotion-decision.js");
  const decision = evaluateChampionDecision(baselineRuns, candidateRuns, report, {
    strict: opts.strict ?? true,
    candidateId: opts.candidateId ?? null,
  });

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
    "",
    "decision (E1-08):",
    `  ${decision.decision}  [${decision.reasonCode}]`,
    `  ${decision.explanation}`,
    ...(decision.comparability !== null && !decision.comparability.comparable
      ? [`  incomparable reasons: ${decision.comparability.reasons.join(", ")}`]
      : []),
  ];
  return { report, lines, decision };
}
