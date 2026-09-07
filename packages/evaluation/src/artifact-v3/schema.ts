/**
 * E2-01 — artifact-v3 runtime schema: parse & version discrimination.
 *
 * External JSON is NEVER `as`-cast into internal types. Every field is
 * validated at runtime by the functions here; a malformed artifact produces a
 * typed `ArtifactSchemaError` with a stable reason, never a silent cast.
 */

import {
  ARTIFACT_V3_SCHEMA_VERSION,
  type ArtifactClassification,
  type CaseOutcomeV3,
  type ExperimentArtifactV3,
} from "./types.js";

/** Stable schema-error reasons (also used as validator reason codes). */
export type SchemaErrorReason =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "SCHEMA_VALIDATION_FAILED"
  | "DUPLICATE_OUTCOME"
  | "MISSING_REQUIRED_FIELD"
  | "CONTENT_DIGEST_MISMATCH"
  | "SUMMARY_MISMATCH"
  | "DANGLING_REF"
  | "DUPLICATE_EVENT";

export class ArtifactSchemaError extends Error {
  readonly reason: SchemaErrorReason;
  readonly field: string;
  constructor(reason: SchemaErrorReason, field: string, detail: string) {
    super(`[${reason}] ${field}: ${detail}`);
    this.name = "ArtifactSchemaError";
    this.reason = reason;
    this.field = field;
  }
}

/**
 * Classify an arbitrary parsed JSON document by SHAPE (no throw — fail-closed
 * read). E4-03 #2: classification NEVER asserts promotion eligibility. A
 * document merely carrying schemaVersion "3.0.0" is classified as the "v3"
 * SHAPE, but `promotionEligible` is always false here — eligibility is granted
 * only by a SUCCESSFUL strict load (`loadExperimentArtifactV3`), which runs the
 * full field-level + cross-field + digest/summary validation. This closes the
 * "schemaVersion looks right ⇒ eligible" hole.
 */
export function classifyArtifact(value: unknown): ArtifactClassification {
  if (typeof value !== "object" || value === null) {
    return { schemaVersion: null, kind: "unknown", promotionEligible: false };
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion : null;
  if (schemaVersion === ARTIFACT_V3_SCHEMA_VERSION) {
    // Shape is V3, but eligibility requires a successful strict load (E4-03 #2).
    return { schemaVersion, kind: "v3", promotionEligible: false };
  }
  if (schemaVersion !== null) {
    return { schemaVersion, kind: "unknown", promotionEligible: false };
  }
  // Legacy shapes: report object {results:[...]} or flat outcome array.
  if (Array.isArray(record.results)) {
    return { schemaVersion: null, kind: "legacy-report-object", promotionEligible: false };
  }
  if (Array.isArray(value) && value.length > 0) {
    return { schemaVersion: null, kind: "legacy-flat-outcomes", promotionEligible: false };
  }
  return { schemaVersion: null, kind: "unknown", promotionEligible: false };
}

// ---------------------------------------------------------------------------
// Field validators (hand-rolled; no external cast)
// ---------------------------------------------------------------------------

function expectString(v: unknown, field: string, allowNull = false): string | null {
  if (v === null && allowNull) return null;
  if (typeof v !== "string") throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected string, got ${typeof v}`);
  return v;
}

/** E4-03 #2: identity / grade strings must be non-empty when present. */
function expectNonEmptyString(v: unknown, field: string, allowNull = false): string | null {
  const s = expectString(v, field, allowNull);
  if (s !== null && s.trim() === "") {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, "expected a non-empty string");
  }
  return s;
}

function expectNumber(v: unknown, field: string, allowNull = false): number | null {
  if (v === null && allowNull) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected finite number, got ${typeof v}`);
  }
  return v;
}

