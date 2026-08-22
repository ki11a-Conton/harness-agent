import { describe, expect, it } from "vitest";
import { gradeOf } from "./runner.js";
import { buildFalseCompleteScenarios } from "./false-complete-cases.js";

describe("P19-6 false-complete benchmark expansion", () => {
  it("has all seven canonical failure modes", () => {
    const scenarios = buildFalseCompleteScenarios();
    expect(scenarios).toHaveLength(7);
    const modes = scenarios.map((s) => s.id);
    expect(modes).toContain("fc-1-code-changed-no-tests");
    expect(modes).toContain("fc-2-tests-failed-said-done");
    expect(modes).toContain("fc-3-verifier-missing");
    expect(modes).toContain("fc-4-verifier-timeout");
    expect(modes).toContain("fc-5-reviewer-parse-failure");
    expect(modes).toContain("fc-6-partial-tests-passed");
    expect(modes).toContain("fc-7-empty-change-set-claimed-done");
  });

  it("grades every scenario exactly as its failure mode dictates (never from 'done' wording)", () => {
    for (const scenario of buildFalseCompleteScenarios()) {
      const actual = gradeOf(scenario.events);
      expect(actual, scenario.id).toBe(scenario.expectedGrade);
    }
  });

  it("a verified_complete grade is NEVER the answer for a code-changing turn without a gate", () => {
    const scenarios = buildFalseCompleteScenarios();
    const noGate = scenarios.find((s) => s.id === "fc-1-code-changed-no-tests")!;
    expect(noGate.expectedGrade).toBe("unverified_complete");
    expect(noGate.expectedGrade).not.toBe("verified_complete");
  });

  it("every scenario carries a runner-ready EvalCase asserting the same grade", () => {
    for (const scenario of buildFalseCompleteScenarios()) {
      expect(scenario.caseDef.expectedGrade).toBe(scenario.expectedGrade);
      expect(scenario.caseDef.tags).toContain("false-complete");
    }
  });
});
