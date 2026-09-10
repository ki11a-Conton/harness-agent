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
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { stableStringify } from "./manifest.js";
import { loadExperimentArtifactV3, validateExperimentArtifactV3FromBytes } from "./artifact-v3/loader.js";

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
  | "PATH_OUTSIDE_BUNDLE"
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

/** Digest the writer/E2-06 layer uses for artifact digests: sha256 over the
 *  TRIMMED UTF-8 text (loadV3ArtifactPair's convention). The replay must
 *  recompute it EXACTLY like the writer, or a genuine bundle would mismatch. */
function sha256OfTrimmedText(buf: Buffer): string {
  return createHash("sha256").update(buf.toString("utf8").trim(), "utf8").digest("hex");
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
/**
 * E4-06 #3 — a bundle ref must resolve inside the trusted bundle root, both
 * lexically (no `..` traversal, no absolute path to elsewhere) and after
 * symlink resolution. Returns violation strings (empty when safe).
 */
async function pathGuardViolations(bundleRoot: string, p: string, role: string): Promise<string[]> {
  const out: string[] = [];
  const abs = resolve(bundleRoot, p);
  const rel = relative(bundleRoot, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    out.push(`${role}: path "${p}" resolves outside the trusted bundle root`);
    return out; // refuse to read anything outside the root
  }
  try {
    const realRoot = await realpath(bundleRoot);
    const realTarget = await realpath(abs);
    const realRel = relative(realRoot, realTarget);
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
      out.push(`${role}: path "${p}" escapes the bundle root via symlink`);
    }
  } catch (pathErr) {
    // Best-effort realpath check; when the target does not exist or cannot be
    // resolved the strict artifact load reports it as ARTIFACT_NOT_V3 below.
    // Still reported so a flaky filesystem is never invisible.
    process.stderr.write(`[degraded] promotion-envelope realpath check skipped: ${pathErr instanceof Error ? pathErr.message : String(pathErr)}\n`);
  }
  return out;
}

