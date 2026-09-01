/**
 * E2-14 — MechanismContract: offline causal readiness for every candidate.
 *
 * Before ANY model money is spent, each candidate must prove, from the REAL
 * production ArmFactory + runner wiring (never a registry JSON patch):
 *
 *   1. it changes a real runtime / model-visible surface (no-op fails);
 *   2. which cases are ELIGIBLE to observe that change;
 *   3. the baseline does NOT already have the same mechanism on those cases;
 *   4. what EVENT counts as "activated" (+ a digest-consistent proof);
 *   5. what outcome is attributable vs overall noise.
 *
 * A candidate that fails its contract is NOT_READY / UNSUPPORTED and is
 * barred from the E2-15 paid preflight — provider calls = 0.
 *
 * Everything here is PURE / offline: no provider, no API key, no network.
 */

import { getArmFactory, type ResolvedArmSnapshot } from "./arm-factory.js";
import { getCandidateRegistry } from "./candidate-registry.js";

export const MECHANISM_CONTRACT_SCHEMA_VERSION = "1.0.0";

export type Readiness =
  | "READY"
  | "NOT_READY"
  | "UNSUPPORTED"; // no real wiring branch (CANDIDATE_UNSUPPORTED)

export interface MechanismContract {
  schemaVersion: string;
  candidateId: string;
  /** What real runtime/model-visible surface this candidate changes. */
  modelVisibleSurface: string;
  /** How a case qualifies to observe the change. */
  eligibilityRule: string;
  /** Minimum eligible cases required to schedule a promotion run. */
  minEligibleCases: number;
  /** Expected failure cluster this candidate targets. */
  expectedFailureCluster: string;
  /** Event(s) that prove activation (typed, from the run path). */
  requiredActivationEvents: string[];
  /** Conditions that make the candidate a no-op (forbidden). */
  forbiddenNoOpConditions: string[];
}

