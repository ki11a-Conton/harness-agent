/**
 * E2-04 — Causal Activation Evidence V2.
 *
 * V1 (E1-04) carried hard-coded "digests" like "no-memory" or
 * "deferred-schema+tool_lookup" — strings that prove nothing about what the
 * model actually saw. V2 replaces self-declaration with evidence captured at
 * the real execution point:
 *
 *   - every activation event is RECORDED where the fact happened (memory
 *     block injection, subagent dispatch, recovery decision, tool
 *     advertisement, model-visible context digest), carrying the ACTUAL
 *     sanitized payload digest + case/arm/repetition/attempt lineage;
 *   - a CLI candidate-name branch that only flips a flag but changes no real
 *     request surfaces as a SELF_REPORTED_ACTIVATION and is REJECTED;
 *   - memory with a seeded source but an EMPTY injection is
 *     eligibleButNotActivated — never activated;
 *   - lineage must match the outcome (same case/attempt/repetition), else
 *     LINEAGE_MISMATCH;
 *   - quality attribution reports all-pairs / eligible-pairs /
 *     activated-pairs effects separately, so a candidate that wins only on
 *     ineligible or unactivated cases never claims mechanism causality.
 *
 * Module layout: schema + event types (here), recorders + validator +
 * aggregator + quality attribution. V1 stays in activation-evidence.ts for
 * legacy compat; this module is the promotion-grade path.
 */

export const ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

export type ActivationMechanism =
  | "memory"
  | "recovery"
  | "tool-schema"
  | "subagent"
  | "context"
  | "prompt-guidance";

export type ActivationEvidenceType =
  | "memory-block-injected"
  | "memory-store-seeded"
  | "recovery-decided"
  | "tool-schema-advertised"
  | "subagent-dispatched"
  | "context-selection"
  | "prompt-guidance-injected";

/** Lineage tying an activation event to the exact outcome it contributed to. */
export interface ActivationLineageV2 {
  caseId: string;
  armId: string;
  attempt: number;
  repetition: number;
}

/** Sanitized payload — counts, digests, category ids; NEVER raw secrets or
 *  full prompts. */
export interface ActivationPayloadV2 {
  /** Canonical digest of the actual model-visible/decision input (recomputed
   *  by the validator, never a hard-coded string). */
  digest: string;
  /** Entry count when the payload is a set (memory blocks, tool schema). */
  entryCount?: number;
  /** Source categories (memory source labels, tool names). */
  sourceCategories?: string[];
  /** Recovery planner policy id. */
  policyId?: string;
  /** Recovery action chosen. */
  action?: string;
  /** Recovery budget snapshot. */
  budget?: number;
  /** Prompt-guidance injected-block length. */
  blockLength?: number;
}

export interface ActivationEventV2 {
  /** Globally unique event id. */
  eventId: string;
  schemaVersion: typeof ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION;
  /** Candidate the event belongs to (the ARM under test). */
  candidateId: string;
  mechanism: ActivationMechanism;
  evidenceType: ActivationEvidenceType;
  lineage: ActivationLineageV2;
  payload: ActivationPayloadV2;
}

export interface ActivationEventV2Source {
  event: ActivationEventV2;
  /** Raw canonical input the digest was computed from (for recomputation).
   *  Optional at capture; required for validator recompute checks. */
  digestSource?: unknown;
}

// ---------------------------------------------------------------------------
// Recorders (called AT the fact site, never from the candidate-name branch)
// ---------------------------------------------------------------------------

export interface ActivationRecorderV2 {
  record(event: ActivationEventV2): void;
  events(): ActivationEventV2[];
}

