/**
 * N6 / N2 — the fail-closed pre-registration for
 * `context_safe_tool_call_efficiency_v1` (the MAIN experiment).
 *
 * Purpose: freeze, BEFORE any model result, everything that could otherwise be
 * tuned after seeing one — the exact strategy bytes of both arms, the case set
 * with its content and verifier digests, the provider/model/params, the AB/BA
 * schedule, the budget and the decision gates. Any change to any of those
 * changes `preregistrationDigest`, so an old approval can never authorize a
 * rewritten plan.
 *
 * Honest scope: this module BUILDS and DRY-RUNS the plan. It makes no provider
 * call (`dryRun` reports `providerCalls: 0`), and it does not execute the
 * experiment — the N5 paired evaluation is NOT_RUN in this environment because
 * there are no model credentials and no paid budget.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import {
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  contextSafeToolCallEfficiencyGuidanceDigest,
  TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";
import { buildPairedPlan, type PairedExperimentPlan } from "./paired-plan.js";

export const CONTEXT_SAFE_PREREGISTRATION_SCHEMA = "context-safe-tool-call-efficiency-preregistration-v1";
export const CONTEXT_SAFE_CANDIDATE_ID = "context_safe_tool_call_efficiency_v1";
export const CONTEXT_SAFE_COMPARISON_ARM_ID = "tool_call_efficiency_v1";

/**
 * The frozen schedule: 24 cases × 4 repetitions × 2 arms = 192 logical arm runs
 * per experiment. `logicalRuns` counts ARM RUNS, never model calls — one arm run
 * may make many model calls and transport retries.
 */
export const CONTEXT_SAFE_REPETITIONS = 4;
export const CONTEXT_SAFE_MAIN_CASES = 24;
export const CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT =
  CONTEXT_SAFE_MAIN_CASES * CONTEXT_SAFE_REPETITIONS * 2;

/**
 * The plan's decision gates, frozen as data and bound into the identity. The
 * experiment may not be re-interpreted later with a looser threshold: changing
 * any number here changes `preregistrationDigest`.
 */
/** The frozen decision gates (values are `number` so a tampered copy is representable). */
export interface ContextSafeGates {
  missingGroupVerifiedPassRateLiftPp: number;
  pairedBootstrapIterations: number;
  pairedBootstrapOneSidedLowerBoundMin: number;
  controlSuccessMustNotDecrease: boolean;
  newSecurityViolationsMax: number;
  newFalseCompleteMax: number;
  totalTokensMaxRatioOfBaseline: number;
  modelCallAttemptsMaxRatioOfBaseline: number;
  unproductiveRepeatedToolCallsMustNotGrow: boolean;
  holdoutOverallPassRateMustNotDecrease: boolean;
  holdoutMissingGroupLiftPp: number;
  baselineZeroUsesAbsoluteNonGrowth: boolean;
  usageUnknownIsNotZero: boolean;
}

export const CONTEXT_SAFE_GATES: Readonly<ContextSafeGates> = Object.freeze({
  /** Main experiment: missing-evidence group verified pass-rate lift, percentage points. */
  missingGroupVerifiedPassRateLiftPp: 5,
  /** Paired bootstrap iterations (case-aggregated, frozen seed). */
  pairedBootstrapIterations: 10_000,
  /** 95% one-sided lower bound of the paired difference must be >= this. */
  pairedBootstrapOneSidedLowerBoundMin: 0,
  /** The control group's success count may not fall. */
  controlSuccessMustNotDecrease: true,
  /** New security violations and new false-completes allowed: none. */
  newSecurityViolationsMax: 0,
  newFalseCompleteMax: 0,
  /** Cost/behaviour ceilings relative to the resolved baseline arm. */
  totalTokensMaxRatioOfBaseline: 1.1,
  modelCallAttemptsMaxRatioOfBaseline: 1.1,
  unproductiveRepeatedToolCallsMustNotGrow: true,
  /** Holdout: overall pass rate may not fall, and the missing group keeps the lift. */
  holdoutOverallPassRateMustNotDecrease: true,
  holdoutMissingGroupLiftPp: 5,
  /** When the baseline count is 0, use the absolute non-growth rule (never 0/0). */
  baselineZeroUsesAbsoluteNonGrowth: true,
  /** Unknown usage is NOT zero. */
  usageUnknownIsNotZero: true,
});

