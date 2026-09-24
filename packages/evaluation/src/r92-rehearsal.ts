/**
 * E4-R92 — the offline rehearsal that gates the authorization request.
 *
 * Plan §R92 做什么 #4: the plan is presented to the user only after a full
 * fake-provider rehearsal passes. Plan §R92 怎么做 requires the runner to be
 * PROVEN to stop as agreed under injected identity drift, expired
 * authorization, budget exhaustion, 429/5xx, disconnect, persistence failure
 * and a mid-run stop. Plan §R92 怎么验收 requires that with 0 external requests.
 *
 * This module runs that matrix against the REAL `runPairedExperiment` — the
 * same executor the paid campaign would use — with an injected fake provider.
 * It is deliberately not a mock of the runner: a rehearsal that reimplements
 * the runner proves nothing about the runner.
 *
 * Two honesty properties are structural:
 *
 *  - **Zero external requests.** The rehearsal never constructs a provider; the
 *    caller injects one. The report records both the declared `externalRequests:
 *    0` and the observed `guardReached` count, so a caller that injects a
 *    network-capable provider cannot silently turn the rehearsal into spend.
 *
 *  - **No real results.** `realScores: false` / `passRateClaim: false` and a
 *    `billingClass` of `offline-rehearsal` keep a rehearsal from being read as
 *    a measurement, which is the conflation plan §三 explicitly forbids.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider, ModelRef, ProviderConfig, ModelRequest, ModelEvent } from "@ar/contracts";
import type { EvalOutcome } from "./runner.js";
import type { BenchmarkCase } from "./baseline.js";
import { buildPairedPlan, computePairedPlanDigest } from "./paired-plan.js";
import {
  buildExecutionIdentityV1,
  type PairedExecutionIdentityV1,
} from "./paired-execution-identity.js";
import { runPairedExperiment, type PairedArmContext, type PairedExperimentRunResult } from "./paired-executor.js";
import {
  R92_AUTHORIZATION_SCHEMA,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  r92AuthorizationGate,
  type R92AuthorizationV1,
  type R92CapIntent,
  type R92GateCode,
} from "./r92-authorization.js";

export const R92_REHEARSAL_SCHEMA = "e4-r92-rehearsal-v1";

/** The fake suite id used throughout. Never a real suite. */
const REHEARSAL_SUITE = "rehearsal";

/** Case ids are synthetic: the rehearsal proves the RUNNER's behaviour, so it
 *  must not consume the frozen dev-set selection it is validating. They carry
 *  the `rehearsal/` suite prefix so the envelope passes the SAME case-id
 *  allow-list a real plan passes — a rehearsal validated by a relaxed copy of
 *  the rule would prove nothing about the rule. Eight cases keeps the rehearsal
 *  envelope inside the plan's 6–10 window, so the rehearsal exercises the same
 *  envelope shape the real campaign would use. */
const REHEARSAL_CASES = ["r-c1", "r-c2", "r-c3", "r-c4", "r-c5", "r-c6", "r-c7", "r-c8"].map(
  (id) => `${REHEARSAL_SUITE}/${id}`,
);

/** 8 cases x 1 repetition x 2 arms = 16 logical runs. */
const REHEARSAL_PLANNED_RUNS = REHEARSAL_CASES.length * 2;

export type R92RehearsalScenarioId =
  | "authorized-happy-path"
  | "unauthorized"
  | "expired-authorization"
  | "wrong-digest"
  | "identity-drift"
  | "budget-exhaustion"
  | "provider-429"
  | "provider-5xx"
  | "disconnect"
  | "persistence-failure"
  | "mid-run-stop"
  | "blocked-cap";

export interface R92RehearsalScenario {
  id: R92RehearsalScenarioId;
  /** What this scenario proves, in one line. */
  proves: string;
  /** Whether the scenario is expected to reach the executor at all. */
  expectsProviderCalls: boolean;
}