function expectBoolean(v: unknown, field: string, allowNull = false): boolean | null {
  if (v === null && allowNull) return null;
  if (typeof v !== "boolean") throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected boolean, got ${typeof v}`);
  return v;
}

function expectObject(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, "expected object");
  }
  return v as Record<string, unknown>;
}

function expectArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, "expected array");
  return v;
}

/** E4-03 #3: numeric fields carry range / integrality / finiteness bounds. */
function expectNonNegativeInteger(v: unknown, field: string): number {
  const n = expectNumber(v, field); // rejects NaN / Infinity / non-number
  if (n === null || !Number.isInteger(n) || n < 0) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected non-negative integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

function expectPositiveInteger(v: unknown, field: string): number {
  const n = expectNumber(v, field);
  if (n === null || !Number.isInteger(n) || n < 1) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected positive integer (>=1), got ${JSON.stringify(v)}`);
  }
  return n;
}

function expectNonNegativeNumber(v: unknown, field: string, allowNull = false): number | null {
  const n = expectNumber(v, field, allowNull);
  if (n !== null && n < 0) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected non-negative number, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** E4-03 #1: a digest field must be an exact-length lowercase hex string. */
function expectHexDigest(v: unknown, field: string, length: number, allowNull = false): string | null {
  if (v === null && allowNull) return null;
  if (typeof v !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(v)) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected ${length}-char lowercase hex digest, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** E4-03 #1: a Git SHA is 40 (sha-1) or 64 (sha-256) lowercase hex. */
function expectGitSha(v: unknown, field: string, allowNull = false): string | null {
  if (v === null && allowNull) return null;
  if (typeof v !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected a 40- or 64-char hex git SHA, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** E4-03 #3/#4: a rate field is a finite number in [0, 1]. */
function expectRate(v: unknown, field: string): number {
  const n = expectNumber(v, field);
  if (n === null || n < 0 || n > 1) {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", field, `expected a rate in [0,1], got ${JSON.stringify(v)}`);
  }
  return n;
}

/** E4-03 #4: a category→count map with non-negative integer values. */
function expectCountMap(v: unknown, field: string): Record<string, number> {
  const o = expectObject(v, field);
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    out[k] = expectNonNegativeInteger(val, `${field}.${k}`);
  }
  return out;
}

/**
 * E4-03 #4: the persisted summary is validated FIELD BY FIELD (no raw cast).
 * Value correctness against the outcomes is still re-derived by the loader /
 * validator (SUMMARY_MISMATCH); this closes the type/range hole.
 */
function parseSummaryV3(v: unknown): ExperimentArtifactV3["summary"] {
  const s = expectObject(v, "summary");
  return {
    suiteCount: expectNonNegativeInteger(s.suiteCount, "summary.suiteCount"),
    caseCount: expectNonNegativeInteger(s.caseCount, "summary.caseCount"),
    passed: expectNonNegativeInteger(s.passed, "summary.passed"),
    failed: expectNonNegativeInteger(s.failed, "summary.failed"),
    passRate: expectRate(s.passRate, "summary.passRate"),
    terminationReasons: expectCountMap(s.terminationReasons, "summary.terminationReasons"),
    failureCategories: expectCountMap(s.failureCategories, "summary.failureCategories"),
    totalTokensInput: expectNonNegativeInteger(s.totalTokensInput, "summary.totalTokensInput"),
    totalTokensOutput: expectNonNegativeInteger(s.totalTokensOutput, "summary.totalTokensOutput"),
    totalCostUsd: expectNonNegativeNumber(s.totalCostUsd, "summary.totalCostUsd", true),
    medianLatencyMs: expectNonNegativeNumber(s.medianLatencyMs, "summary.medianLatencyMs")!,
    totalToolCalls: expectNonNegativeInteger(s.totalToolCalls, "summary.totalToolCalls"),
    recoveryCount: expectNonNegativeInteger(s.recoveryCount, "summary.recoveryCount"),
    recoveryRate: expectRate(s.recoveryRate, "summary.recoveryRate"),
  };
}

/** Parse one case outcome with full field validation. */
export function parseCaseOutcomeV3(raw: unknown, index: number): CaseOutcomeV3 {
  const o = expectObject(raw, `outcomes[${index}]`);
  const outcome: CaseOutcomeV3 = {
    caseId: expectNonEmptyString(o.caseId, `outcomes[${index}].caseId`)!,
    suite: expectNonEmptyString(o.suite, `outcomes[${index}].suite`)!,
    armId: expectNonEmptyString(o.armId, `outcomes[${index}].armId`)!,
    attempt: expectNonNegativeInteger(o.attempt, `outcomes[${index}].attempt`),
    repetition: expectPositiveInteger(o.repetition, `outcomes[${index}].repetition`),
    order: expectNonNegativeInteger(o.order, `outcomes[${index}].order`),
    passed: expectBoolean(o.passed, `outcomes[${index}].passed`)!,
    grade: expectNonEmptyString(o.grade, `outcomes[${index}].grade`, true),
    verificationPassed: expectBoolean(o.verificationPassed, `outcomes[${index}].verificationPassed`, true),
    terminationReason: expectString(o.terminationReason, `outcomes[${index}].terminationReason`, true),
    failureCategory: expectString(o.failureCategory, `outcomes[${index}].failureCategory`, true),
    inputTokens: expectNonNegativeInteger(o.inputTokens, `outcomes[${index}].inputTokens`),
    outputTokens: expectNonNegativeInteger(o.outputTokens, `outcomes[${index}].outputTokens`),
    costUsd: expectNonNegativeNumber(o.costUsd, `outcomes[${index}].costUsd`, true),
    latencyMs: expectNonNegativeInteger(o.latencyMs, `outcomes[${index}].latencyMs`),
    toolCalls: expectNonNegativeInteger(o.toolCalls, `outcomes[${index}].toolCalls`),
    recoveryDecisions: expectArray(o.recoveryDecisions, `outcomes[${index}].recoveryDecisions`).map((d, i) => {
      const r = expectObject(d, `outcomes[${index}].recoveryDecisions[${i}]`);
      return {
        id: expectString(r.id, `outcomes[${index}].recoveryDecisions[${i}].id`)!,
        action: expectString(r.action, `outcomes[${index}].recoveryDecisions[${i}].action`)!,
        budgetExhausted: expectBoolean(r.budgetExhausted, `outcomes[${index}].recoveryDecisions[${i}].budgetExhausted`)!,
      };
    }),
    activationRef: expectString(o.activationRef, `outcomes[${index}].activationRef`, true),
    securityOutcomeRef: expectString(o.securityOutcomeRef, `outcomes[${index}].securityOutcomeRef`, true),
    outputDigest: expectString(o.outputDigest, `outcomes[${index}].outputDigest`, true),
    workspaceDigest: expectString(o.workspaceDigest, `outcomes[${index}].workspaceDigest`, true),
    judgeVersion: expectString(o.judgeVersion, `outcomes[${index}].judgeVersion`)!,
    evaluationContextHash: expectHexDigest(o.evaluationContextHash, `outcomes[${index}].evaluationContextHash`, 64, true),
    candidateConfigHash: expectHexDigest(o.candidateConfigHash, `outcomes[${index}].candidateConfigHash`, 64, true),
  };
  return outcome;
}

/**
 * E4-03 #1: validate the manifest's identity fields by format, but only for
 * keys that are actually present (conditional). This tightens malformed values
 * (a non-hex gitSha, a bogus isolationStrength, a negative repeat) without
 * requiring fields that later tasks wire in (decisionPolicyVersion /
 * thresholdDigest arrive with E4-05).
 */
function validateManifestFields(manifest: Record<string, unknown>): void {
  if ("gitSha" in manifest) expectGitSha(manifest.gitSha, "manifest.gitSha", true);
  if ("sourceSha" in manifest) expectGitSha(manifest.sourceSha, "manifest.sourceSha", true);
  if ("planDigest" in manifest) expectHexDigest(manifest.planDigest, "manifest.planDigest", 64, true);
  if ("runtimeConfigHash" in manifest) expectHexDigest(manifest.runtimeConfigHash, "manifest.runtimeConfigHash", 64, true);
  if ("thresholdDigest" in manifest) expectHexDigest(manifest.thresholdDigest, "manifest.thresholdDigest", 64, true);
  if ("model" in manifest) expectNonEmptyString(manifest.model, "manifest.model", true);
  if ("provider" in manifest) expectNonEmptyString(manifest.provider, "manifest.provider", true);
  if ("decisionPolicyVersion" in manifest) expectNonEmptyString(manifest.decisionPolicyVersion, "manifest.decisionPolicyVersion");
  if ("isolationStrength" in manifest) {
    const v = manifest.isolationStrength;
    if (v !== "strong" && v !== "insecure-local" && v !== "none") {
      throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", "manifest.isolationStrength", `expected strong|insecure-local|none, got ${JSON.stringify(v)}`);
    }
  }
  if ("promotionEligible" in manifest) expectBoolean(manifest.promotionEligible, "manifest.promotionEligible");
  if ("repeat" in manifest) expectPositiveInteger(manifest.repeat, "manifest.repeat");
  if ("caseCount" in manifest) expectNonNegativeInteger(manifest.caseCount, "manifest.caseCount");
  if ("outcomeCount" in manifest) expectNonNegativeInteger(manifest.outcomeCount, "manifest.outcomeCount");
}

/** Strict-parse the ENTIRE V3 artifact. Throws ArtifactSchemaError on any
 *  missing/mistyped field; validates digests + summary + duplicates. */
export function parseExperimentArtifactV3(value: unknown): ExperimentArtifactV3 {
  const record = expectObject(value, "artifact");
  const schemaVersion = expectString(record.schemaVersion, "schemaVersion");
  if (schemaVersion !== ARTIFACT_V3_SCHEMA_VERSION) {
    throw new ArtifactSchemaError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "schemaVersion",
      `got "${schemaVersion}", expected "${ARTIFACT_V3_SCHEMA_VERSION}"`,
    );
  }

  const armRaw = expectObject(record.arm, "arm");
  const arm = {
    armId: expectString(armRaw.armId, "arm.armId")!,
    candidateId: expectString(armRaw.candidateId, "arm.candidateId", true),
    candidateConfigHash: expectHexDigest(armRaw.candidateConfigHash, "arm.candidateConfigHash", 64, true),
  };
  // E4-03 #1: a candidate arm must carry its config hash (baseline may be null).
  // A candidate whose config hash is missing cannot be reproduced or compared.
  if (arm.candidateId !== null && arm.candidateConfigHash === null) {
    throw new ArtifactSchemaError(
      "MISSING_REQUIRED_FIELD",
      "arm.candidateConfigHash",
      `candidate arm "${arm.candidateId}" has no candidateConfigHash`,
    );
  }

  const manifest = expectObject(record.manifest, "manifest");
  // E3-04: an empty manifest object is never valid — the manifest must carry
  // source/build/provider/protocol/arm/runtime identities.
  if (Object.keys(manifest).length === 0) {
    throw new ArtifactSchemaError("MISSING_REQUIRED_FIELD", "manifest", "manifest is an empty object — required identities missing");
  }
  // E4-03 #1: field-level manifest validation. Conditional on presence so it is
  // forward-compatible with fields wired by later tasks (E4-04 activation,
  // E4-05 decision policy), but any PRESENT identity is format-checked.
  validateManifestFields(manifest);

  const outcomesRaw = expectArray(record.outcomes, "outcomes");
  const outcomes = outcomesRaw.map((o, i) => parseCaseOutcomeV3(o, i));

  // Duplicate case/arm/repetition key → DUPLICATE_OUTCOME.
  const seen = new Set<string>();
  for (const o of outcomes) {
    const key = `${o.caseId}:${o.armId}:${o.attempt}:${o.repetition}`;
    if (seen.has(key)) {
      throw new ArtifactSchemaError("DUPLICATE_OUTCOME", "outcomes", `duplicate key ${key}`);
    }
    seen.add(key);
  }

  const activationEvidence = expectArray(record.activationEvidence, "activationEvidence").map((e, i) => {
    const ev = expectObject(e, `activationEvidence[${i}]`);
    return {
      id: expectString(ev.id, `activationEvidence[${i}].id`)!,
      reasonCodes: expectArray(ev.reasonCodes, `activationEvidence[${i}].reasonCodes`).map((rc, j) =>
        expectString(rc, `activationEvidence[${i}].reasonCodes[${j}]`)!),
      note: expectString(ev.note, `activationEvidence[${i}].note`)!,
    };
  });

  const securityOutcomes = expectArray(record.securityOutcomes, "securityOutcomes").map((s, i) => {
    const so = expectObject(s, `securityOutcomes[${i}]`);
    const kind = expectString(so.kind, `securityOutcomes[${i}].kind`)!;
    if (!["attack_attempted", "escaped", "blocked", "clean"].includes(kind)) {
      throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", `securityOutcomes[${i}].kind`, `unknown kind "${kind}"`);
    }
    return {
      caseId: expectString(so.caseId, `securityOutcomes[${i}].caseId`)!,
      kind: kind as "attack_attempted" | "escaped" | "blocked" | "clean",
      detail: expectString(so.detail, `securityOutcomes[${i}].detail`)!,
    };
  });

  const provRaw = expectObject(record.provenance, "provenance");
  const provenance = {
    sourceManifestPath: expectString(provRaw.sourceManifestPath, "provenance.sourceManifestPath", true),
    gitSha: expectGitSha(provRaw.gitSha, "provenance.gitSha", true),
    dirty: expectBoolean(provRaw.dirty, "provenance.dirty", true),
    model: expectString(provRaw.model, "provenance.model", true),
    provider: expectString(provRaw.provider, "provenance.provider", true),
    runtimeConfigHash: expectHexDigest(provRaw.runtimeConfigHash, "provenance.runtimeConfigHash", 64, true),
  };

  const contentDigest = expectHexDigest(record.contentDigest, "contentDigest", 64)!;

  return {
    schemaVersion,
    arm,
    manifest,
    outcomes,
    // summary is validated field-by-field here (E4-03 #4, no raw cast) and
    // re-derived + compared by the loader/validator (SUMMARY_MISMATCH).
    summary: parseSummaryV3(record.summary),
    activationEvidence,
    securityOutcomes,
    provenance,
    contentDigest,
  };
}

/**
 * E4-03 #2: cross-field integrity — every outcome ref must resolve to a real
 * event carried in the SAME artifact, and activation-evidence event ids must be
 * unique. Returns violation descriptions (empty = clean). Used by both the
 * strict loader (throws) and the directory validator (records checks).
 *   - activationRef        → an activationEvidence[].id
 *   - securityOutcomeRef   → a securityOutcomes[].caseId
 */
export function findRefAndEventViolations(artifact: ExperimentArtifactV3): {
  dangling: string[];
  duplicateEvents: string[];
} {
  const activationIds = new Set<string>();
  const duplicateEvents: string[] = [];
  for (const ae of artifact.activationEvidence) {
    if (activationIds.has(ae.id)) duplicateEvents.push(ae.id);
    activationIds.add(ae.id);
  }
  const securityCaseIds = new Set(artifact.securityOutcomes.map((s) => s.caseId));
  const dangling: string[] = [];
  for (const o of artifact.outcomes) {
    if (o.activationRef !== null && !activationIds.has(o.activationRef)) {
      dangling.push(`outcomes[${o.caseId}].activationRef "${o.activationRef}" has no matching activationEvidence id`);
    }
    if (o.securityOutcomeRef !== null && !securityCaseIds.has(o.securityOutcomeRef)) {
      dangling.push(`outcomes[${o.caseId}].securityOutcomeRef "${o.securityOutcomeRef}" has no matching securityOutcome caseId`);
    }
  }
  return { dangling, duplicateEvents };
}