export class ContextSafePreregistrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${CONTEXT_SAFE_PREREGISTRATION_SCHEMA}[${code}]: ${message}`);
    this.name = "ContextSafePreregistrationError";
    this.code = code;
  }
}

export interface ContextSafePreregCaseEntry {
  caseId: string;
  suite: string;
  condition: string;
  contentDigest: string;
  verifierDigest: string;
}

export interface ContextSafePreregSubject {
  /** The executable source the run must check out. 40-hex git SHA. */
  candidateSourceSha: string;
  /** Real resolved arm digest of the comparison arm (the live v2 strategy). */
  baselineArmDigest: string;
  /** Real resolved arm digest of the candidate. */
  candidateArmDigest: string;
  cleanTreePolicy: "require-clean";
  runtimeConfigDigest: string;
}

export interface ContextSafePreregPrompt {
  candidateId: string;
  guidanceVersion: string;
  /** sha256 of the EXACT candidate strategy text. */
  guidanceDigest: string;
  /** Digest of the candidate's mechanism contract (eligibility + activation). */
  contractDigest: string;
  /** The comparison arm's own version/digest — never assumed equal. */
  comparisonCandidateId: string;
  comparisonGuidanceVersion: string;
  comparisonGuidanceDigest: string;
}

export interface ContextSafePreregProvider {
  providerId: string;
  modelId: string;
  /** sha256 of the NORMALIZED endpoint (never a raw URL or userinfo/query). */
  endpointDigest: string;
  requestProfileDigest: string;
  pricingDigest?: string;
  usdMicrosPerCall?: number | null;
}

export interface ContextSafePreregDataset {
  suiteId: string;
  suiteVersion: string;
  caseRoot: string;
  holdoutPolicy: string;
  cases: ContextSafePreregCaseEntry[];
  /** DERIVED over the ordered case entries. */
  caseSetDigest: string;
  /** Digest of the frozen case manifest this selection came from. */
  selectionProvenanceDigest: string;
}

export interface ContextSafePreregEvaluation {
  /** Digest over every case's verifier (the ORIGINAL command verifiers). */
  verifierDigest: string;
  scorerDigest: string;
  judgeId: string;
  judgeDigest: string;
  gates: ContextSafeGates;
  gatesDigest: string;
}

export interface ContextSafePreregSchedule {
  repetitions: number;
  /** Order seed controls AB/BA + pair order ONLY — never a model seed. */
  orderSeed: number;
  planDigest: string;
  /** DERIVED: 2 × repetitions × cases. */
  logicalRuns: number;
  abCount: number;
  baCount: number;
  balanced: boolean;
}

export interface ContextSafePreregBudget {
  /** REAL per-logical-run model-call ceiling (the harness iteration limit). */
  maxModelCallsPerRun: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  /** Integer USD micros, or null when pricing is unknown. */
  maxUsdMicros: number | null;
  pricingUnknownPolicy: "refuse";
  /** DERIVED: maxModelCallsPerRun × logicalRuns. */
  campaignWorstCaseModelCalls: number;
}

export interface ContextSafePreregistration {
  schemaVersion: string;
  subject: ContextSafePreregSubject;
  prompt: ContextSafePreregPrompt;
  provider: ContextSafePreregProvider;
  dataset: ContextSafePreregDataset;
  evaluation: ContextSafePreregEvaluation;
  schedule: ContextSafePreregSchedule;
  budget: ContextSafePreregBudget;
  /** DERIVED root identity over the SOURCE inputs only. */
  preregistrationDigest: string;
}

export interface ContextSafePreregistrationOptions {
  subject: {
    candidateSourceSha: string;
    baselineArmDigest: string;
    candidateArmDigest: string;
    runtimeConfigDigest: string;
  };
  provider: {
    providerId: string;
    modelId: string;
    endpointBaseUrl?: string | null;
    requestProfile: Record<string, unknown>;
    pricingDigest?: string;
    usdMicrosPerCall?: number | null;
  };
  /** The frozen case manifest entries (main experiment only — never holdout). */
  cases: ContextSafePreregCaseEntry[];
  suite: { id: string; version: string; caseRoot: string };
  holdoutPolicy: string;
  selectionProvenanceDigest: string;
  evaluation: { scorerDigest: string; judgeId: string; judgeDigest: string };
  schedule: { orderSeed: number };
  budget: {
    maxModelCallsPerRun: number;
    maxToolCalls: number;
    maxDurationMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxUsdMicros: number | null;
  };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function requireSha40(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) {
    throw new ContextSafePreregistrationError("INVALID_FIELD", `${field} must be a 40-hex git SHA`);
  }
  return v;
}

function requireNonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ContextSafePreregistrationError("INVALID_FIELD", `${field} must be a non-empty string`);
  }
  return v;
}

function requirePositiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new ContextSafePreregistrationError("INVALID_FIELD", `${field} must be a positive safe integer`);
  }
  return v;
}

function requireNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new ContextSafePreregistrationError("INVALID_FIELD", `${field} must be a non-negative safe integer`);
  }
  return v;
}

/** Normalize an endpoint to a digest: scheme+host+port only, never userinfo/query. */
function captureEndpointIdentity(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ContextSafePreregistrationError("INVALID_ENDPOINT", `endpoint is not a valid URL: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ContextSafePreregistrationError("ENDPOINT_USERINFO", "endpoint must not carry userinfo");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const port = url.port !== "" ? url.port : scheme === "https" ? "443" : scheme === "http" ? "80" : "";
  return sha256(`${scheme}://${url.hostname.toLowerCase()}:${port}`);
}

