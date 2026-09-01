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
 */

import { readFile } from "node:fs/promises";
import { ArtifactSchemaError, classifyArtifact, parseExperimentArtifactV3 } from "./schema.js";
import type { ExperimentArtifactV3 } from "./types.js";
import { discoverArtifactFiles } from "./loader.js";
import { computeContentDigestV3, deriveSummaryV3 } from "./writer.js";

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
  | "EMPTY_ARTIFACT";

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
 * Validate a single parsed V3 artifact (cross-field checks).
 * Caller is responsible for providing the raw parsed object (from
 * parseExperimentArtifactV3 or from the writer).
 */
export function validateArtifactV3(artifact: ExperimentArtifactV3): ArtifactValidationCheck[] {
  const checks: ArtifactValidationCheck[] = [];

  // 1. Empty check.
  if (artifact.outcomes.length === 0) {
    checks.push({ code: "EMPTY_ARTIFACT", passed: false, detail: "0 cases in artifact" });
  } else {
    checks.push({ code: "EMPTY_ARTIFACT", passed: true, detail: `${artifact.outcomes.length} cases` });
  }

  // 2. Re-derive summary and compare.
  const derived = deriveSummaryV3(artifact.outcomes);
  if (derived.caseCount !== artifact.summary.caseCount) {
    checks.push({
      code: "SUMMARY_MISMATCH",
      passed: false,
      detail: `persisted caseCount=${artifact.summary.caseCount} != derived ${derived.caseCount}`,
    });
  } else if (derived.passed !== artifact.summary.passed) {
    checks.push({
      code: "SUMMARY_MISMATCH",
      passed: false,
      detail: `persisted passed=${artifact.summary.passed} != derived ${derived.passed}`,
    });
  } else {
    checks.push({ code: "SUMMARY_MISMATCH", passed: true, detail: "summary matches derived" });
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