import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { judgePairComparability, aggregateActivationOf } from "./provenance-v2.js";
import { loadRunsFromArtifact } from "./load-runs.js";
import type { EvalOutcome } from "./runner.js";

function make(id: string, overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    caseId: id,
    status: "failed",
    actualStatus: "failed",
    events: [],
    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 1, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },
    violations: [],
    suite: "holdout",
    judgeVersion: "1.0.0",
    ...overrides,
  };
}

describe("judgePairComparability (E1-07)", () => {
  it("identical context hash + different config hash + activation = comparable", () => {
    const b = [
      make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-b", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c1", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
      make("c2", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-b", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c2", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
      make("c3", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-b", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c3", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
    ];
    const c = [
      make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-c", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c1", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
      make("c2", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-c", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c2", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
      make("c3", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-c", activationEvidence: { schemaVersion: "1.0.0", candidateId: "memory_retrieval", caseId: "c3", eligible: true, activated: true, activationCount: 1, reasonCodes: ["memory_retrieved"], baselineMechanismDigest: "b", candidateMechanismDigest: "c" } }),
    ];
    const v = judgePairComparability(b, c, { candidateId: "memory_retrieval" });
    expect(v.comparable).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.contextHashStatus).toBe("matched");
    expect(v.activation).not.toBeNull();
  });

  it("mismatched context hash → incomparable", () => {
    const b = [make("c1", { evaluationContextHash: "ctx-a", candidateConfigHash: "cfg-b" })];
    const c = [make("c1", { evaluationContextHash: "ctx-b", candidateConfigHash: "cfg-c" })];
    const v = judgePairComparability(b, c, { strict: false });
    expect(v.comparable).toBe(false);
    expect(v.reasons).toContain("context_hash_mismatch");
  });

  it("same config hash → incomparable (candidate made no difference)", () => {
    const b = [make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg" })];
    const c = [make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg" })];
    const v = judgePairComparability(b, c, { strict: false });
    expect(v.comparable).toBe(false);
    expect(v.reasons).toContain("candidate_config_hash_same");
  });

  it("missing context hash → absent but still comparable when strict=false", () => {
    const b = [make("c1", {})];
    const c = [make("c1", {})];
    const v = judgePairComparability(b, c, { strict: false });
    // Without strict, absent context hash is still a reason.
    expect(v.reasons).toContain("missing_context_hash");
    expect(v.comparable).toBe(false);
  });

  it("case mismatch → incomparable", () => {
    const b = [make("c1")];
    const c = [make("c2")];
    const v = judgePairComparability(b, c, { strict: false });
    expect(v.reasons).toContain("case_mismatch");
    expect(v.comparable).toBe(false);
  });

  it("legacy runs without activation evidence fail strict comparability", () => {
    const b = [make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-b" })];
    const c = [make("c1", { evaluationContextHash: "ctx", candidateConfigHash: "cfg-c" })];
    const v = judgePairComparability(b, c, { strict: true, candidateId: "x" });
    expect(v.comparable).toBe(false);
    expect(v.reasons).toContain("legacy_no_activation_evidence");
  });

  it("aggregateActivationOf returns null when no evidence present", () => {
    const run = [make("c1")];
    expect(aggregateActivationOf(run)).toBeNull();
  });

  it("historical 2026-08-27 deferred-schema pair is NOT strictly comparable", async () => {
    // Repro: legacy runs predate activation evidence and carry self-reported
    // hash fields. Under strict E1-07 rules they must fail closed.
    const base = join(process.cwd(), "benchmarks", "results");
    const b = await loadRunsFromArtifact(join(base, "2026-08-27-deepseek-v4-flash", "holdout.json"));
    const c = await loadRunsFromArtifact(join(base, "2026-08-27-deepseek-v4-flash-deferred-schema", "holdout.json"));
    expect(b.runs.length).toBeGreaterThan(0);
    expect(c.runs.length).toBe(b.runs.length);
    const v = judgePairComparability(b.runs, c.runs, { strict: true, candidateId: "tool_selector_deferred_schema" });
    expect(v.comparable).toBe(false);
    // The definitive reason: no activation evidence on the legacy run.
    expect(v.reasons).toContain("legacy_no_activation_evidence");
  });
});