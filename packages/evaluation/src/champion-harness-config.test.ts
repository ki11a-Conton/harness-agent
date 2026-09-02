import { describe, expect, it } from "vitest";
import { resolveChampionProfile, runtimeIdentityOf, proveApplication } from "./champion-profile.js";
import { championHarnessConfigFromProfile, resolveChampionHarness } from "./champion-harness-config.js";

const validC1State = {
  level: "C1",
  candidateId: "adaptive_recovery_v2",
  validity: "PROVEN" as const,
  applied: false,
};

describe("E3-08 champion harness config", () => {
  it("C0 default profile yields baseline harness config (no memory, no recovery)", () => {
    const result = resolveChampionProfile(null, { kind: "default-c0" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.profile) return;
    const config = championHarnessConfigFromProfile(result.profile);
    expect(config.featureFlags.memory).toBe(false);
    expect(config.memory).toBeUndefined();
    expect(config.recovery).toBeUndefined();
    expect(config.runtimeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adaptive_recovery_v2 champion profile yields recovery and no memory", () => {
    const result = resolveChampionProfile(validC1State, {
      kind: "explicit-champion",
      level: "C1",
      candidateId: "adaptive_recovery_v2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.profile) return;
    const config = championHarnessConfigFromProfile(result.profile);
    // adaptive_recovery_v2 sets recoveryPlanner, no memory.
    expect(config.featureFlags.memory).toBe(false);
    expect(config.memory).toBeUndefined();
    // It should set recovery planner.
    expect(config.recovery).toBeDefined();
    // Runtime digest is the arm's canonical digest.
    expect(config.runtimeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("memory_retrieval champion profile yields memory feature flag", () => {
    const memState = { ...validC1State, candidateId: "memory_retrieval" };
    const result = resolveChampionProfile(memState, {
      kind: "explicit-champion",
      level: "C1",
      candidateId: "memory_retrieval",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.profile) return;
    const config = championHarnessConfigFromProfile(result.profile);
    // memory_retrieval sets features.memory=true.
    expect(config.featureFlags.memory).toBe(true);
    expect(config.memory).toBeDefined();
    expect(config.memory!.enabled).toBe(true);
    // No recovery.
    expect(config.recovery).toBeUndefined();
  });

  it("resolveChampionHarness: full production entry computes identity + proof", () => {
    const result = resolveChampionHarness(validC1State, {
      level: "C1",
      candidateId: "adaptive_recovery_v2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harnessConfig).toBeDefined();
    expect(result.identity).toBeDefined();
    expect(result.proof).toBeDefined();
    expect(result.proof!.proven).toBe(true);
    expect(result.proof!.status).toBe("applied");
  });

  it("resolveChampionHarness: quarantined state is rejected", () => {
    const quarantined = { ...validC1State, validity: "QUARANTINED_PENDING_REEVALUATION" as const };
    const result = resolveChampionHarness(quarantined, {
      level: "C1",
      candidateId: "adaptive_recovery_v2",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("quarantined");
  });
});