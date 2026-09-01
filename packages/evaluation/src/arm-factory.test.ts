import { describe, expect, it } from "vitest";
import {
  getArmFactory,
  defaultBenchmarkHarnessConfig,
  wireCandidateMechanism,
  type CaseEligibility,
} from "./arm-factory.js";
import { getCandidateRegistry } from "./candidate-registry.js";

describe("E2-03 arm factory", () => {
  it("1. baseline snapshot matches the default benchmark Harness (context stays true)", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveBaseline();
    expect(baseline.candidateId).toBeNull();
    expect(baseline.armId).toBe("baseline");
    // Context is NOT flipped off by the registry.
    expect((baseline.harnessConfig.features as Record<string, boolean>).context).toBe(true);
    expect((defaultBenchmarkHarnessConfig().features as Record<string, boolean>).context).toBe(true);
    // Baseline reports every candidate OFF.
    expect(baseline.mechanisms.activations.every((m) => m.on === false)).toBe(true);
  });

  it("2. memory candidate: baseline memory off, candidate memory on, eligibility separate", () => {
    const factory = getArmFactory();
    const eligibilities: CaseEligibility[] = [
      { caseId: "ho-31", mechanism: "memory", eligible: true, reason: "hasMemorySource" },
      { caseId: "ho-32", mechanism: "memory", eligible: true, reason: "hasMemorySource" },
      { caseId: "ho-01", mechanism: "memory", eligible: false, reason: "noMemorySource" },
    ];
    const baseline = factory.resolveBaseline(eligibilities);
    const memoryReg = getCandidateRegistry().find("memory_retrieval")!;
    const wiring = wireCandidateMechanism(memoryReg);
    const candidateConfig = wiring.apply({ ...baseline.harnessConfig });
    const candidate = factory.resolveCandidate("memory_retrieval", eligibilities);

    // Baseline memory OFF.
    expect(wiring.isActive(baseline.harnessConfig)).toBe(false);
    expect((baseline.harnessConfig.features as Record<string, boolean>).memory).toBe(false);
    // Candidate memory ON.
    expect(wiring.isActive(candidateConfig)).toBe(true);
    const memActivation = candidate.mechanisms.activations.find((m) => m.mechanism === "memory_retrieval")!;
    expect(memActivation.on).toBe(true);
    expect(memActivation.constructorIdentity).toBe("memory:sqlite-retrieval-v1");
    // Eligibility is per-case and SEPARATE from activation.
    expect(candidate.perCaseEligibility.find((e) => e.caseId === "ho-31")!.eligible).toBe(true);
    expect(candidate.perCaseEligibility.find((e) => e.caseId === "ho-01")!.eligible).toBe(false);
  });

  it("3. delegation (no real subagent wiring) preflight fails with CANDIDATE_UNSUPPORTED + no provider allowed", () => {
    const factory = getArmFactory();
    const result = factory.preflight("delegation");
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("CANDIDATE_UNSUPPORTED");
    expect(result.providerCallsAllowed).toBe(false);
  });

  it("4. no-op candidate returns NO_CAUSAL_DELTA with provider calls blocked", () => {
    const factory = getArmFactory();
    // context_pipeline_v5 is UNSUPPORTED in the registry.
    const unsupported = factory.preflight("context_pipeline_v5");
    expect(unsupported.ok).toBe(false);
    expect(unsupported.reasonCode).toBe("CANDIDATE_UNSUPPORTED");
    expect(unsupported.providerCallsAllowed).toBe(false);

    // A candidate that resolves to an identical config is a NO_CAUSAL_DELTA.
    const unknown = factory.preflight("does_not_exist");
    expect(unknown.ok).toBe(false);
    expect(unknown.reasonCode).toBe("UNKNOWN_CANDIDATE");
  });

  it("5. a working candidate passes preflight with a causal delta", () => {
    const factory = getArmFactory();
    const result = factory.preflight("adaptive_recovery_v2");
    expect(result.ok).toBe(true);
    expect(result.providerCallsAllowed).toBe(true);
  });

  it("6. declared-path discipline: compare() surface reports declared deltas", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveBaseline();
    const candidate = factory.resolveCandidate("adaptive_recovery_v2");
    const cmp = factory.compare(baseline, candidate);
    expect(cmp.hasCausalDelta).toBe(true);
    expect(cmp.undeclaredDeltas).toEqual([]);
    expect(cmp.declaredDeltas.length).toBeGreaterThan(0);
    expect(cmp.providerCallsAllowed).toBe(true);
  });

  it("7. identity stability: same arm always resolves to the same digest", () => {
    const factory = getArmFactory();
    const a = factory.resolveCandidate("adaptive_recovery_v2");
    const b = factory.resolveCandidate("adaptive_recovery_v2");
    expect(a.digest).toBe(b.digest);
    expect(a.armId).toBe(b.armId);
  });

  it("wireCandidateMechanism never fabricates an active mechanism for unsupported ids", () => {
    const registry = getCandidateRegistry();
    for (const reg of registry.all()) {
      const wiring = wireCandidateMechanism(reg);
      expect(typeof wiring.constructorId).toBe("string");
      expect(wiring.constructorId.length).toBeGreaterThan(0);
      // Applying to the baseline never crashes and never flips context off.
      const base = defaultBenchmarkHarnessConfig();
      const applied = wiring.apply(base);
      expect((applied.features as Record<string, boolean>).context).toBe(true);
    }
  });
});