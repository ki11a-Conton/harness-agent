import { describe, expect, it } from "vitest";
import type { PairedEvalReport } from "./paired-eval.js";
import {
  evaluateHardGates,
  evaluatePromotion,
  evaluateQualityGates,
  type HardGateStatus,
} from "./promotion-gate.js";

const GREEN: HardGateStatus = {
  typecheck: true,
  test: true,
  build: true,
  coverage: true,
  crossPlatformMatrix: true,
  adversarialEscapes: 0,
  newFailOpenPath: false,
  crashRecoveryDuplicateSideEffect: false,
};

function report(overrides: Partial<PairedEvalReport["aggregated"]> = {}): PairedEvalReport {
  const base = {
    cases: 30,
    candidateWins: 0,
    baselineWins: 0,
    ties: 30,
    bothFailed: 0,
    netPassedDelta: 0,
    toolCallsDelta: 0,
    tokensDelta: 0,
    costUsdDelta: 0,
    candidateVerifiedRate: 1,
    baselineVerifiedRate: 1,
    recoveryDelta: 0,
    compactionDelta: 0,
  };
  return {
    mode: "real-model",
    cases: [],
    aggregated: { ...base, ...overrides },
    claim: "",
  };
}

describe("P21-4 hard gates", () => {
  it("passes when every pipeline signal is green", () => {
    expect(evaluateHardGates(GREEN)).toMatchObject({ passed: true, failures: [] });
  });

  it("fails fail-closed on any single missing signal", () => {
    expect(evaluateHardGates({ ...GREEN, coverage: false })).toMatchObject({ passed: false });
    expect(evaluateHardGates({ ...GREEN, adversarialEscapes: 1 })).toMatchObject({ passed: false });
    expect(evaluateHardGates({ ...GREEN, newFailOpenPath: true })).toMatchObject({ passed: false });
    expect(evaluateHardGates({ ...GREEN, crashRecoveryDuplicateSideEffect: true })).toMatchObject({ passed: false });
    expect(evaluateHardGates({ ...GREEN, crossPlatformMatrix: false })).toMatchObject({ passed: false });
  });
});

describe("P21-4 quality gates", () => {
  it("passes a neutral paired run (no regression, no verified drop)", () => {
    const result = evaluateQualityGates(report());
    expect(result.passed).toBe(true);
  });

  it("fails on a net regression", () => {
    const result = evaluateQualityGates(report({ netPassedDelta: -2, baselineWins: 2 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/net regression/);
  });

  it("fails when verified completion drops beyond tolerance", () => {
    const result = evaluateQualityGates(
      report({ candidateVerifiedRate: 0.8, baselineVerifiedRate: 1 }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/verified completion dropped/);
  });

  it("fails when cost grows without a net success gain", () => {
    const result = evaluateQualityGates(report({ tokensDelta: 5000, netPassedDelta: 0 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/cost growth without benefit/);
  });

  it("fails when the pass-rate gain is bought by unbounded attempts", () => {
    const result = evaluateQualityGates(
      report({ candidateWins: 2, netPassedDelta: 2, toolCallsDelta: 60, recoveryDelta: 4 }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/unbounded attempts/);
  });

  it("recommends repetition for a below-threshold net delta (small-sample honesty)", () => {
    const result = evaluateQualityGates(
      report({ candidateWins: 1, netPassedDelta: 1, tokensDelta: 0, toolCallsDelta: 0 }),
    );
    // net delta 1 < minConclusive 2 → recommend repetition, but no failure.
    expect(result.passed).toBe(true);
    expect(result.recommendsRepetition).toBe(true);
  });
});

describe("P21-4 full promotion verdict", () => {
  it("promotes only when hard AND quality gates pass and the sample is conclusive", () => {
    const good = evaluatePromotion(
      report({ candidateWins: 3, netPassedDelta: 3, toolCallsDelta: 5, tokensDelta: 0 }),
      GREEN,
    );
    expect(good.hardGatesPassed).toBe(true);
    expect(good.qualityGatesPassed).toBe(true);
    expect(good.recommendsRepetition).toBe(false);
    expect(good.promoted).toBe(true);
  });

  it("never promotes when a hard gate fails, even with a strong candidate", () => {
    const verdict = evaluatePromotion(
      report({ candidateWins: 5, netPassedDelta: 5 }),
      { ...GREEN, adversarialEscapes: 1 },
    );
    expect(verdict.hardGatesPassed).toBe(false);
    expect(verdict.promoted).toBe(false);
  });

  it("a strong candidate on a conclusive sample still promotes with repetition disabled by threshold", () => {
    const verdict = evaluatePromotion(
      report({ candidateWins: 1, netPassedDelta: 1 }),
      GREEN,
      { minConclusiveNetDelta: 1 },
    );
    expect(verdict.promoted).toBe(true);
  });
});
