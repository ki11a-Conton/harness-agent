/**
 * E2-01 — artifact-v3 canonical writer.
 *
 * Produces the canonical, digest-anchored V3 artifact from an explicit input.
 * Rules:
 *   - summary is DERIVED from the outcomes; the writer never accepts an
 *     unchecked caller-supplied summary;
 *   - content digest is sha256 over a stable key-ordered UTF-8 serialization
 *     that EXCLUDES the digest field itself and any non-deterministic fields
 *     (absolute temp paths, wall-clock timestamps);
 *   - writes are atomic (temp file + rename).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARTIFACT_V3_SCHEMA_VERSION,
  type ActivationEvidenceV3,
  type ArmIdentityV3,
  type CaseOutcomeV3,
  type ExperimentArtifactV3,
  type ProvenanceRefsV3,
  type SecurityOutcomeV3,
  type SummaryV3,
} from "./types.js";
import { stableStringify } from "../manifest.js";

/** Inputs the writer needs — everything except summary/digest (derived). */
export interface ExperimentArtifactV3Input {
  arm: ArmIdentityV3;
  manifest: Record<string, unknown>;
  outcomes: CaseOutcomeV3[];
  activationEvidence?: ActivationEvidenceV3[];
  securityOutcomes?: SecurityOutcomeV3[];
  provenance: ProvenanceRefsV3;
}

/** Derive the canonical SummaryV3 PURELY from outcomes. */
export function deriveSummaryV3(outcomes: CaseOutcomeV3[]): SummaryV3 {
  const suites = new Set(outcomes.map((o) => o.suite));
  const terminationReasons: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  let passed = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let totalCostUsd = 0;
  let anyCost = false;
  const latencies: number[] = [];
  let totalToolCalls = 0;
  let recoveryCount = 0;
  let recoveredCount = 0;

  for (const o of outcomes) {
    if (o.passed) passed += 1;
    if (o.terminationReason !== null) {
      terminationReasons[o.terminationReason] = (terminationReasons[o.terminationReason] ?? 0) + 1;
    }
    if (o.failureCategory !== null) {
      failureCategories[o.failureCategory] = (failureCategories[o.failureCategory] ?? 0) + 1;
    }
    totalTokensInput += o.inputTokens;
    totalTokensOutput += o.outputTokens;
    if (o.costUsd !== null) {
      totalCostUsd += o.costUsd;
      anyCost = true;
    }
    latencies.push(o.latencyMs);
    totalToolCalls += o.toolCalls;
    if (o.recoveryDecisions.length > 0) recoveryCount += 1;
    if (o.recoveryDecisions.some((d) => !d.budgetExhausted)) recoveredCount += 1;
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const median = sortedLat.length === 0
    ? 0
    : sortedLat.length % 2 === 1
      ? sortedLat[Math.floor(sortedLat.length / 2)]!
      : (sortedLat[sortedLat.length / 2 - 1]! + sortedLat[sortedLat.length / 2]!) / 2;

  return {
    suiteCount: suites.size,
    caseCount: outcomes.length,
    passed,
    failed: outcomes.length - passed,
    passRate: outcomes.length === 0 ? 0 : passed / outcomes.length,
    terminationReasons,
    failureCategories,
    totalTokensInput,
    totalTokensOutput,
    totalCostUsd: anyCost ? totalCostUsd : null,
    medianLatencyMs: median,
    totalToolCalls,
    recoveryCount,
    recoveryRate: recoveryCount === 0 ? 0 : recoveredCount / recoveryCount,
  };
}

/** Fields excluded from the content digest (non-deterministic, self, or
 *  derived-from-outcomes — summary is recomputed and cross-checked by the
 *  loader/validator, so tampering it alone must surface as SUMMARY_MISMATCH,
 *  distinct from CONTENT_DIGEST_MISMATCH on outcome tampering). */
const NON_DIGEST_KEYS = new Set([
  "contentDigest",
  "generatedAt",
  "timestamp",
  "createdAt",
  "updatedAt",
  "summary",
]);

/** Canonical digest input: stable key order, UTF-8, no self/non-deterministic
 *  fields, no absolute temp paths. Used by writer AND validator (must agree). */
export function canonicalDigestInput(artifact: Omit<ExperimentArtifactV3, "contentDigest">): string {
  const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  stripNonDigest(clone);
  return stableStringify(clone);
}

function stripNonDigest(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripNonDigest(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (NON_DIGEST_KEYS.has(key)) {
      delete record[key];
    } else {
      stripNonDigest(record[key]);
    }
  }
}

/** sha256 (hex) over the canonical digest input. */
export function computeContentDigestV3(artifact: Omit<ExperimentArtifactV3, "contentDigest">): string {
  return createHash("sha256").update(canonicalDigestInput(artifact), "utf8").digest("hex");
}

/** Build the full V3 artifact (summary + digest derived). Pure. */
export function buildExperimentArtifactV3(input: ExperimentArtifactV3Input): ExperimentArtifactV3 {
  const summary = deriveSummaryV3(input.outcomes);
  const base: Omit<ExperimentArtifactV3, "contentDigest"> = {
    schemaVersion: ARTIFACT_V3_SCHEMA_VERSION,
    arm: input.arm,
    manifest: input.manifest,
    outcomes: input.outcomes,
    summary,
    activationEvidence: input.activationEvidence ?? [],
    securityOutcomes: input.securityOutcomes ?? [],
    provenance: input.provenance,
  };
  return { ...base, contentDigest: computeContentDigestV3(base) };
}

/** Atomically write the V3 artifact (temp file + rename). */
export async function writeExperimentArtifactV3(
  artifact: ExperimentArtifactV3,
  path: string,
): Promise<void> {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${path.split(/[\\/]/).pop()}.tmp-${randomUUID()}`);
  await writeFile(tmp, json, "utf8");
  await rename(tmp, path);
}
