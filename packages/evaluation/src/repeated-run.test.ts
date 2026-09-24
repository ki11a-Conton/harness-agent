import { describe, expect, it } from "vitest";
import { runRepeatedBaseline, judgeRepeatedPair } from "./repeated-run.js";
import type { BenchmarkCase, BaselineMeta } from "./baseline.js";
import type { EvalOutcome } from "./runner.js";

const META: BaselineMeta = {
  generatedAt: "2026-08-28T00:00:00.000Z",
  benchmarkVersion: "2.0.0",
  model: { providerId: "scripted", modelId: "test" },
  casesTotal: 3,
  suite: "holdout",
};

function makeCase(id: string): BenchmarkCase {
  return {
    id,
    task: `task-${id}`,
    expected: { status: "completed" },
    suite: "holdout",
    fixture: { "request.md": `request-${id}` },
  } as unknown as BenchmarkCase;
}

function outcome(id: string, pass: boolean): EvalOutcome {
  return {
    caseId: id,
    status: pass ? "passed" : "failed",
    actualStatus: pass ? "completed" : "failed",
    events: [],
    metrics: { turn_count: 1, tool_call_count: 1, tokens_input: 10, tokens_output: 10, context_tokens: 0, compaction_count: 0, duration_ms: 50, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0.001, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 },
    violations: [],
    suite: "holdout",
    judgeVersion: "1.0.0",
  };
}

describe("runRepeatedBaseline (E1-11)", () => {
  it("runs a suite N times and reports aggregate stats", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    const res = await runRepeatedBaseline(cases, (c) => Promise.resolve(outcome(c.id, true)), META, { repeat: 3 });
    expect(res.aggregate.repeats).toBe(3);
    expect(res.repeats).toHaveLength(3);
    expect(res.aggregate.perRepeatPassRates).toEqual([1, 1, 1]);
    expect(res.aggregate.passRateMean).toBe(1);
    expect(res.aggregate.passRateStd).toBe(0);
  });

  it("reports spread when outcomes vary across repeats", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    let call = 0;
    const res = await runRepeatedBaseline(
      cases,
      () => {
        // 9 calls total (3 cases x 3 repeats):
        //   calls 0-2 (repeat 0): all pass → rate 1.0
        //   calls 3-5 (repeat 1): all fail → rate 0.0
        //   calls 6-8 (repeat 2): first passes → rate 1/3
        const pass = call < 3 ? true : call < 6 ? false : call === 6;
        call++;
        return Promise.resolve(outcome("", pass));
      },
      META,
      { repeat: 3 },
    );
    expect(res.aggregate.perRepeatPassRates).toEqual([1, 0, 1 / 3]);
    expect(res.aggregate.passRateMean).toBeCloseTo((1 + 0 + 1 / 3) / 3, 5);
    expect(res.aggregate.passRateStd).toBeGreaterThan(0);
    expect(res.aggregate.passRateMin).toBe(0);
    expect(res.aggregate.passRateMax).toBe(1);
  });

  it("single repeat (default) has std 0 and is a single measurement", async () => {
    const res = await runRepeatedBaseline([makeCase("a")], (c) => Promise.resolve(outcome(c.id, true)), META, {});
    expect(res.aggregate.repeats).toBe(1);
    expect(res.aggregate.passRateStd).toBe(0);
  });

  it("interleave uses distinct seeds per repeat (same case count)", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    const res = await runRepeatedBaseline(cases, (c) => Promise.resolve(outcome(c.id, true)), META, {
      repeat: 4,
      interleave: true,
      seed: 7,
      shuffle: true,
    });
    expect(res.aggregate.repeats).toBe(4);
    expect(res.repeats.every((r) => r.summary.total === 3)).toBe(true);
  });
});

describe("judgeRepeatedPair (E1-11)", () => {
  it("reports repeat-to-repeat net deltas", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    // Baseline: 2/3 pass; candidate: 3/3 pass — net +1 every repeat.
    const base = await runRepeatedBaseline(
      cases,
      (c) => Promise.resolve(outcome(c.id, c.id !== "b")),
      META,
      { repeat: 2 },
    );
    const cand = await runRepeatedBaseline(
      cases,
      (c) => Promise.resolve(outcome(c.id, true)),
      META,
      { repeat: 2 },
    );
    const v = judgeRepeatedPair(base, cand);
    expect(v.repeats).toBe(2);
    expect(v.delta.sign).toBe("positive");
    expect(v.delta.mean).toBe(1);
    expect(v.delta.min).toBe(1);
    expect(v.delta.max).toBe(1);
  });

  it("is incomparable when a repeat lacks activation evidence (strict)", async () => {
    const cases = [makeCase("a")];
    const base = await runRepeatedBaseline(cases, (c) => Promise.resolve(outcome(c.id, true)), META, { repeat: 1 });
    const cand = await runRepeatedBaseline(cases, (c) => Promise.resolve(outcome(c.id, true)), META, { repeat: 1 });
    const v = judgeRepeatedPair(base, cand, { candidateId: "memory_retrieval" });
    // Legacy runs have no activation evidence → strict comparability fails.
    expect(v.comparable).toBe(false);
    expect(v.reasons).toContain("legacy_no_activation_evidence");
  });

  it("mixed signs across repeats are reported as mixed, never a win", async () => {
    const cases = [makeCase("a"), makeCase("b"), makeCase("c")];
    // Baseline: always 2/3; candidate: repeat 0 → 3/3 (+1), repeat 1 → 1/3 (-1).
    let candCalls = 0;
    const base = await runRepeatedBaseline(
      cases,
      (c) => Promise.resolve(outcome(c.id, c.id !== "b")),
      META,
      { repeat: 2 },
    );
    const cand = await runRepeatedBaseline(
      cases,
      (c) => {
        const pass = candCalls++ < 3 ? true : c.id === "a";
        return Promise.resolve(outcome(c.id, pass));
      },
      META,
      { repeat: 2 },
    );
    const v = judgeRepeatedPair(base, cand);
    expect(v.delta.sign).toBe("mixed");
    expect(v.delta.mean).toBe(0);
  });
});