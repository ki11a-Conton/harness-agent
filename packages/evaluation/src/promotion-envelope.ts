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
import { resolve } from "node:path";
import { stableStringify } from "./manifest.js";
import { loadExperimentArtifactV3 } from "./artifact-v3/loader.js";

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
  /** E3-07: path + digest of the REAL DecisionArtifactV3 that authorized this
   *  promotion. A bare digest string is NOT authority — the artifact must
   *  exist and its content digest must match. */
  decisionArtifactPath: string;
  decisionArtifactDigest: string;
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
  | "ARTIFACT_NOT_V3"
  | "CANDIDATE_NOT_ELIGIBLE"
  | "CROSS_BINDING_MISMATCH"
  | "DECISION_ARTIFACT_MISSING"
  | "DECISION_ARTIFACT_DIGEST_CHANGED"
  | "DECISION_ARTIFACT_INVALID"
  | "DECISION_ARTIFACT_DIGEST_INVALID"
  | "DECISION_REPLAY_MISMATCH"
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
  /** E3-07: real DecisionArtifactV3 path + content digest (REQUIRED). */
  decisionArtifactPath: string;
  decisionArtifactDigest: string;
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
    decisionArtifactPath: input.decisionArtifactPath,
    decisionArtifactDigest: input.decisionArtifactDigest,
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
    /** E3-07: re-read + re-digest the DecisionArtifactV3 (default true). */
    verifyDecisionArtifact?: boolean;
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
  if (typeof e.decisionArtifactPath !== "string" || e.decisionArtifactPath === "") {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "decisionArtifactPath missing" });
  }
  if (typeof e.decisionArtifactDigest !== "string" || e.decisionArtifactDigest === "") {
    issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "decisionArtifactDigest missing" });
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
      decisionArtifactPath: e.decisionArtifactPath,
      decisionArtifactDigest: e.decisionArtifactDigest,
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

  // E3-07: verify the REAL DecisionArtifact that authorized this promotion.
  // A bare `decisionEnvelopeDigest` string is NOT authority — the decision
  // artifact must exist, its content digest must match, and it must be a
  // valid DecisionArtifactV3 with schema + policy + contentDigest + ACCEPT
  // decision (acceptance #1/#2).
  if (verify.verifyDecisionArtifact !== false && typeof e.decisionArtifactPath === "string") {
    try {
      const buf = await readFile(e.decisionArtifactPath);
      const actual = sha256OfFileBytes(buf);
      if (actual !== e.decisionArtifactDigest) {
        issues.push({ code: "DECISION_ARTIFACT_DIGEST_CHANGED", detail: `decision artifact ${e.decisionArtifactPath} digest changed: recorded ${e.decisionArtifactDigest}, actual ${actual}` });
      } else {
        // Digest matches — confirm the artifact is a valid DecisionArtifactV3:
        // schemaVersion, policyVersion, contentDigest and ACCEPT decision.
        try {
          const parsed = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
          if (typeof parsed.schemaVersion !== "string" || parsed.schemaVersion === "") {
            issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: "decision artifact missing schemaVersion" });
          }
          if (typeof parsed.policyVersion !== "string" || parsed.policyVersion === "") {
            issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: "decision artifact missing policyVersion" });
          }
          if (parsed.decision !== "ACCEPT") {
            issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: `decision artifact decision="${String(parsed.decision)}" is not ACCEPT` });
          }
          if (typeof parsed.contentDigest !== "string" || parsed.contentDigest === "") {
            issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: "decision artifact missing contentDigest" });
          }
        } catch {
          issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: "decision artifact is not valid JSON" });
        }
      }
    } catch {
      issues.push({ code: "DECISION_ARTIFACT_MISSING", detail: `decision artifact ${e.decisionArtifactPath} missing/unreadable` });
    }
  }

  // E4-06 — the envelope is authority ONLY if the referenced artifacts are REAL
  // V3 experiment artifacts + a REAL DecisionArtifact, cross-bound to each
  // other, and the candidate is promotion-eligible. A JSON that merely says
  // ACCEPT with correct file SHAs is NOT enough: the files must strict-load as
  // V3, the DecisionArtifact's own content digest must recompute, and its
  // planDigest / candidateId / sourceSha must agree with the artifacts.
  if (verify.verifyArtifactRefs !== false) {
    const refByRole = new Map<string, AxisArtifactRef>();
    for (const ref of e.artifactRefs ?? []) {
      if (ref && typeof ref.role === "string") {
        if (refByRole.has(ref.role)) {
          issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `duplicate artifactRef role "${ref.role}" (one file per role)` });
        }
        refByRole.set(ref.role, ref);
      }
    }
    const baseRef = refByRole.get("baseline");
    const candRef = refByRole.get("candidate");
    if (!baseRef) issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "artifactRefs missing a baseline role" });
    if (!candRef) issues.push({ code: "MISSING_REQUIRED_FIELD", detail: "artifactRefs missing a candidate role" });
    // One file may not impersonate two roles (e.g. baseline ref pointed at the
    // candidate artifact).
    if (baseRef && candRef && resolve(baseRef.path) === resolve(candRef.path)) {
      issues.push({ code: "CROSS_BINDING_MISMATCH", detail: "baseline and candidate artifactRefs resolve to the same file (one file per role)" });
    }

    const strictLoadV3 = async (ref: AxisArtifactRef | undefined, role: string) => {
      if (!ref) return null;
      // Full strict load: schema + refs + content digest + summary + eventRecords.
      // A plain text file, a non-V3 shape, or a V3 whose internal contentDigest
      // no longer matches its (tampered) outcomes all throw here.
      try {
        const { artifact } = await loadExperimentArtifactV3(ref.path);
        return artifact;
      } catch (err) {
        issues.push({ code: "ARTIFACT_NOT_V3", detail: `${role} artifact ${ref.path} fails strict V3 load: ${err instanceof Error ? err.message : String(err)}` });
        return null;
      }
    };
    const candV3 = await strictLoadV3(candRef, "candidate");
    const baseV3 = await strictLoadV3(baseRef, "baseline");

    // candidate must be promotion-eligible (strong isolation recorded at run time).
    if (candV3 && candV3.manifest["promotionEligible"] !== true) {
      issues.push({ code: "CANDIDATE_NOT_ELIGIBLE", detail: `candidate promotionEligible=${String(candV3.manifest["promotionEligible"])} — insecure/none isolation cannot promote` });
    }

    // DecisionArtifact: recompute its content digest + cross-bind to the plan.
    if (typeof e.decisionArtifactPath === "string") {
      try {
        const buf = await readFile(e.decisionArtifactPath);
        const parsed = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
        const recomputed = computeDecisionArtifactContentDigestV3(parsed);
        if (typeof parsed.contentDigest !== "string" || recomputed !== parsed.contentDigest) {
          issues.push({ code: "DECISION_ARTIFACT_DIGEST_INVALID", detail: `decision artifact contentDigest recomputes to ${recomputed}, recorded ${String(parsed.contentDigest)}` });
        }
        if (typeof parsed.candidateId === "string" && parsed.candidateId !== e.candidateId) {
          issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `decision.candidateId "${String(parsed.candidateId)}" != envelope.candidateId "${e.candidateId}"` });
        }
        if (candV3 && parsed.planDigest !== (candV3.manifest["planDigest"] ?? null)) {
          issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `decision.planDigest ${String(parsed.planDigest)} != candidate manifest.planDigest ${String(candV3.manifest["planDigest"])}` });
        }
        if (candV3 && e.sourceSha != null && e.sourceSha !== candV3.provenance.gitSha) {
          issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `envelope.sourceSha ${String(e.sourceSha)} != candidate provenance.gitSha ${String(candV3.provenance.gitSha)}` });
        }
        // E4-06 #4/#5: replay the pure evaluator on the strict-loaded pair and
        // require the FULL decision payload to match the stored artifact. A file
        // that says ACCEPT over a pair that actually fails is caught here.
        if (baseV3 && candV3) {
          const { verifyDecisionArtifactReplayV3 } = await import("./champion-eval-v3.js");
          const replayViolations = verifyDecisionArtifactReplayV3(baseV3, candV3, parsed);
          for (const v of replayViolations) {
            issues.push({ code: "DECISION_REPLAY_MISMATCH", detail: v });
          }
        }
      } catch {
        // presence/JSON already reported by the block above
      }
    }
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