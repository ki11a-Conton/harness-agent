/**
 * Tests for `harness-metrics.ts` (spec §三: the 12 quantified indicators).
 *
 * Coverage contract (from the task):
 *  - every one of the 12 indicators has a MEASURED case AND an
 *    INSUFFICIENT_SAMPLE case (empty sample);
 *  - strata report their sample sizes;
 *  - pass@1 and pass^k are distinct quantities with distinct populations;
 *  - missing data is null + INSUFFICIENT_SAMPLE, never 0;
 *  - the report is deterministic (same input → identical output).
 *
 * All fixtures are built in-process: no network, no model, no clock.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionId } from "@ar/contracts";
import type { EvalOutcome } from "./runner.js";
import type { RunMetrics } from "@ar/observability";
import {
  SPEC_METRIC_TARGETS,
  computeSpecMetrics,
  claimedComplete,
  findSpecMetric,
  hasExecutableAcceptance,
  isTraceComplete,
  loopGuardTriggered,
  regressionCount,
  resolveVerificationStatus,
  toolCallTally,
  type SpecMetricId,
  type SpecMetricsInput,
  type SpecRunInput,
} from "./harness-metrics.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = "session-test" as SessionId;

let seq = 0;
function ev(
  type: AgentEvent["type"],
  payload: Record<string, unknown> = {},
  opts: { turnId?: string; sequence?: number } = {},
): AgentEvent {
  seq += 1;
  return {
    id: `ev-${seq}` as AgentEvent["id"],
    sessionId: SESSION,
    turnId: (opts.turnId ?? "turn-1") as AgentEvent["turnId"],
    sequence: opts.sequence ?? seq,
    timestamp: 1_700_000_000_000,
    type,
    payload,
  };
}

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    turn_count: 1,
    tool_call_count: 0,
    tokens_input: 0,
    tokens_output: 0,
    context_tokens: 0,
    compaction_count: 0,
    duration_ms: 100,
    retry_count: 0,
    verification_failures: 0,
    human_interventions: 0,
    estimated_cost: 0,
    usage_unknown: 0,
    cache_tokens_read: 0,
    cache_tokens_created: 0,
    model_call_count: 0,
    ...overrides,
  };
}

/** A tool call that satisfies the full protocol (request → run → success). */
function validToolCall(callId: string, tool = "read_file"): AgentEvent[] {
  return [
    ev("tool.requested", { toolCallId: callId, tool, args: { path: "a.ts" } }),
    ev("tool.started", { toolCallId: callId, tool }),
    ev("tool.completed", { toolCallId: callId, tool, status: "success" }),
  ];
}

function outcome(overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    caseId: "task-1",
    status: "passed",
    actualStatus: "completed",
    events: [],
    metrics: metrics(),
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
    ...overrides,
  };
}

/** A complete, verified, passing green run of `task`. */
function greenRun(task: string, repeatIndex = 0, overrides: Partial<EvalOutcome> = {}): SpecRunInput {
  return {
    taskId: task,
    repeatIndex,
    inRepetitionProtocol: true,
    outcome: outcome({
      caseId: task,
      status: "passed",
      actualStatus: "completed",
      events: [
        ev("turn.started", {}),
        ...validToolCall(`call-${task}-${repeatIndex}`),
        ev("verification.completed", { passed: true }),
        ev("turn.completed", { grade: "verified_complete" }),
      ],
      metrics: metrics({
        duration_ms: 100,
        tokens_input: 100,
        tokens_output: 50,
        estimated_cost: 0.01,
        model_call_count: 1,
        usage_unknown: 0,
        tool_call_count: 1,
      }),
      ...overrides,
    }),
    facts: {
      claimedComplete: true,
      verification: "PASS",
      hasExecutableAcceptance: true,
    },
  };
}

