import { describe, expect, it } from "vitest";
import type { RunMetrics } from "@ar/observability";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import { BenchRunner } from "./bench.js";
import type { BenchCaseResult } from "./bench.js";

// ---- factories: fake EvalOutcome/EvalCase, no runtime needed --------------

function makeCase(id: string): EvalCase {
  return { id, task: `task ${id}`, expected: { status: "completed" } };
}

function makeMetrics(partial: Partial<RunMetrics> = {}): RunMetrics {
  return {
    turn_count: 0,
    tool_call_count: 0,
    tokens_input: 0,
    tokens_output: 0,
    context_tokens: 0,
    compaction_count: 0,
    duration_ms: 0,
    retry_count: 0,
    verification_failures: 0,
    human_interventions: 0,
    estimated_cost: 0,

    usage_unknown: 0,

    cache_tokens_read: 0,

    cache_tokens_created: 0,

    model_call_count: 0,
    ...partial,
  };
}

function makeOutcome(overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    caseId: "case-1",
    status: "passed",
    actualStatus: "completed",
    events: [],
    metrics: makeMetrics(),
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
    ...overrides,
  };
}

/** A harness run that looks outcomes up by case id (missing → default pass). */
function runnerFor(outcomes: EvalOutcome[]): (c: EvalCase) => Promise<EvalOutcome> {
  const byId = new Map(outcomes.map((o) => [o.caseId, o]));
  return async (c) => byId.get(c.id) ?? makeOutcome({ caseId: c.id });
}

const runner = new BenchRunner();

describe("winner determination", () => {
  it("a wins when a passes and b fails on every case", async () => {
    const cases = [makeCase("c1"), makeCase("c2"), makeCase("c3")];
    const runA = runnerFor(
      cases.map((c) => makeOutcome({ caseId: c.id, status: "passed" })),
    );
    const runB = runnerFor(
      cases.map((c) => makeOutcome({ caseId: c.id, status: "failed", violations: ["x"] })),
    );
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.cases.map((e) => e.winner)).toEqual(["A", "A", "A"]);
    expect(report.summary.a.success).toBe(3);
    expect(report.summary.b.success).toBe(0);
  });

  it("b wins when b passes and a fails on every case", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const runA = runnerFor(
      cases.map((c) => makeOutcome({ caseId: c.id, status: "failed", violations: ["x"] })),
    );
    const runB = runnerFor(
      cases.map((c) => makeOutcome({ caseId: c.id, status: "passed" })),
    );
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.cases.map((e) => e.winner)).toEqual(["B", "B"]);
    expect(report.summary.b.success).toBe(2);
    expect(report.summary.a.success).toBe(0);
  });

  it("reports tie when outcomes are identical", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const runA = runnerFor(
      cases.map((c) =>
        makeOutcome({ caseId: c.id, status: "passed", metrics: makeMetrics({ tool_call_count: 2 }) }),
      ),
    );
    const runB = runnerFor(
      cases.map((c) =>
        makeOutcome({ caseId: c.id, status: "passed", metrics: makeMetrics({ tool_call_count: 2 }) }),
      ),
    );
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.cases.map((e) => e.winner)).toEqual(["tie", "tie"]);
    expect(report.summary.a).toEqual(report.summary.b);
  });

  it("reports both_failed when both fail with equal violations", async () => {
    const cases = [makeCase("c1")];
    const runA = runnerFor([
      makeOutcome({ caseId: "c1", status: "failed", violations: ["v1", "v2"] }),
    ]);
    const runB = runnerFor([
      makeOutcome({ caseId: "c1", status: "failed", violations: ["v1", "v2"] }),
    ]);
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.cases[0]!.winner).toBe("both_failed");
  });

  it("fewer violations decides a failed-vs-failed case", async () => {
    const cases = [makeCase("c1")];
    const aWins = await runner.runCompare({
      cases,
      runA: runnerFor([makeOutcome({ caseId: "c1", status: "failed", violations: ["v1"] })]),
      runB: runnerFor([makeOutcome({ caseId: "c1", status: "failed", violations: ["v1", "v2"] })]),
    });
    expect(aWins.cases[0]!.winner).toBe("A");

    const bWins = await runner.runCompare({
      cases,
      runA: runnerFor([makeOutcome({ caseId: "c1", status: "failed", violations: ["v1", "v2"] })]),
      runB: runnerFor([makeOutcome({ caseId: "c1", status: "failed", violations: ["v1"] })]),
    });
    expect(bWins.cases[0]!.winner).toBe("B");
  });

  it("ranks status above violations (passed with more violations beats failed)", async () => {
    const cases = [makeCase("c1")];
    const report = await runner.runCompare({
      cases,
      runA: runnerFor([makeOutcome({ caseId: "c1", status: "failed", violations: [] })]),
      runB: runnerFor([
        makeOutcome({ caseId: "c1", status: "passed", violations: ["v1", "v2", "v3"] }),
      ]),
    });
    expect(report.cases[0]!.winner).toBe("B");
  });

  it("ranks error below failed regardless of violations", async () => {
    const cases = [makeCase("c1")];
    const report = await runner.runCompare({
      cases,
      runA: runnerFor([makeOutcome({ caseId: "c1", status: "error", reason: "boom" })]),
      runB: runnerFor([
        makeOutcome({ caseId: "c1", status: "failed", violations: ["v1", "v2", "v3"] }),
      ]),
    });
    expect(report.cases[0]!.winner).toBe("B");
  });

  it("reports tie when both harnesses error", async () => {
    const cases = [makeCase("c1")];
    const report = await runner.runCompare({
      cases,
      runA: runnerFor([makeOutcome({ caseId: "c1", status: "error", reason: "boom" })]),
      runB: runnerFor([makeOutcome({ caseId: "c1", status: "error", reason: "boom" })]),
    });
    expect(report.cases[0]!.winner).toBe("tie");
  });
});