/** Name kept private: the v2 module already exports the identical constant. */
const PROVIDER_DEFAULT_ENDPOINT_DIGEST = "provider-default-endpoint";

export function computeContextSafeCaseSetDigest(cases: readonly ContextSafePreregCaseEntry[]): string {
  return sha256(
    stableStringify(
      cases.map((c) => ({ caseId: c.caseId, suite: c.suite, contentDigest: c.contentDigest, verifierDigest: c.verifierDigest })),
    ),
  );
}

export function computeContextSafeVerifierDigest(cases: readonly ContextSafePreregCaseEntry[]): string {
  return sha256(stableStringify(cases.map((c) => ({ caseId: c.caseId, verifierDigest: c.verifierDigest }))));
}

/**
 * Root identity over the SOURCE inputs. Derived counters (logicalRuns, AB/BA
 * counts, campaignWorstCaseModelCalls) are recomputed on load and are NOT part
 * of the identity; everything a reader could retune is.
 */
export function computeContextSafePreregistrationDigest(a: ContextSafePreregistration): string {
  return sha256(
    stableStringify({
      schemaVersion: a.schemaVersion,
      subject: a.subject,
      prompt: a.prompt,
      provider: a.provider,
      dataset: {
        suiteId: a.dataset.suiteId,
        suiteVersion: a.dataset.suiteVersion,
        caseRoot: a.dataset.caseRoot,
        holdoutPolicy: a.dataset.holdoutPolicy,
        cases: a.dataset.cases,
        selectionProvenanceDigest: a.dataset.selectionProvenanceDigest,
      },
      evaluation: {
        scorerDigest: a.evaluation.scorerDigest,
        judgeId: a.evaluation.judgeId,
        judgeDigest: a.evaluation.judgeDigest,
        gates: a.evaluation.gates,
      },
      schedule: { repetitions: a.schedule.repetitions, orderSeed: a.schedule.orderSeed },
      budget: {
        maxModelCallsPerRun: a.budget.maxModelCallsPerRun,
        maxToolCalls: a.budget.maxToolCalls,
        maxDurationMs: a.budget.maxDurationMs,
        maxInputTokens: a.budget.maxInputTokens,
        maxOutputTokens: a.budget.maxOutputTokens,
        maxTotalTokens: a.budget.maxTotalTokens,
        maxUsdMicros: a.budget.maxUsdMicros,
        pricingUnknownPolicy: a.budget.pricingUnknownPolicy,
      },
    }),
  );
}

