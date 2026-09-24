import { describe, expect, it } from "vitest";
import { chooseBestRecoveryPolicy, recoveryCostScore } from "./recovery-policy.js";

const CHAMP = {
  policyName: "champion",
  passRate: 0.7,
  totalRetries: 4,
  totalTokens: 20_000,
  costScore: recoveryCostScore(0.7, 4, 20_000),
};

describe("P3-13 recovery policy — cost gate", () => {
  it("promotes a policy that gains quality per retry (cost gate passes)", () => {
    // Better pass, similar retries → higher cost score.
    const good = {
      policyName: "smart-retry",
      passRate: 0.85,
      totalRetries: 5,
      totalTokens: 22_000,
      costScore: recoveryCostScore(0.85, 5, 22_000),
    };
    const d = chooseBestRecoveryPolicy(CHAMP, [good]);
    expect(d.keepChampion).toBe(false);
    expect(d.promotedName).toBe("smart-retry");
  });

  it("rejects a policy that brute-forces success with mass retries", () => {
    const brute = {
      policyName: "retry-everything",
      passRate: 0.95, // looks best
      totalRetries: 40, // 10x champion
      totalTokens: 120_000,
      costScore: recoveryCostScore(0.95, 40, 120_000),
    };
    const d = chooseBestRecoveryPolicy(CHAMP, [brute]);
    expect(d.keepChampion).toBe(true);
    expect(d.reasons.join(" ")).toContain("brute-forces");
  });

  it("fails the cost gate when retries inflate without proportional quality", () => {
    const inflated = {
      policyName: "many-retries-lower-score",
      passRate: 0.75,
      totalRetries: 22,
      totalTokens: 90_000,
      costScore: recoveryCostScore(0.75, 22, 90_000),
    };
    const d = chooseBestRecoveryPolicy(CHAMP, [inflated], { maxRetryMultiplier: 3 });
    // 22 > 4*3=12 → brute-force excluded.
    expect(d.keepChampion).toBe(true);
  });

  it("keeps the champion when nothing clears the cost gate", () => {
    const meh = { ...CHAMP, policyName: "no-gain", passRate: 0.7, totalRetries: 4, costScore: CHAMP.costScore };
    const d = chooseBestRecoveryPolicy(CHAMP, [meh]);
    expect(d.keepChampion).toBe(true);
  });

  it("cost score punishes retry/token inflation", () => {
    expect(recoveryCostScore(0.9, 2, 10_000)).toBeGreaterThan(recoveryCostScore(0.9, 40, 10_000));
    expect(recoveryCostScore(0.9, 2, 10_000)).toBeGreaterThan(recoveryCostScore(0.9, 2, 120_000));
  });
});