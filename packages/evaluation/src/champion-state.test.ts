import { describe, expect, it } from "vitest";
import {
  createInitialChampionState,
  evaluateChampionPromotion,
  applyPromotion,
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

  it("C2 is the max level — no further promotion", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "r1.json");
    const c2 = applyPromotion(c1, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "r2.json");
    const v = evaluateChampionPromotion(c2, "delegation", "ACCEPT", "r3.json");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.decision).toBe("ALREADY_MAX");
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