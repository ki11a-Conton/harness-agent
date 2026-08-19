import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import {
  aggregateToolSelection,
  decideToolSelectionPromotion,
  renderToolComparison,
  runToolSelectionExperiment,
  selectRelevantTools,
  simulateToolSelectionRun,
} from "./tool-selection.js";

const CASE: EvalCase = {
  id: "tool-case",
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
      tool_call_count: 3,
      tokens_input: 4000,
      tokens_output: 400,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 1500,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0.01,
      ...metrics,
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

describe("P3-4 dynamic tool selection — selector", () => {
  it("always includes every safety-critical tool regardless of cues", () => {
    // A pure docs task: non-critical render_docs should be included, and all
    // safety-critical tools stay present.
    const s = selectRelevantTools(
      makeCase("c", "write documentation", { "README.md": "# hi" }),
    );
    const safe = ["read_file", "write_file", "edit_file", "search", "exec", "verification"];
    for (const name of safe) expect(s.selected).toContain(name);
    expect(s.safetyComplete).toBe(true);
    expect(s.selected).toContain("render_docs");
  });

  it("omits irrelevant non-critical tools to save schema tokens", () => {
    const s = selectRelevantTools(makeCase("c", "write documentation"));
    expect(s.omitted).toContain("sql_run");
    expect(s.omitted).toContain("web_fetch");
    expect(s.schemaTokens).toBeLessThan(s.fullSchemaTokens);
  });

  it("keeps a data tool when cues (csv/datasets) match", () => {
    const s = selectRelevantTools(
      makeCase("c", "parse this csv and query the dataset", { "d/c.csv": "a,b" }),
    );
    expect(s.selected).toContain("query_dataset");
    expect(s.selected).toContain("sql_run");
  });

  it("is deterministic for the same input", () => {
    const a = selectRelevantTools(makeCase("c", "debug the crash"));
    const b = selectRelevantTools(makeCase("c", "debug the crash"));
    expect(a.selected).toEqual(b.selected);
  });
});

describe("P3-4 dynamic tool selection — deterministic challenger model", () => {
  it("full_catalog is the identity champion (full schema tokens, no drift)", () => {
    const outcome = makeOutcome("c", "passed");
    const sel = selectRelevantTools(makeCase("c", "write documentation"));
    const run = simulateToolSelectionRun(outcome, sel, "full_catalog");
    expect(run.passed).toBe(true);
    expect(run.schemaTokens).toBe(sel.fullSchemaTokens);
    expect(run.tokens).toBe(4400);
    expect(run.durationMs).toBe(1500);
  });

  it("dynamic_subset realizes schema savings", () => {
    const outcome = makeOutcome("c", "passed");
    const sel = selectRelevantTools(makeCase("c", "write documentation"));
    const run = simulateToolSelectionRun(outcome, sel, "dynamic_subset", { seed: 3 });
    expect(run.schemaTokens).toBe(sel.schemaTokens);
    expect(run.schemaTokens).toBeLessThan(sel.fullSchemaTokens);
  });

  it("a safety-incomplete subset fails closed", () => {
    const outcome = makeOutcome("c", "passed");
    const badSelection: {
      caseId: string;
      selected: string[];
      omitted: string[];
      schemaTokens: number;
      fullSchemaTokens: number;
      safetyComplete: boolean;
      hasFallback: boolean;
    } = {
      caseId: "c",
      selected: ["read_file"],
      omitted: ["exec"],
      schemaTokens: 120,
      fullSchemaTokens: 1300,
      safetyComplete: false,
      hasFallback: false,
    };
    const run = simulateToolSelectionRun(
      outcome,
      badSelection as never,
      "dynamic_subset",
      { seed: 3 },
    );
    expect(run.safetyComplete).toBe(false);
    expect(run.passed).toBe(false);
  });

  it("schema savings relieve context on a long task and lift pass (high reach)", () => {
    const outcome = makeOutcome("c", "failed", { context_tokens: 26_000 });
    const sel = selectRelevantTools(makeCase("c", "write documentation"));
    const run = simulateToolSelectionRun(outcome, sel, "dynamic_subset", {
      model: { schemaSavingsReach: 1, missRate: 0, contextLift: 1 },
      seed: 3,
    });
    expect(run.passed).toBe(true);
  });
});

describe("P3-4 dynamic tool selection — aggregation and promotion gate", () => {
  it("aggregateToolSelection computes pass rate, schema savings and safety", () => {
    const runs = [
      { caseId: "a", policy: "dynamic_subset" as const, schemaTokens: 800, fullSchemaTokens: 1280, tokens: 4400, durationMs: 1500, missed: false, safetyComplete: true, passed: true },
      { caseId: "b", policy: "dynamic_subset" as const, schemaTokens: 800, fullSchemaTokens: 1280, tokens: 4400, durationMs: 1500, missed: true, safetyComplete: true, passed: false },
    ];
    const agg = aggregateToolSelection(runs, "dynamic_subset");
    expect(agg.passRate).toBe(0.5);
    expect(agg.misses).toBe(1);
    expect(agg.safetyCompleteAll).toBe(true);
    expect(agg.schemaSavingsRatio).toBeGreaterThan(0);
  });

  it("promotes a subset that saves tokens, maintains pass, low misses, cost positive", () => {
    const d = decideToolSelectionPromotion({ passDelta: 0, schemaSavingsRatio: 0.4, missRatio: 0.05, safetyComplete: true, costScoreDelta: 5 });
    expect(d.promote).toBe(true);
    expect(d.code).toBe("promote");
  });

  it("rejects a subset that violates the safety subset invariant (absolute)", () => {
    const d = decideToolSelectionPromotion({ passDelta: 0.2, schemaSavingsRatio: 0.4, missRatio: 0, safetyComplete: false, costScoreDelta: 5 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("safety_invariant_failed");
  });

  it("rejects trivial schema savings (not worth the miss risk)", () => {
    const d = decideToolSelectionPromotion({ passDelta: 0, schemaSavingsRatio: 0.01, missRatio: 0.1, safetyComplete: true, costScoreDelta: 2 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("savings_trivial");
  });

  it("rejects a subset whose miss ratio exceeds tolerance (coverage_regression)", () => {
    const d = decideToolSelectionPromotion({ passDelta: 0, schemaSavingsRatio: 0.4, missRatio: 0.6, safetyComplete: true, costScoreDelta: 5 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("coverage_regression");
  });

  it("rejects when cost delta is not positive", () => {
    const d = decideToolSelectionPromotion({ passDelta: 0.1, schemaSavingsRatio: 0.4, missRatio: 0.05, safetyComplete: true, costScoreDelta: -1 });
    expect(d.promote).toBe(false);
    expect(d.code).toBe("cost_negative");
  });
});

describe("P3-4 dynamic tool selection — end-to-end experiment", () => {
  it("promotes when subset relieves context pressure without hurting pass", async () => {
    const cases = Array.from({ length: 4 }, (_, i) =>
      makeCase(`t${i}`, "write documentation for the module and render it as markdown", {
        "README.md": "# x",
      }),
    );
    const result = await runToolSelectionExperiment(
      cases,
      (c) => Promise.resolve(makeOutcome(c.id, "failed", { context_tokens: 26_000 })),
      {
        model: { schemaSavingsReach: 1, missRate: 0, contextLift: 1 },
        gate: { minimumSchemaSavings: 0.1, maxMissRatio: 0.3 },
        seed: 5,
      },
    );
    expect(result.challenger.passRate).toBe(1);
    expect(result.schemaSavingsRatio).toBeGreaterThan(0);
    expect(result.decision.promote).toBe(true);
  });

  it("rejects when the subset saves nothing material and adds overhead", async () => {
    // A task with cues for every non-critical tool → subset ≈ full → trivial savings.
    const task = "write documentation, query the dataset, translate, render, and fetch from url";
    const cases = Array.from({ length: 4 }, (_, i) => makeCase(`k${i}`, task));
    const result = await runToolSelectionExperiment(
      cases,
      (c) => Promise.resolve(makeOutcome(c.id, "passed")),
      {
        model: { schemaSavingsReach: 1 },
        gate: { minimumSchemaSavings: 0.5 },
        seed: 2,
      },
    );
    expect(result.decision.promote).toBe(false);
  });

  it("renderToolComparison includes decision and schema savings", async () => {
    const result = await runToolSelectionExperiment(
      [makeCase("z", "query this dataset and parse the csv", { "d/c.csv": "a" })],
      (c) => Promise.resolve(makeOutcome(c.id, "failed", { context_tokens: 26_000 })),
      {
        model: { schemaSavingsReach: 1, missRate: 0, contextLift: 1 },
        gate: { minimumSchemaSavings: 0.1 },
        seed: 9,
      },
    );
    const text = renderToolComparison(result);
    expect(text).toContain("PROMOTE");
    expect(text).toContain("schema tokens");
    expect(text).toContain("cost score");
  });
});