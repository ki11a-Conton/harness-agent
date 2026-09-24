/**
 * E2-00 — CLI surface for the baseline audit and champion quarantine.
 *
 * `agent champion audit [--baseline <path>] [--candidate <path>] [--review-sha <sha>]`
 *   Read-only audit of the recorded AR2/baseline evidence against the review
 *   baseline. Prints the stable E2BaselineAuditResult JSON (no model calls).
 *
 * `agent champion quarantine [--reason-codes a,b,c] [--note <text>]`
 *   Explicit quarantine step: demotes the active champion to C0 while
 *   preserving the full history. Only reachable from the CLI, like promote.
 *
 * Both read/write docs/evolution/champion-state.json through the same
 * injectable file helpers used by promote/state, so the chain stays auditable.
 */

import { auditBaselineEvidence, type E2BaselineAuditResult } from "@ar/evaluation";
import { readChampionStateFile, writeChampionStateFile } from "./champion-state-file.js";

export const E2_REVIEW_BASELINE_SHA = "5a6f90c4767413ae1c89dca7a451a13ab5dd6cf0";
export const E2_BASELINE_ARTIFACT = "benchmarks/results/2026-08-31-deepseek-v4-flash-budget-aware/baseline-holdout.json";
export const E2_CANDIDATE_ARTIFACT = "benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/candidate-holdout.json";

export interface CommandResult {
  exitCode: number;
  lines: string[];
}

/** Run the read-only E2 baseline audit and render the stable JSON. */
export async function e2AuditCmd(rest: string[]): Promise<CommandResult> {
  const pick = (flag: string, fallback: string): string => {
    const i = rest.indexOf(flag);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1]! : fallback;
  };
  const baselinePath = pick("--baseline", E2_BASELINE_ARTIFACT);
  const candidatePath = pick("--candidate", E2_CANDIDATE_ARTIFACT);
  const reviewSha = pick("--review-sha", E2_REVIEW_BASELINE_SHA);

  const state = await readChampionStateFile();
  if (state instanceof Error) {
    return { exitCode: 1, lines: [`champion audit: ${state.message}`] };
  }

  const result: E2BaselineAuditResult = await auditBaselineEvidence({
    reviewBaselineSha: reviewSha,
    baselinePath,
    candidatePath,
    championApplied: state.applied === true && state.level !== "C0",
    candidateId: state.candidateId,
  });

  const lines = [
    `champion audit (E2-00):`,
    `  review baseline: ${reviewSha}`,
    `  baseline artifact: ${baselinePath} (gitSha ${result.baseline.gitSha ?? "?"}, dirty ${result.baseline.dirty})`,
    `  candidate artifact: ${candidatePath} (gitSha ${result.candidate.gitSha ?? "?"}, dirty ${result.candidate.dirty})`,
    `  validForPromotion: ${result.validForPromotion}`,
    `  activeForProduction: ${result.activeForProduction}`,
    `  historicalDecision: ${result.historicalDecision ?? "(none)"}`,
    `  validity: ${result.validity}`,
    `  recommendedNextAction: ${result.recommendedNextAction}`,
    `  reasonCodes: ${result.reasonCodes.join(", ") || "(none)"}`,
    `  checks:`,
    ...result.checks.map((c: { code: string; passed: boolean; detail: string }) => `    ${c.passed ? "PASS" : "FAIL"}  ${c.code}  ${c.detail}`),
    JSON.stringify(result, null, 2),
  ];
  return { exitCode: result.validForPromotion ? 0 : 1, lines };
}

/** Explicitly quarantine the active champion back to C0 (preserving history). */
export async function e2QuarantineCmd(rest: string[]): Promise<CommandResult> {
  const { quarantineChampionState } = await import("@ar/evaluation");
  const rcIdx = rest.indexOf("--reason-codes");
  const reasonCodes = rcIdx >= 0 && rest[rcIdx + 1] !== undefined
    ? rest[rcIdx + 1]!.split(",").map((s) => s.trim()).filter(Boolean)
    : ["SOURCE_DIRTY", "SINGLE_RUN_INSUFFICIENT", "PRODUCTION_APPLICATION_UNPROVEN"];
  const noteIdx = rest.indexOf("--note");
  const note = noteIdx >= 0 && rest[noteIdx + 1] !== undefined
    ? rest[noteIdx + 1]!
    : "single dirty run cannot be production-valid under E2 (E2-00 quarantine)";

  const current = await readChampionStateFile();
  if (current instanceof Error) {
    return { exitCode: 1, lines: [`champion quarantine: ${current.message}`] };
  }
  const quarantined = quarantineChampionState(current, { reasonCodes, note });
  if (quarantined.level === current.level && quarantined.level === "C0" && current.level === "C0") {
    // Already C0 — still record the audit action for provenance.
    await writeChampionStateFile(quarantined);
    return {
      exitCode: 0,
      lines: [
        `champion quarantine: already C0 — recorded audit action (${reasonCodes.join(", ")})`,
        `  history: ${quarantined.history.length} promotion(s) preserved`,
      ],
    };
  }
  await writeChampionStateFile(quarantined);
  return {
    exitCode: 0,
    lines: [
      `champion quarantine: ${current.level} -> C0 (${current.candidateId ?? "(none)"})`,
      `  reasonCodes: ${reasonCodes.join(", ")}`,
      `  note: ${note}`,
      `  history: ${quarantined.history.length} promotion(s) preserved`,
      `  validity: ${quarantined.validity}`,
    ],
  };
}
