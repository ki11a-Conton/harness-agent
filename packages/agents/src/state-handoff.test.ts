import { describe, expect, it } from "vitest";
import type { WorkingState } from "@ar/contracts";
import { newWorkingState } from "@ar/contracts";
import type { DelegationResult } from "./delegation.js";
import { mergeChildCompletion, scopedContextFromWorkingState } from "./state-handoff.js";

function childResult(overrides: Partial<DelegationResult> = {}): DelegationResult {
  return {
    status: "success",
    summary: "done",
    childSessionId: "session_child" as never,
    toolCalls: 0,
    durationMs: 0,
    evidence: [],
    artifacts: [],
    answer: "implemented src/a.ts",
    findings: [],
    changedArtifacts: [],
    testsRun: [],
    openQuestions: [],
    blockers: [],
    suggestedNextActions: [],
    budgetUsed: { toolCalls: 0, durationMs: 0 },
    verified: false,
    ...overrides,
  };
}

describe("P1-9 scopedContextFromWorkingState", () => {
  it("projects the minimal necessary context: goal, constraints, plan, decisions", () => {
    const state = newWorkingState("fix the bug");
    state.constraints = ["no new deps"];
    state.plan = ["repro", "patch", "verify"];
    state.decisions = ["use the working state"];
    state.importantFacts = ["runtime ignores importantFacts"];

    const blocks = scopedContextFromWorkingState(state);

    expect(blocks).toHaveLength(4);
    expect(blocks[0]!.content).toContain("# Goal\nfix the bug");
    expect(blocks[1]!.content).toContain("# Constraints\nno new deps");
    expect(blocks[2]!.content).toContain("# Plan");
    expect(blocks[3]!.content).toContain("# Decisions");
    // Minimal necessary context: importantFacts is NOT projected by default.
    expect(blocks.some((b) => b.content.includes("Important facts"))).toBe(false);
  });

  it("never forks the parent transcript: blocks are trusted system blocks", () => {
    const state = newWorkingState("g");
    state.decisions = ["d1", "d2"];

    const blocks = scopedContextFromWorkingState(state);

    for (const block of blocks) {
      expect(block.source).toBe("system");
      expect(block.trust).toBe("trusted");
      expect(block.compressible).toBe(true);
      expect(block.ephemeral).toBe(false);
      expect(block.tokens).toBeGreaterThan(0);
      expect(block.id.startsWith("scoped:")).toBe(true);
    }
  });

  it("supports an explicit scope and caps entry count and block size", () => {
    const state = newWorkingState("g");
    state.decisions = Array.from({ length: 40 }, (_, i) => `d${i}`);

    const blocks = scopedContextFromWorkingState(state, {
      include: new Set(["decisions"]),
      maxEntries: 5,
      maxBlockChars: 40,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.length).toBeLessThanOrEqual(40);
    // Only the first 5 decisions were projected.
    expect(blocks[0]!.content).toContain("d0");
    expect(blocks[0]!.content).not.toContain("d39");
  });
});

describe("P1-9 mergeChildCompletion", () => {
  it("adopts artifacts, findings, tests, questions and next actions into the parent", () => {
    const parent = newWorkingState("p");
    parent.filesChanged = ["src/parent.ts"];
    const child = childResult({
      changedArtifacts: [{ path: "src/a.ts", sourceRef: "message:m1" }],
      findings: [{ claim: "verification passed", evidenceRefs: ["event:e1"], confidence: "high" }],
      testsRun: [{ description: "npm test", passed: true, sourceRef: "message:m2" }],
      openQuestions: ["is the API stable?"],
      suggestedNextActions: ["run lint"],
      answer: "implemented src/a.ts",
    });

    const report = mergeChildCompletion(parent, child);

    expect(report.mergedPaths).toEqual(["src/a.ts"]);
    expect(parent.filesChanged).toEqual(["src/parent.ts", "src/a.ts"]);
    expect(parent.artifactRefs).toContain("src/a.ts");
    expect(report.adoptedFindings).toHaveLength(1);
    expect(parent.decisions.some((d) => d.includes("verification passed"))).toBe(true);
    expect(parent.testsRun).toContain("npm test");
    expect(parent.openQuestions).toContain("is the API stable?");
    expect(parent.pending).toContain("run lint");
    expect(parent.childAgentRefs).toContain(child.childSessionId);
    // Ownership: the child is recorded, and the merge decision is logged.
    expect(parent.decisions.some((d) => d.includes(`child ${child.childSessionId}`))).toBe(true);
  });

  it("flags a path both parent and child modified as a conflict without applying the child version", () => {
    const parent = newWorkingState("p");
    parent.filesChanged = ["src/a.ts"];
    const child = childResult({
      changedArtifacts: [{ path: "src/a.ts", sourceRef: "message:m1" }],
    });

    const report = mergeChildCompletion(parent, child);

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.path).toBe("src/a.ts");
    expect(report.skipped).toEqual([{ reason: "stale", detail: "src/a.ts" }]);
    // The parent version is preserved.
    expect(parent.filesChanged).toEqual(["src/a.ts"]);
    expect(report.mergedPaths).toEqual([]);
  });

  it("deduplicates repeated findings by claim", () => {
    const parent = newWorkingState("p");
    const first = childResult({
      findings: [{ claim: "verification passed", evidenceRefs: ["event:e1"], confidence: "high" }],
    });
    mergeChildCompletion(parent, first);

    const second = childResult({
      findings: [{ claim: "verification passed", evidenceRefs: ["event:e2"], confidence: "high" }],
    });
    const report = mergeChildCompletion(parent, second);

    expect(report.adoptedFindings).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toBe("duplicate");
  });

  it("never merges a failed child; the failure is recorded for the parent", () => {
    const parent = newWorkingState("p");
    const child = childResult({
      status: "failed",
      error: "boom",
      changedArtifacts: [{ path: "src/a.ts", sourceRef: "message:m1" }],
      findings: [{ claim: "verification passed", evidenceRefs: ["event:e1"], confidence: "high" }],
    });

    const report = mergeChildCompletion(parent, child);

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toBe("failed");
    expect(report.mergedPaths).toEqual([]);
    expect(report.adoptedFindings).toEqual([]);
    expect(parent.filesChanged).toEqual([]);
    expect(parent.failures).toContain(`child ${child.childSessionId}: boom`);
    expect(parent.decisions.some((d) => d.includes("failed; its changes were not merged"))).toBe(true);
  });

  it("treats a cancelled/timeout child as partial: nothing ref-backed to merge", () => {
    const parent = newWorkingState("p");
    const cancelled = childResult({ status: "cancelled" });
    const timedOut = childResult({ status: "timeout" });

    for (const child of [cancelled, timedOut]) {
      const report = mergeChildCompletion(parent, child);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]!.reason).toBe("partial");
      expect(report.mergedPaths).toEqual([]);
    }
    expect(parent.filesChanged).toEqual([]);
    expect(parent.failures).toEqual([]);
  });

  it("leaves unrelated parent state untouched", () => {
    const parent = newWorkingState("p");
    parent.constraints = ["keep"];
    parent.completed = ["c1"];
    parent.commandsRun = ["npm run build"];
    parent.importantFacts = ["fact"];
    const snapshot = {
      goal: parent.goal,
      constraints: [...parent.constraints],
      completed: [...parent.completed],
      commandsRun: [...parent.commandsRun],
      importantFacts: [...parent.importantFacts],
      plan: [...parent.plan],
    };

    mergeChildCompletion(
      parent,
      childResult({ changedArtifacts: [{ path: "src/a.ts", sourceRef: "message:m1" }] }),
    );

    expect(parent.goal).toBe(snapshot.goal);
    expect(parent.constraints).toEqual(snapshot.constraints);
    expect(parent.completed).toEqual(snapshot.completed);
    expect(parent.commandsRun).toEqual(snapshot.commandsRun);
    expect(parent.importantFacts).toEqual(snapshot.importantFacts);
    expect(parent.plan).toEqual(snapshot.plan);
  });
});