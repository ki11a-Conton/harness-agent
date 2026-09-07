/**
 * E2-01 — artifact-v3 loader: strict and legacy paths.
 *
 * STRICT loader (`loadExperimentArtifactV3`) accepts ONLY a schemaVersion
 * "3.0.0" artifact and re-verifies content digest + summary on load. Any other
 * shape is classified via `classifyArtifact` and can only be read through the
 * LEGACY path, which never marks it promotion-eligible.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchemaError, classifyArtifact, findRefAndEventViolations, parseExperimentArtifactV3 } from "./schema.js";
import type { ArtifactClassification, ExperimentArtifactV3 } from "./types.js";
import { canonicalDigestInput, deriveSummaryV3 } from "./writer.js";

export interface LoadedArtifact {
  artifact: ExperimentArtifactV3;
  /** Path the artifact was loaded from. */
  path: string;
  /** Re-verified summary (equals artifact.summary when not tampered). */
  recomputedSummary: ReturnType<typeof deriveSummaryV3>;
}

export interface LegacyLoadedArtifact {
  /** Stable classification. */
  kind: ArtifactClassification["kind"];
  schemaVersion: string | null;
  /** The raw parsed document (never cast to internal types). */
  raw: unknown;
  /** Path the legacy artifact was loaded from. */
  path: string;
  /** Legacy results are for historical display only — never promotion. */
  promotionEligible: false;
  /** Best-effort per-case count (0 when shape is unknown). */
  caseCount: number;
}

/** Strict-load a V3 artifact. Re-verifies digest + summary. Throws
 *  ArtifactSchemaError on any provenance/digest/summary violation. */
export async function loadExperimentArtifactV3(path: string): Promise<LoadedArtifact> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactSchemaError("SCHEMA_VALIDATION_FAILED", path, "not valid JSON");
  }
  const classification = classifyArtifact(parsed);
  if (classification.kind !== "v3") {
    throw new ArtifactSchemaError(
      "UNSUPPORTED_SCHEMA_VERSION",
      path,
      `expected schemaVersion "3.0.0", got ${classification.schemaVersion ?? "no schemaVersion"} (kind ${classification.kind})`,
    );
  }
  const artifact = parseExperimentArtifactV3(parsed);

  // E4-03 #2: outcome refs must resolve to real events in this artifact, and
  // activation-evidence ids must be unique — enforced on the strict-load path.
  const { dangling, duplicateEvents } = findRefAndEventViolations(artifact);
  if (duplicateEvents.length > 0) {
    throw new ArtifactSchemaError("DUPLICATE_EVENT", "activationEvidence", `duplicate event ids: ${duplicateEvents.join(", ")}`);
  }
  if (dangling.length > 0) {
    throw new ArtifactSchemaError("DANGLING_REF", "outcomes", dangling.join("; "));
  }

  const recomputedSummary = deriveSummaryV3(artifact.outcomes);

  // Re-verify content digest (CONTENT_DIGEST_MISMATCH on tampering). The
  // canonical digest excludes the contentDigest field itself AND the summary
  // (writer's NON_DIGEST_KEYS), so passing the full artifact minus the digest
  // field is correct.
  const { computeContentDigestV3 } = await import("./writer.js");
  const { contentDigest: recordedDigest, ...digestSource } = artifact;
  const recomputedDigest = computeContentDigestV3(digestSource);
  if (recomputedDigest !== recordedDigest) {
    throw new ArtifactSchemaError(
      "CONTENT_DIGEST_MISMATCH",
      "contentDigest",
      `recorded ${recordedDigest}, recomputed ${recomputedDigest}`,
    );
  }

  // Re-derived summary must equal the persisted summary; tampering the
  // persisted summary alone surfaces as SUMMARY_MISMATCH (distinct from
  // CONTENT_DIGEST_MISMATCH, which covers the outcomes payload).
  // E3-04: validate EVERY summary field, not just caseCount/passed.
  const persisted = artifact.summary;
  if (persisted === undefined || typeof persisted !== "object" || persisted === null) {
    throw new ArtifactSchemaError("SUMMARY_MISMATCH", "summary", "persisted summary missing or not an object");
  }
  const summaryFields: (keyof typeof recomputedSummary)[] = [
    "suiteCount", "caseCount", "passed", "failed", "passRate",
    "terminationReasons", "failureCategories",
    "totalTokensInput", "totalTokensOutput", "totalCostUsd",
    "medianLatencyMs", "totalToolCalls", "recoveryCount", "recoveryRate",
  ];
  for (const field of summaryFields) {
    const pv = (persisted as unknown as Record<string, unknown>)[field];
    const rv = recomputedSummary[field];
    // Deep-equality check using JSON.stringify for nested objects.
    const pStr = JSON.stringify(pv);
    const rStr = JSON.stringify(rv);
    if (pStr !== rStr) {
      throw new ArtifactSchemaError(
        "SUMMARY_MISMATCH",
        `summary.${field}`,
        `persisted ${pStr}, recomputed ${rStr}`,
      );
    }
  }

  // E3-04: provenance unknown-identity check — when all required provenance
  // fields are null, the artifact is not promotion-eligible.
  const prov = artifact.provenance;
  const allUnknown = prov.gitSha === null && prov.model === null && prov.provider === null
    && prov.sourceManifestPath === null && prov.runtimeConfigHash === null;
  if (allUnknown) {
    throw new ArtifactSchemaError(
      "MISSING_REQUIRED_FIELD",
      "provenance",
      "all required provenance fields are null — UNKNOWN_IDENTITY; promotion not eligible",
    );
  }

  return { artifact, path, recomputedSummary };
}

