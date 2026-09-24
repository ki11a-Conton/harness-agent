import { describe, expect, it } from "vitest";
import { classifyCommand } from "./command-classifier.js";
import { buildVerificationPlan, planToVerificationSpecs } from "./verification/plan-builder.js";

describe("P8-4: shared command classifier", () => {
  it("classifies test/typecheck/build/lint/verify consistently", () => {
    expect(classifyCommand("pnpm test").category).toBe("test");
    expect(classifyCommand("vitest run").category).toBe("test");
    expect(classifyCommand("pnpm typecheck").category).toBe("typecheck");
    expect(classifyCommand("tsc --noEmit").category).toBe("typecheck");
    expect(classifyCommand("npm run build").category).toBe("build");
    expect(classifyCommand("eslint .").category).toBe("lint");
    expect(classifyCommand("cargo check").category).toBe("check");
    expect(classifyCommand("make verify").category).toBe("verify");
    expect(classifyCommand("echo hello").category).toBe("other");
  });
});

describe("P8-1: verification plan builder", () => {
  it("targets changed tests, then the package test, then typecheck/build", () => {
    const plan = buildVerificationPlan({
      root: "/repo",
      filesChanged: ["src/lib/parser.ts", "src/lib/parser.test.ts"],
      commands: { test: "pnpm test", typecheck: "pnpm typecheck", build: "pnpm build" },
    });
    expect(plan.steps[0]!.command).toContain("parser.test.ts");
    expect(plan.steps.some((s) => s.command === "pnpm test" && s.cwd === "src")).toBe(true);
    expect(plan.steps.some((s) => s.command === "pnpm typecheck")).toBe(true);
    expect(plan.steps.some((s) => s.command === "pnpm build")).toBe(true);
  });

  it("plans only the repo test when no tests changed and no package boundary", () => {
    const plan = buildVerificationPlan({
      root: "/repo",
      filesChanged: ["README.md"],
      commands: { test: "jest" },
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.command).toBe("jest");
    expect(plan.rationale[0]).toContain("repository test suite");
  });

  it("returns an honest empty plan without discovered commands", () => {
    const plan = buildVerificationPlan({ root: "/repo", filesChanged: ["a.ts"] });
    expect(plan.steps).toHaveLength(0);
    expect(plan.rationale.some((r) => r.includes("no test command"))).toBe(true);
  });

  it("P8-1: converts a plan into executable verification specs (command + args split)", () => {
    const plan = buildVerificationPlan({
      root: "/repo",
      filesChanged: ["src/parser.test.ts"],
      commands: { test: "pnpm test", typecheck: "pnpm typecheck" },
    });
    const specs = planToVerificationSpecs(plan);
    expect(specs.length).toBeGreaterThanOrEqual(2);
    const pnpm = specs.find((s) => s.kind === "command" && s.command === "pnpm");
    expect(pnpm).toBeDefined();
    expect((pnpm as { args?: string[] }).args).toEqual(["test", "src/parser.test.ts"]);
    expect(specs.every((s) => s.kind === "command")).toBe(true);
  });

  it("P8-1: shell-special arguments survive the spec conversion (verifier shell-quotes them)", () => {
    const specs = planToVerificationSpecs({
      steps: [{ kind: "command", command: 'node -e "process.exit(0)"', required: true }],
      rationale: [],
    });
    expect(specs).toEqual([
      { kind: "command", command: "node", args: ["-e", '"process.exit(0)"'], description: 'planned: node -e "process.exit(0)"' },
    ]);
  });
});

describe("P8-3: false-complete grading", () => {
  it("grades verified_complete and verification_failed directly", async () => {
    const { gradeCompletion: g } = await import("@ar/contracts");
    expect(g("verified_complete")).toBe("verified_complete");
    expect(g("verification_failed")).toBe("verification_failed");
  });

  it("bare model_stopped is unverified_complete (never success)", async () => {
    const { gradeCompletion: g } = await import("@ar/contracts");
    expect(g("model_stopped")).toBe("unverified_complete");
  });

  it("partial gate evidence grades verified_partial", async () => {
    const { gradeCompletion: g } = await import("@ar/contracts");
    expect(g("model_stopped", { passedSteps: 1, totalSteps: 2 })).toBe("verified_partial");
    expect(g("model_stopped", { passedSteps: 2, totalSteps: 2 })).toBe("verified_complete");
  });
});
