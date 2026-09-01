/**
 * E1-04 — mechanism activation evidence.
 *
 * Promotion-quality evidence must come from the RUN PATH, not from a candidate
 * id or a self-reported feature flag. Every case records whether the candidate
 * mechanism was eligible, whether it actually activated, how many times, and a
 * sanitized summary. A case with 0 activations (or where activation cannot be
 * observed) must be INVALID/INCONCLUSIVE for promotion — never ACCEPT.
 *
 * Activation evidence is gathered from real execution points (tool requests,
 * context construction, recovery decisions) by an observer wired into the
 * runner — the runner never writes `activated=true` from the candidate name.
 */

export const ACTIVATION_EVIDENCE_SCHEMA_VERSION = "1.0.0";

export type ActivationReasonCode =
  | "mechanism_wired"
  | "tool_lookup_registered"
  | "tool_lookup_called"
  | "schema_stubbed"
  | "schema_advert_deferred"
  | "memory_store_seeded"
  | "memory_retrieved"
  | "memory_block_injected"
  | "recovery_decision"
  | "context_dynamic_allocated"
  | "context_dynamic_used"
  | "budget_guidance_injected"
  | "eligible_case"
  | "not_eligible_no_seed"
  | "not_eligible_no_mechanism"
  | "not_observable"
  | "activation_zero";

/** Mechanism-specific activation contract (versioned, machine-readable). */
export interface ActivationContract {
  candidateId: string;
  schemaVersion: string;
  /** Minimum fraction of eligible cases that must actually activate. */
  minActivatedCoverage: number;
  /** Minimum number of eligible cases the experiment must contain. */
  minEligibleCases: number;
}

/**
 * Per-case activation evidence. Summaries are sanitized (counts + digests
 * only) — never raw prompts, full memory text, or secrets.
 */
export interface CandidateActivationEvidence {
  schemaVersion: string;
  candidateId: string;
  caseId: string;
  /** Whether the mechanism could possibly activate for this case. */
  eligible: boolean;
  /** Whether the mechanism actually activated during the run. */
  activated: boolean;
  activationCount: number;
  reasonCodes: ActivationReasonCode[];
  /** Mechanism-specific digest of what the model actually saw. */
  baselineMechanismDigest: string;
  candidateMechanismDigest: string;
  /** Sanitized mechanism-specific payload summary (no secrets/prompts). */
  summary?: Record<string, unknown>;
}

/** Aggregate activation coverage across a run. */
export interface ActivationCoverageSummary {
  schemaVersion: string;
  candidateId: string;
  eligible: number;
  activated: number;
  notActivated: number;
  unknown: number;
  /** activated / eligible — used by promotion gate. */
  coverage: number;
  /** Whether every eligible case that could not activate has an explanation. */
  allReasoned: boolean;
}

/** Build an empty (unobserved) evidence — fail-closed default. */
export function emptyActivationEvidence(
  candidateId: string,
  caseId: string,
  eligible: boolean,
  reason: ActivationReasonCode,
): CandidateActivationEvidence {
  return {
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    candidateId,
    caseId,
    eligible,
    activated: false,
    activationCount: 0,
    reasonCodes: [reason],
    baselineMechanismDigest: "",
    candidateMechanismDigest: "",
  };
}

/** Aggregate per-case activation evidence into a coverage summary. */
export function aggregateActivation(
  evidence: CandidateActivationEvidence[],
): ActivationCoverageSummary {
  let eligible = 0;
  let activated = 0;
  let notActivated = 0;
  let unknown = 0;
  let allReasoned = true;
  for (const e of evidence) {
    if (!e.eligible) continue;
    eligible += 1;
    if (e.activated) {
      activated += 1;
    } else {
      notActivated += 1;
      // An eligible-but-not-activated case is reasoned only if it carries an
      // explicit non-activation reason code (e.g. activation_zero).
      if (!e.reasonCodes.some((r) => r === "activation_zero" || r === "not_observable")) {
        allReasoned = false;
      }
    }
  }
  // Cases where activation is genuinely unobservable count toward unknown.
  // (A case with eligible=false is not part of the coverage denominator.)
  return {
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    candidateId: evidence[0]?.candidateId ?? "baseline",
    eligible,
    activated,
    notActivated,
    unknown,
    coverage: eligible === 0 ? 0 : activated / eligible,
    allReasoned,
  };
}

