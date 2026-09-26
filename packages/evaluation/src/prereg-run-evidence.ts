/**
 * A6 — the RAW per-run evidence artifacts a verified arm run must produce, and
 * the validator that binds a run's DECLARED evidence to those bytes.
 *
 * WHY THIS EXISTS
 * ---------------
 * `PreregisteredArmOutcome.evidence` used to be a pure claim: a runner returned
 * `{ traceDigest: "a".repeat(64), verifiedCompletion: true, … }` and the only
 * check was that the strings had the right SHAPE. A 64-hex forgery with no
 * trace, no verifier and no request-bound activation anywhere on disk was
 * indistinguishable from a real run, so a fabricated outcome could satisfy
 * every hard gate and reach ACCEPT.
 *
 * The fix is to make every decision input a REFERENCE to raw bytes the executor
 * wrote to a driver-created evidence directory, and to VERIFY the reference by
 * reading those bytes back:
 *
 *   manifest.json  — the immutable run manifest; its sha256 MUST equal the
 *                    declared `traceDigest`, and it MUST carry this run's exact
 *                    identity (digest, plan, armRunId, arm, case, repetition,
 *                    orderIndex, executor). A swapped, truncated or regenerated
 *                    manifest cannot match.
 *   verifier.json  — the REAL verifier's raw output; it must corroborate the
 *                    declared `verifiedCompletion` (a bare boolean is ignored).
 *   activation.json— request-bound activation evidence; present IFF the declared
 *                    `activationEvidenceDigest` is non-null, and its bytes MUST
 *                    hash to that digest. A baseline run carrying one is
 *                    CONTAMINATION, not activation.
 *   security.json  — the raw security-event log; it must corroborate the
 *                    declared `securityViolations`.
 *
 * A missing/unreadable/mismatching artifact makes the run UNVERIFIED, which the
 * aggregate renders as `digestValid=false` → INVALID — never ACCEPT. Hashing is
 * an INTEGRITY check, not a proof of honest execution: binding to the trusted
 * execution manifest and the budget journal is the further A6 item and is not
 * claimed here.
 *
 * PURE / OFFLINE: reads local files, no provider, no network.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PREREG_RUN_MANIFEST_SCHEMA = "prereg-run-manifest-v1";
export const PREREG_RUN_VERIFIER_SCHEMA = "prereg-run-verifier-v1";
export const PREREG_RUN_SECURITY_SCHEMA = "prereg-run-security-v1";

/** The per-run evidence directory name, relative to the campaign results dir. */
export const PREREG_RUN_EVIDENCE_DIRNAME = "evidence";

export const PREREG_RUN_EVIDENCE_FILENAMES = {
  manifest: "manifest.json",
  verifier: "verifier.json",
  activation: "activation.json",
  security: "security.json",
} as const;

/** The immutable run manifest an executor writes for ONE arm run. */
export interface PreregRunManifest {
  schemaVersion: string;
  executorId: string;
  preregistrationDigest: string;
  planDigest: string;
  armRunId: string;
  armId: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  orderIndex: number;
}

/** The exact identity a run's artifacts and record must agree on. */
export interface PreregRunIdentity {
  preregistrationDigest: string;
  planDigest: string;
  armRunId: string;
  armId: "baseline" | "candidate";
  caseId: string;
  repetition: number;
  orderIndex: number;
}

/** The evidence a runner DECLARES; every field is re-checked against raw bytes. */
export interface PreregDeclaredEvidence {
  executorId: string;
  traceDigest: string;
  verifiedCompletion: boolean;
  securityViolations: number;
  activationEvidenceDigest: string | null;
}

export interface PreregEvidenceVerification {
  /** TRUE only when every declared field is corroborated by raw artifacts. */
  verified: boolean;
  problems: string[];
}

function sha256Hex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

const IDENTITY_KEYS = [
  "preregistrationDigest",
  "planDigest",
  "armRunId",
  "armId",
  "caseId",
  "repetition",
  "orderIndex",
] as const;

/**
 * Read the raw artifacts in `evidenceDir` and decide whether they corroborate
 * `declared`. Never throws: every failure is a `problem`, so the caller can
 * record an explicitly UNVERIFIED run instead of guessing.
 */
export function verifyArmEvidenceFromArtifacts(
  evidenceDir: string,
  identity: PreregRunIdentity,
  declared: PreregDeclaredEvidence,
): PreregEvidenceVerification {
  const problems: string[] = [];
  const readArtifact = (name: string): string | null => {
    try {
      return readFileSync(join(evidenceDir, name), "utf8");
    } catch {
      problems.push(`artifact ${name} is missing or unreadable`);
      return null;
    }
  };

  // --- manifest: the trace identity and integrity ---------------------------
  const manifestText = readArtifact(PREREG_RUN_EVIDENCE_FILENAMES.manifest);
  if (manifestText !== null) {
    if (sha256Hex(manifestText) !== declared.traceDigest) {
      problems.push("traceDigest does not match the manifest bytes");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      problems.push("manifest is not valid JSON");
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const man = parsed as Record<string, unknown>;
      if (man.schemaVersion !== PREREG_RUN_MANIFEST_SCHEMA) {
        problems.push("manifest schemaVersion is not the expected run-manifest schema");
      }
      if (man.executorId !== declared.executorId) {
        problems.push("manifest executorId does not match the declared executor");
      }
      for (const key of IDENTITY_KEYS) {
        if (man[key] !== identity[key]) {
          problems.push(`manifest ${key} does not match this run's identity`);
        }
      }
    } else if (parsed !== null) {
      problems.push("manifest is not a JSON object");
    }
  }

  // --- verifier: a bare boolean is not a verdict ----------------------------
  const verifierText = readArtifact(PREREG_RUN_EVIDENCE_FILENAMES.verifier);
  if (verifierText !== null) {
    try {
      const v = JSON.parse(verifierText) as Record<string, unknown>;
      if (v.schemaVersion !== PREREG_RUN_VERIFIER_SCHEMA) {
        problems.push("verifier schemaVersion is not the expected schema");
      }
      if (v.verifiedCompletion !== declared.verifiedCompletion) {
        problems.push("verifier verdict does not corroborate the declared verifiedCompletion");
      }
    } catch {
      problems.push("verifier artifact is not valid JSON");
    }
  }

  // --- security: an unobserved event count is not a cleared campaign --------
  const securityText = readArtifact(PREREG_RUN_EVIDENCE_FILENAMES.security);
  if (securityText !== null) {
    try {
      const s = JSON.parse(securityText) as Record<string, unknown>;
      if (s.schemaVersion !== PREREG_RUN_SECURITY_SCHEMA) {
        problems.push("security schemaVersion is not the expected schema");
      }
      if (s.violations !== declared.securityViolations) {
        problems.push("security log does not corroborate the declared securityViolations");
      }
    } catch {
      problems.push("security artifact is not valid JSON");
    }
  }

  // --- activation: request-bound evidence, or none at all -------------------
  const activationPath = join(evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.activation);
  if (declared.activationEvidenceDigest !== null) {
    const activationText = readArtifact(PREREG_RUN_EVIDENCE_FILENAMES.activation);
    if (activationText !== null && sha256Hex(activationText) !== declared.activationEvidenceDigest) {
      problems.push("activationEvidenceDigest does not match the activation artifact bytes");
    }
  } else if (existsSync(activationPath)) {
    problems.push("a non-activated run must not carry an activation artifact");
  }

  return { verified: problems.length === 0, problems };
}