/** Build the canonical artifact. PURE — constructs no provider, makes no call. */
export function buildContextSafePreregistration(
  opts: ContextSafePreregistrationOptions,
): ContextSafePreregistration {
  const contract = mechanismContractFor(CONTEXT_SAFE_CANDIDATE_ID);
  if (contract === undefined) {
    throw new ContextSafePreregistrationError("NO_CONTRACT", `no mechanism contract for ${CONTEXT_SAFE_CANDIDATE_ID}`);
  }

  const subject: ContextSafePreregSubject = {
    candidateSourceSha: requireSha40(opts.subject?.candidateSourceSha, "subject.candidateSourceSha"),
    baselineArmDigest: requireNonEmpty(opts.subject?.baselineArmDigest, "subject.baselineArmDigest"),
    candidateArmDigest: requireNonEmpty(opts.subject?.candidateArmDigest, "subject.candidateArmDigest"),
    cleanTreePolicy: "require-clean",
    runtimeConfigDigest: requireNonEmpty(opts.subject?.runtimeConfigDigest, "subject.runtimeConfigDigest"),
  };
  if (subject.baselineArmDigest === subject.candidateArmDigest) {
    throw new ContextSafePreregistrationError("ARMS_IDENTICAL", "baseline and candidate arm digests are identical — no causal delta");
  }

  // Prompt identity comes from the AUTHORITATIVE constants, never the caller.
  const prompt: ContextSafePreregPrompt = {
    candidateId: CONTEXT_SAFE_CANDIDATE_ID,
    guidanceVersion: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
    guidanceDigest: contextSafeToolCallEfficiencyGuidanceDigest(),
    contractDigest: sha256(stableStringify(contract)),
    comparisonCandidateId: CONTEXT_SAFE_COMPARISON_ARM_ID,
    comparisonGuidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
    comparisonGuidanceDigest: toolCallEfficiencyGuidanceDigest(),
  };
  if (prompt.guidanceDigest === prompt.comparisonGuidanceDigest) {
    throw new ContextSafePreregistrationError("PROMPTS_IDENTICAL", "the two arms would inject identical text — no single-variable experiment");
  }

  const endpointDigest = captureEndpointIdentity(opts.provider?.endpointBaseUrl ?? null);
  const provider: ContextSafePreregProvider = {
    providerId: requireNonEmpty(opts.provider?.providerId, "provider.providerId"),
    modelId: requireNonEmpty(opts.provider?.modelId, "provider.modelId"),
    endpointDigest: endpointDigest ?? PROVIDER_DEFAULT_ENDPOINT_DIGEST,
    requestProfileDigest: sha256(stableStringify(opts.provider?.requestProfile ?? {})),
    ...(opts.provider?.pricingDigest !== undefined ? { pricingDigest: opts.provider.pricingDigest } : {}),
    ...(opts.provider?.usdMicrosPerCall !== undefined ? { usdMicrosPerCall: opts.provider.usdMicrosPerCall } : {}),
  };

  // Dataset: the main experiment only. Holdout cases are refused outright.
  const cases = opts.cases ?? [];
  const seen = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.caseId)) {
      throw new ContextSafePreregistrationError("DUPLICATE_CASE", `duplicate case id ${entry.caseId}`);
    }
    seen.add(entry.caseId);
    if (entry.suite === "holdout" || entry.suite.includes("holdout")) {
      throw new ContextSafePreregistrationError("HOLDOUT_LEAK", `${entry.caseId} is a holdout case — refusing to freeze it into the main plan`);
    }
  }
  if (cases.length !== CONTEXT_SAFE_MAIN_CASES) {
    throw new ContextSafePreregistrationError(
      "WRONG_CASE_COUNT",
      `${cases.length} case(s); the frozen main experiment requires exactly ${CONTEXT_SAFE_MAIN_CASES}`,
    );
  }
  if (cases.length < contract.minEligibleCases) {
    throw new ContextSafePreregistrationError(
      "TOO_FEW_CASES",
      `${cases.length} case(s) < contract minimum ${contract.minEligibleCases}`,
    );
  }
  const dataset: ContextSafePreregDataset = {
    suiteId: requireNonEmpty(opts.suite?.id, "suite.id"),
    suiteVersion: requireNonEmpty(opts.suite?.version, "suite.version"),
    caseRoot: requireNonEmpty(opts.suite?.caseRoot, "suite.caseRoot"),
    holdoutPolicy: requireNonEmpty(opts.holdoutPolicy, "holdoutPolicy"),
    cases,
    caseSetDigest: computeContextSafeCaseSetDigest(cases),
    selectionProvenanceDigest: requireNonEmpty(opts.selectionProvenanceDigest, "selectionProvenanceDigest"),
  };

  const evaluation: ContextSafePreregEvaluation = {
    verifierDigest: computeContextSafeVerifierDigest(cases),
    scorerDigest: requireNonEmpty(opts.evaluation?.scorerDigest, "evaluation.scorerDigest"),
    judgeId: requireNonEmpty(opts.evaluation?.judgeId, "evaluation.judgeId"),
    judgeDigest: requireNonEmpty(opts.evaluation?.judgeDigest, "evaluation.judgeDigest"),
    gates: CONTEXT_SAFE_GATES,
    gatesDigest: sha256(stableStringify(CONTEXT_SAFE_GATES)),
  };

  const orderSeed = requireNonNegativeInt(opts.schedule?.orderSeed, "schedule.orderSeed");

  const budget = {
    maxModelCallsPerRun: requirePositiveInt(opts.budget?.maxModelCallsPerRun, "budget.maxModelCallsPerRun"),
    maxToolCalls: requireNonNegativeInt(opts.budget?.maxToolCalls, "budget.maxToolCalls"),
    maxDurationMs: requireNonNegativeInt(opts.budget?.maxDurationMs, "budget.maxDurationMs"),
    maxInputTokens: requireNonNegativeInt(opts.budget?.maxInputTokens, "budget.maxInputTokens"),
    maxOutputTokens: requireNonNegativeInt(opts.budget?.maxOutputTokens, "budget.maxOutputTokens"),
    maxTotalTokens: requireNonNegativeInt(opts.budget?.maxTotalTokens, "budget.maxTotalTokens"),
    maxUsdMicros:
      opts.budget?.maxUsdMicros === null || opts.budget?.maxUsdMicros === undefined
        ? null
        : requireNonNegativeInt(opts.budget.maxUsdMicros, "budget.maxUsdMicros"),
    pricingUnknownPolicy: "refuse" as const,
  };

  // Provisional artifact so the schedule derived values come from the SAME
  // paired-plan builder the executor uses.
  const provisional: ContextSafePreregistration = {
    schemaVersion: CONTEXT_SAFE_PREREGISTRATION_SCHEMA,
    subject,
    prompt,
    provider,
    dataset,
    evaluation,
    schedule: {
      repetitions: CONTEXT_SAFE_REPETITIONS,
      orderSeed,
      planDigest: "",
      logicalRuns: 0,
      abCount: 0,
      baCount: 0,
      balanced: false,
    },
    budget: { ...budget, campaignWorstCaseModelCalls: 0 },
    preregistrationDigest: "",
  };

  const derived = deriveSchedule(provisional);
  const schedule: ContextSafePreregSchedule = {
    repetitions: CONTEXT_SAFE_REPETITIONS,
    orderSeed,
    planDigest: derived.planDigest,
    logicalRuns: derived.logicalRuns,
    abCount: derived.abCount,
    baCount: derived.baCount,
    balanced: derived.balanced,
  };
  if (derived.logicalRuns !== CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT) {
    throw new ContextSafePreregistrationError(
      "WRONG_LOGICAL_RUNS",
      `derived ${derived.logicalRuns} logical arm runs, expected ${CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT}`,
    );
  }
  if (!derived.balanced || derived.abCount !== derived.baCount) {
    throw new ContextSafePreregistrationError(
      "UNBALANCED_SCHEDULE",
      `AB/BA is unbalanced (ab=${derived.abCount}, ba=${derived.baCount}) — refusing to pre-register`,
    );
  }

  const artifact: ContextSafePreregistration = {
    ...provisional,
    schedule,
    budget: { ...budget, campaignWorstCaseModelCalls: budget.maxModelCallsPerRun * derived.logicalRuns },
  };
  return { ...artifact, preregistrationDigest: computeContextSafePreregistrationDigest(artifact) };
}

