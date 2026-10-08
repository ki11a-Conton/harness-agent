/**
 * E2-01 — artifact-v3 validator: content, cross-field, and derived-value checks.
 *
 * Validates a RESULT DIRECTORY on disk, discovering the actual holdout
 * artifacts (baseline-holdout.json / candidate-holdout.json / holdout.json)
 * within it. Unlike the old `validateBenchmarkArtifacts` which could report
 * "0 suites / 0 cases / VALID" on a real result dir, this validator:
 *
 *   - discovers *.json files matching the holdout-arm pattern;
 *   - classifies them (V3 strict, legacy, unknown);
 *   - re-derives summaries from outcomes and cross-checks;
 *   - demands caseCount > 0 and suiteCount > 0 to pass (empty dir → FAIL).
 *
 * Stable reason codes (machine-readable, sortable):
 *   NO_EXPERIMENT_ARTIFACTS   — no holdout-style JSON files found
 *   UNSUPPORTED_SCHEMA_VERSION — V1/V2/unknown schemaVersion
 *   SCHEMA_VALIDATION_FAILED   — field type errors, not-an-array, etc.
 *   CONTENT_DIGEST_MISMATCH    — tampered outcome payload
 *   SUMMARY_MISMATCH           — persisted summary != re-derived summary
 *   DUPLICATE_OUTCOME          — duplicate case/arm/repetition key
 *   MISSING_REQUIRED_FIELD     — grade/termination/verification removed
 *   LEGACY_NOT_PROMOTION_ELIGIBLE — legacy artifact, never promotion
 *   EMPTY_ARTIFACT             — 0 cases in a classified artifact
 *   UNSUPPORTED_BREACH_CLAIM   — M15: an artifact carries an ESCAPE/hardBreach
 *                                verdict with no checkable effect evidence (the
 *                                N7 defect: an unsupported causal assertion in
 *                                an archive invalidated a 512-arm measurement)
 */

import { readFile } from "node:fs/promises";
import { ArtifactSchemaError, classifyArtifact, findEventRecordViolations, findRefAndEventViolations, parseExperimentArtifactV3 } from "./schema.js";
import type { ExperimentArtifactV3 } from "./types.js";
import { discoverArtifactFiles } from "./loader.js";
import { computeContentDigestV3, deriveSummaryV3 } from "./writer.js";
import {
  validateSecurityOutcomeConsistencyV2,
  type SecurityOutcomeConsistencyReport,
} from "../security-outcome-v2.js";

/** Stable validation reason codes. */
export type ValidationReasonCode =
  | "NO_EXPERIMENT_ARTIFACTS"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "SCHEMA_VALIDATION_FAILED"
  | "CONTENT_DIGEST_MISMATCH"
  | "SUMMARY_MISMATCH"
  | "DUPLICATE_OUTCOME"
  | "MISSING_REQUIRED_FIELD"
  | "LEGACY_NOT_PROMOTION_ELIGIBLE"
  | "EMPTY_ARTIFACT"
  | "DANGLING_REF"
  | "DUPLICATE_EVENT"
  | "EVENT_RECORDS_INVALID"
  /** M15: an artifact asserts a breach that no checkable effect evidence backs. */
  | "UNSUPPORTED_BREACH_CLAIM";

export interface ArtifactValidationCheck {
  code: ValidationReasonCode;
  passed: boolean;
  detail: string;
  /** The artifact file this check applies to (empty for dir-level checks). */
  file?: string;
}

export interface DirectoryValidationResult {
  /** Overall: true only when every check passed. */
  ok: boolean;
  errors: ArtifactValidationCheck[];
  summary: { suites: number; cases: number; passed: number; failed: number };
  /** Per-artifact detail entries. */
  detail: ArtifactValidationCheck[];
}

/**
 * M15 — per-artifact result of the breach-claim consistency check.
 *
 * WHY THIS LOOKS AT THE RAW `securityOutcome` OBJECT
 * --------------------------------------------------
 * `SecurityOutcomeV3` is a LOSSY projection: it keeps `kind` ("escaped", …) and
 * a prose `detail`, and carries NO effect-evidence field. The M15 evidence
 * (`evidenceClass` + `effectEvidence`) lives on the `SecurityOutcomeV2` that the
 * runner produced. So the check reads the V2-shaped record when the artifact
 * preserves one, and otherwise falls back to the V3 record treated as
 * evidence-less.
 *
 * CONSEQUENCE (stated honestly, not hidden): a V3 record with
 * `kind: "escaped"` and no V2 evidence alongside it is an UNSUPPORTED breach
 * claim — its kind asserts a breach the archive cannot substantiate. That is
 * exactly the N7 shape.
 */
