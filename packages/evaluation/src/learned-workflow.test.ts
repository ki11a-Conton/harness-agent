import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import {
  learnWorkflow,
  promoteWorkflow,
  rollbackWorkflow,
  shouldApplyWorkflow,
  workflowMatches,
  assertNoGateBypass,
  simulateWorkflowRun,
  runWorkflowExperiment,
} from "./learned-workflow.js";

const CASE: EvalCase = {
  id: "wf-case",
  task: "do the thing",
  expected: { status: "completed" },
  suite: "regression",
};

function makeRun(
  caseId: string,
  status: EvalOutcome["status"] = "passed",
  toolEvents: string[] = [],
): EvalOutcome {
  const events: EvalOutcome["events"] = toolEvents.map((tool, i) => ({
    id: i + 1,
    sessionId: "s" as never,
    sequence: i,
    timestamp: 0,
    type: "tool.completed",
    payload: { tool, status: "success", args: {} },
  })) as unknown as EvalOutcome["events"];
  return {
    caseId,
    status,
    actualStatus: "completed",
    events,
    metrics: {
      turn_count: 1,
      tool_call_count: toolEvents.length,
      tokens_input: 500,
      tokens_output: 120,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 800,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0.01,

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

// A passing run ending in verification after a mutating edit.
const BUILD_DEPLOY = ["read_file", "edit_file", "exec", "verify_step"];

describe("P3-6 learned workflow — learning", () => {
  it("learns a soft workflow from enough passing traces of one task type", () => {
    const trace = [
      makeRun("a", "passed", ["read_file", "edit_file", "exec", "verify_step"]),
      makeRun("b", "passed", ["read_file", "edit_file", "exec", "verify_step"]),
      makeRun("c", "passed", ["read_file", "edit_file", "exec", "verify_step"]),
    ];
    const wf = learnWorkflow(trace, "coding");
    expect(wf).toBeDefined();
    expect(wf!.status).toBe("candidate");
    expect(wf!.evidenceSamples).toBe(3);
    expect(wf!.taskType).toBe("coding");
    expect(wf!.includesVerification).toBe(true);
  });

  it("refuses to learn from a single success (evidence too thin)", () => {
    const trace = [makeRun("a", "passed", BUILD_DEPLOY)];
    const wf = learnWorkflow(trace, "coding", { minSamples: 3 });
    expect(wf).toBeUndefined();
  });

  it("drops a candidate whose steps mutate but never verify (would bypass the gate)", () => {
    const trace = [
      makeRun("a", "passed", ["read_file", "edit_file", "exec"]),
      makeRun("b", "passed", ["read_file", "edit_file", "exec"]),
      makeRun("c", "passed", ["read_file", "edit_file", "exec"]),
    ];
    const wf = learnWorkflow(trace, "coding");
    expect(wf).toBeUndefined();
  });
});

describe("P3-6 learned workflow — promotion, scope & bypass", () => {
  it("promotes a benchmark-validated, evidence-backed, bypass-free workflow", () => {
    const wf = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "test", "verification"],
      status: "candidate" as const,
      evidenceSamples: 5,
      version: 1,
      includesVerification: true,
    };
    const p = promoteWorkflow(wf, { passDelta: 0.2, costScoreDelta: 5, bypassFree: true });
    expect(p.status).toBe("active");
    expect(p.version).toBe(2);
  });

  it("does not promote without benchmark validation lift", () => {
    const wf = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "verification"],
      status: "candidate" as const,
      evidenceSamples: 5,
      version: 1,
      includesVerification: true,
    };
    const p = promoteWorkflow(wf, { passDelta: -0.1, costScoreDelta: 5, bypassFree: true });
    expect(p.status).toBe("candidate");
  });

  it("never promotes a bypassing workflow", () => {
    const wf = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit"],
      status: "candidate" as const,
      evidenceSamples: 5,
      version: 1,
      includesVerification: false,
    };
    const p = promoteWorkflow(wf, { passDelta: 0.5, costScoreDelta: 9, bypassFree: false });
    expect(p.status).toBe("candidate");
  });

  it("is soft + scoped: only active + typing-matching workflows apply", () => {
    const active = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "verification"],
      status: "active" as const,
      evidenceSamples: 5,
      version: 2,
      includesVerification: true,
    };
    expect(shouldApplyWorkflow(active, "coding")).toBe(true);
    expect(shouldApplyWorkflow(active, "data")).toBe(false);
    expect(workflowMatches(active, "coding")).toBe(true);
  });

  it("a rolled_back workflow no longer applies anywhere", () => {
    const active = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "verification"],
      status: "active" as const,
      evidenceSamples: 5,
      version: 2,
      includesVerification: true,
    };
    const rolled = rollbackWorkflow(active);
    expect(rolled.status).toBe("rolled_back");
    expect(shouldApplyWorkflow(rolled, "coding")).toBe(false);
  });

  it("assertNoGateBypass fails closed on a permission-step marker", () => {
    const bad = {
      id: "wf:x",
      taskType: "x",
      preferredSteps: ["permission"],
      status: "candidate" as const,
      evidenceSamples: 5,
      version: 1,
      includesVerification: true,
    };
    expect(() => assertNoGateBypass(bad)).toThrow(/fail closed/);
  });
});

