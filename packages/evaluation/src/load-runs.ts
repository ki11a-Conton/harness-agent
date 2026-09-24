/**
 * E1-06 — unified benchmark/experiment artifact loader.
 *
 * `agent champion eval` historically expected a flat `EvalOutcome[]` array,
 * but committed benchmark artifacts are `{manifest, meta, results, summary}`
 * objects (Repro 4: `baselineRuns.map is not a function`). This loader is the
 * single canonical reader for BOTH shapes, used by `champion eval` and
 * `benchmark validate` alike:
 *
 *   - flat `EvalOutcome[]` (legacy run-runs) → returned as-is (validated).
 *   - committed report object (`results: BenchmarkCaseResult[]`) → converted
 *     losslessly to `EvalOutcome[]`, preserving the per-case provenance fields
 *     (evaluationContextHash / candidateConfigHash / controlledDifference /
 *     activation_evidence) that promotion-grade comparisons need.
 *
 * Loader never invents evidence: a report without provenance converts to
 * outcomes WITHOUT those fields (fail-closed at the comparison layer).
 */

import { readFile } from "node:fs/promises";
import type { EvalOutcome } from "./runner.js";
import { DEFAULT_JUDGE_VERSION, type BenchmarkCaseResult } from "./baseline.js";

export interface LoadedRuns {
  /** The per-case outcomes, in report order. */
  runs: EvalOutcome[];
  /** Which artifact shape produced them. */
  shape: "flat-evaloutcome" | "report-object";
  /** The report's meta (baseline/challenger identity) when a report object. */
  meta?: Record<string, unknown>;
}

export function isReportObject(value: unknown): value is { results?: unknown; summary?: unknown; meta?: unknown } {
  return typeof value === "object" && value !== null && "results" in value && Array.isArray((value as { results?: unknown }).results);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Convert a committed BenchmarkCaseResult to EvalOutcome (lossless for the
 *  fields E1 comparison uses). Absent provenance stays absent — never faked. */
export function resultToOutcome(result: BenchmarkCaseResult): EvalOutcome {
  return {
    caseId: result.task_id,
    status: result.success ? "passed" : "failed",
    actualStatus: result.actual_status,
    events: [],
    metrics: {
      turn_count: 0,
      tool_call_count: result.tool_calls ?? 0,
      tokens_input: result.input_tokens ?? 0,
      tokens_output: result.output_tokens ?? 0,
      context_tokens: 0,
      compaction_count: result.compactions ?? 0,
      duration_ms: result.duration_ms ?? 0,
      retry_count: result.retries ?? 0,
      verification_failures: result.verification_failures ?? 0,
      human_interventions: result.human_interventions ?? 0,
      estimated_cost: 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: result.model_calls ?? 0,
    },
    violations: result.violations ?? [],
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.failure_category !== undefined ? { failureCategory: result.failure_category } : {}),
    suite: result.suite ?? "regression",
    judgeVersion: result.judge_version ?? DEFAULT_JUDGE_VERSION,
    ...(result.evaluationContextHash !== undefined ? { evaluationContextHash: result.evaluationContextHash } : {}),
    ...(result.candidateConfigHash !== undefined ? { candidateConfigHash: result.candidateConfigHash } : {}),
    ...(result.controlledDifference !== undefined ? { controlledDifference: result.controlledDifference } : {}),
    ...(result.activation_evidence !== undefined ? { activationEvidence: result.activation_evidence } : {}),
  };
}

/** Canonical loader: reads a benchmark artifact file (either shape) and
 *  returns validated per-case runs. Throws a descriptive error when the file
 *  is neither a flat outcome array nor a report object. */
export async function loadRunsFromArtifact(path: string): Promise<LoadedRuns> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`artifact is not valid JSON: ${path}`);
  }

  if (isReportObject(parsed)) {
    const results = parsed.results as BenchmarkCaseResult[];
    if (results.length === 0) {
      throw new Error(`artifact report has zero cases: ${path}`);
    }
    return {
      runs: results.map(resultToOutcome),
      shape: "report-object",
      meta: (parsed.meta as Record<string, unknown> | undefined) ?? undefined,
    };
  }

  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first === undefined || typeof first !== "object" || first === null || typeof (first as { caseId?: unknown }).caseId !== "string") {
      throw new Error(`artifact is not a flat EvalOutcome[] (missing caseId on first item): ${path}`);
    }
    return { runs: parsed as EvalOutcome[], shape: "flat-evaloutcome" };
  }

  throw new Error(
    `artifact is neither a flat EvalOutcome[] nor a report object {results:[...]}: ${path}`,
  );
}
