/**
 * E2-07 — PromotionEnvelope: machine-verifiable promotion authority.
 *
 * The E1 `champion promote` trusted a CLI-provided `--decision ACCEPT` and
 * only checked that an evidence FILE existed. That made any text file a
 * promotion authority (F-05). This module replaces that trust boundary:
 *
 *   - the ONLY promotion authority is a structured, content-addressed
 *     `PromotionEnvelope` produced by the decision layer (E2-06) at decision
 *     time;
 *   - the CLI promote command consumes ONLY an envelope path; `--decision
 *     ACCEPT` no longer exists as an authority;
 *   - a strict loader re-verifies: schema version, policy version, decision,
 *     candidate id, parent champion identity (level + state digest), artifact
 *     references (paths + content digests recomputed), source sha, and the
 *     envelope's own content digest;
 *   - any tamper (artifact digest changed, wrong candidate, wrong parent,
 *     wrong policy, hand-written `{"decision":"ACCEPT"}`) is rejected.
 *
 * No cryptographic signature is fabricated: authority rests on canonical
 * content digests + a controlled generator identity + full reference
 * re-verification. The interface leaves room for an optional signature field.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableStringify } from "./manifest.js";

export const PROMOTION_ENVELOPE_SCHEMA_VERSION = "3.0.0";
export const PROMOTION_ENVELOPE_POLICY_VERSION = "e2-07-policy-v1";

export interface AxisArtifactRef {
  role: "baseline" | "candidate";
  path: string;
  /** sha256 of the artifact file at decision time. */
  digest: string;
}

export interface PromotionEnvelope {
  schemaVersion: typeof PROMOTION_ENVELOPE_SCHEMA_VERSION;
  policyVersion: string;
  generatedBy: string;
  generatedAtIso: string;
  decision: "ACCEPT";
  candidateId: string;
  /** Parent champion state identity the promotion is based on. */
  parentLevel: string;
  parentStateDigest: string;
  /** E2-06 decision envelope digest (content-addressed). */
  decisionEnvelopeDigest: string;
  artifactRefs: AxisArtifactRef[];
  /** Source/build sha the artifacts were produced under (E2-02). */
  sourceSha: string | null;
  /** Optional future signature (never fabricated). */
  signature?: string;
  /** Canonical content digest over everything above (self-excluding). */
  contentDigest: string;
}

export type EnvelopeValidationCode =
  | "UNSUPPORTED_SCHEMA"
  | "DECISION_NOT_ACCEPT"
  | "DIGEST_MISMATCH"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DIGEST_CHANGED"
  | "CANDIDATE_MISMATCH"
  | "PARENT_STATE_MISMATCH"
  | "POLICY_VERSION_MISMATCH"
  | "MISSING_REQUIRED_FIELD";

export interface EnvelopeValidationResult {
  ok: boolean;
  envelope: PromotionEnvelope | null;
  issues: Array<{ code: EnvelopeValidationCode; detail: string }>;
}

export interface BuildPromotionEnvelopeInput {
  generatedBy: string;
  decisionEnvelopeDigest: string;
  candidateId: string;
  parentLevel: string;
  parentStateDigest: string;
  artifactRefs: AxisArtifactRef[];
  sourceSha?: string | null;
  generatedAtIso?: string;
}

/** Canonical digest input for the envelope (self-excluding). */
export function envelopeCanonicalInput(e: Omit<PromotionEnvelope, "contentDigest" | "signature">): string {
  return stableStringify(e);
}

export function computeEnvelopeContentDigest(e: Omit<PromotionEnvelope, "contentDigest" | "signature">): string {
  return createHash("sha256").update(envelopeCanonicalInput(e), "utf8").digest("hex");
}

/** Build a signed-by-digest promotion envelope. Pure. */
export function buildPromotionEnvelope(input: BuildPromotionEnvelopeInput): PromotionEnvelope {
  const base: Omit<PromotionEnvelope, "contentDigest" | "signature"> = {
    schemaVersion: PROMOTION_ENVELOPE_SCHEMA_VERSION,
    policyVersion: PROMOTION_ENVELOPE_POLICY_VERSION,
    generatedBy: input.generatedBy,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    decision: "ACCEPT",
    candidateId: input.candidateId,
    parentLevel: input.parentLevel,
    parentStateDigest: input.parentStateDigest,
    decisionEnvelopeDigest: input.decisionEnvelopeDigest,
    artifactRefs: [...input.artifactRefs],
    sourceSha: input.sourceSha ?? null,
  };
  return { ...base, contentDigest: computeEnvelopeContentDigest(base) };
}