export interface ContractEvaluation {
  schemaVersion: string;
  candidateId: string;
  /** Baseline arm snapshot (REAL config, not a patch). */
  baselineState: {
    mechanismOn: boolean;
    surfaceDigest: string | null;
    summary: string;
  };
  /** Candidate arm snapshot (REAL config). */
  candidateState: {
    mechanismOn: boolean;
    surfaceDigest: string | null;
    summary: string;
  };
  /** Eligible cases (by the contract's eligibility rule). */
  eligibleCases: number;
  minEligibleCases: number;
  /** Real causal delta within the declared surface. */
  hasRealDelta: boolean;
  /** Activation observable wiring present (constructor identity + config
   *  digest — the E2-04 V2 recorder wires the real event). */
  activationWired: boolean;
  /** Whether the candidate supplies the required activation events. */
  activationEventsPresent: boolean;
  /** No-op detection: real delta absent OR baseline already has the
   *  mechanism (causal contamination — the F-08 defect). */
  baselineContamination: boolean;
  readiness: Readiness;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const CONTRACTS: Record<string, MechanismContract> = {
  adaptive_recovery_v2: {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId: "adaptive_recovery_v2",
    modelVisibleSurface: "recovery planner wired into the runtime recovery path (conservative-v1)",
    eligibilityRule: "case that can hit a recoverable failure at least once",
    minEligibleCases: 5,
    expectedFailureCluster: "agent_limit / model_error",
    requiredActivationEvents: ["recovery.decided"],
    forbiddenNoOpConditions: ["baseline already uses adaptiveRecovery"],
  },
  memory_retrieval: {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId: "memory_retrieval",
    modelVisibleSurface: "pre-turn memory blocks injected into the model context",
    eligibilityRule: "case with a non-empty seeded memory source",
    minEligibleCases: 3,
    expectedFailureCluster: "verification_failed (missing prior context)",
    requiredActivationEvents: ["memory.retrieved", "memory-block-injected"],
    forbiddenNoOpConditions: ["baseline already injects memory", "candidate memory store is empty"],
  },
  delegation: {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId: "delegation",
    modelVisibleSurface: "subagent dispatch tools + real child agent results",
    eligibilityRule: "case that requires subagent delegation",
    minEligibleCases: 3,
    expectedFailureCluster: "tool_limit (oversized goals)",
    requiredActivationEvents: ["subagent.started", "subagent.completed"],
    forbiddenNoOpConditions: ["no real subagent wiring (registry unsupported)", "baseline already dispatches subagents"],
  },
  budget_aware_completion_v1: {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId: "budget_aware_completion_v1",
    modelVisibleSurface: "step-budget completion guidance present in the final model-visible messages",
    eligibilityRule: "case with a bounded iteration budget (long task)",
    minEligibleCases: 5,
    expectedFailureCluster: "agent_limit (budget exhaustion)",
    requiredActivationEvents: ["budget-guidance-injected"],
    forbiddenNoOpConditions: ["guidance only logged in CLI, absent from model-visible messages"],
  },
  tool_selector_deferred_schema: {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId: "tool_selector_deferred_schema",
    modelVisibleSurface: "advertised tool schema set (deferred full schemas)",
    eligibilityRule: "case that benefits from tool schema discovery (tool_lookup)",
    minEligibleCases: 3,
    expectedFailureCluster: "context_overflow (schema bloat)",
    requiredActivationEvents: ["tool_lookup.called"],
    forbiddenNoOpConditions: ["advertised schema set identical to baseline"],
  },
};

export function mechanismContractFor(candidateId: string): MechanismContract | undefined {
  return CONTRACTS[candidateId];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  /** caseId -> whether the case satisfies the contract's eligibility rule. */
  eligible: Map<string, boolean>;
}

export interface ActivationWiringInput {
  /** candidateId -> whether the E2-04 V2 recorder/observer is wired for the
   *  candidate's real activation events. */
  wired: Record<string, boolean>;
  /** candidateId -> map of required event type -> observed present. */
  requiredEvents?: Record<string, Record<string, boolean>>;
}

/**
 * Evaluate one candidate's offline causal readiness against its contract.
 * Uses the PRODUCTION ArmFactory (real config + constructor identity), the
 * real registry wiring, and the caller's eligibility/activation facts —
 * nothing is self-reported by a CLI candidate branch.
 */
export function evaluateMechanismContract(
  candidateId: string,
  eligibility: EligibilityInput,
  activation: ActivationWiringInput,
  opts: { minEligibleOverride?: number } = {},
): ContractEvaluation {
  const contract = CONTRACTS[candidateId];
  const reasons: string[] = [];
  if (contract === undefined) {
    return {
      schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
      candidateId,
      baselineState: { mechanismOn: false, surfaceDigest: null, summary: "no contract defined" },
      candidateState: { mechanismOn: false, surfaceDigest: null, summary: "no contract defined" },
      eligibleCases: 0,
      minEligibleCases: 0,
      hasRealDelta: false,
      activationWired: false,
      activationEventsPresent: false,
      baselineContamination: false,
      readiness: "UNSUPPORTED",
      reasons: [`no mechanism contract for ${candidateId}`],
    };
  }

  const registry = getCandidateRegistry();
  const registration = registry.find(candidateId);
  if (registration === undefined || registration.status === "unsupported") {
    return {
      schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
      candidateId,
      baselineState: { mechanismOn: false, surfaceDigest: null, summary: "registry: unsupported" },
      candidateState: { mechanismOn: false, surfaceDigest: null, summary: "registry: unsupported" },
      eligibleCases: eligibility.eligible.size,
      minEligibleCases: contract.minEligibleCases,
      hasRealDelta: false,
      activationWired: false,
      activationEventsPresent: false,
      baselineContamination: false,
      readiness: "UNSUPPORTED",
      reasons: [`candidate ${candidateId} is declared UNSUPPORTED (no real wiring branch)`],
    };
  }

  const factory = getArmFactory();
  let baseline: ResolvedArmSnapshot;
  let candidate: ResolvedArmSnapshot;
  try {
    baseline = factory.resolveBaseline();
    candidate = factory.resolveCandidate(candidateId);
  } catch (err) {
    return {
      schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
      candidateId,
      baselineState: { mechanismOn: false, surfaceDigest: null, summary: "arm resolution failed" },
      candidateState: { mechanismOn: false, surfaceDigest: null, summary: "arm resolution failed" },
      eligibleCases: eligibility.eligible.size,
      minEligibleCases: contract.minEligibleCases,
      hasRealDelta: false,
      activationWired: false,
      activationEventsPresent: false,
      baselineContamination: false,
      readiness: "UNSUPPORTED",
      reasons: [`arm resolution failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // The candidate's mechanism activation plan (real wiring).
  const activationOf = (arm: ResolvedArmSnapshot, id: string) =>
    arm.mechanisms.activations.find((m) => m.mechanism === id);
  const baseAct = activationOf(baseline, candidateId);
  const candAct = activationOf(candidate, candidateId);

  // E2-14 #4: a candidate whose REAL wiring is an unsupported stub (no actual
  // mechanism branch — e.g. delegation without subagent dispatch) is
  // UNSUPPORTED, exactly like the ArmFactory preflight (CANDIDATE_UNSUPPORTED).
  if (candAct !== undefined && candAct.constructorIdentity !== null && candAct.constructorIdentity.startsWith("unsupported:")) {
    return {
      schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
      candidateId,
      baselineState: { mechanismOn: baseAct?.on === true, surfaceDigest: baseline.digest, summary: baseline.armId },
      candidateState: { mechanismOn: false, surfaceDigest: candidate.digest, summary: candidate.armId },
      eligibleCases: eligibility.eligible.size,
      minEligibleCases: contract.minEligibleCases,
      hasRealDelta: false,
      activationWired: activation.wired[candidateId] === true,
      activationEventsPresent: false,
      baselineContamination: baseAct?.on === true,
      readiness: "UNSUPPORTED",
      reasons: [`candidate ${candidateId} has no real wiring branch (${candAct.constructorIdentity}) — UNSUPPORTED, provider calls zero`],
    };
  }

  const baselineMechanismOn = baseAct?.on === true;
  const candidateMechanismOn = candAct?.on === true;
  const hasRealDelta = baseline.digest !== candidate.digest && candidateMechanismOn;
  const baselineContamination = baselineMechanismOn; // baseline must NOT have the mechanism
  const eligibleCases = eligibility.eligible.size;
  const minEligible = opts.minEligibleOverride ?? contract.minEligibleCases;
  const activationWired = activation.wired[candidateId] === true;
  const eventsForCandidate = activation.requiredEvents?.[candidateId];
  const activationEventsPresent =
    eventsForCandidate !== undefined
    && contract.requiredActivationEvents.every((e) => eventsForCandidate[e] === true);

  if (registry.find(candidateId)!.status === "unsupported") {
    return {
      schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
      candidateId,
      baselineState: { mechanismOn: baselineMechanismOn, surfaceDigest: baseline.digest, summary: baseline.armId },
      candidateState: { mechanismOn: candidateMechanismOn, surfaceDigest: candidate.digest, summary: candidate.armId },
      eligibleCases,
      minEligibleCases: minEligible,
      hasRealDelta,
      activationWired,
      activationEventsPresent,
      baselineContamination,
      readiness: "UNSUPPORTED",
      reasons: ["registry declares candidate UNSUPPORTED"],
    };
  }

  const readinessReasons: string[] = [];
  if (!hasRealDelta) readinessReasons.push("no real causal delta (arm digest identical or mechanism off)");
  if (baselineContamination) readinessReasons.push("baseline already enables the mechanism (causal contamination — F-08)");
  if (eligibleCases < minEligible) readinessReasons.push(`eligible cases ${eligibleCases} < minimum ${minEligible}`);
  if (!activationWired) readinessReasons.push("activation recorder not wired for the candidate's real events");
  if (!activationEventsPresent) readinessReasons.push(`required activation events absent: ${contract.requiredActivationEvents.join(", ")}`);

  const readiness: Readiness = readinessReasons.length === 0 ? "READY" : "NOT_READY";
  return {
    schemaVersion: MECHANISM_CONTRACT_SCHEMA_VERSION,
    candidateId,
    baselineState: { mechanismOn: baselineMechanismOn, surfaceDigest: baseline.digest, summary: baseline.armId },
    candidateState: { mechanismOn: candidateMechanismOn, surfaceDigest: candidate.digest, summary: candidate.armId },
    eligibleCases,
    minEligibleCases: minEligible,
    hasRealDelta,
    activationWired,
    activationEventsPresent,
    baselineContamination,
    readiness,
    reasons: readinessReasons,
  };
}

/** Build the full readiness matrix across all contracted candidates. */
export function buildReadinessMatrix(
  eligibility: Record<string, EligibilityInput>,
  activation: Record<string, ActivationWiringInput>,
): ContractEvaluation[] {
  return Object.keys(CONTRACTS).map((id) =>
    evaluateMechanismContract(id, eligibility[id] ?? { eligible: new Map() }, activation[id] ?? { wired: {} }),
  );
}

/** Can this candidate be scheduled for a PAID promotion run (preflight)? */
export function paidPreflightAllowed(evaluation: ContractEvaluation): boolean {
  return evaluation.readiness === "READY";
}

export interface ReadinessRow {
  candidateId: string;
  baselineMechanismOn: boolean;
  candidateMechanismOn: boolean;
  eligibleFixture: string;
  activationProof: string;
  readiness: Readiness;
}

/** The machine-readable readiness matrix (E2-14 deliverable table shape). */
export function readinessMatrixTable(evaluations: ContractEvaluation[]): ReadinessRow[] {
  return evaluations.map((e) => ({
    candidateId: e.candidateId,
    baselineMechanismOn: e.baselineState.mechanismOn,
    candidateMechanismOn: e.candidateState.mechanismOn,
    eligibleFixture: `${e.eligibleCases} eligible case(s) (min ${e.minEligibleCases})`,
    activationProof: e.activationEventsPresent ? "required events present" : "activation events MISSING",
    readiness: e.readiness,
  }));
}