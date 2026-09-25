/**
 * N1 — canonical, fail-closed pre-registration **v2** for `tool_call_efficiency_v1`.
 *
 * Why v2 exists: the v1 object (`e4-n5-preregistration-v1`) only bound the
 * candidate, the guidance digest, the case-ID list, the plan digest and a
 * caller-SUPPLIED call estimate. It did not bind the source tree, the arms, the
 * provider/model/endpoint, the per-case CONTENT, the judge/verifier/scorer, the
 * full decision policy, the isolation posture, or a real worst-case budget — and
 * nothing in production consumed it. So "the digest exists" did not mean "the
 * run is constrained by it".
 *
 * v2 makes ONE canonical artifact sufficient to describe *what will run, on
 * which code and data, at what cost, and how it will be judged*:
 *
 *   - subject/source   : candidate source SHA, arm digests, clean-tree policy,
 *                        runtime-config digest
 *   - prompt/mechanism : candidate id, guidance version + digest, contract digest
 *   - provider         : provider/model id, normalized endpoint digest,
 *                        request-profile digest
 *   - dataset          : suite id/version, selection rule + provenance digest,
 *                        holdout policy, per-case id + CONTENT digest +
 *                        eligibility digest, case-set digest
 *   - evaluation       : judge/verifier/scorer identity + digests, the FULL
 *                        decision policy and its digest
 *   - schedule         : repetitions, order seed, plan digest, logical runs,
 *                        AB/BA counts + balance
 *   - budget           : real per-run model-call ceiling (the ITERATION LIMIT,
 *                        not a caller guess), campaign worst case, tool-call,
 *                        duration and token caps, USD cap OR an explicit
 *                        "pricing unknown → refuse" policy
 *   - isolation/executor: driver/worker/resume schemas, isolation backend + strength
 *
 * Invariants:
 *   - PURE: no provider, no key, no network, no I/O. `providerFactoryCalls` is
 *     structurally 0 — the builder never receives or constructs a provider.
 *   - ONE canonicalization: build / serialize / parse all use `stableStringify`.
 *   - DERIVED fields (case-set digest, plan digest, logical runs, AB/BA counts,
 *     balance, campaign worst case) are RECOMPUTED by the loader and compared;
 *     an artifact's self-reported derived value is never trusted.
 *   - FAIL CLOSED parsing: unknown schema/version, missing fields, wrong types,
 *     non-finite/negative/fractional numbers, unsafe integers, duplicate or
 *     unknown keys, and unknown top-level keys are refused.
 *   - `repetitions >= 2`; an unbalanced AB/BA schedule is refused (not merely
 *     reported).
 *   - endpoint only ever enters a digest — never a raw URL, never a key.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";
import { captureEndpointIdentity } from "./provenance-v3.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import {
  toolCallEfficiencyGuidanceDigest,
  TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
} from "./mechanism-guidance.js";
import { buildPairedPlan, computePairedPlanDigest } from "./paired-plan.js";
import { caseInputFingerprintV1 } from "./paired-execution-identity.js";
import {
  computeThresholdDigestV3,
  validateDecisionPolicyV3,
  type DecisionPolicyV3,
} from "./decision-policy-v3.js";

export const TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA = "tool-call-efficiency-preregistration-v2";
export const TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2 = "tool_call_efficiency_v1";
/** Minimum independent repetitions for a decision-ready plan (matches the
 *  champion decision: `repetitions >= 2`). */
export const PREREG_V2_MIN_REPETITIONS = 2;