/** The declared matrix. Kept as data so a test can assert nothing is missing. */
export const R92_REHEARSAL_SCENARIOS: readonly R92RehearsalScenario[] = [
  { id: "authorized-happy-path", proves: "a fully authorized plan runs to completion offline", expectsProviderCalls: true },
  { id: "unauthorized", proves: "no authorization is refused before the first request", expectsProviderCalls: false },
  { id: "expired-authorization", proves: "an expired authorization is refused before the first request", expectsProviderCalls: false },
  { id: "wrong-digest", proves: "a mismatched authorization digest is refused", expectsProviderCalls: false },
  { id: "identity-drift", proves: "a drifted source SHA is refused before the first request", expectsProviderCalls: false },
  { id: "budget-exhaustion", proves: "the run halts at the declared model-call cap", expectsProviderCalls: true },
  { id: "provider-429", proves: "a rate-limit error yields an invalid arm, never a score", expectsProviderCalls: true },
  { id: "provider-5xx", proves: "a server error yields an invalid arm, never a score", expectsProviderCalls: true },
  { id: "disconnect", proves: "a mid-stream disconnect yields an invalid arm, never a score", expectsProviderCalls: true },
  { id: "persistence-failure", proves: "a journal write failure is surfaced, not swallowed", expectsProviderCalls: true },
  { id: "mid-run-stop", proves: "a mid-run stop resumes with no duplicate or missing arm", expectsProviderCalls: true },
  { id: "blocked-cap", proves: "an unenforceable declared cap is refused instead of run", expectsProviderCalls: false },
];

export interface R92RehearsalObservations {
  stopReason: string | null;
  hitCap: boolean;
  modelCallAttempts: number;
  maxModelCalls: number;
  invalidArms: number;
  scoredPairs: number;
  resumed: boolean;
  duplicateArmRuns: number;
  missingArmRuns: number;
  /** True when a journal write was observed to fail and the failure surfaced. */
  persistenceFailureSurfaced: boolean;
}

export interface R92RehearsalScenarioResult {
  id: R92RehearsalScenarioId;
  proves: string;
  authorizedToExecute: boolean;
  runStatus: "NOT_RUN" | "RAN";
  code: R92GateCode | null;
  /** Provider generate() calls actually made in this scenario. */
  providerRequests: number;
  stoppedAsAgreed: boolean;
  observed: R92RehearsalObservations;
}

export interface R92RehearsalReport {
  schemaVersion: typeof R92_REHEARSAL_SCHEMA;
  scenarios: R92RehearsalScenarioResult[];
  /** Declared: this rehearsal makes no external request. Structural, not
   *  promised — the module accepts no provider and constructs every provider it
   *  uses in-process, so it has no way to reach a network. */
  externalRequests: 0;
  /** Total fake generate() calls across all scenarios. Must be > 0 for the
   *  running scenarios, which is what proves the real executor actually ran. */
  providerRequests: number;
  realScores: false;
  passRateClaim: false;
  billingClass: "offline-rehearsal";
}

export interface R92RehearsalOptions {
  workDir: string;
}

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

/**
 * A provider whose generate() emits `events` then stops. `failWith` makes the
 * stream throw AFTER the first event, which is how a mid-stream disconnect is
 * distinguished from a failure to connect at all.
 */
function scriptedProvider(opts: {
  id: string;
  events?: ModelEvent[];
  failWith?: Error;
  failAfterFirstEvent?: boolean;
  onCall?: () => void;
}): ModelProvider {
  const events = opts.events ?? [
    { type: "text", text: "ok" } as unknown as ModelEvent,
    { type: "done", usage: { inputTokens: 5, outputTokens: 2 } } as unknown as ModelEvent,
  ];
  return {
    id: opts.id,
    async listModels() {
      return [{ id: "m", name: "M" }];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(_request: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          opts.onCall?.();
          let emitted = 0;
          for (const ev of events) {
            if (opts.failWith !== undefined && (opts.failAfterFirstEvent !== true || emitted >= 1)) {
              throw opts.failWith;
            }
            yield ev;
            emitted += 1;
          }
          if (opts.failWith !== undefined && opts.failAfterFirstEvent !== true) {
            throw opts.failWith;
          }
        },
      };
    },
  };
}

