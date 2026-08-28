import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentEvent, TerminationReason, VerificationSpec } from "@ar/contracts";
import { isTerminationReason, LIMIT_TERMINATION_REASON } from "@ar/contracts";
import type { EvalCase, EvalSuite } from "./eval-case.js";
import type { EvalOutcome, FailureCategory } from "./runner.js";
import { scoreCost } from "./cost-model.js";
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

export const DEFAULT_JUDGE_VERSION = "1.0.0";

export interface BenchmarkCase extends EvalCase {
  /** Raw request.md text (identical to `task`; kept for traceability). */
  requestMd: string;
  /** Raw expected.md text (human-readable acceptance criteria). */
  expectedMd: string;
  /** Workspace fixture: relative path → UTF-8 content. */
  fixture: Record<string, string>;
  /** Per-case context budget override (tokens); undefined → harness default. */
  contextBudgetTokens?: number;
  /** P18-2: schema advertisement mode for the case. "full" (default) advertises
   *  every tool schema inline; "deferred" forces the deferred-schema path
   *  (stubs + tool_lookup) so benchmarks can compare token cost / success. */
  schemaMode?: "full" | "deferred";
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

export const EMPTY_RETRY_TAXONOMY: RetryTaxonomy = {
  model: 0,
  tool: 0,
  verification: 0,
  compaction: 0,
  provider: 0,
  sandbox: 0,
  stallRecovery: 0,
  reconciliation: 0,
  mcpReconnect: 0,
};

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
  /** P38.3-10: effective per-case mechanism wiring. Optional for backward
   *  compatibility with older reports. */
  effective_features?: Record<string, boolean>;
  /** E1-04: per-case mechanism activation evidence (from the run path).
   *  Optional for legacy runs; required for strict promotion comparisons. */
  activation_evidence?: import("./activation-evidence.js").CandidateActivationEvidence;
  /** P38.4-7/8: per-case evaluation context hash — persisted so a later
   *  champion evaluation can attribute any delta to the candidate config. */
  evaluationContextHash?: string;
  /** P38.4-7/8: per-case candidate configuration hash. */
  candidateConfigHash?: string;
  /** P38.4-8: explicitly declared controlled difference. */
  controlledDifference?: string[];
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
  model: { providerId: string; modelId: string };
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

// ---------------------------------------------------------------------------
// Case loading
// ---------------------------------------------------------------------------

interface CaseJson {
  expected?: { status?: "completed" | "failed" | "denied" };
  forbidden?: {
    sideEffects?: boolean;
    commands?: string[];
    reads?: string[];
    network?: boolean;
  };
  verification?: VerificationSpec[];
  timeoutMs?: number;
  contextBudgetTokens?: number;
  suite?: EvalSuite;
  tags?: string[];
  expectedTerminationReason?: TerminationReason;
  expectedSecurityEvents?: string[];
  maxRetries?: number;
  maxDurationMs?: number;
  allowArtifacts?: boolean;
  judgeVersion?: string;
}

const CASE_STATUSES = new Set(["completed", "failed", "denied"]);
const CASE_SUITES: EvalSuite[] = ["regression", "holdout", "adversarial", "stress"];
const CASE_SUITE_SET = new Set<string>(CASE_SUITES);

/** Load every benchmark case from `<dir>/<case-id>/`. Dot-directories
 *  (e.g. .git, .keep) are skipped so the cases dir can hold other files. */
export async function loadBenchmarkCases(dir: string): Promise<BenchmarkCase[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const cases: BenchmarkCase[] = [];
  for (const name of names) {
    cases.push(await loadBenchmarkCase(join(dir, name)));
  }
  return cases;
}

/** Load one case directory: request.md + expected.md required, fixture/ and
 *  case.json optional. Throws with a clear message on malformed layouts. */
export async function loadBenchmarkCase(dir: string): Promise<BenchmarkCase> {
  const id = dir.split(sep).pop() ?? "case";
  const requestMd = await readOptional(join(dir, "request.md"));
  if (requestMd === undefined) {
    throw new Error(`benchmark case ${id}: missing request.md`);
  }
  const expectedMd = await readOptional(join(dir, "expected.md"));
  if (expectedMd === undefined) {
    throw new Error(`benchmark case ${id}: missing expected.md`);
  }
  const json = await readOptional(join(dir, "case.json"));
  const parsed = json !== undefined ? parseCaseJson(id, json) : {};

  const fixture = await readFixtureDir(join(dir, "fixture"));

  const task = parsed.task ?? requestMd.trim();
  return {
    id,
    task,
    requestMd,
    expectedMd,
    fixture,
    expected: parsed.expected ?? { status: "completed" },
    suite: parsed.suite ?? "regression",
    judgeVersion: parsed.judgeVersion ?? DEFAULT_JUDGE_VERSION,
    ...(parsed.tags !== undefined && parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
    ...(parsed.forbidden !== undefined ? { forbidden: parsed.forbidden } : {}),
    ...(parsed.verification !== undefined && parsed.verification.length > 0
      ? { verification: parsed.verification }
      : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.contextBudgetTokens !== undefined
      ? { contextBudgetTokens: parsed.contextBudgetTokens }
      : {}),
    ...(parsed.expectedTerminationReason !== undefined
      ? { expectedTerminationReason: parsed.expectedTerminationReason as TerminationReason }
      : {}),
    ...(parsed.expectedSecurityEvents !== undefined && parsed.expectedSecurityEvents.length > 0
      ? { expectedSecurityEvents: parsed.expectedSecurityEvents }
      : {}),
    ...(parsed.expectedEvents !== undefined ? { expectedEvents: parsed.expectedEvents } : {}),
    ...(parsed.requires !== undefined && parsed.requires.length > 0 ? { requires: parsed.requires } : {}),
    ...(parsed.sources !== undefined ? { sources: parsed.sources } : {}),
    ...(parsed.maxRetries !== undefined ? { maxRetries: parsed.maxRetries } : {}),
    ...(parsed.maxDurationMs !== undefined ? { maxDurationMs: parsed.maxDurationMs } : {}),
    ...(parsed.allowArtifacts !== undefined ? { allowArtifacts: parsed.allowArtifacts } : {}),
  };
}

function parseCaseJson(id: string, raw: string): {
  task?: string;
  expected?: { status: "completed" | "failed" | "denied" };
  forbidden?: {
    sideEffects?: boolean;
    commands?: string[];
    reads?: string[];
    network?: boolean;
  };
  verification?: VerificationSpec[];
  timeoutMs?: number;
  contextBudgetTokens?: number;
  suite?: EvalSuite;
  tags?: string[];
  expectedTerminationReason?: string;
  expectedSecurityEvents?: string[];
  expectedEvents?: { atLeast?: Record<string, number> };
  requires?: string[];
  sources?: {
    memory?: {
      content: string;
      type?: "explicit" | "episodic" | "procedural";
      scope?: string;
      importance?: number;
      malicious?: boolean;
    }[];
    skills?: { name: string; description?: string; body: string }[];
  };
  maxRetries?: number;
  maxDurationMs?: number;
  allowArtifacts?: boolean;
  judgeVersion?: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`benchmark case ${id}: case.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`benchmark case ${id}: case.json must be an object`);
  }
  const record = value as Record<string, unknown>;

  const expected = record.expected as Record<string, unknown> | undefined;
  if (expected !== undefined) {
    const status = expected.status;
    if (typeof status !== "string" || !CASE_STATUSES.has(status)) {
      throw new Error(`benchmark case ${id}: case.json expected.status must be one of completed|failed|denied`);
    }
  }
  const forbidden = record.forbidden as Record<string, unknown> | undefined;
  if (forbidden !== undefined && forbidden !== null) {
    for (const key of ["sideEffects", "commands", "reads", "network"] as const) {
      const valueAt = forbidden[key];
      if ((key === "sideEffects" || key === "network") && valueAt !== undefined && typeof valueAt !== "boolean") {
        throw new Error(`benchmark case ${id}: case.json forbidden.${key} must be a boolean`);
      }
      if ((key === "commands" || key === "reads") && valueAt !== undefined && !Array.isArray(valueAt)) {
        throw new Error(`benchmark case ${id}: case.json forbidden.${key} must be a string array`);
      }
    }
  }

  const task = record.task;
  if (task !== undefined && typeof task !== "string") {
    throw new Error(`benchmark case ${id}: case.json task must be a string`);
  }
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs <= 0)) {
    throw new Error(`benchmark case ${id}: case.json timeoutMs must be a positive number`);
  }
  const contextBudgetTokens = record.contextBudgetTokens;
  if (contextBudgetTokens !== undefined && (typeof contextBudgetTokens !== "number" || contextBudgetTokens <= 0)) {
    throw new Error(`benchmark case ${id}: case.json contextBudgetTokens must be a positive number`);
  }

  const suite = record.suite;
  if (suite !== undefined && (typeof suite !== "string" || !CASE_SUITE_SET.has(suite))) {
    throw new Error(`benchmark case ${id}: case.json suite must be one of ${CASE_SUITES.join("|")}`);
  }
  const tags = record.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
    throw new Error(`benchmark case ${id}: case.json tags must be a string array`);
  }
  const expectedTerminationReason = record.expectedTerminationReason;
  if (expectedTerminationReason !== undefined && !isTerminationReason(expectedTerminationReason)) {
    throw new Error(
      `benchmark case ${id}: case.json expectedTerminationReason must be a known TerminationReason ` +
        `(got "${String(expectedTerminationReason)}")`,
    );
  }
  const expectedSecurityEvents = record.expectedSecurityEvents;
  if (expectedSecurityEvents !== undefined && (!Array.isArray(expectedSecurityEvents) || expectedSecurityEvents.some((e) => typeof e !== "string"))) {
    throw new Error(`benchmark case ${id}: case.json expectedSecurityEvents must be a string array`);
  }
  const maxRetries = record.maxRetries;
  if (maxRetries !== undefined && (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new Error(`benchmark case ${id}: case.json maxRetries must be a non-negative integer`);
  }
  const maxDurationMs = record.maxDurationMs;
  if (maxDurationMs !== undefined && (typeof maxDurationMs !== "number" || maxDurationMs <= 0)) {
    throw new Error(`benchmark case ${id}: case.json maxDurationMs must be a positive number`);
  }
  const allowArtifacts = record.allowArtifacts;
  if (allowArtifacts !== undefined && typeof allowArtifacts !== "boolean") {
    throw new Error(`benchmark case ${id}: case.json allowArtifacts must be a boolean`);
  }
  const judgeVersion = record.judgeVersion;
  if (judgeVersion !== undefined && typeof judgeVersion !== "string") {
    throw new Error(`benchmark case ${id}: case.json judgeVersion must be a string`);
  }
  const expectedEvents = record.expectedEvents as Record<string, unknown> | undefined;
  if (expectedEvents !== undefined) {
    const atLeast = expectedEvents.atLeast;
    if (atLeast === undefined) {
      throw new Error(`benchmark case ${id}: case.json expectedEvents.atLeast is required`);
    }
    if (typeof atLeast !== "object" || atLeast === null || Array.isArray(atLeast)) {
      throw new Error(`benchmark case ${id}: case.json expectedEvents.atLeast must be an object`);
    }
    for (const [type, count] of Object.entries(atLeast)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`benchmark case ${id}: case.json expectedEvents.atLeast.${type} must be a non-negative integer`);
      }
    }
  }
  const requires = record.requires;
  if (requires !== undefined && (!Array.isArray(requires) || requires.some((r) => typeof r !== "string"))) {
    throw new Error(`benchmark case ${id}: case.json requires must be a string array`);
  }
  const sources = record.sources as Record<string, unknown> | undefined;
  if (sources !== undefined && (typeof sources !== "object" || sources === null || Array.isArray(sources))) {
    throw new Error(`benchmark case ${id}: case.json sources must be an object`);
  }
  if (sources?.memory !== undefined && !Array.isArray(sources.memory)) {
    throw new Error(`benchmark case ${id}: case.json sources.memory must be an array`);
  }
  if (sources?.skills !== undefined && !Array.isArray(sources.skills)) {
    throw new Error(`benchmark case ${id}: case.json sources.skills must be an array`);
  }
  for (const mem of (sources?.memory as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof mem.content !== "string" || mem.content === "") {
      throw new Error(`benchmark case ${id}: case.json sources.memory[].content must be a non-empty string`);
    }
  }
  for (const skill of (sources?.skills as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof skill.name !== "string" || typeof skill.body !== "string") {
      throw new Error(`benchmark case ${id}: case.json sources.skills[] needs name + body strings`);
    }
  }

  return {
    ...(task !== undefined ? { task: task as string } : {}),
    ...(expected !== undefined ? { expected: { status: expected.status as "completed" | "failed" | "denied" } } : {}),
    ...(forbidden !== undefined && forbidden !== null
      ? {
          forbidden: {
            ...(forbidden.sideEffects !== undefined ? { sideEffects: forbidden.sideEffects as boolean } : {}),
            ...(forbidden.commands !== undefined ? { commands: forbidden.commands as string[] } : {}),
            ...(forbidden.reads !== undefined ? { reads: forbidden.reads as string[] } : {}),
            ...(forbidden.network !== undefined ? { network: forbidden.network as boolean } : {}),
          },
        }
      : {}),
    ...(record.verification !== undefined && Array.isArray(record.verification)
      ? { verification: record.verification as VerificationSpec[] }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
    ...(contextBudgetTokens !== undefined ? { contextBudgetTokens: contextBudgetTokens as number } : {}),
    ...(suite !== undefined ? { suite: suite as EvalSuite } : {}),
    ...(tags !== undefined ? { tags: tags as string[] } : {}),
    ...(expectedTerminationReason !== undefined ? { expectedTerminationReason: expectedTerminationReason as TerminationReason } : {}),
    ...(expectedSecurityEvents !== undefined ? { expectedSecurityEvents: expectedSecurityEvents as string[] } : {}),
    ...(maxRetries !== undefined ? { maxRetries: maxRetries as number } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs: maxDurationMs as number } : {}),
    ...(allowArtifacts !== undefined ? { allowArtifacts: allowArtifacts as boolean } : {}),
    ...(judgeVersion !== undefined ? { judgeVersion: judgeVersion as string } : {}),
    ...(expectedEvents !== undefined
      ? { expectedEvents: expectedEvents as { atLeast?: Record<string, number> } }
      : {}),
    ...(requires !== undefined ? { requires: requires as string[] } : {}),
    ...(sources !== undefined ? { sources: sources as EvalCase["sources"] } : {}),
  };
}

async function readFixtureDir(dir: string): Promise<Record<string, string>> {
  const fixture: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return fixture; // no fixture/ directory → empty workspace
  }
  await walkFixture(dir, "", entries, fixture);
  return fixture;
}

async function walkFixture(
  root: string,
  prefix: string,
  entries: Dirent[],
  out: Record<string, string>,
): Promise<void> {
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFixture(abs, rel, await readdir(abs, { withFileTypes: true }), out);
    } else if (entry.isFile()) {
      out[rel] = await readFile(abs, "utf8");
    }
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

/** Build the plan's unified per-task result from an EvalOutcome. */
export function collectRunMetrics(outcome: EvalOutcome): BenchmarkCaseResult {
  const events = outcome.events;
  const toolCalls = countEvents(events, "tool.requested");
  const toolFailures = countEvents(events, "tool.failed");
  const compactions = countEvents(events, "context.compacted");
  const contextOverflow = events.filter(
    (event) => event.type === "run.limit_reached" && event.payload.limit === "maxTokens",
  ).length;
  const verificationPassed = events.some(
    (event) => event.type === "verification.completed" && event.payload.passed === true,
  );
  const verificationFailures = events.filter(
    (event) =>
      event.type === "verification.failed" ||
      (event.type === "verification.completed" && event.payload.passed === false),
  ).length;

  const success = outcome.status === "passed";
  const failureCategory = classifyFailure(outcome);
  return {
    task_id: outcome.caseId,
    suite: outcome.suite ?? "regression",
    judge_version: outcome.judgeVersion ?? DEFAULT_JUDGE_VERSION,
    success,
    actual_status: outcome.actualStatus,
    ...(failureCategory !== undefined ? { failure_category: failureCategory } : {}),
    duration_ms: outcome.metrics.duration_ms,
    model_calls: countEvents(events, "model.completed"),
    input_tokens: outcome.metrics.tokens_input,
    output_tokens: outcome.metrics.tokens_output,
    tool_calls: toolCalls,
    tool_failures: toolFailures,
    retries: countRecoveryReExecutions(events),
    retry_taxonomy: deriveRetryTaxonomy(events),
    recovery: deriveRecovery(events),
    compactions,
    verification_passed: verificationPassed,
    verification_failures: verificationFailures,
    human_interventions: outcome.metrics.human_interventions,
    // Prefer the runtime's structured reason; fall back to the event-derived
    // one (keeps old runtimes compatible).
    termination_reason: outcome.terminationReason ?? terminationReason(outcome),
    context_overflow: contextOverflow,
    // Model stopped (completed) but the judge says not done: a false
    // completion the runtime did not catch. When the verification gate is
    // wired, a failed gate turns the turn "failed" instead — that case is
    // counted via verification_failures, not here.
    false_complete: !success && outcome.actualStatus === "completed",
    violations: outcome.violations,
    cost: scoreCost(outcome),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.effectiveFeatures !== undefined
      ? { effective_features: outcome.effectiveFeatures }
      : {}),
    // P38.4-7/8: persist per-case provenance so a later champion evaluation
    // can attribute any delta to the candidate configuration. Absent for
    // legacy runs that predate these fields.
    ...(outcome.evaluationContextHash !== undefined
      ? { evaluationContextHash: outcome.evaluationContextHash }
      : {}),
    ...(outcome.candidateConfigHash !== undefined
      ? { candidateConfigHash: outcome.candidateConfigHash }
      : {}),
    ...(outcome.controlledDifference !== undefined
      ? { controlledDifference: outcome.controlledDifference }
      : {}),
    ...(outcome.activationEvidence !== undefined
      ? { activation_evidence: outcome.activationEvidence }
      : {}),
  };
}

/** Event codes that mark a tool failure as a sandbox/permission denial.
 *  Prefix matching keeps this forward-compatible with the finer-grained
 *  codes Phase 9 emits (SANDBOX_FILESYSTEM_DENIED etc.). */
const SANDBOX_DENIAL_CODES = new Set(["PERMISSION_DENIED"]);

/**
 * Retry taxonomy derived from the event trail. Each kind maps to concrete
 * observable events (see RetryTaxonomy doc); nothing is inferred from model
 * wording. Sandbox re-executions are split out of tool retries by looking at
 * the failure code that preceded the re-execution.
 */
export function deriveRetryTaxonomy(events: AgentEvent[]): RetryTaxonomy {
  const taxonomy: RetryTaxonomy = { ...EMPTY_RETRY_TAXONOMY };
  taxonomy.model = countEvents(events, "model.retry");
  taxonomy.verification = countEvents(events, "verification.failed");
  taxonomy.compaction = countEvents(events, "context.compacted");
  taxonomy.provider = countEvents(events, "retry.provider");
  taxonomy.stallRecovery = countEvents(events, "retry.stallRecovery");
  taxonomy.reconciliation = countEvents(events, "retry.reconciliation");
  taxonomy.mcpReconnect = countEvents(events, "retry.mcpReconnect");

  // Per-call-id trace: the failure that preceded each extra tool.started.
  const byCallId = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.failed" && event.type !== "tool.completed") continue;
    const callId = event.payload.toolCallId;
    if (typeof callId !== "string") continue;
    const trail = byCallId.get(callId);
    if (trail === undefined) byCallId.set(callId, [event]);
    else trail.push(event);
  }
  for (const trail of byCallId.values()) {
    let starts = 0;
    let lastFailureWasSandbox = false;
    for (const event of trail) {
      if (event.type === "tool.started") {
        starts += 1;
        if (starts > 1) {
          // An extra started event = one re-execution, attributed by the
          // failure that preceded it.
          if (lastFailureWasSandbox) taxonomy.sandbox += 1;
          else taxonomy.tool += 1;
        }
        lastFailureWasSandbox = false;
      } else if (event.type === "tool.failed") {
        lastFailureWasSandbox = isSandboxDenial(event.payload.error);
      } else if (event.type === "tool.completed") {
        lastFailureWasSandbox = false;
      }
    }
  }
  return taxonomy;
}

function isSandboxDenial(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  if (typeof code !== "string") return false;
  return code.startsWith("SANDBOX") || SANDBOX_DENIAL_CODES.has(code);
}

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
export function deriveRecovery(events: AgentEvent[]): RecoveryMetrics {
  const modelRetries = countEvents(events, "model.retry");
  const toolFailures = countEvents(events, "tool.failed");
  const verificationFailures = countEvents(events, "verification.failed");
  const verificationPassed = events.some(
    (event) => event.type === "verification.completed" && event.payload.passed === true,
  );

  const recoverable = modelRetries + toolFailures + verificationFailures;

  // Tool recovery: a call id that failed at least once and finally completed
  // with success — every extra started event after the first is a recovery.
  const byCallId = new Map<string, { failures: number; starts: number; finalSuccess: boolean }>();
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.failed" && event.type !== "tool.completed") continue;
    const callId = event.payload.toolCallId;
    if (typeof callId !== "string") continue;
    const entry = byCallId.get(callId) ?? { failures: 0, starts: 0, finalSuccess: false };
    if (event.type === "tool.started") entry.starts += 1;
    else if (event.type === "tool.failed") entry.failures += 1;
    else if (event.type === "tool.completed" && event.payload.status === "success") entry.finalSuccess = true;
    byCallId.set(callId, entry);
  }
  let toolRecovered = 0;
  for (const entry of byCallId.values()) {
    if (entry.failures > 0 && entry.finalSuccess) toolRecovered += entry.starts - 1;
  }

  // Verification recovery: failed gates that were followed by a pass. If the
  // budget was exhausted (last gate failed), that gate is not recovered.
  const verificationRecovered = verificationPassed
    ? verificationFailures
    : Math.max(0, verificationFailures - 1);

  const recovered = modelRetries + toolRecovered + verificationRecovered;
  return {
    recoverable,
    recovered,
    rate: recoverable === 0 ? 0 : recovered / recoverable,
  };
}

/**
 * Recovery re-executions: a toolCallId with N>1 tool.started events means the
 * runtime re-executed the same call (RecoveryPolicy retry loop). Each extra
 * started event after the first is one retry.
 */
export function countRecoveryReExecutions(events: AgentEvent[]): number {
  const startedByCall = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "tool.started") continue;
    const callId = event.payload.toolCallId;
    if (typeof callId !== "string") continue;
    startedByCall.set(callId, (startedByCall.get(callId) ?? 0) + 1);
  }
  let retries = 0;
  for (const count of startedByCall.values()) {
    if (count > 1) retries += count - 1;
  }
  return retries;
}

/** Why did the turn end? Derived from the terminal event + surrounding trail. */
export function terminationReason(outcome: EvalOutcome): string {
  if (outcome.status === "error") return "runtime_error";
  switch (outcome.actualStatus) {
    case "cancelled":
      return "cancelled";
    case "completed": {
      const verified = outcome.events.some(
        (event) => event.type === "verification.completed" && event.payload.passed === true,
      );
      return verified ? "verified_complete" : "model_stopped";
    }
    case "failed": {
      const limit = lastLimitReached(outcome.events);
      // P2-39: map the raw run.limit_reached identifier to the bounded
      // TerminationReason category (no "limit:<kind>" free strings).
      if (limit !== undefined) return LIMIT_TERMINATION_REASON[String(limit)] ?? "failed";
      if (hasEvent(outcome.events, "verification.failed")) return "verification_failed";
      if (hasEvent(outcome.events, "model.failed")) return "model_error";
      return "failed";
    }
    default:
      return outcome.actualStatus;
  }
}

/**
 * P0-6 failure classification (model | harness | judge | infrastructure).
 * The runner records explicit categories for the error paths; agent-side
 * model failures are derived from the termination reason. A case that simply
 * failed the task (e.g. model stopped without completing) has NO category —
 * that is an honest agent outcome, not a harness failure.
 */
export function classifyFailure(outcome: EvalOutcome): FailureCategory | undefined {
  if (outcome.failureCategory !== undefined) return outcome.failureCategory;
  if (outcome.status === "error") return "infrastructure";
  const reason = outcome.terminationReason ?? terminationReason(outcome);
  if (reason === "model_error") return "model";
  return undefined;
}

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
export async function runBaseline(
  cases: BenchmarkCase[],
  runCase: (caseDef: BenchmarkCase) => Promise<EvalOutcome>,
  meta: BaselineMeta,
  opts: RunBaselineOptions = {},
): Promise<BaselineReport> {
  const order = opts.shuffle === true ? shuffledOrder(cases.length, opts.seed ?? 0) : cases.map((_, i) => i);
  const results: BenchmarkCaseResult[] = new Array(cases.length);
  for (let k = 0; k < order.length; k++) {
    const index = order[k]!;
    const caseDef = cases[index]!;
    try {
      const outcome = await runCase(caseDef);
      results[index] = collectRunMetrics(outcome);
    } catch (err) {
      results[index] = {
        task_id: caseDef.id,
        suite: caseDef.suite ?? "regression",
        judge_version: caseDef.judgeVersion ?? DEFAULT_JUDGE_VERSION,
        success: false,
        actual_status: "error",
        failure_category: "infrastructure",
        duration_ms: 0,
        model_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: 0,
        tool_failures: 0,
        retries: 0,
        retry_taxonomy: { ...EMPTY_RETRY_TAXONOMY },
        recovery: { recoverable: 0, recovered: 0, rate: 0 },
        compactions: 0,
        verification_passed: false,
        verification_failures: 0,
        human_interventions: 0,
        termination_reason: "runtime_error",
        context_overflow: 0,
        false_complete: false,
        violations: [],
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // P38.4-real: TPM/rate-limit friendly slow mode — fixed delay between
    // cases (execution pacing, not a correctness primitive; skipped after the
    // last case and when delay is 0).
    if (opts.caseDelayMs !== undefined && opts.caseDelayMs > 0 && k < order.length - 1) {
      await new Promise((r) => setTimeout(r, opts.caseDelayMs));
    }
  }
  return {
    meta: { ...meta, casesTotal: cases.length },
    results,
    summary: summarizeResults(results),
    ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
  };
}

export interface RunBaselineOptions {
  /** Randomize the EXECUTION order (report stays in fixed input order). */
  shuffle?: boolean;
  /** PRNG seed for the shuffle (default 0); same seed → same order. */
  seed?: number;
  /** P0-6 run manifest recorded into the report. */
  manifest?: RunManifest;
  /** P38.4-real: fixed delay in ms between cases (TPM/rate-limit friendly
   *  slow mode; 0/undefined = no delay). Execution pacing only. */
  caseDelayMs?: number;
}

/** Deterministic Fisher-Yates using a seeded mulberry32 PRNG. */
function shuffledOrder(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export function summarizeResults(results: BenchmarkCaseResult[]): BaselineSummary {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  const errors = results.filter((r) => r.actual_status === "error").length;
  const failed = total - passed - errors;

  const durations = results.map((r) => r.duration_ms).sort((a, b) => a - b);
  const modelCalls = results.map((r) => r.model_calls).sort((a, b) => a - b);
  const avg = (pick: (r: BenchmarkCaseResult) => number): number =>
    total === 0 ? 0 : results.reduce((sum, r) => sum + pick(r), 0) / total;

  const retriesByKind: RetryTaxonomy = { ...EMPTY_RETRY_TAXONOMY };
  let recoverable = 0;
  let recovered = 0;
  const terminationDistribution: Record<string, number> = {};
  const failuresByCategory: Record<string, number> = {};
  let costScoreSum = 0;
  let costCaseCount = 0;
  const costDimensionSums: Record<string, number> = {};
  let securityViolations = 0;
  for (const r of results) {
    for (const kind of Object.keys(retriesByKind) as Array<keyof RetryTaxonomy>) {
      retriesByKind[kind] += r.retry_taxonomy[kind];
    }
    recoverable += r.recovery.recoverable;
    recovered += r.recovery.recovered;
    terminationDistribution[r.termination_reason] =
      (terminationDistribution[r.termination_reason] ?? 0) + 1;
    if (r.failure_category !== undefined) {
      failuresByCategory[r.failure_category] = (failuresByCategory[r.failure_category] ?? 0) + 1;
    }
    if (r.cost !== undefined) {
      costCaseCount += 1;
      costScoreSum += r.cost.score;
      if (r.cost.securityViolation) securityViolations += 1;
      for (const [dimension, value] of Object.entries(r.cost.dimensionScores)) {
        costDimensionSums[dimension] = (costDimensionSums[dimension] ?? 0) + value;
      }
    }
  }

  const avgCostDimensions: Record<string, number> = {};
  if (costCaseCount > 0) {
    for (const [dimension, sum] of Object.entries(costDimensionSums)) {
      avgCostDimensions[dimension] = Math.round((sum / costCaseCount) * 100) / 100;
    }
  }

  return {
    total,
    passed,
    failed,
    errors,
    success_rate: total === 0 ? 0 : passed / total,
    latency_p50_ms: percentile(durations, 0.5),
    latency_p95_ms: percentile(durations, 0.95),
    avg_model_calls: avg((r) => r.model_calls),
    model_calls_p50: percentile(modelCalls, 0.5),
    model_calls_p95: percentile(modelCalls, 0.95),
    avg_tool_calls: avg((r) => r.tool_calls),
    avg_tokens_input: avg((r) => r.input_tokens),
    avg_tokens_output: avg((r) => r.output_tokens),
    avg_retries: avg((r) => r.retries),
    retry_rate: total === 0 ? 0 : results.filter((r) => r.retries > 0).length / total,
    retries_by_kind: retriesByKind,
    recovery_rate: recoverable === 0 ? 0 : recovered / recoverable,
    termination_reason_distribution: terminationDistribution,
    total_context_overflows: results.reduce((sum, r) => sum + r.context_overflow, 0),
    total_false_completes: results.filter((r) => r.false_complete).length,
    total_verification_failures: results.reduce((sum, r) => sum + r.verification_failures, 0),
    total_human_interventions: results.reduce((sum, r) => sum + r.human_interventions, 0),
    failures_by_category: failuresByCategory,
    avg_cost_score: costCaseCount === 0 ? 0 : Math.round((costScoreSum / costCaseCount) * 100) / 100,
    avg_cost_dimensions: avgCostDimensions,
    security_violations: securityViolations,
  };
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

/** Write the suite report into outDir: baseline.json + baseline-summary.md
 *  for regression (backward-compatible filenames), <suite>.json +
 *  <suite>-summary.md for the other suites. */
export async function writeBaselineFiles(report: BaselineReport, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const suite = report.meta.suite;
  const base = suite === "regression" ? "baseline" : suite;
  await writeFile(join(outDir, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, `${base}-summary.md`), renderSummaryMd(report), "utf8");
}

export function renderSummaryMd(report: BaselineReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Benchmark ${report.meta.suite}`, "");
  lines.push(`- generated: ${report.meta.generatedAt}`);
  lines.push(`- benchmark version: ${report.meta.benchmarkVersion}`);
  lines.push(`- model: ${report.meta.model.providerId}/${report.meta.model.modelId}`);
  lines.push(`- cases: ${report.meta.casesTotal}`, "");
  if (report.manifest !== undefined) {
    lines.push("## Run manifest", "");
    lines.push(`- git: ${report.manifest.gitSha === null ? "not available" : `${report.manifest.gitSha}${report.manifest.dirty ? " (dirty)" : ""}`}`);
    lines.push(`- candidate: ${report.manifest.candidate ?? "champion baseline"}`);
    lines.push(`- runtime config hash: ${report.manifest.runtimeConfigHash}`);
    lines.push(`- suite version: ${report.manifest.suiteVersion}`);
    lines.push(`- judge version: ${report.manifest.judgeVersion}`);
    lines.push(`- temperature: ${report.manifest.temperature ?? "default"}`);
    lines.push(`- platform: ${report.manifest.platform} / ${report.manifest.nodeVersion}`, "");
  }
  lines.push("## Summary", "");
  lines.push("| metric | value |", "| --- | --- |");
  lines.push(`| success rate | ${formatRate(s.success_rate)} (${s.passed}/${s.total}) |`);
  lines.push(`| latency p50 | ${s.latency_p50_ms} ms |`);
  lines.push(`| latency p95 | ${s.latency_p95_ms} ms |`);
  lines.push(`| model calls p50 | ${s.model_calls_p50} |`);
  lines.push(`| model calls p95 | ${s.model_calls_p95} |`);
  lines.push(`| avg model calls | ${formatNum(s.avg_model_calls)} |`);
  lines.push(`| avg tool calls | ${formatNum(s.avg_tool_calls)} |`);
  lines.push(`| avg input tokens | ${formatNum(s.avg_tokens_input)} |`);
  lines.push(`| avg output tokens | ${formatNum(s.avg_tokens_output)} |`);
  lines.push(`| retry rate | ${formatRate(s.retry_rate)} (avg ${formatNum(s.avg_retries)}/case) |`);
  lines.push(`| recovery rate | ${formatRate(s.recovery_rate)} |`);
  lines.push(`| context overflows | ${s.total_context_overflows} |`);
  lines.push(`| false completes | ${s.total_false_completes} |`);
  lines.push(`| verification failures | ${s.total_verification_failures} |`);
  lines.push(`| human interventions | ${s.total_human_interventions} |`);
  const categories = Object.keys(s.failures_by_category);
  if (categories.length > 0) {
    lines.push(`| failures by category | ${categories.map((c) => `${c} ${s.failures_by_category[c]}`).join(", ")} |`);
  }
  lines.push(`| avg cost score | ${formatNum(s.avg_cost_score)} |`);
  lines.push(`| security violations (hard gate) | ${s.security_violations} |`);
  // P38.3-12: measurement vs quality must be impossible to confuse. The
  // summary is a MEASUREMENT of this run — it never claims agent quality.
  lines.push("", "> This report is a **measurement** (the benchmark ran and produced a valid",
    "> report). It is NOT a quality verdict. Quality assessment happens separately",
    "> against a frozen champion (`agent champion eval baseline-runs.json",
    "> candidate-runs.json`). A low pass rate here means this run's measurement",
    "> failed its cases — it does not by itself promote or demote the agent.");
  const costDims = Object.keys(s.avg_cost_dimensions);
  if (costDims.length > 0) {
    lines.push(`| avg cost dimensions | ${costDims.map((d) => `${d} ${formatNum(s.avg_cost_dimensions[d] ?? 0)}`).join(", ")} |`);
  }
  lines.push("", "## Retry taxonomy", "", "| kind | total |", "| --- | --- |");
  for (const kind of Object.keys(s.retries_by_kind) as Array<keyof RetryTaxonomy>) {
    lines.push(`| retry.${kind} | ${s.retries_by_kind[kind]} |`);
  }
  lines.push("", "## Termination reasons", "", "| reason | count |", "| --- | --- |");
  const reasons = Object.entries(s.termination_reason_distribution).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) lines.push("| (none) | 0 |");
  for (const [reason, count] of reasons) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("", "## Per-case", "", "| task | suite | success | duration_ms | model_calls | tool_calls | tool_failures | retries | recovery | compactions | verification | termination_reason | violations |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.results) {
    lines.push(
      `| ${r.task_id} | ${r.suite} | ${r.success ? "✅" : "❌"} | ${r.duration_ms} | ${r.model_calls} | ${r.tool_calls} | ${r.tool_failures} | ${r.retries} | ${formatRate(r.recovery.rate)} | ${r.compactions} | ${r.verification_passed ? "passed" : r.verification_failures > 0 ? "failed" : "none"} | ${r.termination_reason} | ${r.violations.length} |`,
    );
  }
  lines.push("", "## Notes", "");
  lines.push("- `success` = behavioral judge (EvalRunner) verdict: expected status matched, no forbidden actions, verification gate passed.");
  lines.push("- `false_complete` = turn completed but judge says not done (model claimed done without evidence).");
  lines.push("- `termination_reason`: verified_complete | model_stopped | verification_failed | model_error | limit:<kind> | cancelled | runtime_error.");
  lines.push("- `recovery rate` = recovered failures / recoverable failures (tool + verification + model-error retries), judged from events.");
  return lines.join("\n");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function countEvents(events: AgentEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function hasEvent(events: AgentEvent[], type: string): boolean {
  return events.some((event) => event.type === type);
}

function lastLimitReached(events: AgentEvent[]): string | undefined {
  const limit = [...events]
    .reverse()
    .find((event) => event.type === "run.limit_reached" && typeof event.payload.limit === "string");
  return limit === undefined ? undefined : (limit.payload.limit as string);
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNum(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Relative-path helper for callers that need to copy fixtures elsewhere. */
export function toRelativePath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Baseline comparison (plan.md §133/§150 harness comparison)
// ---------------------------------------------------------------------------

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

export type CaseComparisonOutcome =
  | "newly_passed"
  | "newly_failed"
  | "still_passed"
  | "still_failed"
  | "judge_changed"
  | "infra_failure"
  | "new";

export interface BaselineComparison {
  /** Per-case deltas keyed by task_id. Classification (Phase 6.5): the
   *  regression categories never hide regressions — a case whose judge
   *  version changed is surfaced as judge_changed, a case that crashed as
   *  infra_failure, before success deltas are reported. */
  cases: Record<string, { before: BenchmarkCaseResult; after: BenchmarkCaseResult; outcome: CaseComparisonOutcome }>;
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
export function compareBaselines(before: BaselineReport, after: BaselineReport): BaselineComparison {
  const cases: BaselineComparison["cases"] = {};
  const beforeById = new Map(before.results.map((r) => [r.task_id, r]));
  const afterById = new Map(after.results.map((r) => [r.task_id, r]));

  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  for (const id of ids) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    if (a === undefined) continue; // case removed — not part of the comparison
    if (b === undefined) {
      cases[id] = { before: a, after: a, outcome: "new" };
      continue;
    }
    let outcome: CaseComparisonOutcome;
    if (a.actual_status === "error") {
      outcome = "infra_failure";
    } else if (b.judge_version !== a.judge_version) {
      outcome = "judge_changed";
    } else if (a.success === b.success) {
      outcome = a.success ? "still_passed" : "still_failed";
    } else {
      outcome = a.success ? "newly_passed" : "newly_failed";
    }
    cases[id] = { before: b, after: a, outcome };
  }

  const beforeSummary = before.summary;
  const afterSummary = after.summary;
  return {
    cases,
    summary: {
      success_rate_delta: afterSummary.success_rate - beforeSummary.success_rate,
      passed_delta: afterSummary.passed - beforeSummary.passed,
      latency_p50_delta_ms: afterSummary.latency_p50_ms - beforeSummary.latency_p50_ms,
      latency_p95_delta_ms: afterSummary.latency_p95_ms - beforeSummary.latency_p95_ms,
      avg_model_calls_delta: afterSummary.avg_model_calls - beforeSummary.avg_model_calls,
      avg_tool_calls_delta: afterSummary.avg_tool_calls - beforeSummary.avg_tool_calls,
      avg_tokens_input_delta: afterSummary.avg_tokens_input - beforeSummary.avg_tokens_input,
      avg_tokens_output_delta: afterSummary.avg_tokens_output - beforeSummary.avg_tokens_output,
      avg_retries_delta: afterSummary.avg_retries - beforeSummary.avg_retries,
      retry_rate_delta: afterSummary.retry_rate - beforeSummary.retry_rate,
      recovery_rate_delta: afterSummary.recovery_rate - beforeSummary.recovery_rate,
      context_overflows_delta:
        afterSummary.total_context_overflows - beforeSummary.total_context_overflows,
      false_completes_delta:
        afterSummary.total_false_completes - beforeSummary.total_false_completes,
      verification_failures_delta:
        afterSummary.total_verification_failures - beforeSummary.total_verification_failures,
    },
  };
}
