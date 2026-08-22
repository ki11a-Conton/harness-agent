import { describe, expect, it } from "vitest";
import type { EvalCase } from "./eval-case.js";
import type { EvalOutcome } from "./runner.js";
import {
  learnToolPreference,
  promotePreference,
  rollbackPreference,
  shouldApplyPreference,
  preferenceTargetsSafetyCritical,
  scopeMatches,
  simulatePreferenceRun,
  runPreferenceExperiment,
} from "./tool-preference.js";

const CASE: EvalCase = {
  id: "pref-case",
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
      tokens_output: 100,
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

describe("P3-5 learned tool preference — learning", () => {
  it("learns a candidate preference from a scope with enough evidence", () => {
    const trace = [
      makeRun("a", "passed", ["read_file"]),
      makeRun("b", "passed", ["read_file"]),
      makeRun("c", "passed", ["read_file"]),
      makeRun("d", "failed", ["read_file"]),
    ];
    const pref = learnToolPreference(trace, "coding", "read_file");
    expect(pref).toBeDefined();
    expect(pref!.status).toBe("candidate");
    expect(pref!.evidenceSamples).toBe(4);
    expect(pref!.scope).toBe("coding");
  });

  it("refuses to learn from too little evidence (a single success must not count)", () => {
    const trace = [makeRun("a", "passed", ["read_file"])];
    const pref = learnToolPreference(trace, "coding", "read_file", { minSamples: 3 });
    expect(pref).toBeUndefined();
  });

  it("refuses to learn when the tool did not actually help success", () => {
    const trace = [
      makeRun("a", "failed", ["read_file"]),
      makeRun("b", "failed", ["read_file"]),
      makeRun("c", "failed", ["read_file"]),
    ];
    const pref = learnToolPreference(trace, "coding", "read_file");
    expect(pref).toBeUndefined();
  });
});

describe("P3-5 learned tool preference — scope & rollback", () => {
  const active: ReturnType<typeof promotePreference> = {
    id: "pref:coding:read_file",
    tool: "read_file",
    scope: "coding",
    weight: 1.6,
    status: "active",
    evidenceSamples: 4,
    version: 2,
  };

  it("promotes a benchmark-validated, evidence-backed, safety-intact preference", () => {
    const p = promotePreference(
      { id: "x", tool: "read_file", scope: "coding", weight: 1.5, status: "candidate", evidenceSamples: 5, version: 1 },
      { passDelta: 0.2, costScoreDelta: 5, safetyIntact: true },
    );
    expect(p.status).toBe("active");
    expect(p.version).toBe(2);
  });

  it("does not promote without benchmark pass lift", () => {
    const p = promotePreference(
      { id: "x", tool: "read_file", scope: "coding", weight: 1.5, status: "candidate", evidenceSamples: 5, version: 1 },
      { passDelta: -0.1, costScoreDelta: 5, safetyIntact: true },
    );
    expect(p.status).toBe("candidate");
  });

  it("does not promote a preference that would strip a safety-critical tool", () => {
    const p = promotePreference(
      { id: "x", tool: "exec", scope: "coding", weight: 0.1, status: "candidate", evidenceSamples: 5, version: 1 },
      { passDelta: 0.5, costScoreDelta: 9, safetyIntact: false },
    );
    expect(p.status).toBe("candidate");
  });

  it("scope-aware apply: only active + matching scope applies", () => {
    expect(shouldApplyPreference(active, "coding")).toBe(true);
    expect(shouldApplyPreference(active, "data")).toBe(false); // non-matching scope unchanged
  });

  it("a rolled_back preference no longer applies anywhere", () => {
    const rolled = rollbackPreference(active);
    expect(rolled.status).toBe("rolled_back");
    expect(shouldApplyPreference(rolled, "coding")).toBe(false);
    expect(shouldApplyPreference(rolled, "")).toBe(false);
  });

  it("detects a preference targeting a safety-critical tool", () => {
    expect(preferenceTargetsSafetyCritical("exec")).toBe(true);
    expect(preferenceTargetsSafetyCritical("render_docs")).toBe(false);
  });

  it("scopeMatches treats empty as wildcard", () => {
    expect(scopeMatches("", "anything")).toBe(true);
    expect(scopeMatches("coding", "coding")).toBe(true);
    expect(scopeMatches("coding", "data")).toBe(false);
  });
});

describe("P3-5 learned tool preference — effect model", () => {
  it("no_preferences is the identity champion", () => {
    const run = simulatePreferenceRun(makeRun("c"), "no_preferences", [], "coding");
    expect(run.passed).toBe(true);
    expect(run.appliedPreference).toBe(false);
    expect(run.tokens).toBe(600);
  });

  it("an applied active-scope preference can lift a failing case", () => {
    const prefs = [promotePreference(
      { id: "x", tool: "read_file", scope: "coding", weight: 1.5, status: "candidate", evidenceSamples: 5, version: 1 },
      { passDelta: 0.2, costScoreDelta: 5, safetyIntact: true },
    )];
    const run = simulatePreferenceRun(makeRun("c", "failed"), "learned_preferences", prefs, "coding", { model: { preferencePassGain: 1 }, seed: 3 });
    expect(run.appliedPreference).toBe(true);
    expect(run.passed).toBe(true);
  });

  it("a preference outside the case scope never applies", () => {
    const prefs = [promotePreference(
      { id: "x", tool: "read_file", scope: "coding", weight: 1.5, status: "candidate", evidenceSamples: 5, version: 1 },
      { passDelta: 0.2, costScoreDelta: 5, safetyIntact: true },
    )];
    const run = simulatePreferenceRun(makeRun("c", "failed"), "learned_preferences", prefs, "data", { model: { preferencePassGain: 1 }, seed: 3 });
    expect(run.appliedPreference).toBe(false);
    expect(run.passed).toBe(false); // no lift outside scope
  });

  it("a safety-stripping fault fails closed (no promotion possible)", () => {
    const run = simulatePreferenceRun(makeRun("c", "passed"), "learned_preferences", [], "coding", { model: { faultStripSafety: true }, seed: 3 });
    expect(run.strippedSafetyTool).toBe(true);
    expect(run.passed).toBe(false);
  });
});

describe("P3-5 learned tool preference — end-to-end", () => {
  it("learn → promote → apply lifts scope-matching cases", async () => {
    const training = Array.from({ length: 5 }, (_, i) =>
      makeRun(`tr${i}`, "passed", ["read_file"]),
    );
    const result = await runPreferenceExperiment(
      training,
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file"])),
        cases: Array.from({ length: 3 }, (_, i) => ({ ...CASE, id: `v${i}` })),
        scopeOf: () => "coding",
      },
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file"])),
        cases: Array.from({ length: 3 }, (_, i) => ({ ...CASE, id: `e${i}` })),
        scopeOf: () => "coding",
      },
      {
        tool: "read_file",
        scope: "coding",
        model: { preferencePassGain: 1, applicationReach: 1 },
        seed: 4,
      },
    );
    expect(result.activeCount).toBe(1);
    expect(result.passDelta).toBeGreaterThan(0);
    expect(result.strippedCount).toBe(0);
  });

  it("a rolled-back preference no longer lifts", async () => {
    const training = Array.from({ length: 5 }, (_, i) =>
      makeRun(`tr${i}`, "passed", ["read_file"]),
    );
    const result = await runPreferenceExperiment(
      training,
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file"])),
        cases: [{ ...CASE, id: "v" }],
        scopeOf: () => "coding",
      },
      {
        runWorker: (c) => Promise.resolve(makeRun(c.id, "failed", ["read_file"])),
        cases: [{ ...CASE, id: "e" }],
        scopeOf: () => "coding",
      },
      {
        tool: "read_file",
        scope: "coding",
        model: { preferencePassGain: 1 },
        seed: 4,
        rollbackAfterPromote: true,
      },
    );
    expect(result.activeCount).toBe(0);
    expect(result.passDelta).toBe(0); // rolled back → no-op on eval split
  });
});