describe("totals aggregation", () => {
  it("aggregates success, safety, reliability, efficiency, latency and cost", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const runA = runnerFor([
      makeOutcome({
        caseId: "c1",
        status: "passed",
        metrics: makeMetrics({ tool_call_count: 4, duration_ms: 100, estimated_cost: 0.02 }),
      }),
      makeOutcome({
        caseId: "c2",
        status: "passed",
        metrics: makeMetrics({ tool_call_count: 2, duration_ms: 300, estimated_cost: 0.01 }),
      }),
    ]);
    const runB = runnerFor([
      makeOutcome({ caseId: "c1", status: "error", reason: "boom" }),
      makeOutcome({ caseId: "c2", status: "failed", violations: ["v"] }),
    ]);
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.summary.a).toEqual({
      success: 2,
      safety: 2,
      reliability: 2,
      efficiency: 3,
      latency: 200,
      cost: 0.03,
    });
    expect(report.summary.b).toEqual({
      success: 0,
      safety: 1,
      reliability: 1,
      efficiency: 0,
      latency: 0,
      cost: 0,
    });
  });

  it("safety counts failed outcomes that carry no violations", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const runA = runnerFor([
      makeOutcome({ caseId: "c1", status: "failed", violations: [] }),
      makeOutcome({ caseId: "c2", status: "passed" }),
    ]);
    const runB = runnerFor([
      makeOutcome({ caseId: "c1", status: "failed", violations: ["v"] }),
      makeOutcome({ caseId: "c2", status: "passed" }),
    ]);
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.summary.a.safety).toBe(2);
    expect(report.summary.b.safety).toBe(1);
  });

  it("reliability excludes error outcomes", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const runA = runnerFor([
      makeOutcome({ caseId: "c1", status: "passed" }),
      makeOutcome({ caseId: "c2", status: "error", reason: "boom" }),
    ]);
    const runB = runnerFor([
      makeOutcome({ caseId: "c1", status: "failed", violations: ["v"] }),
      makeOutcome({ caseId: "c2", status: "passed" }),
    ]);
    const report = await runner.runCompare({ cases, runA, runB });
    expect(report.summary.a.reliability).toBe(1);
    expect(report.summary.b.reliability).toBe(2);
  });

  it("zeroes totals when metrics are absent (cost falls back to 0)", async () => {
    const cases = [makeCase("c1")];
    const report = await runner.runCompare({
      cases,
      runA: runnerFor([
        { ...makeOutcome({ caseId: "c1" }), metrics: undefined as unknown as RunMetrics },
      ]),
      runB: runnerFor([makeOutcome({ caseId: "c1" })]),
    });
    expect(report.summary.a.cost).toBe(0);
  });
});

