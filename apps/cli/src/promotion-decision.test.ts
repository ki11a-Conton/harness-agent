import { describe, expect, it } from "vitest";
import { buildPairedReport } from "@ar/evaluation";
import { evaluateChampionDecision } from "./promotion-decision.js";
import type { EvalOutcome } from "@ar/evaluation";

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

const act = (id: string) => ({
  schemaVersion: "1.0.0",
  candidateId: "memory_retrieval",
  caseId: id,
  eligible: true,
  activated: true,
  activationCount: 1,
  reasonCodes: ["memory_retrieved" as const],
  baselineMechanismDigest: "b",
  candidateMechanismDigest: "c",
});

/** 12 paired cases: candidate wins 3 (ACCEPT-worthy), all provenance present. */
function comparablePair(): { b: EvalOutcome[]; c: EvalOutcome[] } {
  const b: EvalOutcome[] = [];
  const c: EvalOutcome[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `ho-${String(i).padStart(2, "0")}`;
    const base = make(id, {
      evaluationContextHash: "ctx",
      candidateConfigHash: "cfg-b",
      controlledDifference: ["candidate:memory_retrieval"],
      activationEvidence: act(id),
    });
    const cand = make(id, {
      evaluationContextHash: "ctx",
      candidateConfigHash: "cfg-c",
      controlledDifference: ["candidate:memory_retrieval"],
      activationEvidence: act(id),
    });
    // Candidate wins cases 0-2, ties the rest (all fail baseline + candidate
    // in 3-11 would be both-failed — keep it simple: candidate passes 0-2).
    if (i < 3) {
      cand.status = "passed";
      cand.actualStatus = "completed";
    }
    b.push(base);
    c.push(cand);
  }
  return { b, c };
}

describe("evaluateChampionDecision (E1-08)", () => {
  it("ACCEPT when comparable + gates pass + sample + delta", () => {
    const { b, c } = comparablePair();
    const report = buildPairedReport(b, c, "stub");
    const d = evaluateChampionDecision(b, c, report, { strict: true, candidateId: "memory_retrieval" });
    expect(d.decision).toBe("ACCEPT");
    expect(d.reasonCode).toBe("ALL_GATES_PASSED");
  });

  it("INVALID when not comparable (missing activation evidence)", () => {
    const { b, c } = comparablePair();
    // Strip activation evidence from candidate.
    const cNoAct = c.map((r) => {
      const { activationEvidence, ...rest } = r;
      return rest;
    });
    const report = buildPairedReport(b, cNoAct, "stub");
    const d = evaluateChampionDecision(b, cNoAct, report, { strict: true, candidateId: "memory_retrieval" });
    expect(d.decision).toBe("INVALID");
    expect(d.reasonCode).toBe("INCOMPARABLE");
  });

  it("INCONCLUSIVE with small sample", () => {
    const { b, c } = comparablePair();
    const report = buildPairedReport(b.slice(0, 5), c.slice(0, 5), "stub");
    const d = evaluateChampionDecision(b.slice(0, 5), c.slice(0, 5), report, { strict: true, candidateId: "memory_retrieval" });
    expect(d.decision).toBe("INCONCLUSIVE");
    expect(d.reasonCode).toBe("SMALL_SAMPLE");
  });

  it("INCONCLUSIVE when no pass delta", () => {
    const { b, c } = comparablePair();
    // No candidate wins → net delta 0.
    const cNoWin = c.map((r) => ({ ...r, status: "failed" as const, actualStatus: "failed" as const }));
    const report = buildPairedReport(b, cNoWin, "stub");
    const d = evaluateChampionDecision(b, cNoWin, report, { strict: true, candidateId: "memory_retrieval" });
    expect(d.decision).toBe("INCONCLUSIVE");
    expect(d.reasonCode).toBe("NO_PASS_DELTA");
  });

  it("REJECT when candidate gains infra failures", () => {
    const { b, c } = comparablePair();
    const cBad = c.map((r, i) => i === 0 ? { ...r, failureCategory: "infrastructure" as const, status: "error" as const, actualStatus: "error" as const } : r);
    const report = buildPairedReport(b, cBad, "stub");
    const d = evaluateChampionDecision(b, cBad, report, { strict: true, candidateId: "memory_retrieval" });
    // Infra increase fails the noNewInfrastructureFailures gate.
    expect(d.decision).toBe("REJECT");
    expect(d.reasonCode).toBe("QUALITY_GATES_FAILED");
  });
});