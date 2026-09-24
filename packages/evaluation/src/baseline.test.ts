import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, SessionId } from "@ar/contracts";
import { newEventId, newSessionId } from "@ar/contracts";
import type { EvalOutcome } from "./runner.js";
import {
  classifyFailure,
  collectRunMetrics,
  compareBaselines,
  countRecoveryReExecutions,
  deriveRecovery,
  deriveRetryTaxonomy,
  loadBenchmarkCases,
  loadBenchmarkCase,
  runBaseline,
  summarizeResults,
  terminationReason,
  writeBaselineFiles,
  EMPTY_RETRY_TAXONOMY,
} from "./baseline.js";
import type { BenchmarkCase } from "./baseline.js";

// ---- helpers ----------------------------------------------------------------

const SESSION: SessionId = newSessionId();

function mk(
  type: AgentEvent["type"],
  payload: Record<string, unknown> = {},
  timestamp = 1,
): AgentEvent {
  return {
    id: newEventId(),
    sessionId: SESSION,
    sequence: 0,
    timestamp,
    type,
    payload,
  };
}

function outcome(overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    caseId: "case-01",
    status: "passed",
    actualStatus: "completed",
    events: [],
    metrics: {
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
    },
    violations: [],
    suite: "regression",
    judgeVersion: "1.0.0",
    ...overrides,
  };
}

function caseDef(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: "case-01",
    task: "do the thing",
    requestMd: "do the thing",
    expectedMd: "the thing is done",
    fixture: {},
    expected: { status: "completed" },
    ...overrides,
  };
}

let tempDirs: string[] = [];
async function makeCaseDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-baseline-test-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    if (rel.includes("/")) {
      await import("node:fs/promises").then((m) => m.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true }));
    }
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

// ---- tests -----------------------------------------------------------------

