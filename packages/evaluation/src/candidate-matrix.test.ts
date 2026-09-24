import { describe, expect, it } from "vitest";
import {
  applyCandidateConfig,
  buildCandidateMatrixPlan,
  CANDIDATE_COMBINATIONS,
  CANDIDATE_FEATURES,
  candidateIds,
  candidateOf,
} from "./candidate-matrix.js";

describe("P21-2 candidate feature matrix", () => {
  it("has all nine plan-required candidates", () => {
    const ids = candidateIds();
    for (const required of [
      "context_pipeline_v5",
      "tool_selector_deferred_schema",
      "memory_retrieval",
      "memory_write_learning",
      "adaptive_recovery",
      "independent_reviewer",
      "delegation",
      "adaptive_context_policy",
      "adaptive_scheduler",
    ]) {
      expect(ids, required).toContain(required);
    }
    expect(ids).toHaveLength(9);
  });

  it("champion default policy is declared per candidate", () => {
    for (const candidate of CANDIDATE_FEATURES) {
      expect(["yes", "no", "evidence"]).toContain(candidate.defaultOn);
    }
    // P21-5 expectations: trusted surface ON, evidence-gated in the middle,
    // trust-surface OFF.
    const byId = Object.fromEntries(CANDIDATE_FEATURES.map((c) => [c.id, c.defaultOn]));
    expect(byId["context_pipeline_v5"]).toBe("yes");
    expect(byId["independent_reviewer"]).toBe("no");
    expect(byId["memory_retrieval"]).toBe("evidence");
    expect(byId["delegation"]).toBe("evidence");
  });

  it("evaluation plan: baseline → single variables → reviewed combinations", () => {
    const plan = buildCandidateMatrixPlan();
    expect(plan.baseline).toBe("baseline");
    expect(plan.singleVariable).toEqual(candidateIds());
    expect(plan.combinations).toEqual([
      ["independent_reviewer", "delegation"],
      ["memory_retrieval", "memory_write_learning"],
      ["adaptive_context_policy", "adaptive_scheduler"],
    ]);
  });

  it("single-variable config differs from baseline by EXACTLY one mechanism", () => {
    const base = { features: { context: true, delegation: false } };
    const baseline = applyCandidateConfig(base, "baseline");
    // baseline disables every candidate
    expect(baseline).toMatchObject({ features: { context: false, delegation: false, memory: false, learning: false } });
    const delegation = applyCandidateConfig(base, "delegation");
    expect(delegation).toMatchObject({ features: { delegation: true } });
    // everything else stays at baseline
    expect(delegation).toMatchObject({ features: { context: false, memory: false, learning: false } });
  });

  it("unknown candidate fails closed (no silent no-op)", () => {
    expect(() => applyCandidateConfig({}, "not-a-candidate")).toThrow(/unknown candidate/);
    expect(candidateOf("not-a-candidate")).toBeUndefined();
  });

  it("every combination consists of existing candidate ids", () => {
    for (const [a, b] of CANDIDATE_COMBINATIONS) {
      expect(candidateOf(a), a).toBeDefined();
      expect(candidateOf(b), b).toBeDefined();
    }
  });
});