export async function loadPromotionEnvelope(
  path: string,
  verify: {
    parentStateDigest?: string;
    candidateId?: string;
    expectedPolicyVersion?: string;
    verifyArtifactRefs?: boolean;
    /** E3-07: re-read + re-digest the DecisionArtifactV3 (default true). */
    verifyDecisionArtifact?: boolean;
    /** E4-06 #3: trusted bundle root. Every artifact ref and the decision
     *  artifact must resolve INSIDE this directory (no traversal / symlink
     *  escape). Defaults to the envelope's own directory. */
    bundleRoot?: string;
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

  // E4-R04 (F11): every path/read in this loader resolves against the trusted
  // BUNDLE ROOT — never process.cwd() — and each file is read ONCE, so the
  // bytes used for digest verification, strict parse and evaluator replay are
  // the same bytes (a file swapped between check and consume cannot smuggle
  // different content through).
  const bundleRoot = verify.bundleRoot ?? dirname(resolve(path));
  const readOnce = new Map<string, Buffer>();
  const readBytes = async (absPath: string): Promise<Buffer | null> => {
    if (readOnce.has(absPath)) return readOnce.get(absPath)!;
    try {
      const b = await readFile(absPath);
      readOnce.set(absPath, b);
      return b;
    } catch {
      return null;
    }
  };
  /** Resolve `p` inside bundleRoot, rejecting traversal/symlink escape BEFORE any
   *  content read; returns the canonical absolute path or null with violations. */
  const resolveBundleRef = async (p: string, role: string): Promise<{ abs: string | null; violations: string[] }> => {
    const violations = await pathGuardViolations(bundleRoot, p, role);
    if (violations.length > 0) return { abs: null, violations };
    return { abs: resolve(bundleRoot, p), violations: [] };
  };

  // Verify artifact refs: file must exist and digest must be unchanged. Reads
  // resolve against bundleRoot and reuse the readOnce cache (F11).
  if (verify.verifyArtifactRefs !== false) {
    await Promise.all(
      (e.artifactRefs ?? []).map(async (ref: AxisArtifactRef) => {
        const { abs, violations } = await resolveBundleRef(ref.path, `artifactRef ${ref.role ?? "?"}`);
        for (const v of violations) issues.push({ code: "PATH_OUTSIDE_BUNDLE", detail: v });
        if (abs === null) return;
        const buf = await readBytes(abs);
        if (buf === null) {
          issues.push({ code: "ARTIFACT_MISSING", detail: `artifact ${ref.path} missing/unreadable` });
          return;
        }
        const actual = sha256OfFileBytes(buf);
        if (actual !== ref.digest) {
          issues.push({ code: "ARTIFACT_DIGEST_CHANGED", detail: `artifact ${ref.path} digest changed: recorded ${ref.digest}, actual ${actual}` });
        }
      }),
    );
  }

  // E4-R15 (N11): the decision artifact is verified through the SAME single
  // read path as every other bundle ref (the E4-06 block below): resolve
  // against bundleRoot → containment guard → readBytes (read once) → digest →
  // strict shape → cross-binding → evaluator replay. The pre-E4-R15 branch
  // that called `readFile(e.decisionArtifactPath)` directly (resolving a
  // RELATIVE path against process.cwd() and reading the file a SECOND time)
  // is REMOVED — there is exactly one read path.

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
    // candidate artifact). Resolved against bundleRoot so a moved bundle still
    // compares the same files (F11).
    if (baseRef && candRef) {
      const b = await resolveBundleRef(baseRef.path, "baseline artifactRef");
      const c = await resolveBundleRef(candRef.path, "candidate artifactRef");
      if (b.abs !== null && c.abs !== null && b.abs === c.abs) {
        issues.push({ code: "CROSS_BINDING_MISMATCH", detail: "baseline and candidate artifactRefs resolve to the same file (one file per role)" });
      }
    }

    // E4-R04 (F11): every read resolves against the BUNDLE ROOT (never
    // process.cwd()), and each file is read ONCE — the same bytes are used for
    // digest verification, strict parse AND evaluator replay, so a file swapped
    // between "check" and "consume" cannot smuggle different content through.
    const strictLoadV3 = async (ref: AxisArtifactRef | undefined, role: string) => {
      if (!ref) return null;
      // Resolve against bundleRoot (F11), then read ONCE and validate from bytes.
      const { abs, violations } = await resolveBundleRef(ref.path, `${role} artifactRef`);
      for (const v of violations) issues.push({ code: "PATH_OUTSIDE_BUNDLE", detail: v });
      if (abs === null) return null;
      const bytes = await readBytes(abs);
      if (bytes === null) {
        issues.push({ code: "ARTIFACT_NOT_V3", detail: `${role} artifact ${ref.path} unreadable` });
        return null;
      }
      try {
        const artifacts = validateExperimentArtifactV3FromBytes(bytes.toString("utf8"), abs);
        return { artifact: artifacts.artifact, digest: sha256OfTrimmedText(bytes) };
      } catch (err) {
        issues.push({ code: "ARTIFACT_NOT_V3", detail: `${role} artifact ${ref.path} fails strict V3 load: ${err instanceof Error ? err.message : String(err)}` });
        return null;
      }
    };
    const candV3 = await strictLoadV3(candRef, "candidate");
    const baseV3 = await strictLoadV3(baseRef, "baseline");

    // candidate must be promotion-eligible (strong isolation recorded at run
    // time) — AND, per E4-R15 (N09 defense), the eligibility claim is not
    // trusted as a bare boolean: a promotion-eligible candidate must carry the
    // full R13 execution plan and the R14 completion marker.
    if (candV3) {
      const m = candV3.artifact.manifest as Record<string, unknown>;
      if (m["promotionEligible"] !== true) {
        issues.push({ code: "CANDIDATE_NOT_ELIGIBLE", detail: `candidate promotionEligible=${String(m["promotionEligible"])} — insecure/none isolation cannot promote` });
      }
      if (typeof m["executionPlan"] !== "object" || m["executionPlan"] === null || Array.isArray(m["executionPlan"])) {
        issues.push({ code: "CANDIDATE_NOT_ELIGIBLE", detail: "candidate manifest lacks the confirmed execution plan (E4-R13) — a self-declared eligibility boolean cannot promote" });
      }
      if (m["runComplete"] !== true) {
        issues.push({ code: "CANDIDATE_NOT_ELIGIBLE", detail: `candidate manifest runComplete=${String(m["runComplete"])} — an incomplete experiment cannot promote` });
      }
    }

    // DecisionArtifact: recompute its content digest + cross-bind to the plan.
    if (typeof e.decisionArtifactPath === "string") {
      const { abs: daAbs, violations: daViolations } = await resolveBundleRef(e.decisionArtifactPath, "decisionArtifact");
      for (const v of daViolations) issues.push({ code: "PATH_OUTSIDE_BUNDLE", detail: v });
      if (daAbs !== null) {
        try {
          if (verify.verifyDecisionArtifact !== false) {
            const buf = await readBytes(daAbs);
            if (buf === null) {
              issues.push({ code: "DECISION_ARTIFACT_MISSING", detail: `decision artifact ${e.decisionArtifactPath} missing/unreadable` });
            } else {
              const actualDaDigest = sha256OfFileBytes(buf);
              if (actualDaDigest !== e.decisionArtifactDigest) {
                issues.push({ code: "DECISION_ARTIFACT_DIGEST_CHANGED", detail: `decision artifact ${e.decisionArtifactPath} digest changed: recorded ${e.decisionArtifactDigest}, actual ${actualDaDigest}` });
              }
              const parsed = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
              // E4-R04 #4: strict version support — a non-empty string is not enough.
              if (parsed.schemaVersion !== "3.0.0") {
                issues.push({ code: "DECISION_ARTIFACT_INVALID", detail: `decision artifact schemaVersion ${JSON.stringify(parsed.schemaVersion)} != supported 3.0.0` });
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
              const { computeDecisionArtifactContentDigestV3 } = await import("./champion-eval-v3.js");
              const recomputed = computeDecisionArtifactContentDigestV3(parsed);
              if (typeof parsed.contentDigest !== "string" || recomputed !== parsed.contentDigest) {
                issues.push({ code: "DECISION_ARTIFACT_DIGEST_INVALID", detail: `decision artifact contentDigest recomputes to ${recomputed}, recorded ${String(parsed.contentDigest)}` });
              }
              if (typeof parsed.candidateId === "string" && parsed.candidateId !== e.candidateId) {
                issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `decision.candidateId "${String(parsed.candidateId)}" != envelope.candidateId "${e.candidateId}"` });
              }
              if (candV3 && parsed.planDigest !== (candV3.artifact.manifest["planDigest"] ?? null)) {
                issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `decision.planDigest ${String(parsed.planDigest)} != candidate manifest.planDigest ${String(candV3.artifact.manifest["planDigest"])}` });
              }
              if (candV3 && e.sourceSha != null && e.sourceSha !== candV3.artifact.provenance.gitSha) {
                issues.push({ code: "CROSS_BINDING_MISMATCH", detail: `envelope.sourceSha ${String(e.sourceSha)} != candidate provenance.gitSha ${String(candV3.artifact.provenance.gitSha)}` });
              }
              // E4-06 #4/#5 + E4-R04 (F09): replay the pure evaluator on the
              // strict-loaded pair with digests computed from the ACTUAL bytes
              // that were read; require the FULL payload to match. A file that
              // says ACCEPT over a pair that actually fails is caught here.
              if (baseV3 && candV3) {
                const { verifyDecisionArtifactReplayV3 } = await import("./champion-eval-v3.js");
                const replayViolations = verifyDecisionArtifactReplayV3(
                  baseV3.artifact,
                  candV3.artifact,
                  parsed,
                  baseV3.digest,
                  candV3.digest,
                );
                for (const v of replayViolations) {
                  issues.push({ code: "DECISION_REPLAY_MISMATCH", detail: v });
                }
              }
            }
          }
        } catch (replayErr) {
          // E4-R15 (N11): a replay THROW is a rejection issue — never a
          // degraded log that lets the promotion proceed on unverified bytes.
          issues.push({ code: "DECISION_REPLAY_MISMATCH", detail: `evaluator replay threw: ${replayErr instanceof Error ? replayErr.message : String(replayErr)}` });
        }
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