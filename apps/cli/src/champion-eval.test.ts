import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalOutcome } from "@ar/evaluation";
import { buildPairedReport } from "@ar/evaluation";
import { runChampionEval, evaluateChampionQuality } from "./champion-eval.js";

let dir = "";
afterEach(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function writeRuns(name: string, runs: EvalOutcome[]): Promise<string> {
  if (dir === "") dir = await mkdtemp(join(tmpdir(), "champion-eval-"));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(runs, null, 2), "utf8");
  return path;
}

function run(caseId: string, passed: boolean, grade: string): EvalOutcome {
  return {
    caseId,
    status: passed ? "passed" : "failed",
    actualStatus: passed ? "completed" : "failed",
    events: [],
    metrics: {
      turn_count: 1,
      tool_call_count: 1,
      tokens_input: 70,
      tokens_output: 30,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 100,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0.001,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: 1,
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
    grade,
  };
}

describe("P21-3 champion eval CLI", () => {
  it("reports paired wins/losses/ties and a truth-rule claim", async () => {
    const baselinePath = await writeRuns("baseline.json", [
      run("a", true, "verified_complete"),
      run("b", false, "verification_failed"),
    ]);
    const candidatePath = await writeRuns("candidate.json", [
      run("a", true, "verified_complete"),
      run("b", true, "verified_complete"),
    ]);
    const { report, lines } = await runChampionEval({
      baselinePath,
      candidatePath,
      mode: "stub",
    });
    expect(report.aggregated.candidateWins).toBe(1);
    expect(report.aggregated.baselineWins).toBe(0);
    expect(report.aggregated.ties).toBe(1);
    expect(report.claim).toContain("mechanism-real passed (stub provider)");
    expect(report.claim).toContain("does NOT claim the agent is stronger");
    expect(lines.join("\n")).toContain("per-case:");
    expect(lines.join("\n")).toContain("b: candidate_only_passed");
  });

  it("fails loudly when a candidate case has no baseline twin", async () => {
    const baselinePath = await writeRuns("baseline2.json", [run("a", true, "verified_complete")]);
    const candidatePath = await writeRuns("candidate2.json", [run("a", true, "verified_complete"), run("b", true, "verified_complete")]);
    // extra candidate case is fine (candidateByCase map superset)
    const ok = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    expect(ok.report.aggregated.cases).toBe(1);

    // missing baseline twin is a hard error
    const badBase = await writeRuns("baseline3.json", [run("a", true, "verified_complete"), run("c", true, "verified_complete")]);
    await expect(
      runChampionEval({ baselinePath: badBase, candidatePath, mode: "real-model" }),
    ).rejects.toThrow(/SAME cases/);
  });

  it("real-model mode flags cost increases needing justification", async () => {
    const baselinePath = await writeRuns("baseline4.json", [run("a", true, "verified_complete")]);
    const candidatePath = await writeRuns("candidate4.json", [run("a", true, "verified_complete")]);
    const { report } = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    // tokens delta is 0 here (same run metrics) — claim must be neutral, not overstated
    expect(report.claim).toContain("real-model paired eval");
  });

  it("P38.3-12: quality policy PASSes for a clean same-case comparison", async () => {
    const baselinePath = await writeRuns("baseline5.json", [
      run("a", true, "verified_complete"),
      run("b", true, "verified_complete"),
    ]);
    const candidatePath = await writeRuns("candidate5.json", [
      run("a", true, "verified_complete"),
      run("b", true, "verified_complete"),
    ]);
    const { lines } = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    const out = lines.join("\n");
    expect(out).toContain("quality policy (P38.3-12 + P38.4-8):");
    expect(out).toContain("PASS  same case set");
    expect(out).toContain("PASS  compatible judge version");
    expect(out).toContain("PASS  security non-regression");
    expect(out).toContain("QUALITY VERDICT: PASS");
  });

  it("P38.3-12: quality policy FAILs on a judge-version mismatch", async () => {
    const baselinePath = await writeRuns("baseline6.json", [
      { ...run("a", true, "verified_complete"), judgeVersion: "1.0.0" },
    ]);
    const candidatePath = await writeRuns("candidate6.json", [
      { ...run("a", true, "verified_complete"), judgeVersion: "1.1.0" },
    ]);
    const { lines } = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    const out = lines.join("\n");
    expect(out).toContain("FAIL  compatible judge version");
    expect(out).toContain("judge version mismatch");
    expect(out).toContain("QUALITY VERDICT: FAIL");
  });

  it("P38.3-12: security regression fails the policy (never acceptable)", async () => {
    const baseline = run("a", true, "verified_complete");
    const insecure = run("a", false, "verification_failed");
    // E1-09: only TYPED security violations count (stable prefix taxonomy).
    insecure.violations = ["forbidden command attempted: rm -rf /etc"];
    const baselinePath = await writeRuns("baseline7.json", [baseline]);
    const candidatePath = await writeRuns("candidate7.json", [insecure]);
    const { lines } = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    const out = lines.join("\n");
    expect(out).toContain("FAIL  security non-regression");
    expect(out).toContain("security violations increased");
    expect(out).toContain("QUALITY VERDICT: FAIL");
  });

  it("P38.3-12: new infrastructure failures fail the policy", async () => {
    const baseline = run("a", true, "verified_complete");
    const infraFail = run("a", false, "verification_failed");
    infraFail.failureCategory = "infrastructure";
    const baselinePath = await writeRuns("baseline8.json", [baseline]);
    const candidatePath = await writeRuns("candidate8.json", [infraFail]);
    const { lines } = await runChampionEval({ baselinePath, candidatePath, mode: "real-model" });
    const out = lines.join("\n");
    expect(out).toContain("FAIL  no new harness/judge/infra failures");
    expect(out).toContain("QUALITY VERDICT: FAIL");
  });

  describe("P38.4-8 provenance comparability", () => {
    // Runs carrying full P38.4-7 provenance.
    function provRun(
      caseId: string,
      passed: boolean,
      evalCtx: string,
      candCfg: string,
      controlled?: string[],
    ): EvalOutcome {
      return {
        ...run(caseId, passed, passed ? "verified_complete" : "verification_failed"),
        evaluationContextHash: evalCtx,
        candidateConfigHash: candCfg,
        ...(controlled !== undefined ? { controlledDifference: controlled } : {}),
      };
    }

    function verdict(
      baselineRuns: EvalOutcome[],
      candidateRuns: EvalOutcome[],
      opts?: { strictPromotion?: boolean },
    ) {
      const report = buildPairedReport(baselineRuns, candidateRuns, "stub");
      return evaluateChampionQuality(baselineRuns, candidateRuns, report, opts);
    }

    it("1. same context + candidate differs → comparable (PASS)", () => {
      const v = verdict(
        [provRun("a", true, "ctx-1", "base-cfg")],
        [provRun("a", true, "ctx-1", "cand-cfg", ["recovery.strategy"])],
      );
      expect(v.checks.compatibleEvaluationContext).toBe(true);
      expect(v.checks.candidateActuallyDiffers).toBe(true);
      expect(v.checks.controlledDifferenceDeclared).toBe(true);
      expect(v.passed).toBe(true);
    });

    it("2. judge same but fixture hash differs → FAIL (context mismatch)", () => {
      const v = verdict(
        [provRun("a", true, "ctx-1", "base-cfg")],
        [provRun("a", true, "ctx-2", "cand-cfg", ["recovery.strategy"])],
      );
      expect(v.checks.compatibleEvaluationContext).toBe(false);
      expect(v.passed).toBe(false);
      expect(v.failures.join("\n")).toContain("evaluation context mismatch");
    });

    it("3. tool policy differs unexpectedly → FAIL via context hash", () => {
      // Same judge, same case, but the evaluation context (which includes the
      // tool schema digest) differs — not attributable.
      const v = verdict(
        [provRun("a", true, "ctx-toolA", "base-cfg")],
        [provRun("a", true, "ctx-toolB", "cand-cfg", ["recovery.strategy"])],
      );
      expect(v.checks.compatibleEvaluationContext).toBe(false);
      expect(v.passed).toBe(false);
    });

    it("4. candidate config identical while challenger claim made → FAIL", () => {
      const v = verdict(
        [provRun("a", true, "ctx-1", "same-cfg")],
        [provRun("a", true, "ctx-1", "same-cfg", ["recovery.strategy"])],
      );
      expect(v.checks.candidateActuallyDiffers).toBe(false);
      expect(v.passed).toBe(false);
      expect(v.failures.join("\n")).toContain("identical to baseline");
    });

    it("5. controlledDifference missing in strict promotion mode → FAIL", () => {
      const v = verdict(
        [provRun("a", true, "ctx-1", "base-cfg")],
        [provRun("a", true, "ctx-1", "cand-cfg")], // no controlledDifference
        { strictPromotion: true },
      );
      expect(v.checks.controlledDifferenceDeclared).toBe(false);
      expect(v.passed).toBe(false);
    });

    it("6. legacy run behavior is explicit and truthful (informational, non-strict passes)", () => {
      // Legacy runs have no provenance fields. Non-strict: informational only,
      // verdict still PASSes for a clean comparison.
      const v = verdict([run("a", true, "verified_complete")], [run("a", true, "verified_complete")]);
      expect(v.checks.compatibleEvaluationContext).toBe(true);
      expect(v.passed).toBe(true);
      // But the informational warning is present so reviewers know.
      expect(v.warnings.join("\n")).toContain("legacy provenance");
    });

    it("7. security regression still fails even when provenance passes", () => {
      const insecure = provRun("a", false, "ctx-1", "cand-cfg", ["recovery.strategy"]);
      // E1-09: typed prefix so the taxonomy counts it as a security violation.
      insecure.violations = ["forbidden network attempted: curl to exfil"];
      const v = verdict(
        [provRun("a", true, "ctx-1", "base-cfg")],
        [insecure],
      );
      expect(v.checks.compatibleEvaluationContext).toBe(true);
      expect(v.checks.candidateActuallyDiffers).toBe(true);
      expect(v.checks.securityNonRegression).toBe(false);
      expect(v.passed).toBe(false);
    });

    it("8. extra candidate case still fails (sameCaseSet)", () => {
      const v = verdict(
        [provRun("a", true, "ctx-1", "base-cfg")],
        [
          provRun("a", true, "ctx-1", "cand-cfg", ["recovery.strategy"]),
          provRun("b", true, "ctx-1", "cand-cfg", ["recovery.strategy"]),
        ],
      );
      expect(v.checks.sameCaseSet).toBe(false);
      expect(v.passed).toBe(false);
      expect(v.failures.join("\n")).toContain("not in the baseline");
    });
  });
});
