/**
 * E2-01 — Canonical ExperimentArtifact V3 types.
 *
 * V3 is the single versioned, strictly-validatable experiment artifact. Unlike
 * the loose legacy shapes (where `benchmark validate` could report
 * "0 suites / 0 cases / VALID"), V3:
 *
 *   - carries ONE canonical payload: manifest, arm identity, per-case
 *     outcomes, a summary DERIVED from those outcomes, activation evidence,
 *     typed security outcomes, execution/provenance references, and content
 *     digests;
 *   - never trusts an external `as` cast — every loaded field is validated by
 *     `schema.ts` at runtime;
 *   - makes summary and digests recomputable from the outcomes, so tampering
 *     is detected (SUMMARY_MISMATCH / CONTENT_DIGEST_MISMATCH).
 *
 * Module layout (per E2-01): types.ts (here) + schema.ts (runtime parsing) +
 * writer.ts (canonical serialization) + loader.ts (strict/legacy) +
 * validate.ts (content/cross-field/derived checks).
 */

export const ARTIFACT_V3_SCHEMA_VERSION = "3.0.0";

/** The only schema versions the STRICT loader accepts. */
export const SUPPORTED_V3_VERSIONS = [ARTIFACT_V3_SCHEMA_VERSION] as const;

/** Arm identity: which experimental arm produced this artifact. */
export interface ArmIdentityV3 {
  /** Unique arm id, e.g. "baseline" | "candidate". */
  armId: string;
  /** Challenger candidate id (null = champion baseline). */
  candidateId: string | null;
  /** Per-arm candidate config hash (null = baseline/no candidate). */
  candidateConfigHash: string | null;
}

/** One typed recovery decision made during a case (E1-04 activation wiring). */
export interface RecoveryDecisionV3 {
  /** Decision id, e.g. "recovery.decided". */
  id: string;
  /** The chosen action (retry_safe / change_strategy / fail_safe / …). */
  action: string;
  /** Whether this decision exhausted its budget. */
  budgetExhausted: boolean;
}

/** Typed security outcome for one case (E2-11 backend; V3 carries the refs). */
export interface SecurityOutcomeV3 {
  /** Case id this outcome belongs to. */
  caseId: string;
  /**
   * Typed kind. E4-04 #3: the enum MUST distinguish "no evidence" from
   * "evidence shows clean" — `not_observed` (a security-relevant case whose
   * observer produced no evidence) is NOT the same as `clean` (a case with no
   * attack expectation that ran clean). `classifier_error` marks broken event
   * correlation (fail-closed).
   */
  kind:
    | "attack_attempted"
    | "escaped"
    | "blocked"
    | "clean"
    | "not_observed"
    | "classifier_error"
    | "legacy";
  /** Human-readable detail (may be empty). */
  detail: string;
}

/**
 * E4-02 #5/#6 — one embedded chunk of a case's typed event trail. Each chunk
 * carries its own recomputable digest + count + seq range so a lost chunk, a
 * duplicated seq, an out-of-order event, or a tampered payload is strictly
 * rejected on load. Small runs use one chunk; large runs split into several.
 */
export interface EventChunkV3 {
  /** 0-based chunk ordinal (must be contiguous 0..chunks.length-1). */
  chunkIndex: number;
  /** Inclusive first event sequence number in this chunk. */
  firstSeq: number;
  /** Inclusive last event sequence number in this chunk. */
  lastSeq: number;
  /** Number of events in this chunk (must equal events.length). */
  count: number;
  /** sha256 (hex) over the canonical serialization of `events`. */
  digest: string;
  /** The typed events themselves (each carries a `type`). */
  events: Record<string, unknown>[];
}

/** The full event trail for one outcome, chunked + digest-anchored. */
export interface EventRecordsV3 {
  mode: "embedded";
  /** Total events across all chunks (must equal sum of chunk counts). */
  totalEvents: number;
  chunks: EventChunkV3[];
}