export interface BreachClaimConsistency {
  ok: boolean;
  /** One entry per failing security outcome. */
  violations: string[];
  /** The V3 caseIds whose claim could not be substantiated. */
  unsupportedCaseIds: string[];
  /** Per-case reports, for callers that want the full detail. */
  reports: Array<{ caseId: string; report: SecurityOutcomeConsistencyReport }>;
}

/** The V2-shaped fields a preserved security record may carry (M15). */
interface PreservedSecurityRecord {
  kind?: unknown;
  hardBreach?: unknown;
  facts?: unknown;
  evidenceClass?: unknown;
  effectEvidence?: unknown;
  /** The V3 `detail` may embed the V2 kind/fact types as prose. */
  detail?: unknown;
  caseId?: unknown;
}

/** True when a V3 record's `kind` asserts a breach. */
function assertsBreachKind(kind: unknown): boolean {
  return kind === "escaped" || kind === "ESCAPE" || kind === "ESCAPE_UNPROVEN";
}

/**
 * M15 — check every security outcome in an artifact for a breach claim that no
 * checkable effect evidence supports. PURE: reads, never mutates, never throws.
 */
export function checkBreachClaimConsistency(artifact: ExperimentArtifactV3): BreachClaimConsistency {
  const violations: string[] = [];
  const unsupportedCaseIds: string[] = [];
  const reports: Array<{ caseId: string; report: SecurityOutcomeConsistencyReport }> = [];

  const records = Array.isArray(artifact.securityOutcomes) ? artifact.securityOutcomes : [];
  for (const record of records) {
    const raw = record as unknown as PreservedSecurityRecord;
    const caseId = typeof raw.caseId === "string" ? raw.caseId : "<unknown-case>";

    // Prefer a V2-shaped record when the artifact preserved one (it can carry
    // real evidence). A V3-only record has no evidence fields by construction.
    const candidate = raw as unknown as Record<string, unknown>;
    const isV2Shaped = Array.isArray(raw.facts) && raw.facts.length > 0;
    const report = isV2Shaped
      ? validateSecurityOutcomeConsistencyV2({
          kind: raw.kind,
          hardBreach: raw.hardBreach,
          facts: raw.facts,
        })
      : // No V2 record: the V3 `kind` is the only claim present. It cannot be
        // substantiated without effect evidence, so it is unsupported when it
        // asserts a breach.
        assertsBreachKind(candidate.kind)
        ? {
            ok: false,
            violations: [
              `breach claim is unsupported: security outcome for ${caseId} asserts kind "${String(candidate.kind)}" ` +
                `but carries no effect evidence (no evidenceClass "effect" with a non-empty effectEvidence path set) — N7 defect`,
            ],
            effectEvidence: [] as string[],
          }
        : { ok: true, violations: [] as string[], effectEvidence: [] as string[] };

    reports.push({ caseId, report });
    if (!report.ok) {
      unsupportedCaseIds.push(caseId);
      for (const v of report.violations) violations.push(`${caseId}: ${v}`);
    }
  }

  return { ok: violations.length === 0, violations, unsupportedCaseIds, reports };
}

/**
 * Validate a single parsed V3 artifact (cross-field checks).
 * Caller is responsible for providing the raw parsed object (from
 * parseExperimentArtifactV3 or from the writer).
 *
 * Every check is ALWAYS emitted, with `passed: true` or `passed: false` — the
 * established style of this function (callers count checks as well as read
 * codes, so a conditionally-absent check would be a silent API change).
 */
