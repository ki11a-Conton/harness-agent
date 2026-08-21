import type { AgentEvent } from "@ar/contracts";
import type { EvalCase, EvalSuite } from "./eval-case.js";
import type { EvalOutcome, FailureCategory } from "./runner.js";
import type { RunManifest } from "./manifest.js";
/**
 * Fixed benchmark suite + baseline report (plan.md Phase 1, hardened in
 * Phase 6.5: suite split, retry taxonomy, recovery rate).
 *
 * The plan's per-task layout is `fixture/ + request.md + expected.md (or
 * checker)`; here the machine-readable counterpart of expected.md is an
 * optional `case.json` carrying the judge inputs (expected status, forbidden
 * actions, verification specs, timeout, context budget override, suite
 * metadata).
 *
 * Result structure follows the plan's unified schema:
 * task_id / success / duration_ms / model_calls / input_tokens / output_tokens
 * / tool_calls / tool_failures / retries / compactions / verification_passed
 * / human_interventions / termination_reason — plus benchmark-only fields
 * (context_overflow, false_complete, violations) and Phase 6.5 fields
 * (retry taxonomy, recovery rate, suite, judge version).
 */
export declare const DEFAULT_JUDGE_VERSION = "1.0.0";
export interface BenchmarkCase extends EvalCase {
    /** Raw request.md text (identical to `task`; kept for traceability). */
    requestMd: string;
    /** Raw expected.md text (human-readable acceptance criteria). */
    expectedMd: string;
    /** Workspace fixture: relative path → UTF-8 content. */
    fixture: Record<string, string>;
    /** Per-case context budget override (tokens); undefined → harness default. */
    contextBudgetTokens?: number;
}
/**
 * Retry taxonomy (Phase 6.5): every retry kind the runtime can express, each
 * derived from observable events — never from model wording.
 *
 * - model:       `model.retry` events (RecoveryPolicy model_error retry).
 * - tool:        re-executions of a failed tool call whose prior failure was
 *                NOT a sandbox/permission denial (recovers into the same
 *                call id).
 * - verification:`verification.failed` events (each failed gate gives the
 *                model a bounded extra chance).
 * - compaction:  `context.compacted` events (auto-compact and reactive
 *                compact-and-retry for context-length errors).
 * - provider:    `retry.provider` events (Phase 11): provider-internal
 *                retries of transient failures (network errors, HTTP
 *                429/5xx) before the response stream starts.
 * - sandbox:     re-executions after a sandbox/permission denial.
 * - stallRecovery: `retry.stallRecovery` events (Phase 11): bounded
 *                recoveries from stall detection — the streak is reset and
 *                a system observation is injected before the turn is
 *                terminated (limit:maxRepeatedToolCalls) on a later streak.
 * - reconciliation: `retry.reconciliation` events (P2-40): started-but-unconfirmed
 *                tools surfaced to the model after a crash/resume. Never
 *                auto-redone (spec maxAttempts 0).
 * - mcpReconnect: `retry.mcpReconnect` events (P2-40): bounded MCP re-handshakes
 *                when a call hits a disconnected client.
 */
export interface RetryTaxonomy {
    model: number;
    tool: number;
    verification: number;
    compaction: number;
    provider: number;
    sandbox: number;
    stallRecovery: number;
    reconciliation: number;
    mcpReconnect: number;
}
export declare const EMPTY_RETRY_TAXONOMY: RetryTaxonomy;
/** Per-case recovery accounting (Phase 6.5): which failures the runtime
 *  recovered from, judged from the event trail. */
