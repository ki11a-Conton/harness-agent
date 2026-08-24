import { readFile } from "node:fs/promises";
import type { EvalOutcome } from "@ar/evaluation";
import { buildPairedReport, type EvalMode, type PairedEvalReport } from "@ar/evaluation";

/**
 * P21-3 — `agent champion eval <baseline-runs.json> <candidate-runs.json>
 * [--mode stub|real-model]`.
 *
 * Both files are JSON arrays of EvalOutcome (the per-case runs produced by a
 * benchmark harness run). The command builds the paired report (same cases,
 * per-case wins/losses/ties, full metric set) and prints a TRUTH-RULE-compliant
 * claim. A missing candidate twin for any baseline case is a hard error —
 * never silently dropped.
 */

export interface ChampionEvalOptions {
  baselinePath: string;
  candidatePath: string;
  mode: EvalMode;
}

export async function runChampionEval(
  opts: ChampionEvalOptions,
): Promise<{ report: PairedEvalReport; lines: string[] }> {
  const baselineRaw = await readFile(opts.baselinePath, "utf8");
  const candidateRaw = await readFile(opts.candidatePath, "utf8");
  const baselineRuns = JSON.parse(baselineRaw) as EvalOutcome[];
  const candidateRuns = JSON.parse(candidateRaw) as EvalOutcome[];
  const report = buildPairedReport(baselineRuns, candidateRuns, opts.mode);

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
  ];
  return { report, lines };
}
