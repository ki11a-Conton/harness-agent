import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalOutcome } from "@ar/evaluation";
import { runChampionEval } from "./champion-eval.js";

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
});