export function createActivationRecorderV2(): ActivationRecorderV2 {
  const events: ActivationEventV2[] = [];
  return {
    record(event: ActivationEventV2): void {
      events.push(event);
    },
    events(): ActivationEventV2[] {
      return [...events];
    },
  };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ActivationValidationCode =
  | "DUPLICATE_EVENT_ID"
  | "CROSS_CASE_EVENT"
  | "CROSS_CANDIDATE_EVENT"
  | "UNKNOWN_SCHEMA_VERSION"
  | "DIGEST_MISSING"
  | "DIGEST_MISMATCH"
  | "LINEAGE_MISMATCH"
  | "SELF_REPORTED_ACTIVATION"
  | "EMPTY_MEMORY_INJECTION"
  | "INVALID_MECHANISM"
  | "INVALID_EVIDENCE_TYPE";

export interface ActivationValidationIssue {
  code: ActivationValidationCode;
  eventId: string | null;
  detail: string;
}

export interface ActivationValidationResultV2 {
  ok: boolean;
  issues: ActivationValidationIssue[];
}

const MECHANISMS: ActivationMechanism[] = ["memory", "recovery", "tool-schema", "subagent", "context", "prompt-guidance"];
const EVIDENCE_TYPES: ActivationEvidenceType[] = [
  "memory-block-injected",
  "memory-store-seeded",
  "recovery-decided",
  "tool-schema-advertised",
  "subagent-dispatched",
  "context-selection",
  "prompt-guidance-injected",
];

/** Outcome lineage the events must match (from the run artifact). */
export interface OutcomeLineageV2 {
  caseId: string;
  armId: string;
  attempt: number;
  repetition: number;
}

/**
 * Validate a captured activation-event set.
 *
 * @param events     captured events
 * @param opts.expectedCandidateId candidate id every event must belong to
 * @param opts.expectedArmId       arm id every event must belong to
 * @param opts.outcomeLineages     map caseId -> known outcome lineages
 * @param opts.recomputeDigest     (event, digestSource) => sha256 — returns the
 *                                 recomputed digest; when provided, DIGEST_MISMATCH
 *                                 is detected for events carrying digestSource
 */
export function validateActivationV2(
  events: ActivationEventV2[],
  opts: {
    expectedCandidateId: string;
    expectedArmId: string;
    outcomeLineages?: Map<string, OutcomeLineageV2[]>;
    recomputeDigest?: (event: ActivationEventV2, source: unknown) => string;
    digestSources?: Map<string, unknown>;
  } = { expectedCandidateId: "", expectedArmId: "" },
): ActivationValidationResultV2 {
  const issues: ActivationValidationIssue[] = [];
  const seen = new Set<string>();

  for (const e of events) {
    // Unknown schema version.
    if (e.schemaVersion !== ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION) {
      issues.push({ code: "UNKNOWN_SCHEMA_VERSION", eventId: e.eventId, detail: `got "${e.schemaVersion}", expected "${ACTIVATION_EVIDENCE_V2_SCHEMA_VERSION}"` });
    }
    // Duplicate event id.
    if (seen.has(e.eventId)) {
      issues.push({ code: "DUPLICATE_EVENT_ID", eventId: e.eventId, detail: `duplicate eventId "${e.eventId}"` });
    }
    seen.add(e.eventId);

    // Cross-candidate / wrong arm.
    if (e.candidateId !== opts.expectedCandidateId) {
      issues.push({ code: "CROSS_CANDIDATE_EVENT", eventId: e.eventId, detail: `event candidate "${e.candidateId}" != expected "${opts.expectedCandidateId}"` });
    }
    if (e.lineage.armId !== opts.expectedArmId) {
      issues.push({ code: "CROSS_CASE_EVENT", eventId: e.eventId, detail: `event arm "${e.lineage.armId}" != expected "${opts.expectedArmId}"` });
    }

    // Mechanism/evidence-type validity.
    if (!MECHANISMS.includes(e.mechanism)) {
      issues.push({ code: "INVALID_MECHANISM", eventId: e.eventId, detail: `unknown mechanism "${e.mechanism}"` });
    }
    if (!EVIDENCE_TYPES.includes(e.evidenceType)) {
      issues.push({ code: "INVALID_EVIDENCE_TYPE", eventId: e.eventId, detail: `unknown evidenceType "${e.evidenceType}"` });
    }

    // Digest presence.
    if (e.payload.digest === undefined || e.payload.digest === null || e.payload.digest === "") {
      issues.push({ code: "DIGEST_MISSING", eventId: e.eventId, detail: "payload digest is empty — hard-coded/self-reported activation" });
    }

    // Lineage consistency with outcomes.
    const known = opts.outcomeLineages?.get(e.lineage.caseId);
    if (known !== undefined && known.length > 0) {
      const matches = known.some(
        (o) => o.armId === e.lineage.armId && o.attempt === e.lineage.attempt && o.repetition === e.lineage.repetition,
      );
      if (!matches) {
        issues.push({
          code: "LINEAGE_MISMATCH",
          eventId: e.eventId,
          detail: `event lineage (${e.lineage.caseId}/${e.lineage.armId}/a${e.lineage.attempt}/r${e.lineage.repetition}) matches no known outcome lineage`,
        });
      }
    }

    // Recompute digest when a source is available — proves the digest is not
    // a hard-coded string.
    const source = opts.digestSources?.get(e.eventId);
    if (source !== undefined && opts.recomputeDigest !== undefined) {
      const recomputed = opts.recomputeDigest(e, source);
      if (recomputed !== e.payload.digest) {
        issues.push({
          code: "DIGEST_MISMATCH",
          eventId: e.eventId,
          detail: `recomputed digest ${recomputed} != recorded ${e.payload.digest}`,
        });
      }
    }

    // Empty memory injection while a seed exists: eligible but NOT activated.
    if (e.evidenceType === "memory-block-injected" && (e.payload.entryCount ?? 0) === 0) {
      issues.push({ code: "EMPTY_MEMORY_INJECTION", eventId: e.eventId, detail: "memory source existed but injection was empty — eligibleButNotActivated, never activated" });
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export interface ActivationAggregationV2 {
  /** Number of events proving real activation. */
  activated: number;
  /** Eligible cases (by contract) but no real activation event. */
  eligibleButNotActivated: number;
  /** Cases not eligible for this mechanism. */
  ineligible: number;
  /** Events that failed validation (duplicate/cross/digest/lineage). */
  invalid: number;
  /** Legacy/unknown evidence that cannot be classified. */
  unknownLegacy: number;
}

export interface EligibilityMapV2 {
  /** caseId -> whether the case is ELIGIBLE for the candidate's mechanism. */
  eligible: Map<string, boolean>;
}

/**
 * Aggregate validated events with per-case eligibility. `events` should be the
 * VALIDATED set; invalid events are counted as `invalid` and excluded from
 * activation (fail-closed — never silently zeroed).
 */
export function aggregateActivationV2(
  events: ActivationEventV2[],
  eligibility: EligibilityMapV2,
  validation: ActivationValidationResultV2,
): ActivationAggregationV2 {
  const invalidIds = new Set(validation.issues.filter((i) => i.eventId !== null).map((i) => i.eventId!));
  let activated = 0;
  let eligibleButNotActivated = 0;
  let invalid = 0;
  const activatedCaseIds = new Set<string>();
  const eligibleIds = new Set(
    [...eligibility.eligible.entries()].filter(([, ok]) => ok).map(([id]) => id),
  );

  for (const e of events) {
    if (invalidIds.has(e.eventId) || e.mechanism === undefined) {
      invalid += 1;
      continue;
    }
    if (!eligibleIds.has(e.lineage.caseId)) {
      // Ineligible case — not part of the mechanism denominator.
      continue;
    }
    activated += 1;
    activatedCaseIds.add(e.lineage.caseId);
  }

  for (const id of eligibleIds) {
    if (!activatedCaseIds.has(id)) eligibleButNotActivated += 1;
  }
  invalid += validation.issues.length;

  return {
    activated,
    eligibleButNotActivated,
    ineligible: eligibility.eligible.size - eligibleIds.size,
    invalid,
    unknownLegacy: 0,
  };
}

// ---------------------------------------------------------------------------
// Quality attribution (all-pairs / eligible-pairs / activated-pairs)
// ---------------------------------------------------------------------------

export interface PairOutcomeV2 {
  caseId: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  /** Whether the case is eligible for the mechanism. */
  eligible: boolean;
  /** Whether the case actually shows an activation event. */
  activated: boolean;
}

export interface QualityAttributionV2 {
  /** Wins across ALL pairs (any case). */
  allPairs: { wins: number; losses: number; netDelta: number };
  /** Wins on ELIGIBLE pairs only. */
  eligiblePairs: { wins: number; losses: number; netDelta: number };
  /** Wins on ACTIVATED pairs only. */
  activatedPairs: { wins: number; losses: number; netDelta: number };
  /** True only when eligible/activated pair evidence supports the mechanism. */
  mechanismCausalSupported: boolean;
}

/** Attribute wins to mechanism causality per E2-04 #5/#7: a candidate that
 *  wins only on ineligible or unactivated cases never claims causality. */
export function attributeQualityV2(pairs: PairOutcomeV2[]): QualityAttributionV2 {
  const all = { wins: 0, losses: 0, netDelta: 0 };
  const eligible = { wins: 0, losses: 0, netDelta: 0 };
  const activated = { wins: 0, losses: 0, netDelta: 0 };

  for (const p of pairs) {
    const d = (p.candidatePassed ? 1 : 0) - (p.baselinePassed ? 1 : 0);
    all.netDelta += d;
    if (d > 0) all.wins += 1;
    else if (d < 0) all.losses += 1;
    if (p.eligible) {
      eligible.netDelta += d;
      if (d > 0) eligible.wins += 1;
      else if (d < 0) eligible.losses += 1;
    }
    if (p.activated) {
      activated.netDelta += d;
      if (d > 0) activated.wins += 1;
      else if (d < 0) activated.losses += 1;
    }
  }

  const mechanismCausalSupported = eligible.netDelta > 0 && activated.netDelta > 0;
  return { allPairs: all, eligiblePairs: eligible, activatedPairs: activated, mechanismCausalSupported };
}