/** The default activation contracts for the wired candidates (E1-04). */
export const DEFAULT_ACTIVATION_CONTRACTS: ActivationContract[] = [
  {
    candidateId: "tool_selector_deferred_schema",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
  {
    candidateId: "memory_retrieval",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
  {
    candidateId: "adaptive_recovery",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
  {
    candidateId: "adaptive_recovery_v2",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
  {
    candidateId: "adaptive_context_policy",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
  {
    candidateId: "budget_aware_completion_v1",
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
    minActivatedCoverage: 0.5,
    minEligibleCases: 3,
  },
];

/** Find the activation contract for a candidate (undefined = no contract). */
export function activationContractFor(candidateId: string): ActivationContract | undefined {
  return DEFAULT_ACTIVATION_CONTRACTS.find((c) => c.candidateId === candidateId);
}

/** Does the run satisfy the candidate's activation contract? */
export function activationSatisfied(
  contract: ActivationContract | undefined,
  coverage: ActivationCoverageSummary,
): boolean {
  if (contract === undefined) return false;
  return coverage.eligible >= contract.minEligibleCases
    && coverage.coverage >= contract.minActivatedCoverage
    && coverage.allReasoned;
}

/** An observed execution-path signal for activation evidence collection. */
export interface ActivationObservation {
  type: string;
  payload?: Record<string, unknown>;
}

/** Input surface `activationEvidenceFor` needs from a case definition. */
export interface ActivationCaseSource {
  id: string;
  sources?: { memory?: readonly { content: string; type?: string }[] };
}

/**
 * E1-04 — mechanism activation evidence for one case. Derived from observed
 * execution events + actual wiring state, never from the candidate name:
 *
 * - tool_selector_deferred_schema: activated when the model actually CALLED
 *   tool_lookup (schema fetch observed in the run path).
 * - memory_retrieval: activated when the runtime emitted memory.retrieved.
 *   An empty store (no seed memory, candidate forced) never counts as
 *   activated — the mechanism saw nothing to retrieve.
 * - adaptive_recovery: activated when a recovery.decided event carried a
 *   planner action.
 * - adaptive_context_policy: activation is NOT observable via events (the
 *   dynamic budget is config-level) → reported not_observable, so the
 *   promotion gate treats it as unproven.
 */
export function activationEvidenceFor(
  candidateId: string,
  caseDef: ActivationCaseSource,
  activationEvents: ActivationObservation[],
): CandidateActivationEvidence {
  const hasSeedMemory = (caseDef.sources?.memory?.length ?? 0) > 0;
  switch (candidateId) {
    case "tool_selector_deferred_schema": {
      const calls = activationEvents.filter((e) => e.type === "tool_lookup_called");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: true,
        activated: calls.length > 0,
        activationCount: calls.length,
        reasonCodes: calls.length > 0 ? ["tool_lookup_called"] : ["activation_zero"],
        baselineMechanismDigest: "inline-full-schema",
        candidateMechanismDigest: "deferred-schema+tool_lookup",
        summary: { toolLookupCalls: calls.length },
      };
    }
    case "memory_retrieval": {
      const retrievals = activationEvents.filter((e) => e.type === "memory_retrieved");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: hasSeedMemory,
        activated: retrievals.length > 0,
        activationCount: retrievals.length,
        reasonCodes: hasSeedMemory
          ? (retrievals.length > 0 ? ["memory_retrieved"] : ["activation_zero"])
          : ["not_eligible_no_seed"],
        baselineMechanismDigest: "no-memory",
        candidateMechanismDigest: hasSeedMemory ? "memory-retrieval+seeded-store" : "memory-retrieval+empty-store",
        summary: { retrievalCount: retrievals.length, seeded: hasSeedMemory },
      };
    }
    case "adaptive_recovery": {
      const decisions = activationEvents.filter((e) => e.type === "recovery_decision");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: true,
        activated: decisions.length > 0,
        activationCount: decisions.length,
        reasonCodes: decisions.length > 0 ? ["recovery_decision"] : ["activation_zero"],
        baselineMechanismDigest: "fixed-recovery",
        candidateMechanismDigest: "adaptive-recovery-planner",
        summary: { recoveryDecisions: decisions.length },
      };
    }
    case "adaptive_recovery_v2": {
      const decisions = activationEvents.filter((e) => e.type === "recovery_decision");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: true,
        activated: decisions.length > 0,
        activationCount: decisions.length,
        reasonCodes: decisions.length > 0 ? ["recovery_decision"] : ["activation_zero"],
        baselineMechanismDigest: "fixed-recovery",
        candidateMechanismDigest: "adaptive-recovery-planner-v2-conservative",
        summary: { recoveryDecisions: decisions.length },
      };
    }
    case "adaptive_context_policy": {
      const allocations = activationEvents.filter((e) => e.type === "context_dynamic_used");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: true,
        activated: allocations.length > 0,
        activationCount: allocations.length,
        reasonCodes: ["not_observable"], // dynamic budget is config-level; no event exists
        baselineMechanismDigest: "fixed-budget",
        candidateMechanismDigest: "dynamic-budget-4096",
        summary: { observable: false },
      };
    }
    case "budget_aware_completion_v1": {
      // E1-13: activation is observed when the step-budget completion guidance
      // was actually injected into the agent's system prompt (a real wiring
      // decision made by the benchmark runner for this candidate). The
      // baseline digest is the standard benchmark prompt; the candidate digest
      // reflects the budget-aware completion guidance block.
      const injections = activationEvents.filter((e) => e.type === "budget_guidance_injected");
      return {
        schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
        candidateId,
        caseId: caseDef.id,
        eligible: true,
        activated: injections.length > 0,
        activationCount: injections.length,
        reasonCodes: injections.length > 0 ? ["budget_guidance_injected"] : ["activation_zero"],
        baselineMechanismDigest: "benchmark-standard-prompt",
        candidateMechanismDigest: "benchmark-prompt+step-budget-guidance",
        summary: { injectionCount: injections.length },
      };
    }
    default:
      return emptyActivationEvidence(candidateId, caseDef.id, false, "not_eligible_no_mechanism");
  }
}
