// P38.4-6 — Benchmark artifact validation + sanitization tests.
//
// Acceptance (from plan §11):
// - a test intentionally corrupting one count must fail validation
// - a test removing one case must fail completeness
// - a test duplicating one case must fail completeness
// - a test inserting a secret-shaped key must fail sanitization validation
// - a valid fixture must produce stable deterministic summary JSON

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSecrets,
  deriveBenchmarkSummary,
  scanForSecrets,
  validateBenchmarkArtifacts,
} from "./artifact-validate.js";
import type { BaselineReport, BenchmarkCaseResult } from "./baseline.js";

const CASE = (id: string, over: Partial<BenchmarkCaseResult> = {}): BenchmarkCaseResult => ({
  task_id: id,
  suite: "regression",
  judge_version: "1.0.0",
  success: true,
  actual_status: "completed",
  failure_category: undefined,
  duration_ms: 100,
  model_calls: 1,
  input_tokens: 100,
  output_tokens: 50,
  tool_calls: 1,
  tool_failures: 0,
  retries: 0,
  retry_taxonomy: {
    model: 0,
    tool: 0,
    verification: 0,
    compaction: 0,
    provider: 0,
    sandbox: 0,
    stallRecovery: 0,
    reconciliation: 0,
    mcpReconnect: 0,
  },
  recovery: { recoverable: 0, recovered: 0, rate: 0 },
  compactions: 0,
  verification_passed: true,
  verification_failures: 0,
  human_interventions: 0,
  termination_reason: "verified_complete",
  context_overflow: 0,
  false_complete: false,
  violations: [],
  ...over,
});

function makeReport(runs: BenchmarkCaseResult[]): BaselineReport {
  const passed = runs.filter((r) => r.success).length;
  const errors = runs.filter((r) => r.actual_status === "error").length;
  const failed = runs.length - passed - errors;
  return {
    meta: {
      generatedAt: "2026-08-26T00:00:00.000Z",
      benchmarkVersion: "2.0.0",
      model: { providerId: "openai", modelId: "deepseek-v4-flash" },
      casesTotal: runs.length,
      suite: "regression",
    },
    results: runs,
    summary: {
      total: runs.length,
      passed,
      failed,
      errors,
      success_rate: passed / runs.length,
      latency_p50_ms: 100,
      latency_p95_ms: 200,
      avg_model_calls: 1,
      model_calls_p50: 1,
      model_calls_p95: 1,
      avg_tool_calls: 1,
      avg_tokens_input: 100,
      avg_tokens_output: 50,
      avg_retries: 0,
      retry_rate: 0,
      retries_by_kind: {
        model: 0,
        tool: 0,
        verification: 0,
        compaction: 0,
        provider: 0,
        sandbox: 0,
        stallRecovery: 0,
        reconciliation: 0,
        mcpReconnect: 0,
      },
      recovery_rate: 0,
      termination_reason_distribution: { verified_complete: runs.length },
      total_context_overflows: 0,
      total_false_completes: 0,
      total_verification_failures: 0,
      total_human_interventions: 0,
      failures_by_category: {},
      avg_cost_score: 0,
      avg_cost_dimensions: {},
      security_violations: 0,
    },
  };
}

async function writeFixture(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "p3846-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(content, null, 2), "utf8");
  }
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("P38.4-6 artifact validation", () => {
  it("valid fixture passes validation", async () => {
    const runs = [CASE("reg-01"), CASE("reg-02")];
    const report = makeReport(runs);
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1, perSuiteCaseIds: { regression: ["reg-01", "reg-02"] } },
      "regression-summary.json": report,
      "regression-runs.sanitized.json": { meta: { suite: "regression" }, results: runs },
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.summary).toMatchObject({ suites: 1, cases: 2, passed: 2, failed: 0 });
    } finally {
      await cleanup(dir);
    }
  });

  it("corrupted count fails validation", async () => {
    const runs = [CASE("reg-01"), CASE("reg-02")];
    const report = makeReport(runs);
    report.summary.total = 3; // corrupted: 2 cases but claims 3
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1 },
      "regression-summary.json": report,
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("cases");
    } finally {
      await cleanup(dir);
    }
  });

  it("removing one case fails completeness", async () => {
    const runs = [CASE("reg-01")]; // expected reg-01 + reg-02
    const report = makeReport(runs);
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1, perSuiteCaseIds: { regression: ["reg-01", "reg-02"] } },
      "regression-summary.json": report,
      "regression-runs.sanitized.json": { results: runs },
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("missing expected case");
    } finally {
      await cleanup(dir);
    }
  });

  it("duplicating one case fails completeness", async () => {
    const runs = [CASE("reg-01"), CASE("reg-01"), CASE("reg-02")];
    const report = makeReport(runs);
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1 },
      "regression-summary.json": report,
      "regression-runs.sanitized.json": { results: runs },
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("duplicate case_id");
    } finally {
      await cleanup(dir);
    }
  });

  it("secret-shaped key fails sanitization validation", async () => {
    const runs = [CASE("reg-01", { violations: ["api_key=sk-abcdef1234567890"] })];
    const report = makeReport(runs);
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1 },
      "regression-summary.json": report,
      "regression-runs.sanitized.json": { results: runs },
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("secrets found");
    } finally {
      await cleanup(dir);
    }
  });

  it("secret scan catches bearer and sk- patterns", () => {
    expect(scanForSecrets("Authorization: Bearer abcdefghijklmnopqrst")).not.toEqual([]);
    expect(scanForSecrets("sk-abcdefghijklmnopqrstuvwxyz123456")).not.toEqual([]);
    expect(scanForSecrets("clean normal text no secrets here")).toEqual([]);
    expect(checkSecrets({ a: "password=hunter2" }).ok).toBe(false);
  });

  it("suite name mismatch fails validation", async () => {
    const report = makeReport([CASE("reg-01")]);
    report.meta.suite = "holdout"; // file says regression-summary.json
    const dir = await writeFixture({
      "manifest.json": { schemaVersion: 1 },
      "regression-summary.json": report,
    });
    try {
      const result = await validateBenchmarkArtifacts(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("does not match");
    } finally {
      await cleanup(dir);
    }
  });

  it("deriveBenchmarkSummary is deterministic and truthful", () => {
    const runs = [
      CASE("reg-01"),
      CASE("reg-02", { success: false, actual_status: "failed", failure_category: "model", termination_reason: "model_error" }),
      CASE("reg-03", { success: false, actual_status: "failed", failure_category: "harness", termination_reason: "tool_error" }),
    ];
    const s1 = deriveBenchmarkSummary(runs, "regression");
    const s2 = deriveBenchmarkSummary(runs, "regression");
    expect(s1).toEqual(s2); // deterministic
    expect(s1.total).toBe(3);
    expect(s1.passed).toBe(1);
    expect(s1.failed).toBe(2);
    expect(s1.errors).toBe(0);
    expect(s1.failureCategories).toEqual({ model: 1, harness: 1 });
    expect(s1.caseIds).toEqual(["reg-01", "reg-02", "reg-03"]);
    expect(s1.tokensInput).toBe(300);
    expect(s1.tokensOutput).toBe(150);
    expect(s1.toolCalls).toBe(3);
  });
});