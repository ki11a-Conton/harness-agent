import { describe, expect, it } from "vitest";
import type { EvalOutcome } from "./runner.js";
import {
  replayAttribution,
  replayEvaluator,
  replayMemoryRanker,
  rankerHitRate,
  testNewJudge,
} from "./offline-replay.js";

function run(caseId: string, passed: boolean, tokens = 1000): { caseId: string; outcome: EvalOutcome } {
  return {
    caseId,
    outcome: {
      caseId,
      status: passed ? "passed" : "failed",
      actualStatus: passed ? "completed" : "failed",
      events: [],
      metrics: {
        turn_count: 1,
        tool_call_count: 0,
        tokens_input: tokens,
        tokens_output: 0,
        context_tokens: 0,
        compaction_count: 0,
        duration_ms: 500,
        retry_count: 0,
        verification_failures: 0,
        human_interventions: 0,
        estimated_cost: 0,
      },
      violations: [],
      suite: "regression",
      judgeVersion: "1.0.0",
    },
  };
}

const currentJudge = (o: EvalOutcome) => o.status === "passed";
const strictLeftGuard = (items: { id: string; score: number }[], k: number) =>
  [...items].sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.id);

describe("P3-15 offline trace replay — evaluator re-run", () => {
  it("re-runs the evaluator over a recorded corpus without a model", () => {
    const records = [run("a", true, 1000), run("b", false, 800), run("c", true, 1200)];
    const s = replayEvaluator(records, currentJudge);
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.passed).toBe(2);
    expect(s.totalTokens).toBe(3000);
  });
});

describe("P3-15 offline trace replay — new judge", () => {
  it("detects which cases flip under a new judge and new failures", () => {
    const records = [run("a", true), run("b", false), run("c", true)];
    const stricter = (o: EvalOutcome): boolean => o.status === "passed" && o.metrics.tokens_input <= 900;
    const diff = testNewJudge(records, currentJudge, stricter);
    expect(diff.currentPassRate).toBeCloseTo(2 / 3);
    expect(diff.newFailures).toContain("c");
    expect(diff.changedCases.length).toBeGreaterThan(0);
  });
});

describe("P3-15 offline trace replay — memory ranker & attribution", () => {
  it("tests a new memory ranker offline by top-k hits", () => {
    const retrievals = [
      { caseId: "m1", candidates: [{ id: "x", score: 0.9 }, { id: "r", score: 0.2 }], relevantId: "r" },
      { caseId: "m2", candidates: [{ id: "r", score: 0.95 }, { id: "x", score: 0.1 }], relevantId: "r" },
    ];
    const results = replayMemoryRanker(retrievals, strictLeftGuard, 2);
    expect(rankerHitRate(results)).toBe(1);
  });

  it("re-runs attribution over recorded event traces", () => {
    const base = [{ caseId: "c", events: [] }, { caseId: "d", events: [] }];
    const chall = [{ caseId: "c", events: [] }, { caseId: "d", events: [] }];
    const at = replayAttribution({ baseline: base, challenger: chall });
    expect(typeof at.likelySource).toBe("string");
    expect(Array.isArray(at.affectedCases)).toBe(true);
  });
});