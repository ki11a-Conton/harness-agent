import { describe, expect, it } from "vitest";
import type { BenchmarkCase } from "./baseline.js";
import type { EvalOutcome } from "./runner.js";
import {
  aggregateArchitecture,
  classifyCaseComplexity,
  complexityCuesOf,
  decidePromotion,
  renderPlannerExecutorComparison,
  runPlannerExecutorExperiment,
  seededRandom,
  simulateArchitectureRun,
} from "./planner-executor.js";

const COMPLEX_CASE: BenchmarkCase = {
  id: "complex",
  task: "Refactor the whole service across multiple files and add tests for each module. This is a long multi-step request that needs planning.",
  requestMd: "Refactor the whole service across multiple files and add tests for each module. This is a long multi-step request that needs planning.",
  expectedMd: "all modules refactored and tests pass",
  expected: { status: "completed" },
  fixture: {
    "src/a.ts": "export const a = 1;",
    "src/b.ts": "export const b = 2;",
    "src/c.ts": "export const c = 3;",
    "test/a.test.ts": "import { a } from './a';",
    "test/b.test.ts": "import { b } from './b';",
  },
  verification: [
    { kind: "command", command: "node test.js" },
    { kind: "artifact", path: "src/a.ts" },
    { kind: "requirement", statement: "all tests pass" },
  ],
  suite: "regression",
};

const SIMPLE_CASE: BenchmarkCase = {
  id: "simple",
  task: "rename a variable",
  requestMd: "rename a variable",
  expectedMd: "variable renamed",
  expected: { status: "completed" },
  fixture: {},
  suite: "regression",
};