export interface RecoveryMetrics {
    /** Failures that could be recovered: tool failures + verification
     *  failures + model-error retries. */
    recoverable: number;
    /** Failures that ended in recovery: model.retry count + re-executions of a
     *  tool call that finally succeeded + verification failures followed by a
     *  passing gate (except the one that exhausted the budget). */
    recovered: number;
    /** recovered / recoverable; 0 when nothing was recoverable. */
    rate: number;
}
export interface BenchmarkCaseResult {
    task_id: string;
    suite: EvalSuite;
    judge_version: string;
    success: boolean;
    actual_status: string;
    /** P0-6: why the case ended the way it did, independent of pass/fail:
     *  model | harness | judge | infrastructure. Absent for clean agent-side
     *  results (the model simply did not complete the task). */
    failure_category?: FailureCategory;
    duration_ms: number;
    model_calls: number;
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
    tool_failures: number;
    retries: number;
    retry_taxonomy: RetryTaxonomy;
    recovery: RecoveryMetrics;
    compactions: number;
    verification_passed: boolean;
    verification_failures: number;
    human_interventions: number;
    termination_reason: string;
    context_overflow: number;
    /** Model stopped (turn completed) but the judge says the task is not done. */
    false_complete: boolean;
    violations: string[];
    reason?: string;
    /** P2-14: weighted extremely-cheap score and security gate, when the cost
     *  model is enabled. Optional for backward compatibility with older reports. */
    cost?: import("./cost-model.js").CostResult;
}
export interface BaselineSummary {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    success_rate: number;
    latency_p50_ms: number;
    latency_p95_ms: number;
    avg_model_calls: number;
    model_calls_p50: number;
    model_calls_p95: number;
    avg_tool_calls: number;
    avg_tokens_input: number;
    avg_tokens_output: number;
    avg_retries: number;
    retry_rate: number;
    retries_by_kind: RetryTaxonomy;
    recovery_rate: number;
    termination_reason_distribution: Record<string, number>;
    total_context_overflows: number;
    total_false_completes: number;
    total_verification_failures: number;
    total_human_interventions: number;
    /** P0-6: per-category failure counts (model/harness/judge/infrastructure). */
    failures_by_category: Record<string, number>;
    /** P2-14: average weighted cost score; 0 when every run security-gated. */
    avg_cost_score: number;
    /** P2-14: average per-dimension cost sub-scores (present when ≥1 case has
     *  a cost model; dimension always a full 0..100 scale). */
    avg_cost_dimensions: Record<string, number>;
    /** P2-14: number of runs that tripped the security hard gate. */
    security_violations: number;
}
export interface BaselineMeta {
    generatedAt: string;
    benchmarkVersion: string;
    model: {
        providerId: string;
        modelId: string;
    };
    casesTotal: number;
    /** Suite this report covers (regression | holdout | adversarial | stress). */
    suite: EvalSuite;
}
export interface BaselineReport {
    meta: BaselineMeta;
    results: BenchmarkCaseResult[];
    summary: BaselineSummary;
    /** P0-6: reproducible run identity (gitSha/dirty/model/runtimeConfigHash/
     *  timestamp/platform/nodeVersion). Optional for backward compatibility. */
    manifest?: RunManifest;
}
/** Load every benchmark case from `<dir>/<case-id>/`. Dot-directories
 *  (e.g. .git, .keep) are skipped so the cases dir can hold other files. */
export declare function loadBenchmarkCases(dir: string): Promise<BenchmarkCase[]>;
/** Load one case directory: request.md + expected.md required, fixture/ and
 *  case.json optional. Throws with a clear message on malformed layouts. */
export declare function loadBenchmarkCase(dir: string): Promise<BenchmarkCase>;
/** Build the plan's unified per-task result from an EvalOutcome. */
export declare function collectRunMetrics(outcome: EvalOutcome): BenchmarkCaseResult;
/**
 * Retry taxonomy derived from the event trail. Each kind maps to concrete
 * observable events (see RetryTaxonomy doc); nothing is inferred from model
 * wording. Sandbox re-executions are split out of tool retries by looking at
 * the failure code that preceded the re-execution.
 */
export declare function deriveRetryTaxonomy(events: AgentEvent[]): RetryTaxonomy;
/**
 * Recovery accounting (Phase 6.5). Recoverable failures: tool failures,
 * verification failures, model-error retries. Recovered:
 * - model-error retries: every `model.retry` event means the request was
 *   recovered and the loop continued.
 * - tool failures: re-execution of the same call id that finally succeeded.
 * - verification failures: a failed gate followed (eventually) by a passing
 *   gate; the gate that exhausted the budget is not recovered.
 * The rate is per-case; the summary aggregates the sums, never the rates.
 */
export declare function deriveRecovery(events: AgentEvent[]): RecoveryMetrics;
/**
 * Recovery re-executions: a toolCallId with N>1 tool.started events means the
 * runtime re-executed the same call (RecoveryPolicy retry loop). Each extra
 * started event after the first is one retry.
 */
