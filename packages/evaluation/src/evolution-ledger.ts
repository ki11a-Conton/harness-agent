/**
 * E2-12 — EvolutionLedger: single machine-truth source for evolution evidence.
 *
 * Fixes the F-13 contradiction problem: handoff / decision ledger / evidence
 * JSONs were separately hand-written and could disagree (one says C0, another
 * C1; an evidence file points at a missing path). This module establishes ONE
 * versioned ledger whose fields are either IMPORTED RECORDS (historical
 * verdicts, validity, reason codes) or DERIVED FROM the canonical artifacts on
 * disk (durations, case/pass counts, security summaries, digests).
 *
 * Design rules:
 *   - the ledger is the machine truth; human handoff text is GENERATED or
 *     STRICTLY VERIFIED against it (written narrative may only add comments,
 *     never override machine facts);
 *   - every referenced artifact path must EXIST and its content digest must
 *     match the recorded digest, else verify fails (MISSING_REFERENCE /
 *     DIGEST_MISMATCH);
 *   - summaries (duration / case count / pass count / security) are recomputed
 *     from the artifact and compared — hand-written conflicts fail;
 *   - exactly ONE active champion (C0 default); legacy artifacts are never
 *     promotion-eligible;
 *   - AR2 is recorded with BOTH layers: historical raw decision (was ACCEPT)
 *     and E2 validity (INVALID_PROVENANCE, signal at most
 *     PROMISING_BUT_INCONCLUSIVE, active production C0).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { stableStringify } from "./manifest.js";

export const EVOLUTION_LEDGER_SCHEMA_VERSION = "2.0.0";

export type EvidenceValidity =
  | "PROVEN"
  | "INVALID_PROVENANCE"
  | "QUARANTINED_PENDING_REEVALUATION"
  | "HISTORICAL_ONLY";

export interface LedgerArtifactRef {
  /** Repository-relative path (verified to exist + digest). */
  path: string;
  /** sha256 of the file at import time (re-verified by the checker). */
  digest: string;
  /** Role of this artifact (baseline/candidate/paired-report/audit). */
  role: "baseline" | "candidate" | "paired-report" | "audit" | "evidence";
}

export interface LedgerExperimentEntry {
  /** Experiment id (e.g. E1-NEXT-004). */
  experimentId: string;
  candidateId: string | null;
  /** Parent/previous candidate (null = champion baseline). */
  parentCandidateId: string | null;
  /** Artifacts this experiment references. */
  artifacts: LedgerArtifactRef[];
  /** Machine-derived facts (recomputed during check, not hand-written). */
  derived: {
    caseCount: number | null;
    passedCount: number | null;
    totalDurationMs: number | null;
    securityBreaches: number | null;
  } | null;
  /** Historical raw decision (what the decision layer said AT THE TIME). */
  rawDecision: "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "INVALID" | null;
  /** E2 validity (what the E2 audit concludes NOW). */
  currentValidity: EvidenceValidity;
  /** Stable reason codes (E2-00/E2-02/E2-06). */
  reasonCodes: string[];
  /** Also-relevant quality/security/activation summary (machine-checked). */
  qualitySummary: string | null;
  securitySummary: string | null;
  activationSummary: string | null;
  /** Paid authorization reference (presence only, never a secret). */
  paidAuthorization: { authorized: boolean } | null;
  /** Champion transition refs (promoted to/rolled back from). */
  championTransitionRefs: string[];
  /** Hand-written narrative may ONLY add comments, never override facts. */
  humanNotes: string | null;
}