export function validateArtifactV3(artifact: ExperimentArtifactV3): ArtifactValidationCheck[] {
  const checks: ArtifactValidationCheck[] = [];

  // 1. Empty check.
  if (artifact.outcomes.length === 0) {
    checks.push({ code: "EMPTY_ARTIFACT", passed: false, detail: "0 cases in artifact" });
  } else {
    checks.push({ code: "EMPTY_ARTIFACT", passed: true, detail: `${artifact.outcomes.length} cases` });
  }

  // 2. Re-derive summary and compare EVERY field (E3-04: not just
  //    caseCount/passed — a tampered passRate/tokens/cost/latency/recoveryRate
  //    must be rejected).
  const derived = deriveSummaryV3(artifact.outcomes);
  const summaryFields: (keyof typeof derived)[] = [
    "suiteCount", "caseCount", "passed", "failed", "passRate",
    "terminationReasons", "failureCategories",
    "totalTokensInput", "totalTokensOutput", "totalCostUsd",
    "medianLatencyMs", "totalToolCalls", "recoveryCount", "recoveryRate",
  ];
  const summaryMismatches: string[] = [];
  for (const field of summaryFields) {
    const pStr = JSON.stringify((artifact.summary as unknown as Record<string, unknown>)[field]);
    const rStr = JSON.stringify(derived[field]);
    if (pStr !== rStr) summaryMismatches.push(`${field}: persisted ${pStr} != derived ${rStr}`);
  }
  if (summaryMismatches.length > 0) {
    checks.push({
      code: "SUMMARY_MISMATCH",
      passed: false,
      detail: summaryMismatches.join("; "),
    });
  } else {
    checks.push({ code: "SUMMARY_MISMATCH", passed: true, detail: "all summary fields match derived" });
  }

  // 3. Content digest re-verification.
  const { contentDigest: recordedDigest, ...digestSource } = artifact;
  const recomputedDigest = computeContentDigestV3(digestSource);
  if (recomputedDigest !== recordedDigest) {
    checks.push({
      code: "CONTENT_DIGEST_MISMATCH",
      passed: false,
      detail: `recorded ${recordedDigest}, recomputed ${recomputedDigest}`,
    });
  } else {
    checks.push({ code: "CONTENT_DIGEST_MISMATCH", passed: true, detail: "content digest matches" });
  }

  // 4. Duplicate key check (already done by schema parser, but repeat for
  //    cross-field validator completeness).
  const seen = new Set<string>();
  let dupes = 0;
  for (const o of artifact.outcomes) {
    const key = `${o.caseId}:${o.armId}:${o.attempt}:${o.repetition}`;
    if (seen.has(key)) dupes += 1;
    seen.add(key);
  }
  if (dupes > 0) {
    checks.push({ code: "DUPLICATE_OUTCOME", passed: false, detail: `${dupes} duplicate outcome keys` });
  } else {
    checks.push({ code: "DUPLICATE_OUTCOME", passed: true, detail: "no duplicate outcomes" });
  }

  // 5. MISSING_REQUIRED_FIELD: check that grade/terminationReason are present
  //    (null is allowed — the field exists, just not set). But if the field
  //    is completely absent from the JSON, the schema parser would have thrown
  //    SCHEMA_VALIDATION_FAILED. Here we verify at least one outcome has a
  //    terminationReason (non-null).
  const hasTermination = artifact.outcomes.some((o) => o.terminationReason !== null);
  if (!hasTermination) {
    checks.push({ code: "MISSING_REQUIRED_FIELD", passed: false, detail: "all outcomes missing terminationReason" });
  } else {
    checks.push({ code: "MISSING_REQUIRED_FIELD", passed: true, detail: "terminationReason present" });
  }

  // 6. Provenance unknown identity (E3-04): all required provenance fields
  //    null => never promotion-eligible.
  const prov = artifact.provenance;
  const allUnknown = prov.gitSha === null && prov.model === null && prov.provider === null
    && prov.sourceManifestPath === null && prov.runtimeConfigHash === null;
  if (allUnknown) {
    checks.push({
      code: "MISSING_REQUIRED_FIELD",
      passed: false,
      detail: "all required provenance fields are null — UNKNOWN_IDENTITY; promotion not eligible",
    });
  } else {
    checks.push({ code: "MISSING_REQUIRED_FIELD", passed: true, detail: "provenance identity present" });
  }

  // 7. E4-03 #2: outcome refs resolve to real events; activation ids unique.
  const { dangling, duplicateEvents } = findRefAndEventViolations(artifact);
  if (duplicateEvents.length > 0) {
    checks.push({ code: "DUPLICATE_EVENT", passed: false, detail: `duplicate activationEvidence ids: ${duplicateEvents.join(", ")}` });
  } else {
    checks.push({ code: "DUPLICATE_EVENT", passed: true, detail: "activation event ids unique" });
  }
  if (dangling.length > 0) {
    checks.push({ code: "DANGLING_REF", passed: false, detail: dangling.join("; ") });
  } else {
    checks.push({ code: "DANGLING_REF", passed: true, detail: "all outcome refs resolve to real events" });
  }

  // 8. E4-02 #6: embedded event trails are intact + tamper-evident.
  const erViolations = findEventRecordViolations(artifact);
  if (erViolations.length > 0) {
    checks.push({ code: "EVENT_RECORDS_INVALID", passed: false, detail: erViolations.join("; ") });
  } else {
    checks.push({ code: "EVENT_RECORDS_INVALID", passed: true, detail: "event records intact (or absent)" });
  }

  // 9. M15: every breach claim must be backed by checkable effect evidence. An
  //    archive that carries an ESCAPE verdict with nothing to verify is exactly
  //    how the N7 assertion travelled as fact and invalidated a 512-arm
  //    measurement. Emitted unconditionally, in this function's style.
  const breachConsistency = checkBreachClaimConsistency(artifact);
  if (breachConsistency.ok) {
    checks.push({
      code: "UNSUPPORTED_BREACH_CLAIM",
      passed: true,
      detail:
        artifact.securityOutcomes.length === 0
          ? "no security outcomes to substantiate"
          : `all ${artifact.securityOutcomes.length} security outcome claim(s) are evidence-supported`,
    });
  } else {
    checks.push({
      code: "UNSUPPORTED_BREACH_CLAIM",
      passed: false,
      detail: breachConsistency.violations.join("; "),
    });
  }

  return checks;
}

