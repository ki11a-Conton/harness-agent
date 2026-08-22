import { describe, expect, it } from "vitest";
import { chooseBestSchedulerPolicy, stressStable } from "./scheduler-policy.js";

const CHAMP = {
  policyName: "champion",
  stressPassRate: 0.7,
  securityViolations: 0,
  falseCompletes: 0,
  p95LatencyMs: 5_000,
  totalTokens: 20_000,
};

describe("P3-12 scheduler policy — stress-suite promotion", () => {
  it("promotes a stress-stable policy that lifts the stress pass rate", () => {
    const stable = { ...CHAMP, policyName: "max4-fair", stressPassRate: 0.85 };
    const d = chooseBestSchedulerPolicy(CHAMP, [stable]);
    expect(d.keepChampion).toBe(false);
    expect(d.promotedName).toBe("max4-fair");
  });

  it("rejects a policy with new security violations (instability)", () => {
    const jumpy = { ...CHAMP, policyName: "greedy", stressPassRate: 0.9, securityViolations: 2 };
    const d = chooseBestSchedulerPolicy(CHAMP, [jumpy]);
    expect(d.keepChampion).toBe(true);
  });

  it("stressStable fails on raised false-complete / latency / token overruns", () => {
    expect(stressStable({ ...CHAMP, falseCompletes: 1 }).stable).toBe(false);
    expect(
      stressStable({ ...CHAMP, p95LatencyMs: 99_999 }, { p95LatencyMsBudget: 50_000 }).stable,
    ).toBe(false);
    expect(
      stressStable({ ...CHAMP, totalTokens: 99_999 }, { tokenBudget: 50_000 }).stable,
    ).toBe(false);
    expect(stressStable(CHAMP).stable).toBe(true);
  });

  it("keeps the champion when nothing clears the stress gate", () => {
    const d = chooseBestSchedulerPolicy(CHAMP, [
      { ...CHAMP, policyName: "instable", securityViolations: 1, stressPassRate: 0.95 },
      { ...CHAMP, policyName: "nolift", stressPassRate: 0.7 },
    ]);
    expect(d.keepChampion).toBe(true);
  });
});