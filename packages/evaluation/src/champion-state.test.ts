import { describe, expect, it } from "vitest";
import {
  createInitialChampionState,
  evaluateChampionPromotion,
  applyPromotion,
  rollbackChampionState,
  nextChampionLevel,
} from "./champion-state.js";

describe("champion state machine (E1-14)", () => {
  it("initial state is C0 (frozen production baseline)", () => {
    const s = createInitialChampionState();
    expect(s.level).toBe("C0");
    expect(s.candidateId).toBeNull();
    expect(s.configPatch).toEqual({});
    expect(s.evidenceRef).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.applied).toBe(true);
  });

  it("C0 → C1 with a strict ACCEPT decision and evidence", () => {
    const c0 = createInitialChampionState();
    const v = evaluateChampionPromotion(c0, "memory_retrieval", "ACCEPT", "runs/c1/holdout.json");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.next.level).toBe("C1");
      expect(v.next.candidateId).toBe("memory_retrieval");
      expect(v.next.evidenceRef).toBe("runs/c1/holdout.json");
      expect(v.next.history).toHaveLength(1);
      expect(v.next.history[0]!.candidateId).toBe("memory_retrieval");
      // Applying the active profile is a separate step.
      expect(v.next.applied).toBe(false);
    }
  });

  it("REJECT / INCONCLUSIVE / INVALID never promote", () => {
    const c0 = createInitialChampionState();
    for (const decision of ["REJECT", "INCONCLUSIVE", "INVALID"] as const) {
      const v = evaluateChampionPromotion(c0, "memory_retrieval", decision, "runs/x.json");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.decision).toBe(decision);
    }
  });

  it("ACCEPT without an evidence reference does not promote", () => {
    const c0 = createInitialChampionState();
    const v = evaluateChampionPromotion(c0, "memory_retrieval", "ACCEPT", undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.decision).toBe("NO_EVIDENCE_REF");
  });

  it("unknown / no-op candidates never promote (fail-closed)", () => {
    const c0 = createInitialChampionState();
    // An unknown candidate resolves (try/catch catches CANDIDATE_NOT_FOUND).
    const v = evaluateChampionPromotion(c0, "does_not_exist", "ACCEPT", "runs/x.json");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.decision).toBe("REJECT");
  });

  it("C1 → C2 is a chained promotion that retains C1 in history", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "runs/c1/holdout.json");
    const v = evaluateChampionPromotion(c1, "budget_aware_completion_v1", "ACCEPT", "runs/c2/holdout.json");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.next.level).toBe("C2");
      expect(v.next.candidateId).toBe("budget_aware_completion_v1");
      expect(v.next.history).toHaveLength(2);
      expect(v.next.history[0]!.candidateId).toBe("memory_retrieval");
      expect(v.next.history[1]!.candidateId).toBe("budget_aware_completion_v1");
    }
  });

  it("E2-07: the chain is unbounded — C2 can promote to C3 (no max)", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "r1.json");
    const c2 = applyPromotion(c1, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "r2.json");
    expect(c2.level).toBe("C2");
    const v = evaluateChampionPromotion(c2, "adaptive_recovery_v2", "ACCEPT", "r3.json");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.next.level).toBe("C3");
      expect(v.next.history).toHaveLength(3);
    }
    // And further: C3 -> C4.
    if (v.ok) {
      const v4 = evaluateChampionPromotion(v.next, "delegation", "ACCEPT", "r4.json");
      expect(v4.ok).toBe(true);
      if (v4.ok) expect(v4.next.level).toBe("C4");
    }
  });

  it("E2-07: applyPromotion records envelope + decision digests when provided", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "r1.json", {
      envelopeDigest: "env-digest-abc",
      decisionEnvelopeDigest: "dec-digest-xyz",
    });
    expect(c1.level).toBe("C1");
    expect(c1.history[0]!.envelopeDigest).toBe("env-digest-abc");
    expect(c1.history[0]!.decisionEnvelopeDigest).toBe("dec-digest-xyz");
  });

  it("E2-07: rollback is an explicit transition that preserves full history", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "r1.json", {
      envelopeDigest: "env1",
    });
    const c2 = applyPromotion(c1, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "r2.json", {
      envelopeDigest: "env2",
    });
    const rolled = rollbackChampionState(c2, { targetLevel: "C0", reason: "E2-07 test rollback" });
    expect(rolled.level).toBe("C0");
    expect(rolled.candidateId).toBeNull();
    expect(rolled.rollback).toBeDefined();
    expect(rolled.rollback!.fromLevel).toBe("C2");
    expect(rolled.history.length).toBeGreaterThanOrEqual(3); // 2 promotions + rollback record
    // History still contains the C1/C2 promotions.
    expect(rolled.history.some((h) => h.candidateId === "adaptive_recovery_v2")).toBe(true);
    expect(rolled.history.some((h) => h.candidateId === "budget_aware_completion_v1")).toBe(true);
  });

  it("E2-07: rollback to a non-lower target is rejected", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "r1.json");
    expect(() => rollbackChampionState(c1, { targetLevel: "C1", reason: "same level" })).toThrow(/not lower/);
    expect(() => rollbackChampionState(c1, { targetLevel: "C2", reason: "upgrade" })).toThrow(/not lower/);
  });

  it("applyPromotion is pure — does not mutate the input state", () => {
    const c0 = createInitialChampionState();
    const next = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "r.json");
    // Input unchanged.
    expect(c0.level).toBe("C0");
    expect(c0.history).toHaveLength(0);
    expect(next.level).toBe("C1");
  });
});