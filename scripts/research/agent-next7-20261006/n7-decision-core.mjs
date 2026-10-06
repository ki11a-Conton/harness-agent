/** Combine recomputed main/holdout judgments. This never installs a champion. */
import { digest } from "./execution-common.mjs";

export function combineJudgments(main, holdout) {
  const intact = (report, role) => {
    if (!report || report.schemaVersion !== "n7-judge-result-v1" || report.experiment !== role) return false;
    const { judgeDigest, ...body } = report;
    return judgeDigest === digest(body);
  };
  const proven = (report, role) => intact(report, role) && report.evidenceKind === "REAL_PROVIDER" &&
    report.verdict === "ALL_GATES_PASSED" && report.modelQuality === "MEASURED_BY_THIS_CAMPAIGN" &&
    Array.isArray(report.gates) && report.gates.length > 0 && report.gates.every(g => g.passed === true);
  const sameBinding = intact(main, "main") && intact(holdout, "holdout") &&
    /^[a-f0-9]{64}$/.test(main.executionBindingDigest ?? "") && main.executionBindingDigest === holdout.executionBindingDigest;
  const gates = [
    { gate: "main_real_all_gates", passed: proven(main, "main") },
    { gate: "holdout_real_all_gates", passed: proven(holdout, "holdout") },
    { gate: "same_execution_binding", passed: sameBinding },
  ];
  const passed = gates.every(g => g.passed);
  const strong = passed && [main, holdout].every(r => r.promotion === "REQUIRES_BOTH_EXPERIMENTS_AND_ENGINEERING_GATES");
  const report = { schemaVersion: "n7-joint-decision-v1", evidenceKind: main?.evidenceKind === "REAL_PROVIDER" && holdout?.evidenceKind === "REAL_PROVIDER" ? "REAL_PROVIDER" : "SYNTHETIC_OR_INCOMPLETE",
    experiments: { main: main?.judgeDigest ?? null, holdout: holdout?.judgeDigest ?? null },
    executionBindingDigest: sameBinding ? main.executionBindingDigest : null, gates,
    verdict: passed ? "BOTH_EXPERIMENT_GATES_PASSED" : "NOT_PROVEN", strongIsolationQualified: strong,
    promotion: strong ? "AWAITING_ENGINEERING_AND_EXISTING_CHAMPION_FLOW" : "NOT_ELIGIBLE",
    note: "Both full experiments are required. Raw judgments must be recomputed by the CLI; this result neither proves engineering gates nor installs or promotes a champion." };
  return { ...report, decisionDigest: digest(report) };
}