function outcome(
  caseId: string,
  status: EvalOutcome["status"],
  metrics?: Partial<EvalOutcome["metrics"]>,
): EvalOutcome {
  return {
    caseId,
    status,
    actualStatus: status === "error" ? "error" : "completed",
    events: [],
    metrics: {
      turn_count: 1,
      tool_call_count: 4,
      tokens_input: 800,
      tokens_output: 200,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 1000,
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

describe("P3-1 planner/executor — complexity classification", () => {
  it("classifies a multi-file, verification-gated task as complex", () => {
    const c = classifyCaseComplexity(COMPLEX_CASE);
    expect(c.complex).toBe(true);
    expect(c.score).toBeGreaterThanOrEqual(0.5);
  });

  it("classifies a trivial task as simple", () => {
    const c = classifyCaseComplexity(SIMPLE_CASE);
    expect(c.complex).toBe(false);
    expect(c.score).toBeLessThan(0.5);
  });

  it("derives complexity cues from real case fields, not model wording", () => {
    const cues = complexityCuesOf(COMPLEX_CASE);
    expect(cues.verificationSpecCount).toBe(3);
    expect(cues.hasVerification).toBe(true);
    expect(cues.suite).toBe("regression");
  });

  it("treats adversarial/stress suites as complex-cued", () => {
    const adv = classifyCaseComplexity({ ...COMPLEX_CASE, suite: "adversarial" as const });
    expect(adv.complex).toBe(true);
  });
});

describe("P3-1 planner/executor — deterministic challenger model", () => {
  it("single_loop is the identity (champion): no token/latency/tool drift", () => {
    const c = classifyCaseComplexity(COMPLEX_CASE);
    const base = outcome("complex", "passed");
    const run = simulateArchitectureRun(base, "single_loop", c);
    expect(run.passed).toBe(true);
    expect(run.tokens).toBe(1000);
    expect(run.durationMs).toBe(1000);
    expect(run.toolCalls).toBe(4);
    expect(run.architecture).toBe("single_loop");
  });

  it("planner_executor adds fixed planning tokens/latency on every case", () => {
    const c = classifyCaseComplexity(COMPLEX_CASE);
    const base = outcome("complex", "passed");
    const run = simulateArchitectureRun(base, "planner_executor", c, { seed: 1 });
    expect(run.tokens).toBe(1000 + 600);
    expect(run.durationMs).toBe(1000 + 800);
  });

  it("can flip a failed complex baseline to passed with bounded probability", () => {
    const c = classifyCaseComplexity(COMPLEX_CASE);
    const base = outcome("complex", "failed");
    const model = { complexPassGain: 1 };
    const run = simulateArchitectureRun(base, "planner_executor", c, {
      model,
      seed: 7,
    });
    expect(run.passed).toBe(true);
  });

  it("can regress a simple passing baseline only up to simplePassPenalty", () => {
    const c = classifyCaseComplexity(SIMPLE_CASE);
    const base = outcome("simple", "passed");
    const model = { simplePassPenalty: 1 }; // guaranteed flip when drawn < 1
    const run = simulateArchitectureRun(base, "planner_executor", c, {
      model,
      seed: 3,
    });
    expect(run.passed).toBe(false);
  });

  it("seededRandom is deterministic for a fixed seed", () => {
    expect(seededRandom(42)()).toBe(seededRandom(42)());
  });
});

describe("P3-1 planner/executor — aggregation and cost", () => {
  it("aggregateArchitecture computes pass rates per complexity bucket", () => {
    const c = classifyCaseComplexity(COMPLEX_CASE);
    const s = classifyCaseComplexity(SIMPLE_CASE);
    const runs = [
      simulateArchitectureRun(outcome("complex", "passed"), "single_loop", c),
      simulateArchitectureRun(outcome("complex", "passed"), "single_loop", c),
      simulateArchitectureRun(outcome("simple", "passed"), "single_loop", s),
      simulateArchitectureRun(outcome("simple", "failed"), "single_loop", s),
    ];
    const agg = aggregateArchitecture(runs, "single_loop");
    expect(agg.passRateComplex).toBe(1);
    expect(agg.passRateSimple).toBe(0.5);
    expect(agg.passRateOverall).toBe(0.75);
    expect(agg.totalTokens).toBe(4000);
  });
});

describe("P3-1 planner/executor — promotion gate", () => {
  it("promotes a real complex gain with positive cost delta", () => {
    const d = decidePromotion({ complexPassDelta: 0.2, simplePassDelta: 0, costScoreDelta: 5 });
    expect(d.promote).toBe(true);
    expect(d.code).toBe("promote");
  });

  it("rejects a token/latency-only change (no complex gain)", () => {
    const d = decidePromotion({ complexPassDelta: 0, simplePassDelta: 0, costScoreDelta: -2 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("no_complex_gain");
  });

  it("rejects when simple tasks regress beyond tolerance", () => {
    const d = decidePromotion({ complexPassDelta: 0.2, simplePassDelta: -0.1, costScoreDelta: 5 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("simple_regression");
  });

  it("rejects when the cost score is net-negative despite quality gain", () => {
    const d = decidePromotion({ complexPassDelta: 0.2, simplePassDelta: 0, costScoreDelta: -0.5 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("cost_negative");
  });

  it("honors a raised minimumComplexGain", () => {
    const d = decidePromotion({
      complexPassDelta: 0.02,
      simplePassDelta: 0,
      costScoreDelta: 5,
      gate: { minimumComplexGain: 0.05 },
    });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("no_complex_gain");
  });
});

describe("P3-1 planner/executor — end-to-end experiment", () => {
  it("promotes when planner/executor lifts complex tasks net-positive", async () => {
    const caso = await runPlannerExecutorExperiment(
      [COMPLEX_CASE, COMPLEX_CASE, COMPLEX_CASE, COMPLEX_CASE],
      () => Promise.resolve(outcome("complex", "failed")),
      { model: { complexPassGain: 1, simplePassPenalty: 0 } },
    );
    expect(caso.decision.promote).toBe(true);
    expect(caso.complexCount).toBe(4);
    expect(caso.challenger.passRateComplex).toBeGreaterThan(caso.baseline.passRateComplex);
  });

  it("rejects when the effect is only token/latency inflation", async () => {
    const result = await runPlannerExecutorExperiment(
      [COMPLEX_CASE],
      () => Promise.resolve(outcome("complex", "failed")),
      { model: { complexPassGain: 0, planningTokensPerCase: 5_000_000, planningLatencyMsPerCase: 5_000_000 } },
    );
    expect(result.decision.promote).toBe(false);
    expect(result.tokenDeltaRatio).toBeGreaterThan(0);
    expect(result.latencyDeltaRatio).toBeGreaterThan(0);
  });

  it("renderPlannerExecutorComparison includes the decision and deltas", async () => {
    const result = await runPlannerExecutorExperiment(
      [COMPLEX_CASE],
      () => Promise.resolve(outcome("complex", "failed")),
      { model: { complexPassGain: 1, simplePassPenalty: 0 } },
    );
    const text = renderPlannerExecutorComparison(result);
    expect(text).toContain("PROMOTE");
    expect(text).toContain("complex");
    expect(text).toContain("cost score");
  });
});