describe("loadBenchmarkCases", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("loads a case directory with request.md, expected.md and fixture files", async () => {
    const root = await makeCaseDir({
      "simple/request.md": "fix the typo in app.js",
      "simple/expected.md": "app.js contains no typo",
      "simple/fixture/app.js": "const mesage = 1;",
      "simple/fixture/sub/util.js": "export const x = 1;",
    });
    const cases = await loadBenchmarkCases(root);

    expect(cases).toHaveLength(1);
    expect(cases[0]!.id).toBe("simple");
    expect(cases[0]!.task).toBe("fix the typo in app.js");
    expect(cases[0]!.requestMd).toBe("fix the typo in app.js");
    expect(cases[0]!.expectedMd).toBe("app.js contains no typo");
    expect(cases[0]!.fixture).toEqual({
      "app.js": "const mesage = 1;",
      "sub/util.js": "export const x = 1;",
    });
  });

  it("orders cases by directory name", async () => {
    const root = await makeCaseDir({
      "b/request.md": "b",
      "b/expected.md": "b",
      "a/request.md": "a",
      "a/expected.md": "a",
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("throws when request.md is missing", async () => {
    const root = await makeCaseDir({ "broken/expected.md": "x" });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("missing request.md");
  });

  it("throws when expected.md is missing", async () => {
    const root = await makeCaseDir({ "broken/request.md": "x" });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("missing expected.md");
  });

  it("parses case.json (expected/forbidden/verification/timeout/budget)", async () => {
    const root = await makeCaseDir({
      "hard/request.md": "do not exfiltrate",
      "hard/expected.md": "no exfil",
      "hard/case.json": JSON.stringify({
        expected: { status: "denied" },
        forbidden: { commands: ["exfil"], reads: ["secret.txt"] },
        verification: [{ kind: "artifact", path: "out.txt" }],
        timeoutMs: 5000,
        contextBudgetTokens: 2000,
      }),
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.expected).toEqual({ status: "denied" });
    expect(cases[0]!.forbidden).toEqual({ commands: ["exfil"], reads: ["secret.txt"] });
    expect(cases[0]!.verification).toEqual([{ kind: "artifact", path: "out.txt" }]);
    expect(cases[0]!.timeoutMs).toBe(5000);
    expect(cases[0]!.contextBudgetTokens).toBe(2000);
  });

  it("parses Phase 6.5 case.json fields (suite/tags/termination/security/retries/duration/artifacts/judge)", async () => {
    const root = await makeCaseDir({
      "hard/request.md": "task",
      "hard/expected.md": "done",
      "hard/case.json": JSON.stringify({
        suite: "adversarial",
        tags: ["injection", "network"],
        expectedTerminationReason: "tool_limit",
        expectedSecurityEvents: ["security.network_denied", "security.fs_denied"],
        maxRetries: 4,
        maxDurationMs: 120000,
        allowArtifacts: false,
        forbidden: { network: true },
        judgeVersion: "2.0.0",
      }),
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.suite).toBe("adversarial");
    expect(cases[0]!.tags).toEqual(["injection", "network"]);
    expect(cases[0]!.expectedTerminationReason).toBe("tool_limit");
    expect(cases[0]!.expectedSecurityEvents).toEqual(["security.network_denied", "security.fs_denied"]);
    expect(cases[0]!.maxRetries).toBe(4);
    expect(cases[0]!.maxDurationMs).toBe(120000);
    expect(cases[0]!.allowArtifacts).toBe(false);
    expect(cases[0]!.forbidden?.network).toBe(true);
    expect(cases[0]!.judgeVersion).toBe("2.0.0");
  });

  it("parses P4-12/P4-3 fields (expectedEvents.atLeast + requires)", async () => {
    const root = await makeCaseDir({
      "m/request.md": "task",
      "m/expected.md": "done",
      "m/case.json": JSON.stringify({
        expectedEvents: { atLeast: { "memory.retrieved": 1, "subagent.started": 2 } },
        requires: ["memory", "subagent"],
      }),
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.expectedEvents).toEqual({ atLeast: { "memory.retrieved": 1, "subagent.started": 2 } });
    expect(cases[0]!.requires).toEqual(["memory", "subagent"]);
  });

  it("rejects malformed expectedEvents / requires (P4-3/P4-12)", async () => {
    const root = await makeCaseDir({
      "bad1/request.md": "t", "bad1/expected.md": "d",
      "bad1/case.json": JSON.stringify({ expectedEvents: { atLeast: { "memory.retrieved": -1 } } }),
      "bad2/request.md": "t", "bad2/expected.md": "d",
      "bad2/case.json": JSON.stringify({ requires: 42 }),
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow();
  });

  it("defaults suite to regression and judgeVersion to 1.0.0", async () => {
    const root = await makeCaseDir({ "plain/request.md": "x", "plain/expected.md": "x" });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.suite).toBe("regression");
    expect(cases[0]!.judgeVersion).toBe("1.0.0");
    expect(cases[0]!.allowArtifacts).toBeUndefined();
  });

  it("rejects an invalid suite", async () => {
    const root = await makeCaseDir({
      "bad/request.md": "x",
      "bad/expected.md": "x",
      "bad/case.json": JSON.stringify({ suite: "nightly" }),
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("suite must be one of");
  });

  it("rejects a negative maxRetries", async () => {
    const root = await makeCaseDir({
      "bad/request.md": "x",
      "bad/expected.md": "x",
      "bad/case.json": JSON.stringify({ maxRetries: -1 }),
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("maxRetries must be a non-negative integer");
  });

  it("rejects a non-string judgeVersion", async () => {
    const root = await makeCaseDir({
      "bad/request.md": "x",
      "bad/expected.md": "x",
      "bad/case.json": JSON.stringify({ judgeVersion: 2 }),
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("judgeVersion must be a string");
  });

  it("lets case.json task override request.md", async () => {
    const root = await makeCaseDir({
      "c/request.md": "human prompt",
      "c/expected.md": "x",
      "c/case.json": JSON.stringify({ task: "machine prompt" }),
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.task).toBe("machine prompt");
  });

  it("rejects an invalid expected status", async () => {
    const root = await makeCaseDir({
      "bad/request.md": "x",
      "bad/expected.md": "x",
      "bad/case.json": JSON.stringify({ expected: { status: "maybe" } }),
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("expected.status must be one of");
  });

  it("rejects malformed case.json", async () => {
    const root = await makeCaseDir({
      "bad/request.md": "x",
      "bad/expected.md": "x",
      "bad/case.json": "{not json",
    });
    await expect(loadBenchmarkCases(root)).rejects.toThrow("not valid JSON");
  });

  it("handles a case without fixture and without case.json", async () => {
    const root = await makeCaseDir({ "bare/request.md": "x", "bare/expected.md": "x" });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.fixture).toEqual({});
    expect(cases[0]!.expected).toEqual({ status: "completed" });
  });
});

describe("collectRunMetrics", () => {
  it("maps the event trail into the plan's unified result structure", () => {
    const events: AgentEvent[] = [
      mk("turn.started", { turnId: "t1" }, 0),
      mk("model.started", {}, 10),
      mk("model.completed", { finishReason: "tool_calls" }, 20),
      mk("tool.requested", { toolCallId: "c1", name: "exec", args: { command: "node test.js" } }, 30),
      mk("tool.started", { toolCallId: "c1", tool: "exec" }, 40),
      mk("tool.failed", { toolCallId: "c1", error: { code: "PROCESS_ERROR" } }, 50),
      mk("tool.started", { toolCallId: "c1", tool: "exec" }, 60),
      mk("tool.completed", { toolCallId: "c1", tool: "exec", status: "success" }, 70),
      mk("model.completed", { finishReason: "stop" }, 80),
      mk("verification.completed", { passed: true }, 90),
      mk("context.compacted", { compressed: 1 }, 95),
      mk("turn.completed", { turnId: "t1" }, 100),
    ];
    const o = outcome({
      events,
      metrics: {
        turn_count: 1,
        tool_call_count: 1,
        tokens_input: 1200,
        tokens_output: 300,
        context_tokens: 1500,
        compaction_count: 1,
        duration_ms: 100,
        retry_count: 1,
        verification_failures: 0,
        human_interventions: 0,
        estimated_cost: 0.01,

        usage_unknown: 0,

        cache_tokens_read: 0,

        cache_tokens_created: 0,

        model_call_count: 0,
      },
    });

    const result = collectRunMetrics(o);
    expect(result).toMatchObject({
      task_id: "case-01",
      suite: "regression",
      judge_version: "1.0.0",
      success: true,
      actual_status: "completed",
      duration_ms: 100,
      model_calls: 2,
      input_tokens: 1200,
      output_tokens: 300,
      tool_calls: 1,
      tool_failures: 1,
      retries: 1,
      retry_taxonomy: {
        model: 0,
        tool: 1,
        verification: 0,
        compaction: 1,
        provider: 0,
        sandbox: 0,
        stallRecovery: 0,
      },
      recovery: { recoverable: 1, recovered: 1, rate: 1 },
      compactions: 1,
      verification_passed: true,
      verification_failures: 0,
      human_interventions: 0,
      termination_reason: "verified_complete",
      context_overflow: 0,
      false_complete: false,
    });
    expect(result.violations).toEqual([]);
  });

  it("counts context overflow from run.limit_reached maxTokens", () => {
    const events = [
      mk("run.limit_reached", { limit: "maxTokens", used: 9999 }, 1),
      mk("run.limit_reached", { limit: "maxIterationsPerTurn", used: 20 }, 2),
    ];
    const result = collectRunMetrics(outcome({ actualStatus: "failed", events }));
    expect(result.context_overflow).toBe(1);
    expect(result.termination_reason).toBe("agent_limit");
  });

  it("detects false completion: model stopped but judge says not done", () => {
    const result = collectRunMetrics(
      outcome({
        status: "failed",
        actualStatus: "completed",
        violations: ["expected completed but turn failed"],
        events: [mk("turn.completed", {}, 1)],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.false_complete).toBe(true);
    expect(result.termination_reason).toBe("model_stopped");
  });

  it("is not a false completion when the verification gate caught it", () => {
    const events = [
      mk("verification.failed", { error: "tests fail" }, 1),
      mk("turn.failed", {}, 2),
    ];
    const result = collectRunMetrics(
      outcome({ status: "failed", actualStatus: "failed", events }),
    );
    expect(result.false_complete).toBe(false);
    expect(result.termination_reason).toBe("verification_failed");
    expect(result.verification_failures).toBe(1);
  });
});

describe("countRecoveryReExecutions", () => {
  it("counts re-executions per toolCallId (N started events → N-1 retries)", () => {
    const events = [
      mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      mk("tool.started", { toolCallId: "c2", tool: "read_file" }),
    ];
    expect(countRecoveryReExecutions(events)).toBe(2);
  });

  it("counts zero when every call executed exactly once", () => {
    const events = [
      mk("tool.started", { toolCallId: "c1" }),
      mk("tool.started", { toolCallId: "c2" }),
    ];
    expect(countRecoveryReExecutions(events)).toBe(0);
  });
});

describe("deriveRetryTaxonomy", () => {
  it("classifies re-executions by the preceding failure (sandbox vs tool)", () => {
    const events = [
      mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      mk("tool.failed", { toolCallId: "c1", error: { code: "PROCESS_ERROR" } }),
      mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      mk("tool.completed", { toolCallId: "c1", status: "success" }),
      mk("tool.started", { toolCallId: "c2", tool: "read_file" }),
      mk("tool.failed", { toolCallId: "c2", error: { code: "SANDBOX_FILESYSTEM_DENIED" } }),
      mk("tool.started", { toolCallId: "c2", tool: "read_file" }),
      mk("tool.completed", { toolCallId: "c2", status: "success" }),
    ];
    const taxonomy = deriveRetryTaxonomy(events);
    expect(taxonomy.tool).toBe(1);
    expect(taxonomy.sandbox).toBe(1);
    expect(taxonomy.model).toBe(0);
  });

  it("counts model/verification/compaction retries from their events", () => {
    const events = [
      mk("model.retry", { attempt: 1 }),
      mk("model.retry", { attempt: 2 }),
      mk("verification.failed", { attempt: 1 }),
      mk("context.compacted", { reactive: false }),
      mk("context.compacted", { reactive: true }),
    ];
    const taxonomy = deriveRetryTaxonomy(events);
    expect(taxonomy.model).toBe(2);
    expect(taxonomy.verification).toBe(1);
    expect(taxonomy.compaction).toBe(2);
  });

  it("provider and stallRecovery retries are counted from their events (Phase 11)", () => {
    const events = [
      mk("retry.provider", { attempt: 1 }),
      mk("retry.provider", { attempt: 2 }),
      mk("retry.stallRecovery", { streak: 3 }),
      mk("tool.started", { toolCallId: "c1" }),
    ];
    const taxonomy = deriveRetryTaxonomy(events);
    expect(taxonomy.provider).toBe(2);
    expect(taxonomy.stallRecovery).toBe(1);
  });

  it("P2-40: reconciliation and mcpReconnect are counted from their events", () => {
    const events = [
      mk("retry.reconciliation", { tool: "exec", toolCallId: "c1" }),
      mk("retry.reconciliation", { tool: "write_file", toolCallId: "c2" }),
      mk("retry.mcpReconnect", { target: "git" }),
      mk("retry.mcpReconnect", { target: "slack" }),
      mk("retry.mcpReconnect", { target: "git" }),
    ];
    const taxonomy = deriveRetryTaxonomy(events);
    expect(taxonomy.reconciliation).toBe(2);
    expect(taxonomy.mcpReconnect).toBe(3);
  });

  it("empty trail yields the empty taxonomy", () => {
    expect(deriveRetryTaxonomy([])).toEqual(EMPTY_RETRY_TAXONOMY);
  });
});

describe("deriveRecovery", () => {
  it("counts tool failures that finally succeeded as recovered", () => {
    const events = [
      mk("tool.started", { toolCallId: "c1" }),
      mk("tool.failed", { toolCallId: "c1" }),
      mk("tool.started", { toolCallId: "c1" }),
      mk("tool.completed", { toolCallId: "c1", status: "success" }),
    ];
    const recovery = deriveRecovery(events);
    expect(recovery.recoverable).toBe(1);
    expect(recovery.recovered).toBe(1);
    expect(recovery.rate).toBe(1);
  });

  it("counts model retries as recovered failures", () => {
    const events = [mk("model.retry", {}), mk("model.completed", { finishReason: "stop" })];
    const recovery = deriveRecovery(events);
    expect(recovery.recoverable).toBe(1);
    expect(recovery.recovered).toBe(1);
  });

  it("verification failures recovered when a gate finally passes", () => {
    const events = [
      mk("verification.failed", { attempt: 1 }),
      mk("verification.failed", { attempt: 2 }),
      mk("verification.completed", { passed: true }),
    ];
    const recovery = deriveRecovery(events);
    expect(recovery.recoverable).toBe(2);
    expect(recovery.recovered).toBe(2);
    expect(recovery.rate).toBe(1);
  });

  it("the verification failure that exhausted the budget is not recovered", () => {
    const events = [
      mk("verification.failed", { attempt: 1 }),
      mk("verification.failed", { attempt: 2 }),
      mk("verification.failed", { attempt: 3 }),
      mk("turn.failed", {}),
    ];
    const recovery = deriveRecovery(events);
    expect(recovery.recoverable).toBe(3);
    expect(recovery.recovered).toBe(2);
  });

  it("zero recoverable failures → rate 0", () => {
    expect(deriveRecovery([mk("turn.completed", {})])).toEqual({ recoverable: 0, recovered: 0, rate: 0 });
  });
});

describe("terminationReason", () => {
  it("verified_complete when verification passed", () => {
    const o = outcome({
      events: [mk("verification.completed", { passed: true }), mk("turn.completed", {})],
    });
    expect(terminationReason(o)).toBe("verified_complete");
  });

  it("model_stopped when completed without verification", () => {
    expect(terminationReason(outcome({ events: [mk("turn.completed", {})] }))).toBe("model_stopped");
  });

  it("tool_limit when a run limit was reached", () => {
    const o = outcome({
      actualStatus: "failed",
      events: [mk("run.limit_reached", { limit: "maxToolCalls" }), mk("turn.failed", {})],
    });
    expect(terminationReason(o)).toBe("tool_limit");
  });

  it("model_error when the model failed", () => {
    const o = outcome({
      actualStatus: "failed",
      events: [mk("model.failed", {}), mk("turn.failed", {})],
    });
    expect(terminationReason(o)).toBe("model_error");
  });

  it("cancelled", () => {
    expect(terminationReason(outcome({ actualStatus: "cancelled" }))).toBe("cancelled");
  });

  it("runtime_error for error outcomes", () => {
    expect(terminationReason(outcome({ status: "error", actualStatus: "error" }))).toBe("runtime_error");
  });
});

describe("runBaseline + summarizeResults", () => {
  it("runs every case and preserves input order", async () => {
    const cases = [
      caseDef({ id: "a" }),
      caseDef({ id: "b" }),
      caseDef({ id: "c" }),
    ];
    const ran: string[] = [];
    const report = await runBaseline(
      cases,
      async (c) => {
        ran.push(c.id);
        return outcome({ caseId: c.id, metrics: { ...outcome().metrics, duration_ms: 10 } });
      },
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 3, suite: "regression" },
    );

    expect(ran).toEqual(["a", "b", "c"]);
    expect(report.results.map((r) => r.task_id)).toEqual(["a", "b", "c"]);
    expect(report.summary.total).toBe(3);
    expect(report.summary.passed).toBe(3);
    expect(report.summary.success_rate).toBe(1);
  });

  it("turns a throwing runCase into an error result (no crash, no fabrication)", async () => {
    const report = await runBaseline(
      [caseDef({ id: "boom" })],
      async () => {
        throw new Error("harness exploded");
      },
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 1, suite: "regression" },
    );

    expect(report.results[0]).toMatchObject({
      task_id: "boom",
      success: false,
      actual_status: "error",
      termination_reason: "runtime_error",
    });
    expect(report.results[0]!.reason).toBe("harness exploded");
    expect(report.summary.errors).toBe(1);
    expect(report.summary.success_rate).toBe(0);
  });

  it("computes p50/p95 latency and averages", () => {
    const summary = summarizeResults(
      [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((duration_ms, i) =>
        collectRunMetrics(
          outcome({
            caseId: `c${i}`,
            status: i % 2 === 0 ? "passed" : "failed",
            metrics: { ...outcome().metrics, duration_ms },
          }),
        ),
      ),
    );

    expect(summary.total).toBe(10);
    expect(summary.passed).toBe(5);
    expect(summary.success_rate).toBe(0.5);
    expect(summary.latency_p50_ms).toBe(500);
    expect(summary.latency_p95_ms).toBe(1000);
    expect(summary.avg_model_calls).toBe(0);
    expect(summary.avg_tool_calls).toBe(0);
  });

  it("aggregates retry/overflow/false-complete/verification counters", () => {
    const results = [
      collectRunMetrics(outcome({
        status: "failed",
        actualStatus: "completed",
        events: [mk("tool.started", { toolCallId: "c" }), mk("tool.started", { toolCallId: "c" }), mk("turn.completed", {})],
      })),
      collectRunMetrics(outcome({
        status: "failed",
        actualStatus: "failed",
        events: [mk("run.limit_reached", { limit: "maxTokens" }), mk("verification.failed", {}), mk("turn.failed", {})],
      })),
      collectRunMetrics(outcome({
        events: [mk("verification.completed", { passed: true }), mk("turn.completed", {})],
      })),
    ];
    const summary = summarizeResults(results);
    expect(summary.retry_rate).toBeCloseTo(1 / 3, 5);
    expect(summary.avg_retries).toBeCloseTo(1 / 3, 5);
    expect(summary.total_context_overflows).toBe(1);
    expect(summary.total_false_completes).toBe(1);
    expect(summary.total_verification_failures).toBe(1);
    expect(summary.total_human_interventions).toBe(0);
  });
});

describe("writeBaselineFiles", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writes baseline.json and baseline-summary.md", async () => {
    const outDir = await makeCaseDir({});
    const report = await runBaseline(
      [caseDef({ id: "single" })],
      async () => outcome({ caseId: "single" }),
      { generatedAt: "2026-01-01T00:00:00.000Z", benchmarkVersion: "1.0.0", model: { providerId: "openai", modelId: "gpt-4o-mini" }, casesTotal: 1, suite: "regression" },
    );
    await writeBaselineFiles(report, outDir);

    const jsonPath = join(outDir, "baseline.json");
    const mdPath = join(outDir, "baseline-summary.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(parsed.meta.casesTotal).toBe(1);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.summary.success_rate).toBe(1);

    const md = await readFile(mdPath, "utf8");
    expect(md).toContain("# Benchmark regression");
    expect(md).toContain("| success rate | 100.0% (1/1) |");
    expect(md).toContain("| single | regression | ✅ |");
  });

  it("writes <suite>.json + <suite>-summary.md for non-regression suites", async () => {
    const outDir = await makeCaseDir({});
    const report = await runBaseline(
      [caseDef({ id: "adv-1", suite: "adversarial", judgeVersion: "2.0.0" })],
      async () => outcome({ caseId: "adv-1", suite: "adversarial", judgeVersion: "2.0.0" }),
      { generatedAt: "now", benchmarkVersion: "2.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 1, suite: "adversarial" },
    );
    await writeBaselineFiles(report, outDir);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(outDir, "adversarial.json"))).toBe(true);
    expect(existsSync(join(outDir, "adversarial-summary.md"))).toBe(true);
    expect(existsSync(join(outDir, "baseline.json"))).toBe(false);

    const parsed = JSON.parse(await readFile(join(outDir, "adversarial.json"), "utf8"));
    expect(parsed.meta.suite).toBe("adversarial");
    expect(parsed.results[0]).toMatchObject({ task_id: "adv-1", suite: "adversarial", judge_version: "2.0.0" });
  });
});

describe("loadBenchmarkCase edge cases", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("empty case dir → empty case list", async () => {
    const root = await makeCaseDir({});
    expect(await loadBenchmarkCases(root)).toEqual([]);
  });

  it("skips dot-directories (e.g. .git, .keep)", async () => {
    const root = await makeCaseDir({
      ".git/HEAD": "ref: refs/heads/master",
      ".keep": "",
      "real/request.md": "x",
      "real/expected.md": "x",
    });
    const cases = await loadBenchmarkCases(root);
    expect(cases.map((c) => c.id)).toEqual(["real"]);
  });

  it("case id is the directory basename", async () => {
    const root = await makeCaseDir({ "multi_file_refactor_01/request.md": "x", "multi_file_refactor_01/expected.md": "x" });
    const cases = await loadBenchmarkCases(root);
    expect(cases[0]!.id).toBe("multi_file_refactor_01");
  });
});

describe("classifyFailure (P0-6)", () => {
  it("honors the runner's explicit category", () => {
    expect(classifyFailure(outcome({ status: "error", failureCategory: "judge" }))).toBe("judge");
    expect(classifyFailure(outcome({ status: "error", failureCategory: "harness" }))).toBe("harness");
  });

  it("derives model failures from the model_error termination reason", () => {
    expect(classifyFailure(outcome({ status: "failed", terminationReason: "model_error" }))).toBe("model");
  });

  it("classifies an unclassified error status as infrastructure", () => {
    expect(classifyFailure(outcome({ status: "error", actualStatus: "error" }))).toBe("infrastructure");
  });

  it("leaves a clean agent-side failure unclassified (no harness fault)", () => {
    expect(
      classifyFailure(outcome({ status: "failed", actualStatus: "failed", terminationReason: "verification_failed" })),
    ).toBeUndefined();
  });
});

describe("runBaseline P0-6 options", () => {
  it("randomizes execution order but keeps the report in fixed case order", async () => {
    const cases = ["a", "b", "c", "d", "e"].map((id) => caseDef({ id }));
    const ran: string[] = [];
    const report = await runBaseline(
      cases,
      async (c) => {
        ran.push(c.id);
        return outcome({ caseId: c.id });
      },
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 5, suite: "regression" },
      { shuffle: true, seed: 7 },
    );

    expect(ran).toHaveLength(5);
    expect(ran).not.toEqual(["a", "b", "c", "d", "e"]); // execution was reordered
    expect([...ran].sort()).toEqual(["a", "b", "c", "d", "e"]); // a permutation
    expect(report.results.map((r) => r.task_id)).toEqual(["a", "b", "c", "d", "e"]); // fixed report order
  });

  it("reproduces the same execution order for the same seed", async () => {
    const cases = ["a", "b", "c", "d", "e"].map((id) => caseDef({ id }));
    const run = async () => {
      const ran: string[] = [];
      await runBaseline(
        cases,
        async (c) => {
          ran.push(c.id);
          return outcome({ caseId: c.id });
        },
        { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 5, suite: "regression" },
        { shuffle: true, seed: 42 },
      );
      return ran;
    };
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
  });

  it("records the run manifest on the report", async () => {
    const report = await runBaseline(
      [caseDef({ id: "a" })],
      async (c) => outcome({ caseId: c.id }),
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 1, suite: "regression" },
      { manifest: { gitSha: "abc", dirty: false, model: "m", provider: "p", temperature: null, suiteVersion: "2.1.0", judgeVersion: "1.0.0", runtimeConfigHash: "hash", timestamp: "t", platform: process.platform, nodeVersion: process.version, profile: "benchmark", features: { context: true }, contextBudgetTokens: 32000, taskSuites: ["regression"], randomSeed: 42, candidate: null } },
    );
    expect(report.manifest).toMatchObject({ gitSha: "abc", runtimeConfigHash: "hash" });
  });

  it("marks a runner exception as an infrastructure failure (never an agent failure)", async () => {
    const report = await runBaseline(
      [caseDef({ id: "boom" })],
      async () => {
        throw new Error("workspace exploded");
      },
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 1, suite: "regression" },
    );

    expect(report.results[0]).toMatchObject({
      success: false,
      actual_status: "error",
      failure_category: "infrastructure",
      termination_reason: "runtime_error",
      false_complete: false,
    });
    expect(report.summary.failures_by_category).toEqual({ infrastructure: 1 });
  });

  it("propagates the outcome failure category and aggregates them in the summary", async () => {
    const report = await runBaseline(
      ["model-boom", "harness-throw", "clean-fail"].map((id) => caseDef({ id })),
      async (c) => {
        if (c.id === "model-boom") {
          return outcome({ caseId: c.id, status: "failed", actualStatus: "failed", terminationReason: "model_error" });
        }
        if (c.id === "harness-throw") {
          return outcome({ caseId: c.id, status: "error", actualStatus: "error", failureCategory: "harness", reason: "boom" });
        }
        return outcome({ caseId: c.id, status: "failed", actualStatus: "completed", violations: ["expected x"] });
      },
      { generatedAt: "now", benchmarkVersion: "1.0.0", model: { providerId: "p", modelId: "m" }, casesTotal: 3, suite: "regression" },
    );

    expect(report.results.find((r) => r.task_id === "model-boom")!.failure_category).toBe("model");
    expect(report.results.find((r) => r.task_id === "harness-throw")!.failure_category).toBe("harness");
    expect(report.results.find((r) => r.task_id === "clean-fail")!.failure_category).toBeUndefined();
    expect(report.summary.failures_by_category).toEqual({ model: 1, harness: 1 });
  });
});

describe("compareBaselines", () => {
  function report(results: Array<{ id: string; success: boolean; retries?: number }>) {
    const built = results.map((r) => {
      // retries are derived from re-executed tool calls (N started events per
      // call id → N-1 retries), so craft the event trail accordingly.
      const startedEvents = Array.from(
        { length: (r.retries ?? 0) + 1 },
        () => mk("tool.started", { toolCallId: "c1", tool: "exec" }),
      );
      const result = collectRunMetrics(
        outcome({
          caseId: r.id,
          status: r.success ? "passed" : "failed",
          actualStatus: r.success ? "completed" : "failed",
          metrics: { ...outcome().metrics, duration_ms: 1000, retry_count: r.retries ?? 0 },
          events: startedEvents,
        }),
      );
      return { id: r.id, result };
    });
    return {
      meta: { generatedAt: "now", benchmarkVersion: "1", model: { providerId: "p", modelId: "m" }, casesTotal: built.length, suite: "regression" },
      results: built.map((b) => b.result),
      summary: summarizeResults(built.map((b) => b.result)),
    } as import("./baseline.js").BaselineReport;
  }

  it("reports per-case newly/still passed/failed", () => {
    const before = report([
      { id: "a", success: false },
      { id: "b", success: true },
      { id: "c", success: true },
    ]);
    const after = report([
      { id: "a", success: true },
      { id: "b", success: false },
      { id: "c", success: true },
    ]);
    const comparison = compareBaselines(before, after);

    expect(comparison.cases["a"]!.outcome).toBe("newly_passed");
    expect(comparison.cases["b"]!.outcome).toBe("newly_failed");
    expect(comparison.cases["c"]!.outcome).toBe("still_passed");
    expect(comparison.summary.passed_delta).toBe(0); // a +1, b -1
    expect(comparison.summary.success_rate_delta).toBe(0);
  });

  it("surfaces judge_changed when the judge version differs (never masked)", () => {
    const before = report([{ id: "x", success: false }]);
    const after = report([{ id: "x", success: true }]);
    // Same case, different judge logic → the pass/fail delta is meaningless.
    after.results[0]!.judge_version = "2.0.0";
    const comparison = compareBaselines(before, after);

    expect(comparison.cases["x"]!.outcome).toBe("judge_changed");
    // The summary deltas still reflect raw numbers; classification is the
    // source of truth for "did the agent improve?".
    expect(comparison.summary.passed_delta).toBe(1);
  });

  it("surfaces infra_failure when the after run crashed", () => {
    const before = report([{ id: "x", success: true }]);
    const after = report([{ id: "x", success: true }]);
    after.results[0]!.actual_status = "error";
    after.results[0]!.termination_reason = "runtime_error";
    const comparison = compareBaselines(before, after);

    expect(comparison.cases["x"]!.outcome).toBe("infra_failure");
  });

  it("aggregates deltas for retries", () => {
    const before = report([{ id: "x", success: true, retries: 10 }]);
    const after = report([{ id: "x", success: true, retries: 2 }]);
    const comparison = compareBaselines(before, after);

    expect(comparison.summary.avg_retries_delta).toBeCloseTo(-8, 5);
    expect(comparison.summary.latency_p50_delta_ms).toBe(0);
  });

  it("treats a case only present in the after report as new", () => {
    const before = report([{ id: "a", success: true }]);
    const after = report([
      { id: "a", success: true },
      { id: "b", success: true },
    ]);
    const comparison = compareBaselines(before, after);
    expect(comparison.cases["b"]!.outcome).toBe("new");
  });
});
