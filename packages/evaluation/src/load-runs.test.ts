import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRunsFromArtifact,
  isReportObject,
  resultToOutcome,
  type LoadedRuns,
} from "./load-runs.js";
import { EMPTY_RETRY_TAXONOMY } from "./baseline.js";
import { validateBenchmarkArtifacts } from "./artifact-validate.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "e1-loadruns-"));
}

describe("loadRunsFromArtifact (E1-06)", () => {
  it("accepts a flat EvalOutcome[] array", async () => {
    const dir = tempDir();
    const p = join(dir, "runs.json");
    writeFileSync(p, JSON.stringify([{ caseId: "c1", status: "passed", actualStatus: "completed", events: [], metrics: {}, violations: [], suite: "holdout", judgeVersion: "1.0.0" }]));
    const loaded = await loadRunsFromArtifact(p);
    expect(loaded.shape).toBe("flat-evaloutcome");
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0]!.caseId).toBe("c1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a committed report object {results:[...]} (Repro 4 fix)", async () => {
    const dir = tempDir();
    const p = join(dir, "holdout.json");
    writeFileSync(
      p,
      JSON.stringify({
        meta: { suite: "holdout", model: "m" },
        results: [
          {
            task_id: "ho-01",
            suite: "holdout",
            judge_version: "1.0.0",
            success: true,
            actual_status: "completed",
            duration_ms: 10,
            model_calls: 1,
            input_tokens: 5,
            output_tokens: 5,
            tool_calls: 1,
            tool_failures: 0,
            retries: 0,
            retry_taxonomy: EMPTY_RETRY_TAXONOMY,
            recovery: { recoverable: 0, recovered: 0, rate: 0 },
            compactions: 0,
            verification_passed: true,
            verification_failures: 0,
            human_interventions: 0,
            termination_reason: "verified_complete",
            context_overflow: 0,
            false_complete: false,
            violations: [],
            evaluationContextHash: "ctx-hash",
            candidateConfigHash: "cfg-hash",
            controlledDifference: ["candidate:x"],
            activation_evidence: { schemaVersion: "1.0.0", candidateId: "x", caseId: "ho-01", eligible: true, activated: true, activationCount: 1, reasonCodes: [], baselineMechanismDigest: "b", candidateMechanismDigest: "c" },
          },
        ],
        summary: { total: 1, passed: 1, failed: 0 },
      }),
    );
    const loaded = await loadRunsFromArtifact(p);
    expect(loaded.shape).toBe("report-object");
    expect(loaded.meta).toEqual({ suite: "holdout", model: "m" });
    const outcome = loaded.runs[0]!;
    expect(outcome.caseId).toBe("ho-01");
    expect(outcome.status).toBe("passed");
    // Provenance must round-trip losslessly.
    expect(outcome.evaluationContextHash).toBe("ctx-hash");
    expect(outcome.candidateConfigHash).toBe("cfg-hash");
    expect(outcome.controlledDifference).toEqual(["candidate:x"]);
    expect(outcome.activationEvidence?.activated).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an artifact that is neither shape", async () => {
    const dir = tempDir();
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ hello: "world" }));
    await expect(loadRunsFromArtifact(p)).rejects.toThrow(/neither/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resultToOutcome never invents missing provenance", () => {
    const outcome = resultToOutcome({
      task_id: "t1",
      suite: "regression",
      judge_version: "1.0.0",
      success: false,
      actual_status: "failed",
      duration_ms: 1,
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      tool_calls: 0,
      tool_failures: 0,
      retries: 0,
      retry_taxonomy: EMPTY_RETRY_TAXONOMY,
      recovery: { recoverable: 0, recovered: 0, rate: 0 },
      compactions: 0,
      verification_passed: false,
      verification_failures: 0,
      human_interventions: 0,
      termination_reason: "failed",
      context_overflow: 0,
      false_complete: false,
      violations: [],
    });
    expect(outcome.evaluationContextHash).toBeUndefined();
    expect(outcome.candidateConfigHash).toBeUndefined();
    expect(outcome.activationEvidence).toBeUndefined();
  });
});

describe("validateBenchmarkArtifacts single-suite dir (E1-06, Repro 5)", () => {
  it("validates a single-suite challenger directory without manifest.json", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "holdout.json"),
      JSON.stringify({
        meta: { suite: "holdout" },
        results: [
          { task_id: "ho-1", suite: "holdout", judge_version: "1.0.0", success: true, actual_status: "completed", duration_ms: 1, model_calls: 1, input_tokens: 1, output_tokens: 1, tool_calls: 1, tool_failures: 0, retries: 0, retry_taxonomy: EMPTY_RETRY_TAXONOMY, recovery: { recoverable: 0, recovered: 0, rate: 0 }, compactions: 0, verification_passed: true, verification_failures: 0, human_interventions: 0, termination_reason: "verified_complete", context_overflow: 0, false_complete: false, violations: [] },
        ],
        summary: { total: 1, passed: 1, failed: 0 },
      }),
    );
    writeFileSync(
      join(dir, "holdout-summary.json"),
      JSON.stringify({ meta: { suite: "holdout" }, summary: { total: 1, passed: 1, failed: 0, errors: 0 } }),
    );
    writeFileSync(
      join(dir, "holdout-runs.sanitized.json"),
      JSON.stringify({
        results: [
          { task_id: "ho-1", suite: "holdout", judge_version: "1.0.0", success: true, actual_status: "completed", duration_ms: 1, model_calls: 1, input_tokens: 1, output_tokens: 1, tool_calls: 1, tool_failures: 0, retries: 0, retry_taxonomy: EMPTY_RETRY_TAXONOMY, recovery: { recoverable: 0, recovered: 0, rate: 0 }, compactions: 0, verification_passed: true, verification_failures: 0, human_interventions: 0, termination_reason: "verified_complete", context_overflow: 0, false_complete: false, violations: [] },
        ],
      }),
    );
    const result = await validateBenchmarkArtifacts(dir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.cases).toBe(1);
    expect(result.summary.passed).toBe(1);
    // Missing manifest degrades to a warning, not a failure.
    expect(result.warnings.some((w) => w.includes("manifest.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