describe("report structure and determinism", () => {
  it("produces an empty report for an empty case list (zeroed totals, no NaN)", async () => {
    const report = await runner.runCompare({
      cases: [],
      runA: async () => makeOutcome(),
      runB: async () => makeOutcome(),
    });
    expect(report.cases).toEqual([]);
    expect(report.summary.a).toEqual({
      success: 0,
      safety: 0,
      reliability: 0,
      efficiency: 0,
      latency: 0,
      cost: 0,
    });
    expect(report.summary.b).toEqual(report.summary.a);
  });

  it("preserves input case order in the report regardless of resolution timing", async () => {
    const cases = [makeCase("c1"), makeCase("c2"), makeCase("c3")];
    const outcomes = (status: EvalOutcome["status"]) =>
      new Map(cases.map((c) => [c.id, makeOutcome({ caseId: c.id, status })]));
    const delayed =
      (status: EvalOutcome["status"], delays: Record<string, number>) =>
      async (c: EvalCase) => {
        await new Promise((resolve) => setTimeout(resolve, delays[c.id] ?? 0));
        return outcomes(status).get(c.id)!;
      };
    const report = await runner.runCompare({
      cases,
      runA: delayed("passed", { c1: 10, c2: 0, c3: 5 }),
      runB: delayed("failed", { c1: 0, c2: 10, c3: 0 }),
    });
    expect(report.cases.map((e) => e.caseId)).toEqual(["c1", "c2", "c3"]);
    expect(report.cases.map((e) => e.winner)).toEqual(["A", "A", "A"]);
  });

  it("hands the same case object to both harness runs (§133 same task)", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const seenA: EvalCase[] = [];
    const seenB: EvalCase[] = [];
    const report = await runner.runCompare({
      cases,
      runA: async (c) => {
        seenA.push(c);
        return makeOutcome({ caseId: c.id });
      },
      runB: async (c) => {
        seenB.push(c);
        return makeOutcome({ caseId: c.id, status: "failed", violations: ["v"] });
      },
    });
    expect(seenA).toEqual(cases);
    expect(seenB).toEqual(cases);
    expect(seenA[0]).toBe(cases[0]);
    expect(seenB[0]).toBe(cases[0]);
    expect(report.cases.map((e) => e.winner)).toEqual(["A", "A"]);
  });

  it("is deterministic: identical inputs produce identical reports", async () => {
    const cases = [makeCase("c1"), makeCase("c2")];
    const aOutcomes = new Map([
      ["c1", makeOutcome({ caseId: "c1", status: "passed", metrics: makeMetrics({ tool_call_count: 3 }) })],
      ["c2", makeOutcome({ caseId: "c2", status: "failed", violations: ["v"] })],
    ]);
    const bOutcomes = new Map([
      ["c1", makeOutcome({ caseId: "c1", status: "passed" })],
      ["c2", makeOutcome({ caseId: "c2", status: "passed", metrics: makeMetrics({ tool_call_count: 1 }) })],
    ]);
    const runA = async (c: EvalCase) => aOutcomes.get(c.id)!;
    const runB = async (c: EvalCase) => bOutcomes.get(c.id)!;
    const first = await runner.runCompare({ cases, runA, runB });
    const second = await runner.runCompare({ cases, runA, runB });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.cases.map((e) => e.winner)).toEqual(["tie", "B"]);
  });

  it("rejects when a harness run throws (no fabricated outcome)", async () => {
    const cases = [makeCase("c1")];
    await expect(
      runner.runCompare({
        cases,
        runA: async () => makeOutcome({ caseId: "c1" }),
        runB: async () => {
          throw new Error("harness crash");
        },
      }),
    ).rejects.toThrow("harness crash");
  });

  it("surfaces per-case results with both outcomes and the caseId", async () => {
    const cases = [makeCase("c1")];
    const resultB = makeOutcome({ caseId: "c1", status: "failed", violations: ["v"] });
    const report = await runner.runCompare({
      cases,
      runA: async (c) => makeOutcome({ caseId: c.id, metrics: makeMetrics({ duration_ms: 42 }) }),
      runB: async () => resultB,
    });
    const entry: BenchCaseResult = report.cases[0]!;
    expect(entry.caseId).toBe("c1");
    expect(entry.resultA.metrics.duration_ms).toBe(42);
    expect(entry.resultB).toBe(resultB);
    expect(entry.winner).toBe("A");
  });
});