/** Legacy-load any non-V3 artifact for HISTORICAL display only. Never throws
 *  on legacy shapes (it is the fail-open read path for old records); the
 *  artifact is always promotion-ineligible. */
export async function loadLegacyArtifact(path: string): Promise<LegacyLoadedArtifact> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown", schemaVersion: null, raw: undefined, path, promotionEligible: false, caseCount: 0 };
  }
  const classification = classifyArtifact(parsed);
  let caseCount = 0;
  if (classification.kind === "legacy-report-object") {
    caseCount = (parsed as { results: unknown[] }).results.length;
  } else if (classification.kind === "legacy-flat-outcomes") {
    caseCount = (parsed as unknown[]).length;
  }
  return {
    kind: classification.kind,
    schemaVersion: classification.schemaVersion,
    raw: parsed,
    path,
    promotionEligible: false,
    caseCount,
  };
}

/**
 * Discover experiment artifact files in a directory. The E2-01 validator must
 * find the ACTUAL artifacts for EVERY suite (holdout, regression, adversarial,
 * stress, smoke), never report "0 suites / 0 cases" on a real result dir.
 *
 * E3-04: canonical naming is `<arm>-<suite>.json` (e.g.
 * baseline-holdout.json / candidate-regression.json) or `<suite>.json`
 * (e.g. holdout.json); `-summary.json` / `-runs.json` / `-r<N>.json`
 * repeat/summary files are excluded so they never double-count an outcome.
 */
export async function discoverArtifactFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  // The suite names the benchmark runner emits as canonical artifacts.
  const KNOWN_SUITES = ["holdout", "regression", "adversarial", "stress", "smoke"];
  const candidates: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    // Never a summary/repeat/run-list artifact.
    if (lower.endsWith("-summary.json") || lower.endsWith("-runs.json")) continue;
    if (/-r\d+\.json$/.test(lower)) continue;
    // Canonical arm-suite name (baseline-holdout.json, candidate-regression.json)
    // or bare suite name (holdout.json, regression.json).
    const isSuiteJson = KNOWN_SUITES.some((s) => lower === `${s}.json` || lower.endsWith(`-${s}.json`));
    if (isSuiteJson) {
      candidates.push(join(dir, entry));
    }
  }
  return candidates.sort();
}