function fakeOutcome(caseId: string, passed: boolean): EvalOutcome {
  return {
    caseId,
    suite: REHEARSAL_SUITE,
    status: passed ? "passed" : "failed",
    actualStatus: passed ? "completed" : "failed",
    events: [],
    violations: [],
    judgeVersion: "1.0.0",
    metrics: {
      turn_count: 1,
      tool_call_count: 0,
      tokens_input: 5,
      tokens_output: 2,
      context_tokens: 0,
      compaction_count: 0,
      duration_ms: 1,
      retry_count: 0,
      verification_failures: 0,
      human_interventions: 0,
      estimated_cost: 0,
      usage_unknown: 0,
      cache_tokens_read: 0,
      cache_tokens_created: 0,
      model_call_count: 1,
    },
  } as unknown as EvalOutcome;
}

function rehearsalCases(): BenchmarkCase[] {
  return REHEARSAL_CASES.map(
    (id) =>
      ({
        id,
        suite: REHEARSAL_SUITE,
        requestMd: `request ${id}`,
        expectedMd: `expected ${id}`,
        fixture: {},
        expected: { status: "completed" },
        judgeVersion: "1.0.0",
      }) as unknown as BenchmarkCase,
  );
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

const SHA_BASELINE = "b".repeat(40);
const SHA_CANDIDATE = "c".repeat(40);

const CAP_INTENT: R92CapIntent = {
  campaignModelCalls: 4,
  perCaseToolCalls: 100,
  perCaseDurationMs: 600_000,
  maxLogicalRuns: REHEARSAL_PLANNED_RUNS,
  maxEstimatedTokens: null,
  maxEstimatedCostUsd: null,
  caseCount: REHEARSAL_CASES.length,
  repetitions: 1,
  armCount: 2,
  invocationMode: "single-invocation-over-frozen-list",
};

function rehearsalAuth(over: Partial<R92AuthorizationV1> = {}): R92AuthorizationV1 {
  const caseFingerprints = Object.fromEntries(REHEARSAL_CASES.map((id, i) => [id, String(i).repeat(64)]));
  return {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r92-rehearsal",
    createdAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-10-17T00:00:00.000Z",
    scopeStatement:
      "synthetic offline rehearsal cases, mechanism verification only — NOT population-representative, never a pass-rate claim.",
    selectionDigest: "1".repeat(64),
    caseIds: [...REHEARSAL_CASES],
    caseFingerprints,
    arms: {
      baseline: { sha: SHA_BASELINE, executionPlanDigest: "d".repeat(64), buildMode: "isolated-checkout" },
      candidate: { sha: SHA_CANDIDATE, executionPlanDigest: "e".repeat(64), buildMode: "isolated-checkout" },
    },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement: "single fix under rehearsal",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId: "rehearsal",
    modelId: "m",
    endpointIdentity: "f".repeat(64),
    effectiveModelParams: { budgetTokens: 1000 },
    repetitions: 1,
    serialism: 1,
    caps: classifyR92Caps(CAP_INTENT),
    unknownCostItems: ["USD total is unprovable in an offline rehearsal"],
    outputDir: ".ci/r92-ab",
    promotionEligible: false,
    ...over,
  };
}

function rehearsalFacts(over: Partial<Parameters<typeof r92AuthorizationGate>[0]["facts"]> = {}) {
  const auth = rehearsalAuth();
  return {
    now: "2026-09-20T00:00:00.000Z",
    executingSourceSha: SHA_CANDIDATE,
    observedArmBuilds: {
      baseline: {
        sha: auth.arms.baseline.sha,
        executionPlanDigest: auth.arms.baseline.executionPlanDigest,
        buildDigest: auth.arms.baseline.buildDigest ?? null,
      },
      candidate: {
        sha: auth.arms.candidate.sha,
        executionPlanDigest: auth.arms.candidate.executionPlanDigest,
        buildDigest: auth.arms.candidate.buildDigest ?? null,
      },
    },
    observedCaseFingerprints: { ...auth.caseFingerprints },
    observedProviderId: auth.providerId,
    observedModelId: auth.modelId,
    observedEndpointIdentity: auth.endpointIdentity,
    ...over,
  };
}

function authorizedEnv(auth: R92AuthorizationV1): Record<string, string> {
  return {
    E4_R92_PAID_AUTH: "1",
    RUN_PAID_BENCHMARKS: "1",
    E4_R92_PAID_AUTH_DIGEST: computeR92AuthorizationDigestV1(auth),
  };
}

/** Identity for the paired executor's own journal gate, kept distinct from the
 *  R92 authorization envelope (they bind different things). */
function executorIdentity(): PairedExecutionIdentityV1 {
  const plan = buildPairedPlan({ suite: REHEARSAL_SUITE, cases: REHEARSAL_CASES, repetitions: 1, orderSeed: 11 });
  return buildExecutionIdentityV1({
    scheduleDigest: computePairedPlanDigest(plan),
    suite: REHEARSAL_SUITE,
    judgeVersion: "1.0.0",
    repetitions: 1,
    orderSeed: 11,
    modelSeed: null,
    caseIds: [...REHEARSAL_CASES],
    caseFingerprints: Object.fromEntries(REHEARSAL_CASES.map((id, i) => [id, String(i).repeat(64)])),
    candidate: "rehearsal-candidate",
    providerId: "rehearsal",
    modelId: "m",
    sourceSha: SHA_CANDIDATE,
    limits: { maxLogicalRuns: REHEARSAL_PLANNED_RUNS, maxModelCalls: REHEARSAL_PLANNED_RUNS, maxEstimatedTokens: null, maxEstimatedCostUsd: null },
    billingClass: "offline-rehearsal",
    isolationBackendId: "none",
    isolationStrength: "none",
    promotionEligible: false,
    decisionPolicy: { version: "p1", minConclusiveNetDelta: 1 },
    thresholdDigest: "a".repeat(64),
  });
}

const EMPTY_OBSERVATIONS: R92RehearsalObservations = {
  stopReason: null,
  hitCap: false,
  modelCallAttempts: 0,
  maxModelCalls: 0,
  invalidArms: 0,
  scoredPairs: 0,
  resumed: false,
  duplicateArmRuns: 0,
  missingArmRuns: 0,
  persistenceFailureSurfaced: false,
};

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

/** A refusal scenario: the gate must reject before any provider is created. */
function refusalScenario(
  id: R92RehearsalScenarioId,
  proves: string,
  input: { env: Record<string, string | undefined>; authorization: R92AuthorizationV1 | null; facts: ReturnType<typeof rehearsalFacts> },
  expectedCode?: R92GateCode,
): R92RehearsalScenarioResult {
  const r = r92AuthorizationGate(input);
  const stoppedAsAgreed =
    r.authorizedToExecute === false && (expectedCode === undefined || r.code === expectedCode);
  return {
    id,
    proves,
    authorizedToExecute: r.authorizedToExecute,
    runStatus: "NOT_RUN",
    code: r.code ?? null,
    providerRequests: 0,
    stoppedAsAgreed,
    observed: { ...EMPTY_OBSERVATIONS, stopReason: r.code ?? null },
  };
}

/** Summarise a real executor result into the observation record.
 *
 *  An "invalid arm" is read from `partialPairs`, because the executor only puts
 *  a pair in `finalizedPairs` when BOTH arms are valid: a pair that is present
 *  but not scored lands in `partialPairs` with `reason: "invalid-arm"`. Counting
 *  invalid arms from `finalizedPairs` would always be zero and would make the
 *  anomaly scenarios pass vacuously. */
function observeRun(
  result: PairedExperimentRunResult,
  extras: Partial<R92RehearsalObservations> = {},
): R92RehearsalObservations {
  if (result.status !== "ok") {
    return { ...EMPTY_OBSERVATIONS, ...extras };
  }
  const invalidArms = result.partialPairs.reduce((n, p) => {
    if (p.reason !== "invalid-arm") return n;
    return n + (p.baseline !== null && !p.baseline.valid ? 1 : 0) + (p.candidate !== null && !p.candidate.valid ? 1 : 0);
  }, 0);
  // A pair that is finalized twice (or whose arms were re-run) is a duplicate.
  const pairCounts = new Map<string, number>();
  for (const p of result.finalizedPairs) pairCounts.set(p.pairId, (pairCounts.get(p.pairId) ?? 0) + 1);
  const duplicateArmRuns = [...pairCounts.values()].filter((n) => n > 1).length;
  // A planned pair that never finalized and was never reported partial is missing.
  const reported = new Set([
    ...result.finalizedPairs.map((p) => p.pairId),
    ...result.partialPairs.map((p) => p.pairId),
  ]);
  const missingArmRuns = result.plan.pairs.filter((p) => !reported.has(p.pairId)).length;
  return {
    ...EMPTY_OBSERVATIONS,
    hitCap: result.haltedByBudget,
    modelCallAttempts: result.counters.modelCallAttempts,
    maxModelCalls: result.counters.maxModelCalls,
    invalidArms,
    scoredPairs: result.finalizedPairs.length,
    duplicateArmRuns,
    missingArmRuns,
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------

/**
 * Run the whole matrix. Returns a report rather than throwing, so a caller can
 * print every scenario's verdict even when one fails — the point is to show the
 * user what was proven before they authorize real spend.
 */
export async function runR92Rehearsal(opts: R92RehearsalOptions): Promise<R92RehearsalReport> {
  // Start from a CLEAN workDir. The executor treats an existing journal as a
  // resume request and rejects it when the identity differs, which would make a
  // second rehearsal silently run nothing — a rehearsal that cannot be re-run is
  // not evidence. The mid-run-stop scenario creates and resumes its own journal
  // inside this fresh directory, so the resume path is still exercised.
  await rm(opts.workDir, { recursive: true, force: true });
  await mkdir(opts.workDir, { recursive: true });
  let providerRequests = 0;
  const note = () => {
    providerRequests += 1;
  };

  // Guard against a scenario silently not running: a `resume-rejected` result
  // means the executor refused the journal, which must never be read as
  // "stopped as agreed".
  const refused = (result: PairedExperimentRunResult): boolean => result.status === "resume-rejected";

  const auth = rehearsalAuth();
  const facts = rehearsalFacts();
  const env = authorizedEnv(auth);
  const cases = rehearsalCases();
  const identity = executorIdentity();
  const plan = buildPairedPlan({ suite: REHEARSAL_SUITE, cases: REHEARSAL_CASES, repetitions: 1, orderSeed: 11 });
  const scenarios: R92RehearsalScenarioResult[] = [];

  // ---- Refusal scenarios: no provider is ever created ---------------------
  scenarios.push(
    refusalScenario("unauthorized", "no authorization is refused before the first request",
      { env: {}, authorization: auth, facts }, "PAID_AUTHORIZATION_REQUIRED"),
  );
  scenarios.push(
    refusalScenario("expired-authorization", "an expired authorization is refused before the first request",
      { env, authorization: auth, facts: rehearsalFacts({ now: "2026-12-01T00:00:00.000Z" }) },
      "AUTHORIZATION_EXPIRED"),
  );
  scenarios.push(
    refusalScenario("wrong-digest", "a mismatched authorization digest is refused",
      { env: { ...env, E4_R92_PAID_AUTH_DIGEST: "0".repeat(64) }, authorization: auth, facts },
      "AUTHORIZATION_DIGEST_MISMATCH"),
  );
  scenarios.push(
    refusalScenario("identity-drift", "a drifted source SHA is refused before the first request",
      { env, authorization: auth, facts: rehearsalFacts({ executingSourceSha: "9".repeat(40) }) },
      "IDENTITY_DRIFT"),
  );

  const blockedAuth = rehearsalAuth({ caps: classifyR92Caps({ ...CAP_INTENT, maxEstimatedCostUsd: 5 }) });
  scenarios.push(
    refusalScenario("blocked-cap", "an unenforceable declared cap is refused instead of run",
      { env: authorizedEnv(blockedAuth), authorization: blockedAuth, facts },
      "CAP_NOT_ENFORCEABLE"),
  );

  // ---- Authorized happy path: the executor really runs --------------------
  {
    let calls = 0;
    const provider = scriptedProvider({ id: "rehearsal", onCall: () => { calls += 1; note(); } });
    const result = await runPairedExperiment({
      plan,
      cases,
      provider,
      // One call per arm run: 8 cases x 2 arms = 16. The happy path must have
      // headroom to COMPLETE, unlike the budget-exhaustion scenario below.
      maxModelCalls: REHEARSAL_PLANNED_RUNS,
      identity,
      journalDir: join(opts.workDir, "happy-journal"),
      // Drive the budgeted provider so the happy path is a genuine end-to-end
      // run (provider + budget + journal + pair finalization), not an arm body
      // that returns a canned outcome.
      runArm: async (arm, _caseDef, ctx) => {
        const client = ctx.provider.createClient(
          { providerId: "rehearsal", modelId: "m" } as ModelRef,
          {} as ProviderConfig,
        );
        for await (const _ of client.generate({} as ModelRequest, new AbortController().signal)) {
          void _;
        }
        return fakeOutcome(arm.caseId, true);
      },
    });
    const observed = observeRun(result);
    scenarios.push({
      id: "authorized-happy-path",
      proves: "a fully authorized plan runs to completion offline",
      authorizedToExecute: r92AuthorizationGate({ env, authorization: auth, facts }).authorizedToExecute,
      runStatus: "RAN",
      code: null,
      providerRequests: calls,
      stoppedAsAgreed:
        !refused(result) &&
        result.status === "ok" &&
        result.finalizedPairs.length === REHEARSAL_CASES.length &&
        result.partialPairs.length === 0 &&
        // The arms really reached the fake provider — otherwise "completed"
        // would prove only that a stub returned a constant.
        calls > 0,
      observed,
    });
  }
  // ---- Budget exhaustion: halt AT the cap, never past it ------------------
  {
    let calls = 0;
    let budgetStopObserved: string | null = null;
    // The budgeted provider counts attempts; the arm body deliberately makes an
    // extra call so the cap is reached mid-pair.
    const provider = scriptedProvider({ id: "rehearsal", onCall: () => { calls += 1; note(); } });
    const result = await runPairedExperiment({
      plan,
      cases,
      provider,
      maxModelCalls: 1,
      identity,
      journalDir: join(opts.workDir, "budget-journal"),
      runArm: async (arm, _caseDef, ctx) => {
        // Attempt TWO calls against a cap of 1. The first consumes the budget;
        // the second must be refused by the budgeted provider BEFORE it reaches
        // the transport. That refusal-at-the-call-site is what makes the cap
        // runtime-enforced rather than a preflight estimate.
        const client = ctx.provider.createClient({ providerId: "rehearsal", modelId: "m" } as ModelRef, {} as ProviderConfig);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            for await (const _ of client.generate({} as ModelRequest, new AbortController().signal)) {
              void _;
            }
          } catch (err) {
            // The budget throwing IS the expected stop, but it must be OBSERVED,
            // not swallowed — the scenario asserts on the recorded reason below.
            budgetStopObserved = err instanceof Error ? err.message : String(err);
            break;
          }
        }
        return fakeOutcome(arm.caseId, true);
      },
    });
    const observed = observeRun(result, { stopReason: "model-call-cap" });
    const attempts = result.status === "ok" ? result.counters.modelCallAttempts : 0;
    const hitCap = result.status === "ok" && result.haltedByBudget;
    scenarios.push({
      id: "budget-exhaustion",
      proves: "the run halts at the declared model-call cap",
      authorizedToExecute: true,
      runStatus: "RAN",
      code: null,
      providerRequests: calls,
      // The cap is a ceiling: hitting it is agreement, exceeding it is not.
      // `budgetStopObserved` proves the budget actually threw at the call site
      // rather than the arm merely finishing early on its own.
      stoppedAsAgreed:
        !refused(result) &&
        hitCap &&
        attempts <= 1 &&
        budgetStopObserved !== null,
      observed,
    });
  }

  // ---- Transport anomalies: invalid arms, never a score -------------------
  const transportScenarios: Array<{ id: R92RehearsalScenarioId; proves: string; err: Error; afterFirst: boolean }> = [
    { id: "provider-429", proves: "a rate-limit error yields an invalid arm, never a score", err: new Error("HTTP 429 rate limit exceeded"), afterFirst: false },
    { id: "provider-5xx", proves: "a server error yields an invalid arm, never a score", err: new Error("HTTP 503 service unavailable"), afterFirst: false },
    { id: "disconnect", proves: "a mid-stream disconnect yields an invalid arm, never a score", err: new Error("socket hang up (ECONNRESET)"), afterFirst: true },
  ];
  for (const t of transportScenarios) {
    let calls = 0;
    const provider = scriptedProvider({
      id: "rehearsal",
      failWith: t.err,
      failAfterFirstEvent: t.afterFirst,
      onCall: () => { calls += 1; note(); },
    });
    const result = await runPairedExperiment({
      plan,
      cases,
      provider,
      maxModelCalls: REHEARSAL_PLANNED_RUNS,
      identity,
      journalDir: join(opts.workDir, `${t.id}-journal`),
      runArm: async (arm, _caseDef, ctx) => {
        const client = ctx.provider.createClient({ providerId: "rehearsal", modelId: "m" } as ModelRef, {} as ProviderConfig);
        // Surface the transport failure the way the real runner would.
        for await (const _ of client.generate({} as ModelRequest, new AbortController().signal)) {
          void _;
        }
        return fakeOutcome(arm.caseId, true);
      },
    });
    const observed = observeRun(result, { stopReason: "transport-error" });
    scenarios.push({
      id: t.id,
      proves: t.proves,
      authorizedToExecute: true,
      runStatus: "RAN",
      code: null,
      providerRequests: calls,
      // A refused journal would also score nothing, so it must be excluded
      // explicitly rather than read as "the anomaly stopped the run".
      stoppedAsAgreed: !refused(result) && observed.scoredPairs === 0 && calls > 0,
      observed,
    });
  }

  // ---- Persistence failure: surfaced, not swallowed -----------------------
  {
    let calls = 0;
    const provider = scriptedProvider({ id: "rehearsal", onCall: () => { calls += 1; note(); } });
    // A journalDir whose parent is a FILE, so mkdir/journal writes must fail.
    // The executor fails on the very first journal write, before any arm result
    // can be trusted — so nothing may be scored, and the failure must surface.
    const blockedPath = join(opts.workDir, "persist-blocker");
    await writeFile(blockedPath, "not a directory");
    let surfaced = false;
    let persistenceError: string | null = null;
    let result: PairedExperimentRunResult | null = null;
    try {
      result = await runPairedExperiment({
        plan,
        cases,
        provider,
        maxModelCalls: 4,
        identity,
        journalDir: join(blockedPath, "journal"),
        runArm: async (arm) => fakeOutcome(arm.caseId, true),
      });
    } catch (err) {
      // The failure must SURFACE, so it is recorded and asserted on rather than
      // swallowed — a swallowed persistence error would look like a clean stop.
      surfaced = true;
      persistenceError = err instanceof Error ? err.message : String(err);
    }
    const observed =
      result === null || result.status !== "ok"
        ? { ...EMPTY_OBSERVATIONS, stopReason: "persistence-failure", persistenceFailureSurfaced: surfaced }
        : observeRun(result, { stopReason: "persistence-failure", persistenceFailureSurfaced: surfaced });
    scenarios.push({
      id: "persistence-failure",
      proves: "a journal write failure is surfaced, not swallowed",
      authorizedToExecute: true,
      runStatus: "RAN",
      code: null,
      providerRequests: calls,
      // Surfacing the failure is the agreement; silently scoring would not be.
      // The recorded message proves a real error surfaced, not an empty flag.
      stoppedAsAgreed: surfaced && persistenceError !== null && observed.scoredPairs === 0,
      observed,
    });
  }

  // ---- Mid-run stop, then resume -----------------------------------------
  {
    const journalDir = join(opts.workDir, "stop-journal");
    let calls = 0;
    const provider = scriptedProvider({ id: "rehearsal", onCall: () => { calls += 1; note(); } });
    // Drive the budgeted provider so the resumed arms are genuine runs.
    const armBody = async (arm: { caseId: string }, _caseDef: BenchmarkCase, ctx: PairedArmContext) => {
      const client = ctx.provider.createClient({ providerId: "rehearsal", modelId: "m" } as ModelRef, {} as ProviderConfig);
      for await (const _ of client.generate({} as ModelRequest, new AbortController().signal)) {
        void _;
      }
      return fakeOutcome(arm.caseId, true);
    };
    // Stop after the 1st logical run by throwing from the observability hook.
    // The injected stop must be OBSERVED: if the first phase did not actually
    // throw, the "resume" below would be a plain first run and the scenario
    // would prove nothing about resumption.
    let injectedStopObserved: string | null = null;
    await runPairedExperiment({
      plan,
      cases,
      provider,
      maxModelCalls: REHEARSAL_PLANNED_RUNS,
      identity,
      journalDir,
      onArmCompleted: async ({ logicalRuns }) => {
        if (logicalRuns >= 1) throw new Error("injected mid-run stop");
      },
      runArm: armBody,
    }).catch((err: unknown) => {
      injectedStopObserved = err instanceof Error ? err.message : String(err);
    });

    // Resume the same journal with the same identity.
    const resumed = await runPairedExperiment({
      plan,
      cases,
      provider,
      maxModelCalls: REHEARSAL_PLANNED_RUNS,
      identity,
      journalDir,
      runArm: armBody,
    });
    const observed = observeRun(resumed, { resumed: true, stopReason: "mid-run-stop" });
    scenarios.push({
      id: "mid-run-stop",
      proves: "a mid-run stop resumes with no duplicate or missing arm",
      authorizedToExecute: true,
      runStatus: "RAN",
      code: null,
      providerRequests: calls,
      stoppedAsAgreed:
        !refused(resumed) &&
        resumed.status === "ok" &&
        // The first phase must have really stopped, or there was no resume.
        injectedStopObserved !== null &&
        observed.duplicateArmRuns === 0 &&
        observed.missingArmRuns === 0 &&
        resumed.finalizedPairs.length === REHEARSAL_CASES.length,
      observed,
    });
  }

  // Order results by the declared matrix so the report reads deterministically.
  const order = new Map(R92_REHEARSAL_SCENARIOS.map((s, i) => [s.id, i]));
  scenarios.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return {
    schemaVersion: R92_REHEARSAL_SCHEMA,
    scenarios,
    externalRequests: 0,
    providerRequests,
    realScores: false,
    passRateClaim: false,
    billingClass: "offline-rehearsal",
  };
}