function sha256OfFileBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Strict-load + verify a promotion envelope from disk.
 *
 * @param path             envelope file path
 * @param verify.parentStateDigest expected current parent state digest (or
 *                                 undefined to skip parent compare)
 * @param verify.candidateId       expected candidate id (if provided)
 * @param verify.expectedPolicyVersion expected policy version
 * @param verify.verifyArtifactRefs whether to re-read + re-digest the artifact
 *                                 files (default true)
 */
export async function loadPromotionEnvelope(
  path: string,
  verify: {
    parentStateDigest?: string;
    candidateId?: string;
    expectedPolicyVersion?: string;
    verifyArtifactRefs?: boolean;
  } = {},
): Promise<EnvelopeValidationResult> {
  const issues: Array<{ code: EnvelopeValidationCode; detail: string }> = [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    return {
      ok: false,
      envelope: null,
      issues: [{ code: "DIGEST_MISMATCH", detail: `envelope not valid JSON: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, envelope: null, issues: [{ code: "MISSING_REQUIRED_FIELD", detail: "envelope is not an object" }] };
  }
  const e = raw as Omit<PromotionEnvelope, "contentDigest"> & { contentDigest?: unknown };

  if (e.schemaVersion !== PROMOTION_ENVELOPE_SCHEMA_VERSION) {
    issues.push({ code: "UNSUPPORTED_SCHEMA", detail: `schemaVersion "${String(e.schemaVersion)}" != "${PROMOTION_ENVELOPE_SCHEMA_VERSION}"` });
  }
  if (e.decision !== "ACCEPT") {
    issues.push({ code: "DECISION_NOT_ACCEPT", detail: `decision "${String(e.decision)}" is not ACCEPT — only an E2-06 ACCEPT envelope promotes` });
  }
  if (e.contentDigest === undefined || typeof e.contentDigest !== "string") {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "contentDigest missing" });
  }
  if (typeof e.candidateId !== "string" || e.candidateId === "") {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "candidateId missing" });
  }
  if (typeof e.parentLevel !== "string" || typeof e.parentStateDigest !== "string") {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "parentLevel/parentStateDigest missing" });
  }
  if (!Array.isArray(e.artifactRefs) || e.artifactRefs.length === 0) {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "artifactRefs missing or empty" });
  }

  // Recompute the envelope's own digest (self-excluding).
  if (typeof e.contentDigest === "string") {
    const base = {
      schemaVersion: e.schemaVersion,
      policyVersion: e.policyVersion,
      generatedBy: e.generatedBy,
      generatedAtIso: e.generatedAtIso,
      decision: e.decision,
      candidateId: e.candidateId,
      parentLevel: e.parentLevel,
      parentStateDigest: e.parentStateDigest,
      decisionEnvelopeDigest: e.decisionEnvelopeDigest,
      artifactRefs: e.artifactRefs,
      sourceSha: e.sourceSha ?? null,
    };
    const recomputed = computeEnvelopeContentDigest(base);
    if (recomputed !== e.contentDigest) {
      issues.push({ code: "DIGEST_MISMATCH", detail: `envelope content digest recomputes to ${recomputed}, recorded ${e.contentDigest}` });
    }
  }

  // Verify artifact refs: file must exist and digest must be unchanged.
  if (verify.verifyArtifactRefs !== false) {
    await Promise.all(
      (e.artifactRefs ?? []).map(async (ref: AxisArtifactRef) => {
        try {
          const buf = await readFile(ref.path);
          const actual = sha256OfFileBytes(buf);
          if (actual !== ref.digest) {
            issues.push({ code: "ARTIFACT_DIGEST_CHANGED", detail: `artifact ${ref.path} digest changed: recorded ${ref.digest}, actual ${actual}` });
          }
        } catch {
          issues.push({ code: "ARTIFACT_MISSING", detail: `artifact ${ref.path} missing/unreadable` });
        }
      }),
    );
  }

  // Parent state compare (when provided).
  if (verify.parentStateDigest !== undefined && e.parentStateDigest !== verify.parentStateDigest) {
    issues.push({
      code: "PARENT_STATE_MISMATCH",
      detail: `envelope parentStateDigest ${e.parentStateDigest} != current ${verify.parentStateDigest}`,
    });
  }
  if (verify.candidateId !== undefined && e.candidateId !== verify.candidateId) {
    issues.push({ code: "CANDIDATE_MISMATCH", detail: `envelope candidate "${e.candidateId}" != expected "${verify.candidateId}"` });
  }
  if (verify.expectedPolicyVersion !== undefined && e.policyVersion !== verify.expectedPolicyVersion) {
    issues.push({ code: "POLICY_VERSION_MISMATCH", detail: `envelope policy "${e.policyVersion}" != expected "${verify.expectedPolicyVersion}"` });
  }

  const ok = issues.length === 0;
  return {
    ok,
    envelope: ok ? (raw as PromotionEnvelope) : null,
    issues,
  };
}