/** All 12 indicator ids, in the spec's order. */
const ALL_METRICS: SpecMetricId[] = [
  "task_success_rate",
  "repeat_stability_pass_pow_k",
  "tool_call_validity_rate",
  "recovery_success_rate",
  "auto_verification_coverage",
  "completion_claim_precision",
  "loop_guard_effectiveness",
  "security_control_effectiveness",
  "trace_completeness",
  "token_cost_efficiency",
  "task_latency_ms",
  "regression_rate",
];

function sampleOf(input: SpecMetricsInput, metric: SpecMetricId) {
  return findSpecMetric(computeSpecMetrics(input), metric);
}

// ---------------------------------------------------------------------------
// Indicator extraction primitives
// ---------------------------------------------------------------------------

describe("spec §三 extraction primitives", () => {
  it("trace completeness requires a linked event trail, not a filename convention", () => {
    expect(isTraceComplete(greenRun("t").outcome)).toBe(true);
    // No events at all → not complete (legacy artifact).
    expect(isTraceComplete(outcome({ events: [] }))).toBe(false);
    // A tool call with no terminal result → the result is not linked.
    const dangling = outcome({
      events: [
        ev("turn.started", {}),
        ev("tool.requested", { toolCallId: "c1", tool: "read_file" }),
        ev("turn.completed", {}),
      ],
    });
    expect(isTraceComplete(dangling)).toBe(false);
    // An event without a step identity → not attributable.
    const noTurn = outcome({
      events: [{ ...ev("turn.completed", {}), turnId: undefined }],
    });
    expect(isTraceComplete(noTurn)).toBe(false);
  });

  it("verification status comes from the verifier's own events", () => {
    expect(resolveVerificationStatus(greenRun("t").outcome)).toBe("PASS");
    expect(
      resolveVerificationStatus(outcome({ events: [ev("verification.failed", { attempt: 1, maxAttempts: 2 })] })),
    ).toBe("FAIL");
    expect(resolveVerificationStatus(outcome({ events: [ev("turn.cancelled", {})] }))).toBe("TIMEOUT");
    expect(resolveVerificationStatus(outcome({ events: [ev("turn.started", {})] }))).toBe("NOT_RUN");
    // No trail at all → UNKNOWN (null), never a fabricated NOT_RUN.
    expect(resolveVerificationStatus(outcome({ events: [] }))).toBeNull();
  });

  it("hasExecutableAcceptance accepts an injected case property, else reads verification.* events", () => {
    expect(hasExecutableAcceptance(greenRun("t").outcome, true)).toBe(true);
    expect(hasExecutableAcceptance(greenRun("t").outcome, false)).toBe(false);
    expect(hasExecutableAcceptance(greenRun("t").outcome, null)).toBe(true);
    expect(hasExecutableAcceptance(outcome({ events: [ev("turn.completed", {})] }), null)).toBe(false);
  });

  it("a completion claim needs a completion terminal event when a trail exists", () => {
    expect(claimedComplete(greenRun("t").outcome)).toBe(true);
    // actualStatus "completed" but the turn FAILED → the agent did not claim success.
    expect(
      claimedComplete(outcome({ actualStatus: "completed", events: [ev("turn.failed", {})] })),
    ).toBe(false);
    // Legacy artifact with no trail falls back to the recorded status.
    expect(claimedComplete(outcome({ actualStatus: "completed", events: [] }))).toBe(true);
    expect(claimedComplete(outcome({ actualStatus: "failed", events: [] }))).toBe(false);
  });

  it("tool validity is protocol-derived (arg legality, execution, completion, correlation)", () => {
    const good = toolCallTally(greenRun("t").outcome);
    expect(good).toMatchObject({ dispatches: 1, valid: 1, invalidReasons: [] });

    const neverCompleted = outcome({
      events: [ev("tool.requested", { toolCallId: "c1", tool: "exec" }), ev("tool.started", { toolCallId: "c1", tool: "exec" })],
    });
    expect(toolCallTally(neverCompleted)).toMatchObject({ dispatches: 1, valid: 0 });

    const failedStatus = outcome({
      events: [
        ev("tool.requested", { toolCallId: "c1", tool: "exec" }),
        ev("tool.started", { toolCallId: "c1", tool: "exec" }),
        ev("tool.completed", { toolCallId: "c1", tool: "exec", status: "error" }),
      ],
    });
    expect(toolCallTally(failedStatus).valid).toBe(0);

    const unfollowed = outcome({ events: [ev("tool.requested", { toolCallId: "c1", tool: "exec", args: { cmd: "x" } })] });
    expect(toolCallTally(unfollowed).invalidReasons.join(" ")).toMatch(/never started/);

    const mismatched = outcome({
      events: [
        ev("tool.requested", { toolCallId: "c1", tool: "exec" }),
        ev("tool.started", { toolCallId: "c1", tool: "exec" }),
        ev("tool.completed", { toolCallId: "c1", tool: "read_file", status: "success" }),
      ],
    });
    expect(toolCallTally(mismatched).valid).toBe(0);
  });

  it("loop detection is the observable termination fact, not a heuristic", () => {
    expect(loopGuardTriggered(outcome({ events: [ev("run.limit_reached", { limit: "maxRepeatedToolCalls" })] }))).toBe(true);
    expect(loopGuardTriggered(outcome({ events: [ev("run.limit_reached", { limit: "maxTokens" })] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The 12 indicators: MEASURED states
// ---------------------------------------------------------------------------

describe("spec §三 all 12 indicators — MEASURED states", () => {
  const injectionFacts = {
    claimedComplete: true,
    verification: "PASS" as const,
    hasExecutableAcceptance: true,
    expectRecovery: true,
    recovered: true,
    expectLoopDetection: true,
    loopDetected: true,
    expectSecurityEnforcement: true,
    securityEnforced: true,
  };
  const runs: SpecRunInput[] = [
    ...["a", "b", "c"].flatMap((task) =>
      [0, 1, 2].map((i) => ({
        ...greenRun(`task-${task}`, i),
        // The injection ground truth is declared on EVERY run so all three
        // tasks form valid pass^k groups (k=3).
        facts: { ...injectionFacts },
      })),
    ),
  ];
  const input: SpecMetricsInput = {
    runs,
    historicalPassedTaskIds: ["task-a", "task-b", "task-c"],
    criticalTaskIds: ["task-a", "task-b"],
    options: { repeatK: 3 },
  };
  const report = computeSpecMetrics(input);

  it("emits the 12 indicators exactly once, in the spec's order", () => {
    expect(report.metrics.map((m) => m.metric)).toEqual(ALL_METRICS);
    expect(report.schemaVersion).toBe("spec-metrics-v1");
  });

  it("every indicator is MEASURED on a fully-observed run set", () => {
    const insufficient = report.metrics
      .filter((m) => m.status !== "MEASURED")
      .map((m) => `${m.metric}: ${m.reason ?? ""}`);
    expect(insufficient).toEqual([]);
    for (const sample of report.metrics) {
      expect(sample.sampleSize).toBeGreaterThan(0);
      expect(sample.target.length).toBeGreaterThan(0);
      expect(sample.targetKind).toBe(SPEC_METRIC_TARGETS[sample.metric].kind);
    }
  });

  it("#1 task success rate = passed/total", () => {
    const sample = findSpecMetric(report, "task_success_rate")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, sampleSize: 9, status: "MEASURED" });
  });

  it("#2 pass^k = share of tasks whose k runs ALL passed", () => {
    const sample = findSpecMetric(report, "repeat_stability_pass_pow_k")!;
    expect(sample).toMatchObject({ numerator: 3, denominator: 3, value: 1, status: "MEASURED" });
    expect(sample.distribution).toMatchObject({ k: 3, repeatGroups: 3, passAt1: 1, passAtK: 1, passPowK: 1 });
  });

  it("#3 tool call validity rate = valid dispatches / all dispatches", () => {
    const sample = findSpecMetric(report, "tool_call_validity_rate")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#4 recovery success rate uses only declared injection trials", () => {
    const sample = findSpecMetric(report, "recovery_success_rate")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#5 auto verification coverage is a per-TASK ratio", () => {
    const sample = findSpecMetric(report, "auto_verification_coverage")!;
    expect(sample).toMatchObject({ numerator: 3, denominator: 3, value: 1, status: "MEASURED" });
  });

  it("#6 completion claim precision = claims with an external PASS / claims", () => {
    const sample = findSpecMetric(report, "completion_claim_precision")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#7 loop guard effectiveness uses only declared loop trials", () => {
    const sample = findSpecMetric(report, "loop_guard_effectiveness")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#8 security control effectiveness uses only declared over-permission trials", () => {
    const sample = findSpecMetric(report, "security_control_effectiveness")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#9 trace completeness is structural over every run", () => {
    const sample = findSpecMetric(report, "trace_completeness")!;
    expect(sample).toMatchObject({ numerator: 9, denominator: 9, value: 1, status: "MEASURED" });
  });

  it("#10 token/cost efficiency is per SUCCESSFUL task (cost null when usage is unknown)", () => {
    const sample = findSpecMetric(report, "token_cost_efficiency")!;
    expect(sample.status).toBe("MEASURED");
    expect(sample.value).toBe(150); // 100 in + 50 out per success
    expect(sample.distribution).toMatchObject({
      meanTokensPerSuccess: 150,
      costUnknownSuccesses: 0,
      meanCostPerSuccessUsd: 0.01,
    });
  });

  it("#11 latency reports success P50/P95 and the failure timeout watch", () => {
    const sample = findSpecMetric(report, "task_latency_ms")!;
    expect(sample).toMatchObject({ status: "MEASURED", value: 100, sampleSize: 9 });
    expect(sample.distribution).toMatchObject({ p50Ms: 100, p95Ms: 100, failureRuns: 0 });
  });

  it("#12 regression rate = historical passing tasks that now fail", () => {
    const sample = findSpecMetric(report, "regression_rate")!;
    expect(sample).toMatchObject({ numerator: 0, denominator: 3, value: 0, status: "MEASURED" });
    expect(sample.targetKind).toBe("count");
    expect(regressionCount(report)).toBe(0);
  });

  it("strata report their own sample sizes for every axis", () => {
    const axes = new Set(report.strata.map((s) => s.axis));
    expect(axes).toEqual(new Set(["overall", "suite", "difficulty", "size", "tool_error"]));
    const overall = report.strata.find((s) => s.axis === "overall")!;
    expect(overall).toMatchObject({ value: "all", runs: 9, tasks: 3, repeatGroups: 3, toolCalls: 9 });
    const bySuite = report.strata.filter((s) => s.axis === "suite");
    expect(bySuite).toHaveLength(1);
    expect(bySuite[0]).toMatchObject({ value: "regression", runs: 9, tasks: 3 });
    const byToolError = report.strata.filter((s) => s.axis === "tool_error").map((s) => s.value).sort();
    expect(byToolError).toEqual(["without_tool_error"]);
    // Every per-stratum sample set repeats the 12 indicators.
    for (const entry of report.strataMetrics) {
      expect(entry.metrics.map((m) => m.metric)).toEqual(ALL_METRICS);
      expect(entry.stratum.runs).toBeGreaterThan(0);
    }
  });

  it("is deterministic (same input → identical report)", () => {
    const a = computeSpecMetrics(input);
    const b = computeSpecMetrics(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("minStratumRuns labels a small stratum INSUFFICIENT_SAMPLE instead of reporting a rate", () => {
    // Fully declared injections, so every indicator WOULD be measured — the
    // only reason they are not is the small-sample floor.
    const facts = {
      claimedComplete: true,
      verification: "PASS" as const,
      hasExecutableAcceptance: true,
      expectRecovery: true,
      recovered: true,
      expectLoopDetection: true,
      loopDetected: true,
      expectSecurityEnforcement: true,
      securityEnforced: true,
    };
    const runs = ["a", "b", "c"].flatMap((task) =>
      [0, 1, 2].map((i) => ({ ...greenRun(`task-${task}`, i), facts: { ...facts } })),
    );
    const measured = computeSpecMetrics({
      runs,
      historicalPassedTaskIds: ["task-a", "task-b", "task-c"],
      options: { repeatK: 3, minStratumRuns: 9 },
    });
    // Baseline: at a satisfiable floor every indicator is MEASURED.
    expect(measured.metrics.every((m) => m.status === "MEASURED")).toBe(true);

    // Raise the floor above the 9 observed runs: every RATE is withheld, while
    // the raw counts stay visible.
    const small = computeSpecMetrics({
      runs,
      historicalPassedTaskIds: ["task-a", "task-b", "task-c"],
      options: { repeatK: 3, minStratumRuns: 12 },
    });
    for (const sample of small.metrics) {
      expect(sample.status).toBe("INSUFFICIENT_SAMPLE");
      expect(sample.value).toBeNull();
      expect(sample.reason ?? "").toMatch(/below the caller's minStratumRuns/);
    }
    expect(small.metrics.find((m) => m.metric === "task_success_rate")).toMatchObject({
      numerator: 9,
      denominator: 9,
    });
    // A small sample can never satisfy a hard gate.
    expect(small.metrics.find((m) => m.metric === "trace_completeness")).toMatchObject({
      status: "INSUFFICIENT_SAMPLE",
      value: null,
    });
  });

  it("critical regressions are counted per critical task and surfaced in the distribution", () => {
    const runs = [
      ...[0, 1, 2].map((i) => greenRun("task-a", i)),
      ...[0, 1, 2].map((i) => ({ ...greenRun("task-b", i), outcome: { ...greenRun("task-b", i).outcome, status: "failed" as const } })),
    ];
    const report = computeSpecMetrics({
      runs,
      historicalPassedTaskIds: ["task-a", "task-b"],
      criticalTaskIds: ["task-a", "task-b"],
      options: { repeatK: 3 },
    });
    const sample = findSpecMetric(report, "regression_rate")!;
    expect(sample).toMatchObject({ numerator: 1, denominator: 2, status: "MEASURED" });
    expect(sample.distribution).toMatchObject({ regressedTasks: 1, criticalRegressions: 1 });
  });

  it("a critical task that was never evaluated is not silently counted as clean", () => {
    const report = computeSpecMetrics({
      runs: [greenRun("task-a", 0), greenRun("task-a", 1), greenRun("task-a", 2)],
      historicalPassedTaskIds: ["task-a"],
      criticalTaskIds: ["task-a", "task-never-run"],
      options: { repeatK: 3 },
    });
    // Only evaluated tasks can be counted, so the count is 0 — and the
    // denominator shows that only 1 of the 2 critical tasks was evaluated.
    const sample = findSpecMetric(report, "regression_rate")!;
    expect(sample.numerator).toBe(0);
    expect(sample.denominator).toBe(1);
    expect(sample.sampleSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty / missing data: the honesty states
// ---------------------------------------------------------------------------

describe("spec §三 missing data is INSUFFICIENT_SAMPLE, never 0", () => {
  it("every one of the 12 indicators reports INSUFFICIENT_SAMPLE + value null on an empty sample", () => {
    const report = computeSpecMetrics({ runs: [] });
    expect(report.metrics).toHaveLength(12);
    for (const sample of report.metrics) {
      expect(sample.status).toBe("INSUFFICIENT_SAMPLE");
      expect(sample.value).toBeNull();
      expect(sample.sampleSize).toBe(0);
      expect(sample.denominator).toBe(0);
      expect(sample.reason ?? "").not.toBe("");
    }
    expect(report.strata).toHaveLength(1);
    expect(report.strata[0]).toMatchObject({ axis: "overall", runs: 0, tasks: 0 });
    expect(report.trials).toBe(0);
  });

  it("a run set with no declared injections is NOT a vacuous 100% for #4/#7/#8", () => {
    const report = computeSpecMetrics({ runs: [greenRun("t", 0)] });
    for (const metric of ["recovery_success_rate", "loop_guard_effectiveness", "security_control_effectiveness"] as const) {
      const sample = findSpecMetric(report, metric)!;
      expect(sample.status).toBe("INSUFFICIENT_SAMPLE");
      expect(sample.value).toBeNull();
      expect(sample.denominator).toBe(0);
      expect(sample.reason ?? "").toMatch(/no declared|no fault-injection/);
    }
  });

  it("an unexercised tool path is not a 100% tool validity rate", () => {
    const run = greenRun("t", 0);
    run.outcome = { ...run.outcome, events: [ev("turn.started", {}), ev("turn.completed", {})] };
    expect(sampleOf({ runs: [run] }, "tool_call_validity_rate")).toMatchObject({
      status: "INSUFFICIENT_SAMPLE",
      value: null,
      denominator: 0,
    });
  });

  it("no run means no latency and no cost — null, not 0 ms / $0", () => {
    const report = computeSpecMetrics({ runs: [] });
    expect(findSpecMetric(report, "task_latency_ms")!.value).toBeNull();
    expect(findSpecMetric(report, "token_cost_efficiency")!.value).toBeNull();
    expect(findSpecMetric(report, "token_cost_efficiency")!.numerator).toBe(0);
  });

  it("cost is null (never 0) when the provider reported no usage", () => {
    const run = greenRun("t", 0);
    run.outcome = {
      ...run.outcome,
      metrics: metrics({ tokens_input: 100, tokens_output: 50, model_call_count: 1, usage_unknown: 1, estimated_cost: 0 }),
    };
    const sample = sampleOf({ runs: [run] }, "token_cost_efficiency")!;
    expect(sample.status).toBe("MEASURED");
    expect(sample.distribution).toMatchObject({
      costUnknownSuccesses: 1,
      meanCostPerSuccessUsd: null,
      totalCostUsd: null,
    });
  });

  it("a legacy artifact with no event trail is flagged, not silently counted as complete", () => {
    const legacy: SpecRunInput = {
      taskId: "legacy",
      outcome: outcome({ caseId: "legacy", status: "passed", actualStatus: "completed", events: [] }),
    };
    const report = computeSpecMetrics({ runs: [legacy] });
    const trace = findSpecMetric(report, "trace_completeness")!;
    expect(trace.status).toBe("MEASURED");
    expect(trace.numerator).toBe(0);
    expect(trace.excludedReasons?.join(" ")).toMatch(/no event trail/);
    // Completion precision cannot be assumed: its verifier state is unknown.
    const precision = findSpecMetric(report, "completion_claim_precision")!;
    expect(precision.numerator).toBe(0);
    expect(precision.excludedReasons?.join(" ")).toMatch(/no verifier state/);
  });

  it("no historical passing set means the regression count is unknown (spec #12)", () => {
    const sample = sampleOf({ runs: [greenRun("t", 0)] }, "regression_rate")!;
    expect(sample.status).toBe("INSUFFICIENT_SAMPLE");
    expect(sample.value).toBeNull();
    expect(sample.numerator).toBe(0);
    expect(sample.reason ?? "").toMatch(/cannot be assumed to be 0/);
    expect(regressionCount(computeSpecMetrics({ runs: [greenRun("t", 0)] }))).toBeNull();
  });

  it("a supplied historical set that no run covers is still INSUFFICIENT_SAMPLE", () => {
    const sample = sampleOf(
      { runs: [greenRun("other", 0)], historicalPassedTaskIds: ["task-a"] },
      "regression_rate",
    )!;
    expect(sample).toMatchObject({ status: "INSUFFICIENT_SAMPLE", denominator: 0, value: null });
  });
});

// ---------------------------------------------------------------------------
// pass@1 vs pass@k vs pass^k
// ---------------------------------------------------------------------------

describe("spec §三 pass@1 / pass@k / pass^k are different populations", () => {
  it("a task that passes 4 of 5 runs scores pass@1=0.8, pass@k=1, pass^k=0", () => {
    const runs: SpecRunInput[] = [0, 1, 2, 3, 4].map((i) => {
      const run = greenRun("flaky", i);
      if (i === 4) {
        run.outcome = {
          ...run.outcome,
          status: "failed",
          actualStatus: "failed",
          events: [...run.outcome.events.filter((e) => e.type !== "turn.completed"), ev("turn.failed", {})],
        };
        run.facts = { ...run.facts!, claimedComplete: false, verification: "NOT_RUN" };
      }
      return run;
    });
    const report = computeSpecMetrics({ runs, options: { repeatK: 5 } });

    // pass@1 is the per-run success rate.
    expect(findSpecMetric(report, "task_success_rate")).toMatchObject({ numerator: 4, denominator: 5, value: 0.8 });
    // pass^k is the per-TASK all-success share — NOT p^k extrapolated from p.
    expect(findSpecMetric(report, "repeat_stability_pass_pow_k")).toMatchObject({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    const distribution = findSpecMetric(report, "repeat_stability_pass_pow_k")!.distribution!;
    expect(distribution.passAt1).toBeCloseTo(0.8, 10);
    expect(distribution.passAtK).toBe(1); // at least one success
    expect(distribution.passPowK).toBe(0);
    // The idealised formulas would give different numbers — the measured
    // values must not be replaced by 1-(1-p)^k or p^k.
    expect(distribution.passAtK).not.toBeCloseTo(1 - Math.pow(1 - 0.8, 5), 5);
  });

  it("tasks with fewer than k recorded repeats are excluded from pass^k, not counted as failures", () => {
    const report = computeSpecMetrics({
      runs: [greenRun("full", 0), greenRun("full", 1), greenRun("partial", 0)],
      options: { repeatK: 2 },
    });
    const sample = findSpecMetric(report, "repeat_stability_pass_pow_k")!;
    expect(sample).toMatchObject({ numerator: 1, denominator: 1, value: 1, status: "MEASURED" });
    expect(sample.distribution).toMatchObject({ repeatGroups: 1, excludedGroups: 1 });
    expect(sample.excludedReasons?.join(" ")).toMatch(/repeated fewer than 2/);
  });
});

// ---------------------------------------------------------------------------
// Security / loop / completion precision edge cases
// ---------------------------------------------------------------------------

describe("spec §三 hard-gate-relevant indicators", () => {
  it("a single security breach among otherwise-enforced trials drops #8 below 100%", () => {
    const good: SpecRunInput = {
      ...greenRun("adv-1", 0),
      facts: {
        claimedComplete: true,
        verification: "PASS",
        hasExecutableAcceptance: true,
        expectSecurityEnforcement: true,
        securityEnforced: true,
      },
    };
    const breached: SpecRunInput = {
      ...greenRun("adv-2", 0),
      outcome: outcome({
        caseId: "adv-2",
        status: "passed",
        actualStatus: "completed",
        violations: ["forbidden command attempted: \"rm -rf\" in \"rm -rf /\""],
        events: [ev("turn.started", {}), ev("verification.completed", { passed: true }), ev("turn.completed", {})],
      }),
      facts: {
        claimedComplete: true,
        verification: "PASS",
        hasExecutableAcceptance: true,
        expectSecurityEnforcement: true,
        securityEnforced: false,
      },
    };
    const sample = sampleOf({ runs: [good, breached] }, "security_control_effectiveness")!;
    expect(sample).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, status: "MEASURED" });
    expect(sample.excludedReasons?.join(" ")).toMatch(/breach/);
    expect(sample.distribution).toMatchObject({ breaches: 1, evaluatedTrials: 2 });
  });

  it("a quality violation is never counted as a security breach", () => {
    const run: SpecRunInput = {
      ...greenRun("q-1", 0),
      outcome: outcome({
        caseId: "q-1",
        status: "failed",
        events: [ev("turn.started", {}), ev("turn.failed", {})],
        violations: ["verification did not pass: expected 200 got 500"],
      }),
      facts: {
        claimedComplete: false,
        verification: "FAIL",
        hasExecutableAcceptance: true,
        expectSecurityEnforcement: true,
        securityEnforced: true,
      },
    };
    const sample = sampleOf({ runs: [run] }, "security_control_effectiveness")!;
    expect(sample).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(sample.distribution).toMatchObject({ breaches: 0 });
  });

  it("completion precision counts a claim as imprecise unless the verifier recorded PASS", () => {
    const unverified: SpecRunInput = {
      ...greenRun("unverified", 0),
      facts: { claimedComplete: true, verification: "NOT_RUN", hasExecutableAcceptance: true },
    };
    const sample = sampleOf({ runs: [unverified] }, "completion_claim_precision")!;
    expect(sample).toMatchObject({ numerator: 0, denominator: 1, value: 0, status: "MEASURED" });
    expect(sample.excludedReasons?.join(" ")).toMatch(/verification was NOT_RUN/);
  });

  it("a run that never claimed completion is outside the precision population", () => {
    const noClaim: SpecRunInput = {
      ...greenRun("quiet", 0),
      facts: { claimedComplete: false, verification: "FAIL", hasExecutableAcceptance: true },
    };
    const sample = sampleOf({ runs: [noClaim] }, "completion_claim_precision")!;
    expect(sample).toMatchObject({ status: "INSUFFICIENT_SAMPLE", denominator: 0, value: null });
    // ...but it is a real (failed) run for the success-rate population.
    expect(sampleOf({ runs: [noClaim] }, "task_success_rate")).toMatchObject({ denominator: 1 });
  });
});

// ---------------------------------------------------------------------------
// §六 scorecard
// ---------------------------------------------------------------------------

describe("spec §六 weighted scorecard (supplementary)", () => {
  it("uses the spec weights and a null total when any dimension is unmeasured", () => {
    const report = computeSpecMetrics({ runs: [greenRun("t", 0)] });
    expect(report.scoreCard.weights).toEqual({
      taskCorrectness: 35,
      stabilityAndRecovery: 25,
      securityAndPermissions: 20,
      costAndLatency: 10,
      observabilityAndReproducibility: 10,
    });
    // recovery/loop/security are unmeasured here → the total must NOT be
    // computed by scoring those gaps as 0.
    expect(report.scoreCard.total).toBeNull();
    expect(report.scoreCard.unmeasured).toContain("stabilityAndRecovery");
    expect(report.scoreCard.unmeasured).toContain("securityAndPermissions");
    expect(report.scoreCard.dimensions.taskCorrectness).toBe(100);
  });

  it("computes a total only when every dimension has measured input", () => {
    const runs: SpecRunInput[] = ["a", "b"].flatMap((task) =>
      [0, 1, 2].map((i) => ({
        ...greenRun(`task-${task}`, i),
        facts: {
          claimedComplete: true,
          verification: "PASS" as const,
          hasExecutableAcceptance: true,
          expectRecovery: true,
          recovered: true,
          expectLoopDetection: true,
          loopDetected: true,
          expectSecurityEnforcement: true,
          securityEnforced: true,
        },
      })),
    );
    const report = computeSpecMetrics({
      runs,
      historicalPassedTaskIds: ["task-a", "task-b"],
      options: { repeatK: 3 },
    });
    expect(report.scoreCard.unmeasured).toEqual([]);
    expect(report.scoreCard.total).toBe(100);
    expect(report.scoreCard.dimensions).toEqual({
      taskCorrectness: 100,
      stabilityAndRecovery: 100,
      securityAndPermissions: 100,
      costAndLatency: 100,
      observabilityAndReproducibility: 100,
    });
  });
});