/** The paired plan the executor would run (identical builder, same inputs). */
export function contextSafePairedPlan(a: ContextSafePreregistration): PairedExperimentPlan {
  return buildPairedPlan({
    suite: a.dataset.suiteId,
    cases: a.dataset.cases.map((c) => c.caseId),
    repetitions: a.schedule.repetitions,
    orderSeed: a.schedule.orderSeed,
  });
}

function deriveSchedule(a: ContextSafePreregistration): {
  planDigest: string;
  logicalRuns: number;
  abCount: number;
  baCount: number;
  balanced: boolean;
} {
  const plan = contextSafePairedPlan(a);
  const abCount = plan.pairs.filter((p) => p.order === "AB").length;
  const baCount = plan.pairs.filter((p) => p.order === "BA").length;
  return {
    planDigest: plan.planDigest,
    logicalRuns: plan.totalLogicalRuns,
    abCount,
    baCount,
    balanced: abCount === baCount,
  };
}

export interface ContextSafeDryRunReport {
  ok: boolean;
  status: "DRY_RUN_ONLY";
  logicalRuns: number;
  abCount: number;
  baCount: number;
  balanced: boolean;
  cases: number;
  repetitions: number;
  planDigest: string;
  campaignWorstCaseModelCalls: number;
  /** A dry run constructs no provider: this is structural, not a measurement. */
  providerCalls: 0;
  paidProviderCalls: 0;
  modelQuality: "NOT_RUN";
  promotion: "NOT_RUN";
  problems: string[];
}