/** Structured, code-carrying failure so callers/tests can assert the REASON. */
export class PreregistrationV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA}: ${message}`);
    this.name = "PreregistrationV2Error";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PreregSubjectSourceV2 {
  /** The executable source the run must check out. 40-hex git SHA. */
  candidateSourceSha: string;
  /** Baseline arm identity digest (real resolved arm config). */
  baselineArmDigest: string;
  /** Candidate arm identity digest (real resolved arm config). */
  candidateArmDigest: string;
  /** Clean-tree policy the runner must enforce before any call. */
  cleanTreePolicy: "require-clean";
  /** Digest of the effective runtime/benchmark config. */
  runtimeConfigDigest: string;
}

export interface PreregPromptMechanismV2 {
  candidateId: string;
  guidanceVersion: string;
  /** Digest of the EXACT strategy text injected (frozen by mechanism-guidance.ts). */
  guidanceDigest: string;
  /** Digest of the full mechanism contract (eligibility + activation). */
  contractDigest: string;
}

export interface PreregProviderV2 {
  providerId: string;
  modelId: string;
  /** sha256 of the NORMALIZED endpoint (never a raw URL, never userinfo/query). */
  endpointDigest: string;
  /** Digest of the effective request profile (budget tokens, stall policy, …). */
  requestProfileDigest: string;
}

/** One selected case: id + CONTENT digest + eligibility evidence digest. */
export interface PreregCaseEntryV2 {
  caseId: string;
  suite: string;
  contentDigest: string;
  eligibilityDigest: string;
}

/** One entry of the REAL catalog universe (superset of the selection). */
export interface PreregCatalogEntryV2 {
  caseId: string;
  suite: string;
  contentDigest: string;
  eligibilityDigest: string;
  holdout: boolean;
  eligible: boolean;
}

export interface PreregDatasetV2 {
  suiteId: string;
  suiteVersion: string;
  selectionRule: string;
  /** Digest of the selection PROVENANCE (the frozen selection artifact). */
  selectionProvenanceDigest: string;
  holdoutPolicy: string;
  /** Selected cases, in frozen order. */
  cases: PreregCaseEntryV2[];
  /** DERIVED: digest over the ordered selected entries. */
  caseSetDigest: string;
}

export interface PreregEvaluationV2 {
  judgeId: string;
  judgeDigest: string;
  verifierDigest: string;
  scorerDigest: string;
  /** The FULL pre-registered decision policy (never a partial threshold set). */
  decisionPolicy: DecisionPolicyV3;
  decisionPolicyDigest: string;
  /**
   * The UNIFIED minimum eligible activation coverage: exactly
   * `max(contract.minEligibleCases, decisionPolicy.minActivationEligibleCases)`.
   *
   * DERIVED and bound in the root digest. It exists so a plan can never be
   * pre-registered against one minimum (the mechanism contract's) while the
   * champion decision interprets a DIFFERENT, smaller one (the policy's) — the
   * effective threshold is one explicit, frozen number, re-derived on every
   * load and refused on any mismatch.
   */
  minEligibleCases: number;
}

export interface PreregScheduleV2 {
  repetitions: number;
  orderSeed: number;
  /** DERIVED: paired plan identity digest. */
  planDigest: string;
  /** DERIVED: 2 × repetitions × cases. */
  logicalRuns: number;
  /** DERIVED. */
  abCount: number;
  /** DERIVED. */
  baCount: number;
  /** DERIVED: `abCount === baCount`. Must be true or the build refuses. */
  balanced: boolean;
}

export interface PreregBudgetV2 {
  /** REAL per-logical-run model-call ceiling (the harness iteration limit),
   *  NOT a caller estimate. */
  maxModelCallsPerRun: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  /** Integer USD micros, or `null` when pricing is unknown. */
  maxUsdMicros: number | null;
  /** What to do when pricing is unknown: refuse (fail closed). */
  pricingUnknownPolicy: "refuse";
  /** DERIVED: maxModelCallsPerRun × logicalRuns. */
  campaignWorstCaseModelCalls: number;
}

export interface PreregIsolationV2 {
  driverSchema: string;
  workerSchema: string;
  isolationBackendId: string;
  isolationStrength: string;
  resumeStateSchema: string;
}

export interface ToolCallEfficiencyPreregistrationV2 {
  schemaVersion: string;
  subject: PreregSubjectSourceV2;
  prompt: PreregPromptMechanismV2;
  provider: PreregProviderV2;
  dataset: PreregDatasetV2;
  evaluation: PreregEvaluationV2;
  schedule: PreregScheduleV2;
  budget: PreregBudgetV2;
  isolation: PreregIsolationV2;
  /** DERIVED root identity over the SOURCE inputs only. */
  preregistrationDigest: string;
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

export interface PreregistrationV2Options {
  subject: PreregSubjectSourceV2;
  /** Candidate id only — the guidance + contract digests come from the
   *  AUTHORITATIVE constants, never from the caller. */
  candidateId: string;
  provider: {
    providerId: string;
    modelId: string;
    /** Raw base URL; normalized to a digest inside. Never stored raw. */
    endpointBaseUrl?: string | null;
    requestProfile: Record<string, unknown>;
  };
  /** The REAL catalog universe the selection must be a subset of. */
  catalog: PreregCatalogEntryV2[];
  selection: {
    caseIds: string[];
    selectionRule: string;
    selectionProvenanceDigest: string;
    holdoutPolicy: string;
  };
  suiteId: string;
  suiteVersion: string;
  evaluation: Omit<PreregEvaluationV2, "decisionPolicyDigest" | "minEligibleCases">;
  schedule: { repetitions: number; orderSeed: number };
  budget: Omit<PreregBudgetV2, "campaignWorstCaseModelCalls">;
  isolation: PreregIsolationV2;
}

/** Source fields that fully determine the root digest (derived excluded). */
function sourceBody(a: ToolCallEfficiencyPreregistrationV2): Record<string, unknown> {
  return {
    schemaVersion: a.schemaVersion,
    subject: {
      candidateSourceSha: a.subject.candidateSourceSha,
      baselineArmDigest: a.subject.baselineArmDigest,
      candidateArmDigest: a.subject.candidateArmDigest,
      cleanTreePolicy: a.subject.cleanTreePolicy,
      runtimeConfigDigest: a.subject.runtimeConfigDigest,
    },
    prompt: {
      candidateId: a.prompt.candidateId,
      guidanceVersion: a.prompt.guidanceVersion,
      guidanceDigest: a.prompt.guidanceDigest,
      contractDigest: a.prompt.contractDigest,
    },
    provider: {
      providerId: a.provider.providerId,
      modelId: a.provider.modelId,
      endpointDigest: a.provider.endpointDigest,
      requestProfileDigest: a.provider.requestProfileDigest,
    },
    dataset: {
      suiteId: a.dataset.suiteId,
      suiteVersion: a.dataset.suiteVersion,
      selectionRule: a.dataset.selectionRule,
      selectionProvenanceDigest: a.dataset.selectionProvenanceDigest,
      holdoutPolicy: a.dataset.holdoutPolicy,
      cases: a.dataset.cases.map((c) => ({
        caseId: c.caseId,
        suite: c.suite,
        contentDigest: c.contentDigest,
        eligibilityDigest: c.eligibilityDigest,
      })),
    },
    evaluation: {
      judgeId: a.evaluation.judgeId,
      judgeDigest: a.evaluation.judgeDigest,
      verifierDigest: a.evaluation.verifierDigest,
      scorerDigest: a.evaluation.scorerDigest,
      decisionPolicy: a.evaluation.decisionPolicy,
      decisionPolicyDigest: a.evaluation.decisionPolicyDigest,
      minEligibleCases: a.evaluation.minEligibleCases,
    },
    schedule: {
      repetitions: a.schedule.repetitions,
      orderSeed: a.schedule.orderSeed,
    },
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
    isolation: {
      driverSchema: a.isolation.driverSchema,
      workerSchema: a.isolation.workerSchema,
      isolationBackendId: a.isolation.isolationBackendId,
      isolationStrength: a.isolation.isolationStrength,
      resumeStateSchema: a.isolation.resumeStateSchema,
    },
  };
}

/** sha256 over the canonical SOURCE body. */
export function computePreregistrationV2Digest(a: ToolCallEfficiencyPreregistrationV2): string {
  return createHash("sha256").update(stableStringify(sourceBody(a)), "utf8").digest("hex");
}

/** Canonical bytes of the WHOLE artifact (source + derived + root digest). */
export function serializePreregistrationV2(a: ToolCallEfficiencyPreregistrationV2): string {
  return stableStringify(a);
}

// ---------------------------------------------------------------------------
// Derived recomputation
// ---------------------------------------------------------------------------

export function computeCaseSetDigestV2(cases: readonly PreregCaseEntryV2[]): string {
  return createHash("sha256")
    .update(
      stableStringify(
        cases.map((c) => ({
          caseId: c.caseId,
          suite: c.suite,
          contentDigest: c.contentDigest,
          eligibilityDigest: c.eligibilityDigest,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

interface DerivedSchedule {
  planDigest: string;
  logicalRuns: number;
  abCount: number;
  baCount: number;
  balanced: boolean;
}

function recomputeScheduleDerived(a: ToolCallEfficiencyPreregistrationV2): DerivedSchedule {
  const plan = buildPairedPlan({
    suite: a.dataset.suiteId,
    cases: a.dataset.cases.map((c) => c.caseId),
    repetitions: a.schedule.repetitions,
    orderSeed: a.schedule.orderSeed,
  });
  const ab = plan.pairs.filter((p) => p.order === "AB").length;
  const ba = plan.pairs.filter((p) => p.order === "BA").length;
  return {
    planDigest: computePairedPlanDigest(plan),
    logicalRuns: plan.totalLogicalRuns,
    abCount: ab,
    baCount: ba,
    balanced: ab === ba,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function requireNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a non-empty string`);
  }
  return v;
}

function requirePositiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || !Number.isSafeInteger(v)) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a positive safe integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a non-negative safe integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireSha40(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a 40-hex git SHA`);
  }
  return v;
}

/** Build the canonical v2 artifact. Pure — touches no provider. */
export function buildToolCallEfficiencyPreregistrationV2(
  opts: PreregistrationV2Options,
): ToolCallEfficiencyPreregistrationV2 {
  if (opts.candidateId !== TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2) {
    throw new PreregistrationV2Error("UNKNOWN_CANDIDATE", `no v2 pre-registration contract for ${opts.candidateId}`);
  }
  const contract = mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2);
  if (contract === undefined) {
    throw new PreregistrationV2Error("NO_CONTRACT", `no mechanism contract for ${TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2}`);
  }

  // --- source ---------------------------------------------------------------
  const subject: PreregSubjectSourceV2 = {
    candidateSourceSha: requireSha40(opts.subject?.candidateSourceSha, "subject.candidateSourceSha"),
    baselineArmDigest: requireNonEmptyString(opts.subject?.baselineArmDigest, "subject.baselineArmDigest"),
    candidateArmDigest: requireNonEmptyString(opts.subject?.candidateArmDigest, "subject.candidateArmDigest"),
    cleanTreePolicy: "require-clean",
    runtimeConfigDigest: requireNonEmptyString(opts.subject?.runtimeConfigDigest, "subject.runtimeConfigDigest"),
  };
  if (subject.baselineArmDigest === subject.candidateArmDigest) {
    throw new PreregistrationV2Error("ARMS_IDENTICAL", "baseline and candidate arm digests are identical — no causal delta");
  }

  // --- prompt / mechanism (authoritative constants, not caller input) -------
  const prompt: PreregPromptMechanismV2 = {
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    guidanceVersion: TOOL_CALL_EFFICIENCY_GUIDANCE_VERSION,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: createHash("sha256").update(stableStringify(contract), "utf8").digest("hex"),
  };

  // --- provider -------------------------------------------------------------
  const endpointDigest = captureEndpointIdentity(opts.provider?.endpointBaseUrl ?? null);
  const provider: PreregProviderV2 = {
    providerId: requireNonEmptyString(opts.provider?.providerId, "provider.providerId"),
    modelId: requireNonEmptyString(opts.provider?.modelId, "provider.modelId"),
    // A null endpoint means the provider default endpoint — itself a bound choice.
    endpointDigest: endpointDigest ?? "provider-default-endpoint",
    requestProfileDigest: createHash("sha256")
      .update(stableStringify(opts.provider?.requestProfile ?? {}), "utf8")
      .digest("hex"),
  };

  // --- dataset: selection MUST be a subset of the real catalog --------------
  const catalog = opts.catalog ?? [];
  const byId = new Map<string, PreregCatalogEntryV2>();
  for (const entry of catalog) {
    if (byId.has(entry.caseId)) {
      throw new PreregistrationV2Error("DUPLICATE_CATALOG_ID", `catalog contains duplicate case id ${entry.caseId}`);
    }
    byId.set(entry.caseId, entry);
  }
  const selectionIds = opts.selection?.caseIds ?? [];
  const seen = new Set<string>();
  const entries: PreregCaseEntryV2[] = [];
  for (const id of selectionIds) {
    if (seen.has(id)) {
      throw new PreregistrationV2Error("DUPLICATE_SELECTION_ID", `selection contains duplicate case id ${id}`);
    }
    seen.add(id);
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new PreregistrationV2Error("UNKNOWN_CASE", `selected case ${id} is not in the real catalog`);
    }
    if (entry.holdout) {
      throw new PreregistrationV2Error("HOLDOUT_LEAK", `selected case ${id} is holdout — refusing to leak holdout into the plan`);
    }
    if (!entry.eligible) {
      throw new PreregistrationV2Error("INELIGIBLE_CASE", `selected case ${id} is not eligible under the contract`);
    }
    entries.push({
      caseId: entry.caseId,
      suite: entry.suite,
      contentDigest: entry.contentDigest,
      eligibilityDigest: entry.eligibilityDigest,
    });
  }
  if (entries.length < contract.minEligibleCases) {
    throw new PreregistrationV2Error(
      "TOO_FEW_CASES",
      `${entries.length} eligible case(s) < contract minimum ${contract.minEligibleCases}`,
    );
  }

  // --- evaluation -----------------------------------------------------------
  const decisionPolicy = opts.evaluation?.decisionPolicy;
  if (decisionPolicy === undefined) {
    throw new PreregistrationV2Error("MISSING_POLICY", "evaluation.decisionPolicy is required (full pre-registered policy)");
  }
  const policyDigest = computeThresholdDigestV3(decisionPolicy);
  // The ONE effective eligible minimum: never the contract alone, never the
  // policy alone. A plan whose selected cases clear the contract but not the
  // policy (or vice versa) is refused; the frozen number is bound in the digest
  // so the champion decision cannot later interpret a smaller threshold.
  const minEligibleCases = Math.max(contract.minEligibleCases, decisionPolicy.minActivationEligibleCases);
  const evaluation: PreregEvaluationV2 = {
    judgeId: requireNonEmptyString(opts.evaluation?.judgeId, "evaluation.judgeId"),
    judgeDigest: requireNonEmptyString(opts.evaluation?.judgeDigest, "evaluation.judgeDigest"),
    verifierDigest: requireNonEmptyString(opts.evaluation?.verifierDigest, "evaluation.verifierDigest"),
    scorerDigest: requireNonEmptyString(opts.evaluation?.scorerDigest, "evaluation.scorerDigest"),
    decisionPolicy,
    decisionPolicyDigest: policyDigest,
    minEligibleCases,
  };
  if (entries.length < minEligibleCases) {
    throw new PreregistrationV2Error(
      "TOO_FEW_CASES",
      `${entries.length} eligible case(s) < unified minimum ${minEligibleCases} ` +
        `(max(contract ${contract.minEligibleCases}, policy ${decisionPolicy.minActivationEligibleCases}))`,
    );
  }

  // --- schedule -------------------------------------------------------------
  const repetitions = requirePositiveInt(opts.schedule?.repetitions, "schedule.repetitions");
  if (repetitions < PREREG_V2_MIN_REPETITIONS) {
    throw new PreregistrationV2Error(
      "REPETITIONS_TOO_LOW",
      `repetitions ${repetitions} < ${PREREG_V2_MIN_REPETITIONS} — a decision-ready plan requires >= ${PREREG_V2_MIN_REPETITIONS}`,
    );
  }
  const orderSeed = requireNonNegativeInt(opts.schedule?.orderSeed, "schedule.orderSeed");

  // --- budget ---------------------------------------------------------------
  const budget: Omit<PreregBudgetV2, "campaignWorstCaseModelCalls"> = {
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
    pricingUnknownPolicy: "refuse",
  };

  const isolation: PreregIsolationV2 = {
    driverSchema: requireNonEmptyString(opts.isolation?.driverSchema, "isolation.driverSchema"),
    workerSchema: requireNonEmptyString(opts.isolation?.workerSchema, "isolation.workerSchema"),
    isolationBackendId: requireNonEmptyString(opts.isolation?.isolationBackendId, "isolation.isolationBackendId"),
    isolationStrength: requireNonEmptyString(opts.isolation?.isolationStrength, "isolation.isolationStrength"),
    resumeStateSchema: requireNonEmptyString(opts.isolation?.resumeStateSchema, "isolation.resumeStateSchema"),
  };

  const datasetBase = {
    suiteId: requireNonEmptyString(opts.suiteId, "suiteId"),
    suiteVersion: requireNonEmptyString(opts.suiteVersion, "suiteVersion"),
    selectionRule: requireNonEmptyString(opts.selection?.selectionRule, "selection.selectionRule"),
    selectionProvenanceDigest: requireNonEmptyString(opts.selection?.selectionProvenanceDigest, "selection.selectionProvenanceDigest"),
    holdoutPolicy: requireNonEmptyString(opts.selection?.holdoutPolicy, "selection.holdoutPolicy"),
    cases: entries,
    caseSetDigest: computeCaseSetDigestV2(entries),
  };

  // Assemble a provisional artifact so derived recomputation uses the SAME code
  // path the loader will use.
  const provisional: ToolCallEfficiencyPreregistrationV2 = {
    schemaVersion: TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA,
    subject,
    prompt,
    provider,
    dataset: datasetBase,
    evaluation,
    schedule: {
      repetitions,
      orderSeed,
      planDigest: "",
      logicalRuns: 0,
      abCount: 0,
      baCount: 0,
      balanced: false,
    },
    budget: { ...budget, campaignWorstCaseModelCalls: 0 },
    isolation,
    preregistrationDigest: "",
  };

  const derived = recomputeScheduleDerived(provisional);
  if (!derived.balanced) {
    throw new PreregistrationV2Error(
      "UNBALANCED_SCHEDULE",
      `AB/BA is unbalanced (ab=${derived.abCount}, ba=${derived.baCount}) — refusing to pre-register`,
    );
  }

  const schedule: PreregScheduleV2 = {
    repetitions,
    orderSeed,
    planDigest: derived.planDigest,
    logicalRuns: derived.logicalRuns,
    abCount: derived.abCount,
    baCount: derived.baCount,
    balanced: derived.balanced,
  };
  const campaignWorstCaseModelCalls = budget.maxModelCallsPerRun * derived.logicalRuns;

  const artifact: ToolCallEfficiencyPreregistrationV2 = {
    ...provisional,
    schedule,
    budget: { ...budget, campaignWorstCaseModelCalls },
  };
  return { ...artifact, preregistrationDigest: computePreregistrationV2Digest(artifact) };
}

// ---------------------------------------------------------------------------
// Strict parse + validate
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectObject(v: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(v)) throw new PreregistrationV2Error("INVALID_SHAPE", `${field} must be an object`);
  return v;
}

function expectKeys(obj: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PreregistrationV2Error("UNKNOWN_FIELD", `${field}.${key} is not a known v2 field`);
    }
  }
}

function expectString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a non-empty string`);
  }
  return v;
}

function expectNonNegInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new PreregistrationV2Error("INVALID_FIELD", `${field} must be a non-negative safe integer`);
  }
  return v;
}

function parseCaseEntry(raw: unknown, i: number): PreregCaseEntryV2 {
  const o = expectObject(raw, `dataset.cases[${i}]`);
  expectKeys(o, ["caseId", "suite", "contentDigest", "eligibilityDigest"], `dataset.cases[${i}]`);
  return {
    caseId: expectString(o.caseId, `dataset.cases[${i}].caseId`),
    suite: expectString(o.suite, `dataset.cases[${i}].suite`),
    contentDigest: expectString(o.contentDigest, `dataset.cases[${i}].contentDigest`),
    eligibilityDigest: expectString(o.eligibilityDigest, `dataset.cases[${i}].eligibilityDigest`),
  };
}

/**
 * Parse + strictly validate a v2 artifact. Recomputes EVERY derived field and
 * the root digest, comparing against the artifact's self-reported values, and
 * refuses on any mismatch. A v1 artifact (or any other schema) is refused.
 */
export function parseAndValidatePreregistrationV2(json: string): ToolCallEfficiencyPreregistrationV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PreregistrationV2Error("NOT_JSON", "artifact is not valid JSON");
  }
  const root = expectObject(raw, "artifact");
  const schemaVersion = expectString(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA) {
    throw new PreregistrationV2Error(
      "WRONG_SCHEMA",
      `schemaVersion ${schemaVersion} is not ${TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA} (v1 cannot authorize formal execution)`,
    );
  }
  expectKeys(
    root,
    ["schemaVersion", "subject", "prompt", "provider", "dataset", "evaluation", "schedule", "budget", "isolation", "preregistrationDigest"],
    "artifact",
  );

  const subj = expectObject(root.subject, "subject");
  expectKeys(subj, ["candidateSourceSha", "baselineArmDigest", "candidateArmDigest", "cleanTreePolicy", "runtimeConfigDigest"], "subject");
  const subject: PreregSubjectSourceV2 = {
    candidateSourceSha: requireSha40(subj.candidateSourceSha, "subject.candidateSourceSha"),
    baselineArmDigest: expectString(subj.baselineArmDigest, "subject.baselineArmDigest"),
    candidateArmDigest: expectString(subj.candidateArmDigest, "subject.candidateArmDigest"),
    cleanTreePolicy: "require-clean",
    runtimeConfigDigest: expectString(subj.runtimeConfigDigest, "subject.runtimeConfigDigest"),
  };

  const pr = expectObject(root.prompt, "prompt");
  expectKeys(pr, ["candidateId", "guidanceVersion", "guidanceDigest", "contractDigest"], "prompt");
  const prompt: PreregPromptMechanismV2 = {
    candidateId: expectString(pr.candidateId, "prompt.candidateId"),
    guidanceVersion: expectString(pr.guidanceVersion, "prompt.guidanceVersion"),
    guidanceDigest: expectString(pr.guidanceDigest, "prompt.guidanceDigest"),
    contractDigest: expectString(pr.contractDigest, "prompt.contractDigest"),
  };
  // Bind to the AUTHORITATIVE constants: a fabricated guidance must be refused.
  if (prompt.candidateId !== TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2) {
    throw new PreregistrationV2Error("UNKNOWN_CANDIDATE", `prompt.candidateId ${prompt.candidateId} is not the tool-call-efficiency candidate`);
  }
  if (prompt.guidanceDigest !== toolCallEfficiencyGuidanceDigest()) {
    throw new PreregistrationV2Error("GUIDANCE_MISMATCH", "prompt.guidanceDigest does not match the authoritative strategy text");
  }

  const pv = expectObject(root.provider, "provider");
  expectKeys(pv, ["providerId", "modelId", "endpointDigest", "requestProfileDigest"], "provider");
  const provider: PreregProviderV2 = {
    providerId: expectString(pv.providerId, "provider.providerId"),
    modelId: expectString(pv.modelId, "provider.modelId"),
    endpointDigest: expectString(pv.endpointDigest, "provider.endpointDigest"),
    requestProfileDigest: expectString(pv.requestProfileDigest, "provider.requestProfileDigest"),
  };

  const ds = expectObject(root.dataset, "dataset");
  expectKeys(ds, ["suiteId", "suiteVersion", "selectionRule", "selectionProvenanceDigest", "holdoutPolicy", "cases", "caseSetDigest"], "dataset");
  if (!Array.isArray(ds.cases)) throw new PreregistrationV2Error("INVALID_SHAPE", "dataset.cases must be an array");
  const cases = ds.cases.map((c, i) => parseCaseEntry(c, i));
  const caseIds = new Set<string>();
  for (const c of cases) {
    if (caseIds.has(c.caseId)) {
      throw new PreregistrationV2Error("DUPLICATE_CASE", `dataset.cases contains duplicate case id ${c.caseId}`);
    }
    caseIds.add(c.caseId);
  }
  const dataset: PreregDatasetV2 = {
    suiteId: expectString(ds.suiteId, "dataset.suiteId"),
    suiteVersion: expectString(ds.suiteVersion, "dataset.suiteVersion"),
    selectionRule: expectString(ds.selectionRule, "dataset.selectionRule"),
    selectionProvenanceDigest: expectString(ds.selectionProvenanceDigest, "dataset.selectionProvenanceDigest"),
    holdoutPolicy: expectString(ds.holdoutPolicy, "dataset.holdoutPolicy"),
    cases,
    caseSetDigest: expectString(ds.caseSetDigest, "dataset.caseSetDigest"),
  };
  if (dataset.caseSetDigest !== computeCaseSetDigestV2(cases)) {
    throw new PreregistrationV2Error("DERIVED_TAMPERED", "dataset.caseSetDigest does not match the selected cases");
  }

  const ev = expectObject(root.evaluation, "evaluation");
  expectKeys(ev, ["judgeId", "judgeDigest", "verifierDigest", "scorerDigest", "decisionPolicy", "decisionPolicyDigest", "minEligibleCases"], "evaluation");
  // Strictly validate the FULL policy (rejects malformed/out-of-range
  // thresholds); the digest is computed over the normalized policy so a
  // partially-declared threshold set cannot masquerade as the real policy.
  let decisionPolicy: DecisionPolicyV3;
  try {
    decisionPolicy = validateDecisionPolicyV3(ev.decisionPolicy);
  } catch (err) {
    throw new PreregistrationV2Error("INVALID_POLICY", err instanceof Error ? err.message : String(err));
  }
  const policyDigest = computeThresholdDigestV3(decisionPolicy);
  const contract = mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2);
  if (contract === undefined) {
    throw new PreregistrationV2Error("NO_CONTRACT", `no mechanism contract for ${TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2}`);
  }
  const evaluation: PreregEvaluationV2 = {
    judgeId: expectString(ev.judgeId, "evaluation.judgeId"),
    judgeDigest: expectString(ev.judgeDigest, "evaluation.judgeDigest"),
    verifierDigest: expectString(ev.verifierDigest, "evaluation.verifierDigest"),
    scorerDigest: expectString(ev.scorerDigest, "evaluation.scorerDigest"),
    decisionPolicy,
    decisionPolicyDigest: expectString(ev.decisionPolicyDigest, "evaluation.decisionPolicyDigest"),
    minEligibleCases: expectNonNegInt(ev.minEligibleCases, "evaluation.minEligibleCases"),
  };
  if (evaluation.decisionPolicyDigest !== policyDigest) {
    throw new PreregistrationV2Error("DERIVED_TAMPERED", "evaluation.decisionPolicyDigest does not match the decision policy");
  }
  // Re-derive the UNIFIED minimum and refuse a plan that carries a different
  // one — a hand-edited (smaller) minimum would otherwise let a 3-case selection
  // be judged against the contract's 5.
  const expectedMinEligibleCases = Math.max(contract.minEligibleCases, decisionPolicy.minActivationEligibleCases);
  if (evaluation.minEligibleCases !== expectedMinEligibleCases) {
    throw new PreregistrationV2Error(
      "DERIVED_TAMPERED",
      `evaluation.minEligibleCases ${evaluation.minEligibleCases} != unified max(contract ${contract.minEligibleCases}, policy ${decisionPolicy.minActivationEligibleCases}) = ${expectedMinEligibleCases}`,
    );
  }
  if (cases.length < evaluation.minEligibleCases) {
    throw new PreregistrationV2Error(
      "TOO_FEW_CASES",
      `${cases.length} selected case(s) < unified minimum ${evaluation.minEligibleCases}`,
    );
  }

  const sc = expectObject(root.schedule, "schedule");
  expectKeys(sc, ["repetitions", "orderSeed", "planDigest", "logicalRuns", "abCount", "baCount", "balanced"], "schedule");
  const repetitions = expectNonNegInt(sc.repetitions, "schedule.repetitions");
  if (repetitions < PREREG_V2_MIN_REPETITIONS) {
    throw new PreregistrationV2Error("REPETITIONS_TOO_LOW", `repetitions ${repetitions} < ${PREREG_V2_MIN_REPETITIONS}`);
  }
  const schedule: PreregScheduleV2 = {
    repetitions,
    orderSeed: expectNonNegInt(sc.orderSeed, "schedule.orderSeed"),
    planDigest: expectString(sc.planDigest, "schedule.planDigest"),
    logicalRuns: expectNonNegInt(sc.logicalRuns, "schedule.logicalRuns"),
    abCount: expectNonNegInt(sc.abCount, "schedule.abCount"),
    baCount: expectNonNegInt(sc.baCount, "schedule.baCount"),
    balanced: sc.balanced === true,
  };

  const bg = expectObject(root.budget, "budget");
  expectKeys(
    bg,
    ["maxModelCallsPerRun", "maxToolCalls", "maxDurationMs", "maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxUsdMicros", "pricingUnknownPolicy", "campaignWorstCaseModelCalls"],
    "budget",
  );
  const maxUsdMicros = bg.maxUsdMicros === null ? null : expectNonNegInt(bg.maxUsdMicros, "budget.maxUsdMicros");
  const budget: PreregBudgetV2 = {
    maxModelCallsPerRun: expectNonNegInt(bg.maxModelCallsPerRun, "budget.maxModelCallsPerRun"),
    maxToolCalls: expectNonNegInt(bg.maxToolCalls, "budget.maxToolCalls"),
    maxDurationMs: expectNonNegInt(bg.maxDurationMs, "budget.maxDurationMs"),
    maxInputTokens: expectNonNegInt(bg.maxInputTokens, "budget.maxInputTokens"),
    maxOutputTokens: expectNonNegInt(bg.maxOutputTokens, "budget.maxOutputTokens"),
    maxTotalTokens: expectNonNegInt(bg.maxTotalTokens, "budget.maxTotalTokens"),
    maxUsdMicros,
    pricingUnknownPolicy: "refuse",
    campaignWorstCaseModelCalls: expectNonNegInt(bg.campaignWorstCaseModelCalls, "budget.campaignWorstCaseModelCalls"),
  };

  const iso = expectObject(root.isolation, "isolation");
  expectKeys(iso, ["driverSchema", "workerSchema", "isolationBackendId", "isolationStrength", "resumeStateSchema"], "isolation");
  const isolation: PreregIsolationV2 = {
    driverSchema: expectString(iso.driverSchema, "isolation.driverSchema"),
    workerSchema: expectString(iso.workerSchema, "isolation.workerSchema"),
    isolationBackendId: expectString(iso.isolationBackendId, "isolation.isolationBackendId"),
    isolationStrength: expectString(iso.isolationStrength, "isolation.isolationStrength"),
    resumeStateSchema: expectString(iso.resumeStateSchema, "isolation.resumeStateSchema"),
  };

  const artifact: ToolCallEfficiencyPreregistrationV2 = {
    schemaVersion: TOOL_CALL_EFFICIENCY_PREREGISTRATION_V2_SCHEMA,
    subject,
    prompt,
    provider,
    dataset,
    evaluation,
    schedule,
    budget,
    isolation,
    preregistrationDigest: expectString(root.preregistrationDigest, "preregistrationDigest"),
  };

  // Recompute ALL derived fields and the root digest; refuse on any drift.
  const derived = recomputeScheduleDerived(artifact);
  if (schedule.planDigest !== derived.planDigest) {
    throw new PreregistrationV2Error("DERIVED_TAMPERED", "schedule.planDigest does not match the recomputed schedule");
  }
  if (schedule.logicalRuns !== derived.logicalRuns) {
    throw new PreregistrationV2Error("DERIVED_TAMPERED", `schedule.logicalRuns ${schedule.logicalRuns} != recomputed ${derived.logicalRuns}`);
  }
  if (schedule.abCount !== derived.abCount || schedule.baCount !== derived.baCount) {
    throw new PreregistrationV2Error("DERIVED_TAMPERED", "schedule AB/BA counts do not match the recomputed schedule");
  }
  if (derived.abCount !== derived.baCount || !schedule.balanced) {
    throw new PreregistrationV2Error("UNBALANCED_SCHEDULE", "AB/BA is unbalanced");
  }
  const expectedWorstCase = budget.maxModelCallsPerRun * derived.logicalRuns;
  if (budget.campaignWorstCaseModelCalls !== expectedWorstCase) {
    throw new PreregistrationV2Error(
      "DERIVED_TAMPERED",
      `budget.campaignWorstCaseModelCalls ${budget.campaignWorstCaseModelCalls} != recomputed ${expectedWorstCase}`,
    );
  }
  const expectedRoot = computePreregistrationV2Digest(artifact);
  if (artifact.preregistrationDigest !== expectedRoot) {
    throw new PreregistrationV2Error("ROOT_DIGEST_MISMATCH", "preregistrationDigest does not match the canonical source body");
  }
  return artifact;
}

/**
 * Formal-execution gate: the ONLY accepted artifact is a freshly validated v2.
 * Kept as a named entry point so the executor binds to one check (N2) rather
 * than re-implementing schema logic.
 */
export function assertFormalExecutionPreregistration(json: string): ToolCallEfficiencyPreregistrationV2 {
  return parseAndValidatePreregistrationV2(json);
}

/** Convenience: build one catalog entry from a REAL benchmark case's content. */
export function catalogEntryFromCase(
  c: { id: string; suite: string; requestMd: string; expectedMd: string; fixture: Record<string, string> },
  eligibility: { eligible: boolean; holdout: boolean; evidence: Record<string, unknown> },
): PreregCatalogEntryV2 {
  return {
    caseId: c.id,
    suite: c.suite,
    contentDigest: caseInputFingerprintV1({
      id: c.id,
      suite: c.suite,
      requestMd: c.requestMd,
      expectedMd: c.expectedMd,
      fixture: c.fixture,
    }),
    eligibilityDigest: caseInputFingerprintV1(eligibility.evidence),
    holdout: eligibility.holdout,
    eligible: eligibility.eligible,
  };
}