/**
 * Validate a result directory: discover holdout artifacts, classify, and
 * run per-artifact + cross-field checks. Never throws — returns a structured
 * result with ok=true only when caseCount > 0 and every check passes.
 * Fixes the "0 suites / 0 cases / VALID" false positive (F-04).
 */
export async function validateArtifactDir(dir: string): Promise<DirectoryValidationResult> {
  const errors: ArtifactValidationCheck[] = [];
  const detail: ArtifactValidationCheck[] = [];
  let totalCases = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const suites = new Set<string>();

  // 1. Discover artifact files.
  const files = await discoverArtifactFiles(dir).catch(() => [] as string[]);
  if (files.length === 0) {
    errors.push({
      code: "NO_EXPERIMENT_ARTIFACTS",
      passed: false,
      detail: `no holdout-style JSON files found in ${dir} (expected *-holdout.json or holdout.json)`,
    });
    return { ok: false, errors, summary: { suites: 0, cases: 0, passed: 0, failed: 0 }, detail };
  }

  // 2. Per-artifact classification + validation.
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      detail.push({ code: "SCHEMA_VALIDATION_FAILED", passed: false, detail: `unreadable: ${file}`, file });
      errors.push({ code: "SCHEMA_VALIDATION_FAILED", passed: false, detail: `unreadable: ${file}`, file });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      detail.push({ code: "SCHEMA_VALIDATION_FAILED", passed: false, detail: `not valid JSON: ${file}`, file });
      errors.push({ code: "SCHEMA_VALIDATION_FAILED", passed: false, detail: `not valid JSON: ${file}`, file });
      continue;
    }

    const classification = classifyArtifact(parsed);
    if (classification.kind === "unknown") {
      detail.push({ code: "UNSUPPORTED_SCHEMA_VERSION", passed: false, detail: `unknown artifact shape: ${file}`, file });
      errors.push({ code: "UNSUPPORTED_SCHEMA_VERSION", passed: false, detail: `unknown artifact shape: ${file}`, file });
      continue;
    }

    if (classification.kind !== "v3") {
      // Legacy artifact — still count cases for the summary, but mark
      // LEGACY_NOT_PROMOTION_ELIGIBLE.
      const legacy = parsed as { results?: unknown[] };
      const legacyCount = legacy.results?.length ?? 0;
      const legacyCheck: ArtifactValidationCheck = {
        code: "LEGACY_NOT_PROMOTION_ELIGIBLE",
        passed: false,
        detail: `${file}: legacy artifact (${classification.kind}), ${legacyCount} cases — promotion not eligible`,
        file,
      };
      detail.push(legacyCheck);
      errors.push(legacyCheck);
      if (legacyCount > 0) {
        totalCases += legacyCount;
        // Attempt to count passes from the legacy structure.
        const report = legacy as { results?: Array<{ success?: boolean }> };
        totalPassed += report.results?.filter((r) => r.success === true).length ?? 0;
      }
      continue;
    }

    // V3 strict path.
    try {
      const artifact = parseExperimentArtifactV3(parsed);
      const v3Checks = validateArtifactV3(artifact);
      for (const c of v3Checks) {
        detail.push({ ...c, file });
        if (!c.passed) errors.push({ ...c, file });
      }
      totalCases += artifact.outcomes.length;
      totalPassed += artifact.summary.passed;
      for (const o of artifact.outcomes) suites.add(o.suite);
    } catch (err) {
      const reason = err instanceof ArtifactSchemaError ? err.reason : "SCHEMA_VALIDATION_FAILED";
      detail.push({ code: reason as ValidationReasonCode, passed: false, detail: `${file}: ${err instanceof Error ? err.message : String(err)}`, file });
      errors.push({ code: reason as ValidationReasonCode, passed: false, detail: `${file}: ${err instanceof Error ? err.message : String(err)}`, file });
    }
  }

  totalFailed = totalCases - totalPassed;

  return {
    ok: errors.length === 0 && totalCases > 0 && suites.size > 0,
    errors,
    summary: { suites: suites.size, cases: totalCases, passed: totalPassed, failed: totalFailed },
    detail,
  };
}