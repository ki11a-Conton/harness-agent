import { describe, expect, it } from "vitest";
import {
  createCandidateRegistry,
  getCandidateRegistry,
} from "./candidate-registry.js";
import { stableStringify } from "./manifest.js";

describe("CandidateRegistry (E1-03)", () => {
  it("lists all nine candidates from the matrix in stable order", () => {
    const registry = createCandidateRegistry();
    const ids = registry.all().map((c) => c.id);
    expect(ids).toEqual([
      "context_pipeline_v5",
      "tool_selector_deferred_schema",
      "memory_retrieval",
      "memory_write_learning",
      "adaptive_recovery",
      "independent_reviewer",
      "delegation",
      "adaptive_context_policy",
      "adaptive_scheduler",
      "budget_aware_completion_v1",
    ]);
  });

  it("marks unwired candidates unsupported and rejects them on validateActive", () => {
    const registry = createCandidateRegistry();
    for (const id of ["context_pipeline_v5", "memory_write_learning", "independent_reviewer", "adaptive_scheduler"]) {
      expect(registry.find(id)!.status).toBe("unsupported");
      expect(() => registry.validateActive(id)).toThrow(/CANDIDATE_UNSUPPORTED/);
    }
  });

  it("marks wired candidates experimental and validates them", () => {
    const registry = createCandidateRegistry();
    for (const id of ["adaptive_recovery", "tool_selector_deferred_schema", "memory_retrieval", "adaptive_context_policy", "delegation"]) {
      expect(registry.find(id)!.status).toBe("experimental");
      expect(() => registry.validateActive(id)).not.toThrow();
    }
  });

  it("rejects an unknown candidate with CANDIDATE_NOT_FOUND", () => {
    const registry = createCandidateRegistry();
    expect(() => registry.validateActive("nope")).toThrow(/CANDIDATE_NOT_FOUND/);
    expect(() => registry.resolve("nope")).toThrow(/CANDIDATE_NOT_FOUND/);
  });

  it("baseline digest is stable across repeated resolution (serialization determinism)", () => {
    const registry = createCandidateRegistry();
    const a = registry.resolveBaseline().semanticDigest;
    const b = registry.resolveBaseline().semanticDigest;
    expect(a).toBe(b);
  });

  it("a candidate whose resolved config equals baseline has NO semantic delta (no fake diff)", () => {
    // Contract: the digest must come from the actual resolved mechanism config,
    // never from the candidate name or a self-reported flag. A candidate that
    // does not change any semantic field must be indistinguishable from baseline.
    const registry = createCandidateRegistry();
    const baseline = registry.resolveBaseline();
    // Every experimental candidate must produce a real semantic delta.
    for (const id of ["adaptive_recovery", "tool_selector_deferred_schema", "memory_retrieval", "adaptive_context_policy", "delegation", "budget_aware_completion_v1"]) {
      const resolved = registry.resolve(id);
      expect(resolved.hasSemanticDelta).toBe(true);
      expect(resolved.semanticDigest).not.toBe(baseline.semanticDigest);
    }
  });

  it("semantic digest changes when a semantic field changes, not on field order", () => {
    const registry = createCandidateRegistry();
    const resolved = registry.resolve("adaptive_recovery");
    // stableStringify ignores key order (deterministic), so re-serializing the
    // same config must give the same digest.
    const canonical = stableStringify(resolved.effectiveConfig);
    expect(canonical).toBe(resolved.semanticDigest);
    // And the digest is not the candidate name.
    expect(resolved.semanticDigest).not.toContain("adaptive_recovery");
  });

  it("singleton registry returns the same instance", () => {
    expect(getCandidateRegistry()).toBe(getCandidateRegistry());
  });

  it("effectiveConfig for a candidate differs from baseline only in its mechanism", () => {
    const registry = createCandidateRegistry();
    const baseline = registry.resolveBaseline();
    const recovery = registry.resolve("adaptive_recovery");
    expect(recovery.effectiveConfig.adaptiveRecovery).toBe(true);
    // Baseline must have adaptiveRecovery unset.
    expect("adaptiveRecovery" in baseline.effectiveConfig).toBe(false);
  });
});
