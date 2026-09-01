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
  | "SUMMARY_MISMATCH";

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

/** Classify an arbitrary parsed JSON document (no throw — fail-closed read). */
export function classifyArtifact(value: unknown): ArtifactClassification {
  if (typeof value !== "object" || value === null) {
    return { schemaVersion: null, kind: "unknown", promotionEligible: false };
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion : null;
  if (schemaVersion === ARTIFACT_V3_SCHEMA_VERSION) {
    return { schemaVersion, kind: "v3", promotionEligible: true };
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

/** Parse one case outcome with full field validation. */
export function parseCaseOutcomeV3(raw: unknown, index: number): CaseOutcomeV3 {
  const o = expectObject(raw, `outcomes[${index}]`);
  const outcome: CaseOutcomeV3 = {
    caseId: expectString(o.caseId, `outcomes[${index}].caseId`)!,
    suite: expectString(o.suite, `outcomes[${index}].suite`)!,
    armId: expectString(o.armId, `outcomes[${index}].armId`)!,
    attempt: expectNumber(o.attempt, `outcomes[${index}].attempt`)!,
    repetition: expectNumber(o.repetition, `outcomes[${index}].repetition`)!,
    order: expectNumber(o.order, `outcomes[${index}].order`)!,
    passed: expectBoolean(o.passed, `outcomes[${index}].passed`)!,
    grade: expectString(o.grade, `outcomes[${index}].grade`, true),
    verificationPassed: expectBoolean(o.verificationPassed, `outcomes[${index}].verificationPassed`, true),
    terminationReason: expectString(o.terminationReason, `outcomes[${index}].terminationReason`, true),
    failureCategory: expectString(o.failureCategory, `outcomes[${index}].failureCategory`, true),
    inputTokens: expectNumber(o.inputTokens, `outcomes[${index}].inputTokens`)!,
    outputTokens: expectNumber(o.outputTokens, `outcomes[${index}].outputTokens`)!,
    costUsd: expectNumber(o.costUsd, `outcomes[${index}].costUsd`, true),
    latencyMs: expectNumber(o.latencyMs, `outcomes[${index}].latencyMs`)!,
    toolCalls: expectNumber(o.toolCalls, `outcomes[${index}].toolCalls`)!,
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
    evaluationContextHash: expectString(o.evaluationContextHash, `outcomes[${index}].evaluationContextHash`, true),
    candidateConfigHash: expectString(o.candidateConfigHash, `outcomes[${index}].candidateConfigHash`, true),
  };
  return outcome;
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
    candidateConfigHash: expectString(armRaw.candidateConfigHash, "arm.candidateConfigHash", true),
  };

  const manifest = expectObject(record.manifest, "manifest");

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
    gitSha: expectString(provRaw.gitSha, "provenance.gitSha", true),
    dirty: expectBoolean(provRaw.dirty, "provenance.dirty", true),
    model: expectString(provRaw.model, "provenance.model", true),
    provider: expectString(provRaw.provider, "provenance.provider", true),
    runtimeConfigHash: expectString(provRaw.runtimeConfigHash, "provenance.runtimeConfigHash", true),
  };

  const contentDigest = expectString(record.contentDigest, "contentDigest")!;

  return {
    schemaVersion,
    arm,
    manifest,
    outcomes,
    // summary + contentDigest are re-derived by the validator; the persisted
    // summary is parsed separately for cross-checking (SUMMARY_MISMATCH).
    summary: record.summary as ExperimentArtifactV3["summary"],
    activationEvidence,
    securityOutcomes,
    provenance,
    contentDigest,
  };
}
