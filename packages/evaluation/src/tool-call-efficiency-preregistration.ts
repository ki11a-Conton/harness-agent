/**
 * N5/P5 — pre-registration of the STRICT paired experiment for
 * `tool_call_efficiency_v1`, at ZERO provider calls.
 *
 * P1–P4 proved the challenger can be really INSTALLED (champion application
 * injects the strategy text), that its ACTIVATION is bound to the actual
 * model-visible prompt bytes, and that the manifest/dry-run identity binds the
 * real system prompt. This module closes the next gap: BEFORE any money is
 * spent, the experiment itself must be pre-registered as a deterministic,
 * strict, budget-bounded paired plan, so the eventual paid run cannot be
 * quietly re-interpreted (different case set, different repetition count,
 * different arm order, or an underfunded budget).
 *
 * It is PURE — no provider, no API key, no network, no I/O — and reuses the
 * existing scheduler (`buildPairedPlan`), the paid guard + budget preflight
 * (`preflightPairedPlan`) and the dry-run renderer (`dryRunPairedPlan`) rather
 * than re-implementing any of them. `providerCalls` is structurally 0 because
 * the builder never receives or constructs a provider.
 *
 * The pre-registration binds:
 *   - the candidate and its mechanism contract (eligibility + activation);
 *   - the EXACT strategy text digest that will be injected (P1/P2/P4);
 *   - the frozen eligible case list, in order;
 *   - the strict paired schedule digest (2 × repetitions × cases logical runs);
 *   - the declared budget caps;
 * into one `preregistrationDigest` a human approves before the paid run.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";
import { mechanismContractFor } from "./mechanism-contract.js";
import { toolCallEfficiencyGuidanceDigest } from "./mechanism-guidance.js";
import {
  buildPairedPlan,
  dryRunPairedPlan,
  preflightPairedPlan,
  PAIRED_PLAN_SCHEMA_VERSION,
  type DryRunReport,
  type PairedExperimentPlan,
  type PreflightResult,
} from "./paired-plan.js";

export const TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION = "e4-n5-preregistration-v1";
export const TOOL_CALL_EFFICIENCY_CANDIDATE_ID = "tool_call_efficiency_v1";

export interface PreregistrationBudget {
  /** Hard runtime cap on model-call attempts for the WHOLE campaign. The
   *  paired executor enforces this as a real stop, not an estimate. */
  campaignModelCalls: number;
  perCaseToolCalls: number;
  perCaseDurationMs: number;
}

export interface PreregistrationOptions {
  /** Eligible case ids, in frozen order, declared BEFORE any result is seen. */
  eligibleCaseIds: string[];
  /** EXACT repetitions per arm per case (strict pair semantics). */
  repetitions: number;
  /** Order seed — controls AB/BA only; never a model seed. */
  orderSeed?: number | null;
  /** Estimated model calls per arm run (>= 1). */
  callsPerArmRun?: number;
  budget: PreregistrationBudget;
}

export interface PreregistrationContractFacts {
  modelVisibleSurface: string;
  eligibilityRule: string;
  minEligibleCases: number;
  expectedFailureCluster: string;
  requiredActivationEvents: string[];
}

export interface PreregistrationStrictness {
  /** Total logical arm runs the plan schedules. */
  logicalRuns: number;
  /** 2 × repetitions × cases — what a strict pair MUST equal. */
  expectedLogicalRuns: number;
  abCount: number;
  baCount: number;
  /** AB and BA are exactly balanced (the guarantee for even pair counts). */
  balanced: boolean;
}

export interface ToolCallEfficiencyPreregistration {
  schemaVersion: string;
  candidateId: string;
  /** Digest of the EXACT strategy text that will be injected (P1/P2/P4). */
  promptAdditionsDigest: string;
  contract: PreregistrationContractFacts;
  eligibleCaseIds: string[];
  plan: PairedExperimentPlan;
  planDigest: string;
  budget: PreregistrationBudget;
  callsPerArmRun: number;
  strictness: PreregistrationStrictness;
  /** What WOULD be spent — computed without touching a provider. */
  dryRun: DryRunReport;
  /** Real provider WITHOUT paid authorization — must refuse (0 calls). */
  preflightUnpaid: PreflightResult;
  /** Real provider WITH paid authorization — must allow exactly the estimate. */
  preflightPaid: PreflightResult;
  /** Structural invariant: pre-registration constructs no provider. */
  providerCalls: 0;
  preregistrationDigest: string;
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || !Number.isFinite(value)) {
    throw new Error(`${TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION}: ${field} must be a positive integer, got ${value}`);
  }
  return value;
}

/** Deterministic pre-registration digest over the identity fields the human
 *  approves. A change to ANY of them yields a new digest, so an old approval
 *  can never authorize a re-interpreted experiment. */
