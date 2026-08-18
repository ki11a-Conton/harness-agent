import { describe, expect, it } from "vitest";
import type { ContextBlock, ContextBudget } from "@ar/contracts";
import { BudgetPlannerImpl } from "./budget.js";

function makeBlock(overrides: Partial<ContextBlock> & { id: string }): ContextBlock {
  return {
    source: "tool",
    trust: "untrusted",
    priority: 0,
    tokens: 100,
    content: `content-${overrides.id}`,
    compressible: true,
    ephemeral: false,
    ...overrides,
  };
}

function makeBudget(overrides?: Partial<ContextBudget>): ContextBudget {
  return {
    maxTokens: 1000,
    reserved: { system: 0, task: 0, output: 0 },
    dynamic: 0,
    ...overrides,
  };
}

const planner = new BudgetPlannerImpl();

describe("BudgetPlannerImpl (CTX-002)", () => {
  it("enforces the hard token ceiling and reports dropped/available", () => {
    const blocks = Array.from({ length: 20 }, (_, i) =>
      makeBlock({ id: `b${i}`, priority: 100 - i, tokens: 100 }),
    );
    const plan = planner.plan(blocks, makeBudget({ maxTokens: 1000 }));

    expect(plan.selected.reduce((s, b) => s + b.tokens, 0)).toBeLessThanOrEqual(1000);
    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.report.used).toBeLessThanOrEqual(1000);
    expect(plan.report.available).toBe(1000 - plan.report.used);
    expect(plan.report.dropped).toBe(plan.dropped.length);
    expect(plan.selected.length + plan.dropped.length).toBe(20);
  });

  it("evicts lowest priority first (same token size)", () => {
    const blocks = [
      makeBlock({ id: "low", priority: 1 }),
      makeBlock({ id: "high", priority: 100 }),
      makeBlock({ id: "mid", priority: 50 }),
    ];
    const plan = planner.plan(blocks, makeBudget({ maxTokens: 200 }));

    expect(plan.selected.map((b) => b.id)).toEqual(["high", "mid"]);
    expect(plan.dropped.map((b) => b.id)).toEqual(["low"]);
  });

  it("never evicts trusted / system / user blocks", () => {
    const blocks = [
      makeBlock({ id: "trusted", trust: "trusted", priority: 1 }),
      makeBlock({ id: "system", source: "system", priority: 1 }),
      makeBlock({ id: "user", source: "user", priority: 1 }),
      makeBlock({ id: "normal", priority: 999, tokens: 2000 }),
    ];
    const plan = planner.plan(blocks, makeBudget({ maxTokens: 500 }));

    expect(plan.selected.map((b) => b.id)).toEqual(["trusted", "system", "user"]);
    expect(plan.dropped.map((b) => b.id)).toEqual(["normal"]);
  });

  it("reports truthful overflow when never-evict blocks exceed maxTokens", () => {
    const blocks = [
      makeBlock({ id: "trustedA", trust: "trusted", tokens: 700 }),
      makeBlock({ id: "trustedB", trust: "trusted", tokens: 500 }),
      makeBlock({ id: "sys", source: "system", priority: 5, tokens: 10 }),
      makeBlock({ id: "normal", priority: 100, tokens: 100 }),
    ];
    const plan = planner.plan(blocks, makeBudget({ maxTokens: 1000 }));

    expect(plan.report.used).toBe(1210);
    expect(plan.report.available).toBe(-210);
    expect(plan.selected.map((b) => b.id)).toEqual(["trustedA", "trustedB", "sys"]);
    expect(plan.dropped.map((b) => b.id)).toEqual(["normal"]);
  });

  it("keeps report.used consistent with sum of selected tokens", () => {
    const blocks = [
      makeBlock({ id: "a", priority: 3, tokens: 120 }),
      makeBlock({ id: "b", priority: 2, tokens: 80 }),
      makeBlock({ id: "c", priority: 1, tokens: 60 }),
    ];
    const plan = planner.plan(blocks, makeBudget({ maxTokens: 150 }));

    const sum = plan.selected.reduce((s, b) => s + b.tokens, 0);
    expect(plan.report.used).toBe(sum);
    expect(plan.report.available).toBe(150 - sum);
  });

  it("returns a zero report for empty input", () => {
    const budget = makeBudget();
    const plan = planner.plan([], budget);

    expect(plan.selected).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.report).toEqual({ used: 0, available: 1000, dropped: 0, compressed: 0 });
  });

  it("is deterministic across calls (JSON-equal output)", () => {
    const blocks = Array.from({ length: 30 }, (_, i) =>
      makeBlock({ id: `b${i}`, priority: (i * 7) % 11, tokens: 40 + (i % 3) * 20 }),
    );
    const budget = makeBudget({ maxTokens: 500 });

    const a = planner.plan(blocks, budget);
    const b = planner.plan(blocks, budget);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reserves the reserved sums away from ordinary blocks", () => {
    const blocks = Array.from({ length: 12 }, (_, i) =>
      makeBlock({ id: `b${i}`, priority: 10 - (i % 3), tokens: 100 }),
    );
    const plan = planner.plan(
      blocks,
      makeBudget({
        maxTokens: 1000,
        reserved: { system: 300, task: 100, output: 100 },
        dynamic: 0,
      }),
    );

    expect(plan.report.used).toBe(500);
    expect(plan.report.available).toBe(500);
  });
});