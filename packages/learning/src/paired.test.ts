import { describe, expect, it } from "vitest";
import type { HarnessScoreCard } from "./scorecard.js";
import {
  comparePaired,
  compareVsReference,
  median,
  medianCard,
  populationVariance,
} from "./paired.js";

function card(overrides: Partial<HarnessScoreCard> = {}): HarnessScoreCard {
  return {
    regressionSuccessRate: 1,
    holdoutSuccessRate: 0.5,
    adversarialPassRate: 1,
    stressPassRate: 1,
    falseCompleteRate: 0,
    recoveryRate: 1,
    retryRate: 0.5,
    latencyP50Ms: 500,
    latencyP95Ms: 1_000,
    avgInputTokens: 1_000,
    avgOutputTokens: 500,
    avgToolCalls: 5,
    contextOverflows: 0,
    securityViolations: 0,
    ...overrides,
  };
}

describe("statistics helpers", () => {
  it("computes medians including even-length means", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("computes population variance", () => {
    expect(populationVariance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4);
    expect(populationVariance([5, 5])).toBe(0);
    expect(populationVariance([5])).toBe(0);
  });

  it("medianCard collapses runs into per-metric medians", () => {
    const collapsed = medianCard([card({ latencyP95Ms: 900 }), card({ latencyP95Ms: 1_100 })]);
    expect(collapsed.latencyP95Ms).toBe(1_000);
    expect(collapsed.regressionSuccessRate).toBe(1);
    expect(collapsed.securityViolations).toBe(0);
  });
});

describe("comparePaired (promotion gate)", () => {
  const champion = [card(), card(), card()];

  it("promotes when the challenger holds regression and improves holdout", () => {
    const challenger = [card({ holdoutSuccessRate: 0.6 }), card({ holdoutSuccessRate: 0.7 }), card({ holdoutSuccessRate: 0.8 })];
    const report = comparePaired(champion, challenger, { holdout: "improve" });

    expect(report.overall).toBe("promote");
    expect(report.reasons).toEqual([]);
  });

  it("rejects a regression beyond tolerance", () => {
    const challenger = [card({ regressionSuccessRate: 0.5 }), card({ regressionSuccessRate: 0.5 }), card({ regressionSuccessRate: 0.5 })];
    const report = comparePaired(champion, challenger);

    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("regressionSuccessRate"))).toBe(true);
  });

  it("allows a regression within tolerance", () => {
    const challenger = [card({ regressionSuccessRate: 0.99 }), card({ regressionSuccessRate: 0.99 }), card({ regressionSuccessRate: 0.99 })];
    expect(comparePaired(champion, challenger).overall).toBe("promote");
  });

  it("rejects on high challenger variance when its median is worse (unstable)", () => {
    const challenger = [
      card({ regressionSuccessRate: 0.7 }),
      card({ regressionSuccessRate: 0.99 }),
      card({ regressionSuccessRate: 0.99 }),
    ];
    const report = comparePaired(champion, challenger);
    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.includes("unstable"))).toBe(true);
  });

  it("fails the false-complete hard gate when any paired run rises", () => {
    const championFC = [card({ falseCompleteRate: 0.1 }), card({ falseCompleteRate: 0.1 }), card({ falseCompleteRate: 0.1 })];
    const challengerFC = [card({ falseCompleteRate: 0.1 }), card({ falseCompleteRate: 0.2 }), card({ falseCompleteRate: 0.1 })];
    const report = comparePaired(championFC, challengerFC);

    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("falseCompleteRate"))).toBe(true);
  });

  it("fails the security hard gate even when every other metric improves", () => {
    const withViolation = [
      card({ securityViolations: 1 }),
      card({ securityViolations: 0 }),
      card({ securityViolations: 0 }),
    ];
    const failing = comparePaired(champion, withViolation);

    expect(failing.overall).toBe("reject");
    expect(failing.reasons.some((r) => r.startsWith("securityViolations"))).toBe(true);
  });

  it("fails latency above the absolute budget", () => {
    const challenger = [
      card({ latencyP95Ms: 2_000 }),
      card({ latencyP95Ms: 2_000 }),
      card({ latencyP95Ms: 2_000 }),
    ];
    const report = comparePaired(champion, challenger, {
      budgets: { latencyP95Ms: 1_500 },
    });
    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("latencyP95Ms"))).toBe(true);
  });

  it("fails latency beyond the relative growth factor", () => {
    const challenger = [
      card({ latencyP95Ms: 1_300 }),
      card({ latencyP95Ms: 1_300 }),
      card({ latencyP95Ms: 1_300 }),
    ];
    const report = comparePaired(champion, challenger);
    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("latencyP95Ms"))).toBe(true);
  });

  it("enforces token budgets when configured", () => {
    const challenger = [
      card({ avgInputTokens: 3_000 }),
      card({ avgInputTokens: 3_000 }),
      card({ avgInputTokens: 3_000 }),
    ];
    const report = comparePaired(champion, challenger, {
      budgets: { avgInputTokens: 2_000 },
    });
    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("avgInputTokens"))).toBe(true);
  });

  it("rejects when holdout must improve but does not", () => {
    const report = comparePaired(champion, champion, { holdout: "improve" });
    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("holdoutSuccessRate"))).toBe(true);
  });

  it("rejects mismatched or insufficient run counts", () => {
    expect(comparePaired(champion, [card()]).overall).toBe("reject");
    expect(comparePaired([card()], [card(), card()]).overall).toBe("reject");
    expect(comparePaired(champion, [card(), card()]).overall).toBe("reject");
  });

  it("reports per-metric verdicts with medians and variances", () => {
    const report = comparePaired(champion, [card({ latencyP95Ms: 1_250 }), card({ latencyP95Ms: 1_300 }), card({ latencyP95Ms: 1_350 })]);
    const latency = report.perMetric.find((v) => v.metric === "latencyP95Ms");
    expect(latency?.championMedian).toBe(1_000);
    expect(latency?.challengerMedian).toBe(1_300);
    expect(latency?.verdict).toBe("fail");
    expect(report.perMetric.some((v) => v.metric === "recoveryRate" && !v.gated)).toBe(true);
  });
});

describe("compareVsReference (rollback)", () => {
  it("rolls back when any current run exceeds the reference security violations", () => {
    const reference = card({ securityViolations: 0 });
    const current = [card(), card({ securityViolations: 1 }), card()];
    const report = compareVsReference(reference, current);

    expect(report.overall).toBe("reject");
    expect(report.reasons.some((r) => r.startsWith("securityViolations"))).toBe(true);
  });

  it("holds the promotion when current runs stay within the reference", () => {
    const reference = card({ latencyP95Ms: 1_000, regressionSuccessRate: 0.9 });
    const current = [card({ latencyP95Ms: 900 }), card({ latencyP95Ms: 1_000 }), card({ latencyP95Ms: 1_100 })];
    expect(compareVsReference(reference, current).overall).toBe("promote");
  });

  it("rolls back on regression below the reference median minus tolerance", () => {
    const reference = card({ regressionSuccessRate: 1 });
    const current = [card({ regressionSuccessRate: 0.6 }), card({ regressionSuccessRate: 0.6 }), card({ regressionSuccessRate: 0.6 })];
    const report = compareVsReference(reference, current);
    expect(report.overall).toBe("reject");
  });

  it("requires repeated current runs", () => {
    expect(compareVsReference(card(), [card()]).overall).toBe("reject");
  });
});
