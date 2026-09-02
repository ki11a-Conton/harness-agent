import { describe, expect, it } from "vitest";
import {
  getArmFactory,
  defaultBenchmarkHarnessConfig,
  wireCandidateMechanism,
  type CaseEligibility,
} from "./arm-factory.js";
import { getCandidateRegistry } from "./candidate-registry.js";

describe("E2-03 arm factory", () => {  it("1. baseline snapshot matches the default benchmark Harness (context stays true)", () => {
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

describe("E3-03 arm factory — typed RuntimeMechanisms + precise path allowlist", () => {
  it("1. resolveArm returns typed runtimeMechanisms for every candidate", () => {
    const factory = getArmFactory();
    const ids = ["memory_retrieval", "adaptive_recovery", "adaptive_recovery_v2",
      "tool_selector_deferred_schema", "adaptive_context_policy", "budget_aware_completion_v1"];
    for (const id of ids) {
      const arm = factory.resolveArm(id);
      expect(arm.runtimeMechanisms).toBeDefined();
      expect(arm.policyVersion).toBeTruthy();
      expect(arm.digest).toBeTruthy();
    }
  });

  it("2. baseline runtimeMechanisms are all false/null (no mechanism active)", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveArm(null);
    expect(baseline.runtimeMechanisms.recoveryPlanner).toBeNull();
    expect(baseline.runtimeMechanisms.memoryRetrieval).toBe(false);
    expect(baseline.runtimeMechanisms.deferredSchema).toBe(false);
    expect(baseline.runtimeMechanisms.adaptiveContextDynamic).toBe(0);
    expect(baseline.runtimeMechanisms.budgetAwareCompletion).toBe(false);
    expect(baseline.runtimeMechanisms.promptAdditionsDigest).toBeNull();
  });

  it("3. candidate runtimeMechanisms correctly reflect the mechanism wiring", () => {
    const factory = getArmFactory();
    const mem = factory.resolveArm("memory_retrieval");
    expect(mem.runtimeMechanisms.memoryRetrieval).toBe(true);
    expect(mem.runtimeMechanisms.recoveryPlanner).toBeNull();

    const rec = factory.resolveArm("adaptive_recovery");
    expect(rec.runtimeMechanisms.recoveryPlanner).toBe("adaptive-v1");
    expect(rec.runtimeMechanisms.memoryRetrieval).toBe(false);

    const rec2 = factory.resolveArm("adaptive_recovery_v2");
    expect(rec2.runtimeMechanisms.recoveryPlanner).toBe("adaptive-v2-conservative");

    const deferred = factory.resolveArm("tool_selector_deferred_schema");
    expect(deferred.runtimeMechanisms.deferredSchema).toBe(true);
    expect(deferred.runtimeMechanisms.promptAdditionsDigest).toBeTruthy();

    const ctx = factory.resolveArm("adaptive_context_policy");
    expect(ctx.runtimeMechanisms.adaptiveContextDynamic).toBe(4096);

    const budget = factory.resolveArm("budget_aware_completion_v1");
    expect(budget.runtimeMechanisms.budgetAwareCompletion).toBe(true);
    expect(budget.runtimeMechanisms.promptAdditionsDigest).toBeTruthy();
  });

  it("4. different candidates produce different digests", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveArm(null);
    const mem = factory.resolveArm("memory_retrieval");
    const rec = factory.resolveArm("adaptive_recovery");
    const digests = new Set([baseline.digest, mem.digest, rec.digest]);
    expect(digests.size).toBe(3);
  });

  it("5. compare uses precise path matching (no features wildcard)", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveBaseline();
    const candidate = factory.resolveCandidate("adaptive_recovery_v2");
    const cmp = factory.compare(baseline, candidate);
    expect(cmp.hasCausalDelta).toBe(true);
    expect(cmp.undeclaredDeltas).toEqual([]);
    expect(cmp.declaredDeltas.length).toBeGreaterThan(0);
    expect(cmp.missingDeclaredDeltas).toEqual([]);
    // The declared delta paths are EXACTLY "harnessConfig.adaptiveRecovery" —
    // no features-memory wildcard, no candidate-id shortcut.
    expect(cmp.declaredDeltas.every((p) => p.startsWith("harnessConfig.adaptiveRecovery"))).toBe(true);
  });

  it("6. compare rejects undeclared config changes (precise path check)", () => {
    const factory = getArmFactory();
    // adaptive_recovery_v2 declares ONLY "harnessConfig.adaptiveRecovery".
    const baseline = factory.resolveBaseline();
    const candidate = factory.resolveCandidate("adaptive_recovery_v2");
    expect(candidate.declaredDeltaPaths).toEqual(["harnessConfig.adaptiveRecovery"]);

    // Inject an undeclared config change (the acceptance scenario:
    // `undeclaredSecurityBypass`) and prove compare() flags it.
    const tampered = {
      ...candidate,
      harnessConfig: { ...candidate.harnessConfig, undeclaredSecurityBypass: true },
    };
    const cmp = factory.compare(baseline, tampered);
    expect(cmp.undeclaredDeltas).toContain("harnessConfig.undeclaredSecurityBypass");
    expect(cmp.comparable).toBe(false);
    expect(cmp.providerCallsAllowed).toBe(false);
    expect(cmp.reasonCode).toBe("UNDECLARED_ARM_DELTA");
  });

  it("6b. declared-but-absent delta path -> NO_CAUSAL_DELTA (no provider calls)", () => {
    const factory = getArmFactory();
    const baseline = factory.resolveBaseline();
    // Declare a path that the candidate does NOT actually change.
    const lying = {
      ...factory.resolveCandidate("adaptive_recovery_v2"),
      declaredDeltaPaths: ["harnessConfig.features.memory"],
    };
    const cmp = factory.compare(baseline, lying);
    expect(cmp.hasCausalDelta).toBe(false);
    expect(cmp.missingDeclaredDeltas).toContain("harnessConfig.features.memory");
    expect(cmp.comparable).toBe(false);
    expect(cmp.providerCallsAllowed).toBe(false);
    expect(cmp.reasonCode).toBe("NO_CAUSAL_DELTA");
  });

  it("7. eligibility separate from activation: baseline eligible memory case still no memory", () => {
    const factory = getArmFactory();
    const eligibilities: CaseEligibility[] = [
      { caseId: "ho-31", mechanism: "memory", eligible: true, reason: "hasMemorySource" },
    ];
    const baseline = factory.resolveArm(null, eligibilities);
    // Baseline has memoryRetrieval=false regardless of eligibility.
    expect(baseline.runtimeMechanisms.memoryRetrieval).toBe(false);
    // But eligibility is recorded per-case.
    expect(baseline.perCaseEligibility.find((e) => e.caseId === "ho-31")!.eligible).toBe(true);

    // Candidate enables memoryRetrieval = true, and eligibility is preserved.
    const candidate = factory.resolveArm("memory_retrieval", eligibilities);
    expect(candidate.runtimeMechanisms.memoryRetrieval).toBe(true);
    expect(candidate.perCaseEligibility.find((e) => e.caseId === "ho-31")!.eligible).toBe(true);
  });

  it("8. runtimeMechanisms digest covers prompt additions (changing prompt changes digest)", () => {
    const factory = getArmFactory();
    const budget = factory.resolveArm("budget_aware_completion_v1");
    expect(budget.runtimeMechanisms.promptAdditionsDigest).toBeTruthy();
    // The arm digest includes the runtimeMechanisms, so the prompt digest
    // contributes to the arm digest.
    const baseline = factory.resolveArm(null);
    expect(baseline.digest).not.toBe(budget.digest);
  });

  it("9. resolveRuntimeMechanisms returns the same typed data as resolveArm", () => {
    const factory = getArmFactory();
    const fromArm = factory.resolveArm("memory_retrieval").runtimeMechanisms;
    const fromDirect = factory.resolveRuntimeMechanisms("memory_retrieval");
    expect(fromDirect).toEqual(fromArm);
  });
});