import { describe, expect, it } from "vitest";
import {
  decideChampionV3,
  CHAMPION_DECISION_ENVELOPE_V3_VERSION,
  envelopeDigestV3,
  type DecisionGateInputV3,
} from "./champion-decision-v3.js";

/** A clean, sufficient, ACCEPT-able input (3 reps, +6 delta, activated). */
function acceptBase(overrides: Partial<DecisionGateInputV3> = {}): DecisionGateInputV3 {
  return {
    digestValid: true,
    pairComplete: true,
    comparable: true,
    incomparabilityReasons: [],
    activationCoverage: 0.9,
    activationEligibleCases: 10,
    minActivationEligibleCases: 3,
    minActivationCoverage: 0.5,
    securityBreachesCandidate: 0,
    securityBreachesBaseline: 0,
    baselineVerifiedRate: 0.8,
    candidateVerifiedRate: 0.85,
    maxVerifiedDrop: 0.05,
    infraFailuresBaseline: 0,
    infraFailuresCandidate: 0,
    cases: 32,
    netPassedDelta: 6,
    repetitions: 3,
    perRepetitionDeltas: [2, 2, 2],
    minConclusiveNetDelta: 2,
    tokensDelta: 40000,
    maxTokensDelta: 100000,
    recommendsRepetition: false,
    ...overrides,
  };
}

describe("E2-06 champion decision V3 golden cases", () => {
  it("golden: dirty cross-SHA AR2 -> INVALID", () => {
    const env = decideChampionV3(acceptBase({
      digestValid: false,
      comparable: false,
      incomparabilityReasons: ["BUILD_SHA_MISMATCH", "BUILD_DIRTY"],
    }));
    expect(env.decision).toBe("INVALID");
    expect(env.reasonCodes).toContain("ARTIFACT_DIGEST_MISMATCH");
    expect(env.reasonCodes).toContain("INCOMPARABLE");
  });

  it("golden: single run 32 cases 10→11 net +1 -> INCONCLUSIVE (never ACCEPT)", () => {
    const env = decideChampionV3(acceptBase({
      netPassedDelta: 1,
      repetitions: 1,
      perRepetitionDeltas: [1],
      minConclusiveNetDelta: 2,
    }));
    expect(env.decision).toBe("INCONCLUSIVE");
    expect(env.reasonCodes).toContain("SINGLE_RUN_REQUIRES_REPETITION");
    expect(env.reasonCodes).toContain("EFFECT_BELOW_THRESHOLD");
  });

  it("golden: recommendsRepetition=true is BINDING — never ACCEPT even with positive delta", () => {
    const env = decideChampionV3(acceptBase({
      netPassedDelta: 3,
      repetitions: 3,
      perRepetitionDeltas: [1, 1, 1],
      recommendsRepetition: true,
    }));
    expect(env.decision).toBe("INCONCLUSIVE");
    expect(env.reasonCodes).toContain("SINGLE_RUN_REQUIRES_REPETITION");
  });

  it("golden: 3 repetitions +/−/+ with tiny net effect -> INCONCLUSIVE (direction unstable)", () => {
    const env = decideChampionV3(acceptBase({
      netPassedDelta: 1,
      repetitions: 3,
      perRepetitionDeltas: [2, -1, 2],
      minConclusiveNetDelta: 2,
    }));
    expect(env.decision).toBe("INCONCLUSIVE");
    expect(env.reasonCodes).toContain("EFFECT_BELOW_THRESHOLD");
    expect(env.reasonCodes).toContain("DIRECTION_UNSTABLE");
  });

  it("golden: 3 repetitions reaching pre-registered effect, no regression -> ACCEPT", () => {
    const env = decideChampionV3(acceptBase());
    expect(env.decision).toBe("ACCEPT");
    expect(env.gates.repetitionSufficient).toBe(true);
    expect(env.gates.effectSufficient).toBe(true);
    expect(env.gates.directionStable).toBe(true);
    expect(env.reasonCodes).toEqual([]);
  });

  it("golden: verified completion regression -> REJECT", () => {
    const env = decideChampionV3(acceptBase({
      baselineVerifiedRate: 0.85,
      candidateVerifiedRate: 0.6,
      maxVerifiedDrop: 0.05,
    }));
    expect(env.decision).toBe("REJECT");
    expect(env.reasonCodes).toContain("VERIFIED_REGRESSION");
  });

  it("golden: actual security breach > 0 -> REJECT", () => {
    const env = decideChampionV3(acceptBase({
      securityBreachesCandidate: 1,
      securityBreachesBaseline: 0,
    }));
    expect(env.decision).toBe("REJECT");
    expect(env.reasonCodes).toContain("SECURITY_BREACH");
  });

  it("golden: activation coverage insufficient -> INCONCLUSIVE (never ACCEPT)", () => {
    const env = decideChampionV3(acceptBase({
      activationCoverage: 0.2,
      activationEligibleCases: 5,
      minActivationCoverage: 0.5,
    }));
    expect(env.decision).toBe("INCONCLUSIVE");
    expect(env.reasonCodes).toContain("ACTIVATION_UNSATISFIED");
    expect(env.reasonCodes).not.toContain("SECURITY_BREACH");
  });

  it("golden: artifact/summary digest mismatch -> INVALID", () => {
    const env = decideChampionV3(acceptBase({ digestValid: false }));
    expect(env.decision).toBe("INVALID");
    expect(env.reasonCodes).toContain("ARTIFACT_DIGEST_MISMATCH");
  });

  it("golden: incomplete pairs -> INVALID", () => {
    const env = decideChampionV3(acceptBase({ pairComplete: false }));
    expect(env.decision).toBe("INVALID");
    expect(env.reasonCodes).toContain("PAIR_INCOMPLETE");
  });

  it("golden: cost ceiling exceeded -> REJECT", () => {
    const env = decideChampionV3(acceptBase({
      tokensDelta: 500000,
      maxTokensDelta: 100000,
    }));
    expect(env.decision).toBe("REJECT");
    expect(env.reasonCodes).toContain("COST_CEILING_EXCEEDED");
  });

  it("golden: runtime error asymmetry (candidate worse) -> REJECT", () => {
    const env = decideChampionV3(acceptBase({
      infraFailuresBaseline: 0,
      infraFailuresCandidate: 3,
    }));
    expect(env.decision).toBe("REJECT");
    expect(env.reasonCodes).toContain("RUNTIME_ERROR_ASYMMETRY");
  });

  it("envelope is machine-readable with policy version, stats and stable digest", () => {
    const env = decideChampionV3(acceptBase());
    expect(env.schemaVersion).toBe(CHAMPION_DECISION_ENVELOPE_V3_VERSION);
    expect(env.gates.artifactIntegrity).toBe(true);
    expect(env.statistics.cases).toBe(32);
    expect(env.nextStep.length).toBeGreaterThan(0);
    const d1 = envelopeDigestV3(acceptBase());
    const d2 = envelopeDigestV3(acceptBase());
    expect(d1).toBe(d2);
  });
});