export function computePreregistrationDigest(
  input: Omit<ToolCallEfficiencyPreregistration, "preregistrationDigest" | "dryRun" | "preflightUnpaid" | "preflightPaid">,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        schemaVersion: input.schemaVersion,
        candidateId: input.candidateId,
        promptAdditionsDigest: input.promptAdditionsDigest,
        contract: input.contract,
        eligibleCaseIds: input.eligibleCaseIds,
        planDigest: input.planDigest,
        repetitions: input.plan.repetitions,
        orderSeed: input.plan.orderSeed,
        budget: input.budget,
        callsPerArmRun: input.callsPerArmRun,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Build the strict paired pre-registration. Fails closed (throws) when the
 * declared experiment cannot be a valid, budget-bounded, strict pair:
 *   - the candidate has no mechanism contract;
 *   - fewer than the contract's minimum eligible cases are declared;
 *   - the budget cannot cover the schedule (underfunded → a partial run is not
 *     a valid strict pair).
 */
export function buildToolCallEfficiencyPreregistration(
  opts: PreregistrationOptions,
): ToolCallEfficiencyPreregistration {
  const candidateId = TOOL_CALL_EFFICIENCY_CANDIDATE_ID;
  const contract = mechanismContractFor(candidateId);
  if (contract === undefined) {
    throw new Error(`${TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION}: no mechanism contract for ${candidateId}`);
  }

  const eligibleCaseIds = [...opts.eligibleCaseIds];
  if (eligibleCaseIds.length < contract.minEligibleCases) {
    throw new Error(
      `${TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION}: ${eligibleCaseIds.length} eligible case(s) declared < contract minimum ${contract.minEligibleCases} — refusing to pre-register`,
    );
  }

  const repetitions = requirePositiveInt(opts.repetitions, "repetitions");
  const callsPerArmRun = requirePositiveInt(opts.callsPerArmRun ?? 1, "callsPerArmRun");
  const budget: PreregistrationBudget = {
    campaignModelCalls: requirePositiveInt(opts.budget.campaignModelCalls, "budget.campaignModelCalls"),
    perCaseToolCalls: requirePositiveInt(opts.budget.perCaseToolCalls, "budget.perCaseToolCalls"),
    perCaseDurationMs: requirePositiveInt(opts.budget.perCaseDurationMs, "budget.perCaseDurationMs"),
  };

  const plan = buildPairedPlan({
    suite: candidateId,
    cases: eligibleCaseIds,
    repetitions,
    orderSeed: opts.orderSeed ?? 0,
  });
  const planDigest = plan.planDigest;

  // Strict pairing: exactly 2 × repetitions × cases logical runs.
  const expectedLogicalRuns = repetitions * eligibleCaseIds.length * 2;
  const abCount = plan.pairs.filter((p) => p.order === "AB").length;
  const baCount = plan.pairs.filter((p) => p.order === "BA").length;
  if (plan.totalLogicalRuns !== expectedLogicalRuns) {
    throw new Error(
      `${TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION}: plan schedules ${plan.totalLogicalRuns} logical runs, expected a strict pair of ${expectedLogicalRuns}`,
    );
  }

  const estimate = plan.maxProviderCalls * callsPerArmRun;
  if (budget.campaignModelCalls < estimate) {
    throw new Error(
      `${TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION}: budget ${budget.campaignModelCalls} model calls cannot cover the schedule's ${estimate} estimated calls — an underfunded plan is not a valid strict pair`,
    );
  }

  const dryRun = dryRunPairedPlan({ plan, providerKind: "real", callsPerArmRun });
  const preflightUnpaid = preflightPairedPlan({ plan, providerKind: "real", paidAuthorized: false, callsPerArmRun });
  const preflightPaid = preflightPairedPlan({ plan, providerKind: "real", paidAuthorized: true, callsPerArmRun });

  const base: Omit<ToolCallEfficiencyPreregistration, "preregistrationDigest"> = {
    schemaVersion: TOOL_CALL_EFFICIENCY_PREREGISTRATION_SCHEMA_VERSION,
    candidateId,
    promptAdditionsDigest: toolCallEfficiencyGuidanceDigest(),
    contract: {
      modelVisibleSurface: contract.modelVisibleSurface,
      eligibilityRule: contract.eligibilityRule,
      minEligibleCases: contract.minEligibleCases,
      expectedFailureCluster: contract.expectedFailureCluster,
      requiredActivationEvents: [...contract.requiredActivationEvents],
    },
    eligibleCaseIds,
    plan,
    planDigest,
    budget,
    callsPerArmRun,
    strictness: {
      logicalRuns: plan.totalLogicalRuns,
      expectedLogicalRuns,
      abCount,
      baCount,
      balanced: abCount === baCount,
    },
    dryRun,
    preflightUnpaid,
    preflightPaid,
    providerCalls: 0,
  };

  return { ...base, preregistrationDigest: computePreregistrationDigest(base) };
}

/** The schema/version the plan and pre-registration share, so a resume of a
 *  different scheduler cannot be mistaken for this experiment. */
export { PAIRED_PLAN_SCHEMA_VERSION };