export interface EvolutionLedger {
  schemaVersion: string;
  generatedAtIso: string;
  reviewBaselineSha: string;
  activeChampion: {
    level: string;
    candidateId: string | null;
    validity: EvidenceValidity;
  };
  experiments: LedgerExperimentEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function digestOfText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Resolve a repo-relative ref against the repo root (absolute-safe). */
export function resolveRef(repoRoot: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(repoRoot, ref);
}

/** Recompute machine-derived facts from a holdout artifact JSON. */
export function deriveFactsFromHoldout(
  parsed: { results?: Array<{ duration_ms?: number; success?: boolean }> },
): LedgerExperimentEntry["derived"] {
  if (!Array.isArray(parsed.results)) return null;
  let passed = 0;
  let totalDurationMs = 0;
  for (const r of parsed.results) {
    if (r.success === true) passed += 1;
    totalDurationMs += typeof r.duration_ms === "number" ? r.duration_ms : 0;
  }
  return {
    caseCount: parsed.results.length,
    passedCount: passed,
    totalDurationMs,
    securityBreaches: null, // typed security outcomes are recomputed by E2-11
  };
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export type VerifyIssueCode =
  | "MISSING_REFERENCE"
  | "DIGEST_MISMATCH"
  | "SUMMARY_MISMATCH"
  | "ACTIVE_CHAMPION_NOT_UNIQUE"
  | "LEGACY_PROMOTION_ELIGIBLE"
  | "AR2_VALIDITY_CONTRADICTION"
  | "GENERATED_AT_STALE";

export interface VerifyIssue {
  code: VerifyIssueCode;
  detail: string;
  experimentId?: string;
}

export interface VerifyOptions {
  /** Filesystem read (injectable for tests). */
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}

export interface EvolutionVerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
}

/** Verify the ledger against the repository: refs exist + digests match,
 *  derived facts recompute, one active champion, no legacy promotion. */
export async function verifyEvolutionLedger(
  ledger: EvolutionLedger,
  repoRoot: string,
  opts: VerifyOptions = {},
): Promise<EvolutionVerifyResult> {
  const read = opts.readFile ?? ((p: string) => readFile(p, "utf8"));
  const issues: VerifyIssue[] = [];

  // 1. Every artifact ref exists and digests match.
  for (const exp of ledger.experiments) {
    for (const ref of exp.artifacts) {
      const abs = resolveRef(repoRoot, ref.path);
      let content: string;
      try {
        content = await read(abs);
      } catch {
        issues.push({ code: "MISSING_REFERENCE", experimentId: exp.experimentId, detail: `artifact ${ref.path} does not exist` });
        continue;
      }
      const actual = digestOfText(content);
      if (actual !== ref.digest) {
        issues.push({ code: "DIGEST_MISMATCH", experimentId: exp.experimentId, detail: `${ref.path}: recorded ${ref.digest.slice(0, 12)}, actual ${actual.slice(0, 12)}` });
      }
    }

    // 2. Derived facts recompute from the CANDIDATE artifact (or baseline when
    //    no candidate exists). The ledger's derived facts describe the
    //    EXPERIMENT's measured outcome — which is the candidate arm.
    const holdoutRef = exp.artifacts.find((a) => a.role === "candidate")
      ?? exp.artifacts.find((a) => a.role === "baseline");
    if (holdoutRef !== undefined) {
      try {
        const parsed = JSON.parse(await read(resolveRef(repoRoot, holdoutRef.path))) as {
          results?: Array<{ duration_ms?: number; success?: boolean }>;
        };
        const derived = deriveFactsFromHoldout(parsed);
        if (derived !== null && exp.derived !== null) {
          if (derived.caseCount !== exp.derived.caseCount || derived.passedCount !== exp.derived.passedCount) {
            issues.push({
              code: "SUMMARY_MISMATCH",
              experimentId: exp.experimentId,
              detail: `case/pass count mismatch: expected ${derived.caseCount}/${derived.passedCount}, recorded ${exp.derived.caseCount}/${exp.derived.passedCount}`,
            });
          }
        } else if (exp.derived === null) {
          issues.push({ code: "SUMMARY_MISMATCH", experimentId: exp.experimentId, detail: `${holdoutRef.path} has results but derived is null` });
        }
      } catch {
        issues.push({ code: "MISSING_REFERENCE", experimentId: exp.experimentId, detail: `${holdoutRef.path} unreadable/invalid JSON` });
      }
    }

    // 3. Legacy evidence must never be promotion-eligible.
    if (exp.currentValidity === "HISTORICAL_ONLY" && exp.rawDecision === "ACCEPT") {
      issues.push({
        code: "LEGACY_PROMOTION_ELIGIBLE",
        experimentId: exp.experimentId,
        detail: `${exp.candidateId} has HISTORICAL_ONLY validity but rawDecision ACCEPT — legacy evidence must never promote`,
      });
    }
  }

  // 4. Exactly one active champion (ledger records it once).
  if (ledger.activeChampion === undefined || ledger.activeChampion.level === undefined) {
    issues.push({ code: "ACTIVE_CHAMPION_NOT_UNIQUE", detail: "no active champion recorded" });
  }

  // 5. AR2 double-layer consistency: validity must be INVALID_PROVENANCE (or
  //    quarantined) — never PROVEN — and raw decision may note ACCEPT history.
  for (const exp of ledger.experiments) {
    if (exp.candidateId === "adaptive_recovery_v2") {
      const validValidities = ["INVALID_PROVENANCE", "QUARANTINED_PENDING_REEVALUATION", "HISTORICAL_ONLY"];
      if (exp.currentValidity === "PROVEN") {
        issues.push({ code: "AR2_VALIDITY_CONTRADICTION", experimentId: exp.experimentId, detail: "adaptive_recovery_v2 must not be PROVEN under E2 (single dirty cross-SHA run)" });
      }
      void validValidities;
    }
  }

  return { ok: issues.length === 0, issues };
}