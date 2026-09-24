import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import {
  CHAMPION_ROUTING,
  classifyTask,
  evaluateRouting,
  simulateRoutedRun,
} from "./model-routing.js";

function run(caseId: string, status: EvalOutcome["status"] = "passed", tokens = 1000): EvalOutcome {
  return {
    caseId,
    status,
    actualStatus: "completed",
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

      usage_unknown: 0,

      cache_tokens_read: 0,

      cache_tokens_created: 0,

      model_call_count: 0,
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
  };
}

const ROUTED: import("./model-routing.js").RoutingPolicy = { simple: "cheap", complex: "strong" };

describe("P3-14 model routing — classification", () => {
  it("classifies complex by suite / verification / multi-file / tags", () => {
    expect(classifyTask({ suite: "stress" } as never)).toBe("complex");
    expect(classifyTask({ suite: "adversarial" } as never)).toBe("complex");
    expect(classifyTask({ suite: "regression", verification: [{} as never] } as never)).toBe("complex");
    expect(classifyTask({ suite: "regression", tags: ["review"] } as never)).toBe("complex");
    expect(classifyTask({ suite: "regression" } as never)).toBe("simple");
  });
});

describe("P3-14 model routing — effect model", () => {
  it("cheap model routes simple/read-only work and costs a fraction of tokens", () => {
    const routed = simulateRoutedRun(run("a", "passed", 1000), "simple", ROUTED, {
      model: { cheapTokenFactor: 0.35 },
    });
    expect(routed.model).toBe("cheap");
    expect(routed.tokens).toBeLessThanOrEqual(350);
    expect(routed.policy).toBe("routed");
  });

  it("strong model is used on complex tasks in the routed policy", () => {
    const routed = simulateRoutedRun(run("a", "failed", 1000), "complex", ROUTED, { seed: 3 });
    expect(routed.model).toBe("strong");
    expect(routed.tokens).toBe(1000);
  });

  it("champion routes everything to strong", () => {
    const r = simulateRoutedRun(run("a", "passed", 900), "simple", CHAMPION_ROUTING);
    expect(r.policy).toBe("single_strong");
    expect(r.model).toBe("strong");
  });
});

describe("P3-14 model routing — cost/quality gate (no default 'multi is better')", () => {
  it("promotes routing only when it saves tokens without regressing complex", () => {
    const champion = [
      run("s1", "passed", 1000), // simple
      run("s2", "passed", 1000),
      run("c1", "passed", 2000), // complex strong
    ].map((o) => simulateRoutedRun(o, classifyTaskShell(o), CHAMPION_ROUTING));
    const routed = [
      run("s1", "passed", 1000),
      run("s2", "passed", 1000),
      run("c1", "passed", 2000),
    ].map((o) => simulateRoutedRun(o, classifyTaskShell(o), ROUTED, { model: { cheapTokenFactor: 0.2 } }));
    const cmp = evaluateRouting(champion, routed);
    expect(cmp.tokenSavingRatio).toBeGreaterThan(0.2);
    expect(cmp.promoteRouted).toBe(true);
  });

  it("does not promote when routing regresses the complex split", () => {
    const champion = [
      run("c1", "passed", 2000),
      run("c2", "passed", 2000),
    ].map((o) => simulateRoutedRun(o, "complex", CHAMPION_ROUTING));
    // Cheap model used on complex here → heavy penalty → regress.
    const routed = [
      run("c1", "failed", 2000), // failed
      run("c2", "passed", 2000),
    ].map((o) => simulateRoutedRun(o, "complex", { simple: "cheap", complex: "cheap" }, { seed: 5 }));
    const cmp = evaluateRouting(champion, routed);
    expect(cmp.promoteRouted).toBe(false);
    expect(cmp.reasons.join(" ")).toContain("regressed");
  });

  it("does not promote without meaningful token savings", () => {
    const champion = [run("a", "passed", 1000), run("b", "passed", 1000)].map((o) =>
      simulateRoutedRun(o, "simple", CHAMPION_ROUTING),
    );
    const routed = [run("a", "passed", 1000), run("b", "passed", 1000)].map((o) =>
      simulateRoutedRun(o, "simple", ROUTED, { model: { cheapTokenFactor: 1 } }),
    );
    const cmp = evaluateRouting(champion, routed);
    expect(cmp.tokenSavingRatio).toBeLessThan(0.2);
    expect(cmp.promoteRouted).toBe(false);
  });
});

function classifyTaskShell(o: EvalOutcome): import("./model-routing.js").TaskClass {
  return o.caseId.startsWith("s") ? "simple" : "complex";
}