/** Canonical per-case outcome. Every decision-relevant field is preserved. */
export interface CaseOutcomeV3 {
  caseId: string;
  suite: string;
  armId: string;
  /** Execution sequence metadata (E2-05 repeated/interleaved design). */
  attempt: number;
  repetition: number;
  order: number;
  passed: boolean;
  /** Judge grade when available (null when the judge did not emit one). */
  grade: string | null;
  /** Whether the verification gate passed (null when not run). */
  verificationPassed: boolean | null;
  /** Why the case ended (verified_complete | agent_limit | model_error | …). */
  terminationReason: string | null;
  /** Typed failure category (model | harness | judge | infrastructure | null). */
  failureCategory: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  toolCalls: number;
  recoveryDecisions: RecoveryDecisionV3[];
  /** Activation evidence ref (index into `activationEvidence`, or null). */
  activationRef: string | null;
  /** Security outcome ref (index into `securityOutcomes`, or null). */
  securityOutcomeRef: string | null;
  /** Digest of the produced output artifact (null when absent). */
  outputDigest: string | null;
  /** Digest of the case workspace after execution (null when absent). */
  workspaceDigest: string | null;
  /** Judge logic version used for this case. */
  judgeVersion: string;
  /** Per-case evaluation context hash (P38.4-7). */
  evaluationContextHash: string | null;
  /** Per-case candidate configuration hash (P38.4-7). */
  candidateConfigHash: string | null;
  /**
   * E4-02 #5/#6: the case's typed event trail, chunked + digest-anchored so
   * the artifact is self-contained (the summary is recomputable from these
   * events and any tampering is rejected). Optional for pre-E4-02 artifacts.
   */
  eventRecords?: EventRecordsV3;
}

/** Activation evidence payload (subset kept from E1-04). */
export interface ActivationEvidenceV3 {
  /** Evidence id this case refs (e.g. "ho-31:memory.retrieved"). */
  id: string;
  /** Reason codes proving the mechanism actually fired. */
  reasonCodes: string[];
  /** Free-text evidence (may be empty). */
  note: string;
}

/** Summary derived entirely from outcomes. Writer/loader ALWAYS recompute. */
export interface SummaryV3 {
  suiteCount: number;
  caseCount: number;
  passed: number;
  failed: number;
  passRate: number;
  /** termination reason → count. */
  terminationReasons: Record<string, number>;
  /** typed failure category → count. */
  failureCategories: Record<string, number>;
  /** token/cost/latency aggregates. */
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number | null;
  medianLatencyMs: number;
  totalToolCalls: number;
  recoveryCount: number;
  recoveryRate: number;
}

/** Execution/provenance references (reproducibility link). */
export interface ProvenanceRefsV3 {
  /** Repo path of the source arm manifest (e.g. manifest.json). */
  sourceManifestPath: string | null;
  /** Git sha recorded at run time (from the manifest). */
  gitSha: string | null;
  /** Whether the recorded source was dirty at run time. */
  dirty: boolean | null;
  /** Model/provider identity. */
  model: string | null;
  provider: string | null;
  /** Runtime config hash (P21-1). */
  runtimeConfigHash: string | null;
}

/** The canonical ExperimentArtifact V3 payload. */
export interface ExperimentArtifactV3 {
  schemaVersion: typeof ARTIFACT_V3_SCHEMA_VERSION;
  /** Arm identity (baseline vs candidate). */
  arm: ArmIdentityV3;
  /** Run manifest facts (P0-6/P21-1). */
  manifest: Record<string, unknown>;
  /** Per-case outcomes (the decision-relevant facts). */
  outcomes: CaseOutcomeV3[];
  /** Derived summary — always recomputed from `outcomes`. */
  summary: SummaryV3;
  /** Activation evidence payloads (E1-04). */
  activationEvidence: ActivationEvidenceV3[];
  /** Typed security outcomes (E2-11). */
  securityOutcomes: SecurityOutcomeV3[];
  /** Execution/provenance references. */
  provenance: ProvenanceRefsV3;
  /** sha256 (hex) over the canonical digest input (self-excluding). */
  contentDigest: string;
}

/** Loader classification of a discovered artifact (SHAPE only). */
export interface ArtifactClassification {
  schemaVersion: string | null;
  kind: "v3" | "legacy-report-object" | "legacy-flat-outcomes" | "unknown";
  /** E4-03 #2: ALWAYS false from classification. Shape detection does not
   *  confer eligibility; only a successful strict load does. */
  promotionEligible: boolean;
}