/**
 * Dry-run the frozen plan. Reports the exact logical arm-run count and refuses
 * (ok: false with problems) when any frozen invariant drifted. Never contacts a
 * provider.
 */
export function dryRunContextSafePreregistration(a: ContextSafePreregistration): ContextSafeDryRunReport {
  const problems: string[] = [];
  const recomputed = computeContextSafePreregistrationDigest(a);
  if (recomputed !== a.preregistrationDigest) {
    problems.push(`preregistrationDigest drifted: recorded ${a.preregistrationDigest}, recomputed ${recomputed}`);
  }
  const derived = deriveSchedule(a);
  if (derived.logicalRuns !== CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT) {
    problems.push(`logicalRuns ${derived.logicalRuns} !== ${CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT}`);
  }
  if (!derived.balanced) problems.push(`AB/BA unbalanced: ab=${derived.abCount}, ba=${derived.baCount}`);
  if (a.dataset.cases.length !== CONTEXT_SAFE_MAIN_CASES) {
    problems.push(`cases ${a.dataset.cases.length} !== ${CONTEXT_SAFE_MAIN_CASES}`);
  }
  if (!CONTEXT_SAFE_REPETITIONS) problems.push("repetitions missing");
  if (a.schedule.logicalRuns !== derived.logicalRuns) {
    problems.push(`recorded logicalRuns ${a.schedule.logicalRuns} !== derived ${derived.logicalRuns}`);
  }
  if (a.budget.maxUsdMicros === null && a.budget.pricingUnknownPolicy !== "refuse") {
    problems.push("unknown pricing must refuse, never run");
  }
  return {
    ok: problems.length === 0,
    status: "DRY_RUN_ONLY",
    logicalRuns: derived.logicalRuns,
    abCount: derived.abCount,
    baCount: derived.baCount,
    balanced: derived.balanced,
    cases: a.dataset.cases.length,
    repetitions: a.schedule.repetitions,
    planDigest: derived.planDigest,
    campaignWorstCaseModelCalls: a.budget.campaignWorstCaseModelCalls,
    providerCalls: 0,
    paidProviderCalls: 0,
    modelQuality: "NOT_RUN",
    promotion: "NOT_RUN",
    problems,
  };
}

/** The two arm texts, exposed so a reader can diff the single variable. */
export const CONTEXT_SAFE_ARM_TEXTS = Object.freeze({
  candidate: CONTEXT_SAFE_TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
  comparison: TOOL_CALL_EFFICIENCY_GUIDANCE_V1,
});

/**
 * Map the frozen case manifest into the plan's case entries. Kept here (not in
 * the caller) so the artifact written by the freeze script and the artifact the
 * test rebuilds can never disagree about which bytes the plan is bound to.
 */
export function contextSafeCaseEntriesFromManifest(
  cases: readonly {
    caseId: string;
    suite: string;
    condition: string;
    contentDigest: string;
    verifierDigest: string;
  }[],
): ContextSafePreregCaseEntry[] {
  return cases.map((c) => ({
    caseId: requireNonEmpty(c.caseId, "case.caseId"),
    suite: requireNonEmpty(c.suite, "case.suite"),
    condition: requireNonEmpty(c.condition, "case.condition"),
    contentDigest: requireNonEmpty(c.contentDigest, "case.contentDigest"),
    verifierDigest: requireNonEmpty(c.verifierDigest, "case.verifierDigest"),
  }));
}