describe("P3-6 learned workflow — effect model", () => {
  it("no_workflow is the identity champion", () => {
    const run = simulateWorkflowRun(makeRun("c"), "no_workflow", [], "coding");
    expect(run.passed).toBe(true);
    expect(run.applied).toBe(false);
    expect(run.gated).toBe(false);
  });

  it("an applied matching soft workflow can lift a failing case", () => {
    const wf = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "verification"],
      status: "active" as const,
      evidenceSamples: 5,
      version: 2,
      includesVerification: true,
    };
    const run = simulateWorkflowRun(makeRun("c", "failed"), "learned_workflow", [wf], "coding", { model: { softGuidanceGain: 1 }, seed: 3 });
    expect(run.applied).toBe(true);
    expect(run.passed).toBe(true);
    expect(run.gated).toBe(false);
  });

  it("a non-matching task type is a no-op (soft + scoped)", () => {
    const wf = {
      id: "wf:coding",
      taskType: "coding",
      preferredSteps: ["read", "edit", "verification"],
      status: "active" as const,
      evidenceSamples: 5,
      version: 2,
      includesVerification: true,
    };
    const run = simulateWorkflowRun(makeRun("c", "failed"), "learned_workflow", [wf], "data", { model: { softGuidanceGain: 1 }, seed: 3 });
    expect(run.applied).toBe(false);
    expect(run.passed).toBe(false);
  });

  it("a gate-bypassing workflow fails closed (fault injection)", () => {
    const run = simulateWorkflowRun(makeRun("c", "passed"), "learned_workflow", [], "coding", { model: { faultBypassVerification: true }, seed: 3 });
    expect(run.gated).toBe(true);
    expect(run.passed).toBe(false);
  });
});

describe("P3-6 learned workflow — end-to-end", () => {
  it("learn → promote → apply lifts matching-type cases", async () => {
    const training = Array.from({ length: 5 }, (_, i) =>
      makeRun(`tr${i}`, "passed", ["read_file", "edit_file", "exec", "verify_step"]),
    );
    const result = await runWorkflowExperiment(
      training,
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file", "edit_file", "exec", "verify_step"])),
        cases: Array.from({ length: 3 }, (_, i) => ({ ...CASE, id: `v${i}` })),
        typeOf: () => "coding",
      },
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file", "edit_file", "exec", "verify_step"])),
        cases: Array.from({ length: 3 }, (_, i) => ({ ...CASE, id: `e${i}` })),
        typeOf: () => "coding",
      },
      { taskType: "coding", model: { softGuidanceGain: 1 }, seed: 4 },
    );
    expect(result.activeCount).toBe(1);
    expect(result.passDelta).toBeGreaterThan(0);
    expect(result.bypassCount).toBe(0);
  });

  it("a rolled-back workflow no longer lifts", async () => {
    const training = Array.from({ length: 5 }, (_, i) =>
      makeRun(`tr${i}`, "passed", ["read_file", "edit_file", "exec", "verify_step"]),
    );
    const result = await runWorkflowExperiment(
      training,
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file", "edit_file", "exec", "verify_step"])),
        cases: [{ ...CASE, id: "v" }],
        typeOf: () => "coding",
      },
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file", "edit_file", "exec", "verify_step"])),
        cases: [{ ...CASE, id: "e" }],
        typeOf: () => "coding",
      },
      { taskType: "coding", model: { softGuidanceGain: 1 }, seed: 4, rollbackAfterPromote: true },
    );
    expect(result.activeCount).toBe(0);
    expect(result.passDelta).toBe(0);
  });
});