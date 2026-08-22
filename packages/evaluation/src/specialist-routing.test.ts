import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import {
  aggregateSpecialist,
  classifyTaskType,
  decideRoutingPromotion,
  renderSpecialistComparison,
  runRoutingExperiment,
  simulateSpecialistRun,
} from "./specialist-routing.js";

const CASE: EvalCase = {
  id: "routing-case",
  task: "implement the feature",
  expected: { status: "completed" },
  suite: "regression",
};

function makeCase(id: string, task: string, fixture: Record<string, string> = {}): EvalCase {
  return { ...CASE, id, task, ...(Object.keys(fixture).length > 0 ? { fixture } : {}) };
}

function makeOutcome(
  caseId: string,
  status: EvalOutcome["status"] = "passed",
  metrics?: Partial<EvalOutcome["metrics"]>,
): EvalOutcome {
  return {
    caseId,
    status,
    actualStatus: status === "error" ? "error" : "completed",
    events: [],
    metrics: {
      turn_count: 1,
      tool_call_count: 2,
      tokens_input: 600,
      tokens_output: 200,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 900,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0.01,

      usage_unknown: 0,

      cache_tokens_read: 0,

      cache_tokens_created: 0,

      model_call_count: 0,
      ...metrics,
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

describe("P3-3 specialist routing — task-type classifier", () => {
  it("classifies a clearly-debuggable task as the debugging specialist", () => {
    const d = classifyTaskType(
      makeCase("c", "debug the crash: fix the stack error and trace the exception"),
    );
    expect(d.type).toBe("debugging");
    expect(d.usesSpecialist).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("classifies a docs task with .md fixture as docs", () => {
    const d = classifyTaskType(makeCase("c", "write documentation", { "README.md": "# hi" }));
    expect(d.type).toBe("docs");
    expect(d.usesSpecialist).toBe(true);
  });

  it("classifies a data task with .csv fixture as data", () => {
    const d = classifyTaskType(makeCase("c", "parse this csv and clean the data", { "d/c.csv": "a,b" }));
    expect(d.type).toBe("data");
    expect(d.usesSpecialist).toBe(true);
  });

  it("keeps a generalist task with no strong cues on the generalist", () => {
    const d = classifyTaskType(makeCase("c", "polish the button"));
    expect(d.type).toBe("generalist");
    expect(d.usesSpecialist).toBe(false);
  });

  it("falls back to the generalist for a fuzzy low-confidence task", () => {
    const d = classifyTaskType(makeCase("c", "look at the machine"));
    expect(d.usesSpecialist).toBe(false);
  });
});

describe("P3-3 specialist routing — deterministic challenger model", () => {
  it("generalist is the identity champion (no token/latency drift)", () => {
    const outcome = makeOutcome("c", "passed");
    const decision = classifyTaskType(makeCase("c", "implement the feature"));
    const run = simulateSpecialistRun(outcome, decision, "generalist");
    expect(run.passed).toBe(true);
    expect(run.routed).toBe(false);
    expect(run.tokens).toBe(800);
    expect(run.durationMs).toBe(900);
  });

  it("low-confidence tasks fall back to generalist behavior but pay routing cost", () => {
    const outcome = makeOutcome("c", "passed");
    // "polish the button" → no cues → not routed
    const decision = classifyTaskType(makeCase("c", "polish the button"));
    const run = simulateSpecialistRun(outcome, decision, "specialist_router");
    expect(run.routed).toBe(false);
    expect(run.tokens).toBe(800 + 400);
    expect(run.durationMs).toBe(900 + 600);
  });

  it("a correct-routed failing task can be recovered by the specialist (truth-driven)", () => {
    const outcome = makeOutcome("c", "failed");
    const decision = classifyTaskType(
      makeCase("c", "debug the crash: fix the stack error and trace the exception"),
    );
    expect(decision.type).toBe("debugging");
    const run = simulateSpecialistRun(outcome, decision, "specialist_router", {
      model: { specialistPassGain: 1, mismatchPassPenalty: 0 },
      truthLane: "debugging",
      seed: 3,
    });
    expect(run.routed).toBe(true);
    expect(run.routedCorrect).toBe(true);
    expect(run.passed).toBe(true);
  });

  it("a mis-routed task regresses a passing result (truth-driven mismatch)", () => {
    const outcome = makeOutcome("c", "passed");
    const decision = classifyTaskType(makeCase("c", "implement the feature"));
    expect(decision.type).toBe("coding");
    const run = simulateSpecialistRun(outcome, decision, "specialist_router", {
      model: { mismatchPassPenalty: 1, specialistPassGain: 0 },
      truthLane: "docs", // routing to coding is a mismatch vs true lane
      seed: 3,
    });
    expect(run.routedWrong).toBe(true);
    expect(run.passed).toBe(false);
  });
});

describe("P3-3 specialist routing — aggregation", () => {
  it("aggregateSpecialist computes pass rate, routed counts and cost score", () => {
    const runs = [
      { caseId: "a", policy: "specialist_router" as const, routed: true, routedCorrect: true, routedWrong: false, passed: true, tokens: 1200, durationMs: 1500 },
      { caseId: "b", policy: "specialist_router" as const, routed: false, routedCorrect: false, routedWrong: false, passed: true, tokens: 1200, durationMs: 1500 },
      { caseId: "c", policy: "specialist_router" as const, routed: true, routedCorrect: false, routedWrong: true, passed: false, tokens: 1200, durationMs: 1500 },
    ];
    const agg = aggregateSpecialist(runs, "specialist_router");
    expect(agg.passRate).toBe(2 / 3);
    expect(agg.routedCount).toBe(2);
    expect(agg.correctlyRouted).toBe(1);
    expect(agg.misRouted).toBe(1);
    expect(agg.costScore).toBeGreaterThan(0);
  });
});

describe("P3-3 specialist routing — promotion gate", () => {
  it("promotes a real pass lift with low mismatch and positive cost delta", () => {
    const d = decideRoutingPromotion({ passDelta: 0.2, mismatchRatio: 0.05, costScoreDelta: 5, asked: true });
    expect(d.promote).toBe(true);
    expect(d.code).toBe("promote");
  });

  it("rejects when nothing was ever routed (pure overhead)", () => {
    const d = decideRoutingPromotion({ passDelta: 0, mismatchRatio: 0, costScoreDelta: 0, asked: false });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("no_gain");
  });

  it("rejects a token/latency-only router with no pass lift (no_gain)", () => {
    const d = decideRoutingPromotion({ passDelta: 0, mismatchRatio: 0, costScoreDelta: -2, asked: true });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("no_gain");
  });

  it("rejects when mis-routing ratio exceeds tolerance", () => {
    const d = decideRoutingPromotion({ passDelta: 0.2, mismatchRatio: 0.6, costScoreDelta: 5, asked: true });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("mismatch_regression");
  });

  it("rejects when routing cost erases the pass lift (cost_negative)", () => {
    const d = decideRoutingPromotion({ passDelta: 0.2, mismatchRatio: 0.05, costScoreDelta: -1, asked: true });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("cost_negative");
  });
});

describe("P3-3 specialist routing — end-to-end experiment", () => {
  it("promotes when routing recovers failing well-matched tasks", async () => {
    const task = "debug the crash: fix the stack error and trace the exception";
    const cases = Array.from({ length: 4 }, (_, i) => makeCase(`h${i}`, task));
    const result = await runRoutingExperiment(
      cases,
      (c) => Promise.resolve(makeOutcome(c.id, "failed")),
      {
        model: { specialistPassGain: 1, mismatchPassPenalty: 0, routingTokensPerCase: 400, routingLatencyMsPerCase: 600 },
        truth: () => "debugging",
        gate: { minimumPassGain: 0.05, maxMismatchRatio: 0.3 },
        seed: 5,
      },
    );
    expect(result.challenger.passRate).toBe(1);
    expect(result.decision.promote).toBe(true);
  });

  it("rejects when routing adds only cost to already-clean outputs", async () => {
    const task = "implement the feature and return";
    const cases = Array.from({ length: 4 }, (_, i) => makeCase(`k${i}`, task));
    const result = await runRoutingExperiment(
      cases,
      (c) => Promise.resolve(makeOutcome(c.id, "passed")),
      {
        model: { specialistPassGain: 1, mismatchPassPenalty: 0, routingTokensPerCase: 1_000_000, routingLatencyMsPerCase: 1_000_000 },
        truth: () => "coding",
        gate: { minimumPassGain: 0.05 },
        seed: 2,
      },
    );
    expect(result.decision.promote).toBe(false);
    expect(result.tokenDeltaRatio).toBeGreaterThan(0);
  });

  it("renderRoutingComparison includes decision and pass delta", async () => {
    const task = "debug the crash: fix the stack error and trace the exception";
    const result = await runRoutingExperiment(
      [makeCase("z", task)],
      (c) => Promise.resolve(makeOutcome(c.id, "failed")),
      {
        model: { specialistPassGain: 1, mismatchPassPenalty: 0 },
        truth: () => "debugging",
        gate: { minimumPassGain: 0.05 },
        seed: 9,
      },
    );
    const text = renderSpecialistComparison(result);
    expect(text).toContain("PROMOTE");
    expect(text).toContain("pass rate");
    expect(text).toContain("cost score");
  });
});