export declare function countRecoveryReExecutions(events: AgentEvent[]): number;
/** Why did the turn end? Derived from the terminal event + surrounding trail. */
export declare function terminationReason(outcome: EvalOutcome): string;
/**
 * P0-6 failure classification (model | harness | judge | infrastructure).
 * The runner records explicit categories for the error paths; agent-side
 * model failures are derived from the termination reason. A case that simply
 * failed the task (e.g. model stopped without completing) has NO category —
 * that is an honest agent outcome, not a harness failure.
 */
export declare function classifyFailure(outcome: EvalOutcome): FailureCategory | undefined;
/**
 * Run every case and summarize. Execution order is configurable; the report
 * order is ALWAYS the input (fixed) case order:
 *
 * - default (shuffle: false): serial execution in input order (report order
 *   === execution order), preserving the historical contract.
 * - shuffle: true: a seeded PRNG randomizes the EXECUTION order while the
 *   report stays in the fixed input order. Use a fixed seed to make the
 *   shuffle reproducible; the same seed always produces the same order.
 *
 * P0-6: an optional `manifest` records the run identity in the report. A
 * throwing `runCase` becomes a `failure_category: "infrastructure"` error
 * result — the runner's own failure is never recorded as an agent failure.
 */
export declare function runBaseline(cases: BenchmarkCase[], runCase: (caseDef: BenchmarkCase) => Promise<EvalOutcome>, meta: BaselineMeta, opts?: RunBaselineOptions): Promise<BaselineReport>;
export interface RunBaselineOptions {
    /** Randomize the EXECUTION order (report stays in fixed input order). */
    shuffle?: boolean;
    /** PRNG seed for the shuffle (default 0); same seed → same order. */
    seed?: number;
    /** P0-6 run manifest recorded into the report. */
    manifest?: RunManifest;
}
export declare function summarizeResults(results: BenchmarkCaseResult[]): BaselineSummary;
/** Write the suite report into outDir: baseline.json + baseline-summary.md
 *  for regression (backward-compatible filenames), <suite>.json +
 *  <suite>-summary.md for the other suites. */
export declare function writeBaselineFiles(report: BaselineReport, outDir: string): Promise<void>;
/** Relative-path helper for callers that need to copy fixtures elsewhere. */
export declare function toRelativePath(root: string, abs: string): string;
export interface BaselineDelta {
    success_rate_delta: number;
    passed_delta: number;
    latency_p50_delta_ms: number;
    latency_p95_delta_ms: number;
    avg_model_calls_delta: number;
    avg_tool_calls_delta: number;
    avg_tokens_input_delta: number;
    avg_tokens_output_delta: number;
    avg_retries_delta: number;
    retry_rate_delta: number;
    recovery_rate_delta: number;
    context_overflows_delta: number;
    false_completes_delta: number;
    verification_failures_delta: number;
}
export type CaseComparisonOutcome = "newly_passed" | "newly_failed" | "still_passed" | "still_failed" | "judge_changed" | "infra_failure" | "new";
export interface BaselineComparison {
    /** Per-case deltas keyed by task_id. Classification (Phase 6.5): the
     *  regression categories never hide regressions — a case whose judge
     *  version changed is surfaced as judge_changed, a case that crashed as
     *  infra_failure, before success deltas are reported. */
    cases: Record<string, {
        before: BenchmarkCaseResult;
        after: BenchmarkCaseResult;
        outcome: CaseComparisonOutcome;
    }>;
    summary: BaselineDelta;
}
/**
 * Compare two reports ("after" minus "before"). Positive success/token/retry
 * semantics: success_rate/passed positive = improvement; latency, tokens,
 * retries, overflows negative = improvement.
 *
 * Classification order (nothing is masked):
 * 1. infra_failure — the after run crashed (actual_status "error").
 * 2. judge_changed — the judge logic version differs between runs; the
 *    pass/fail delta is meaningless until both runs use the same judge.
 * 3. newly/still passed/failed — genuine agent-behavior delta.
 */
export declare function compareBaselines(before: BaselineReport, after: BaselineReport): BaselineComparison;
//# sourceMappingURL=baseline.d.ts.map