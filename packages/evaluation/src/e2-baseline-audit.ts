/**
 * E2-00 — read-only E2 baseline audit: does the current champion evidence
 * qualify as a reproducible, attributable, production-ready promotion?
 *
 * Background (from the E2 review): the E1 next-round eval promoted
 * `adaptive_recovery_v2` to C1 on evidence that fails the strict chain
 * "experimental fact → strict judgement → state promotion → production
 * application":
 *
 *   1. baseline and candidate come from DIFFERENT git SHAs, both `dirty=true`
 *      (actual executed source is not reconstructable) — F-01;
 *   2. each arm is a SINGLE independent run (no AB/BA interleave, no repeat
 *      metadata) yet the +1 delta was judged ACCEPT — F-02;
 *   3. the loader drops termination_reason/grade/verification/manifest, so the
 *      strict gate cannot see the underlying facts — F-03;
 *   4. `champion promote` trusts a CLI-provided `--decision ACCEPT` — F-05;
 *   5. `champion-state.json` marks C1/applied but the production harness never
 *      consumes that state — F-06.
 *
 * This module is a DETERMINISTIC, READ-ONLY audit: given the on-disk baseline
 * and candidate artifacts plus the review baseline SHA, it reports a stable
 * JSON verdict. It NEVER calls a model provider, NEVER mutates artifacts, and
 * NEVER rewrites the champion state. It only inspects and reports.
 *
 * Determinism: the verdict payload contains no wall-clock timestamp, so
 * re-running the audit on the same files yields byte-identical JSON.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const E2_BASELINE_AUDIT_SCHEMA_VERSION = "1.0.0";

/** Stable machine-readable reason codes for every audit failure. */
export type E2ReasonCode =
  | "SOURCE_DIRTY"
  | "SOURCE_SHA_MISMATCH"
  | "IMPLEMENTATION_NOT_IN_RECORDED_SOURCE"
  | "SINGLE_RUN_INSUFFICIENT"
  | "REPETITION_RECOMMENDED_BUT_ACCEPTED"
  | "PRODUCTION_APPLICATION_UNPROVEN"
  | "ARTIFACT_MISSING_OR_CORRUPT";

export interface E2AuditCheck {
  code: E2ReasonCode;
  passed: boolean;
  detail: string;
}

/** Immutable snapshot of one benchmark artifact file (digest + manifest). */
export interface E2AuditArtifactSnapshot {
  path: string;
  exists: boolean;
  /** SHA-256 of the raw file bytes (hex). Null when the file is unreadable. */
  sha256: string | null;
  /** `manifest.gitSha` recorded by the benchmark runner. */
  gitSha: string | null;
  /** `manifest.dirty` recorded by the benchmark runner. */
  dirty: boolean | null;
  /** Per-case run count (`results.length`). */
  caseCount: number | null;
  /** Repetition/interleave metadata (E2-05 shape; absent for single runs). */
  repetition: {
    /** Total planned repeats (null when not a repeated/interleaved design). */
    repeat: number | null;
    /** True when AB/BA interleaving metadata is present. */
    interleaved: boolean;
  };
}

export interface E2BaselineAuditResult {
  schemaVersion: string;
  /** Overall verdict: false unless EVERY check passes. */
  validForPromotion: boolean;
  /** The level production parsing may treat as active (C0 until re-proven). */
  activeForProduction: "C0";
  /** What the promotion history claimed at the time (null = never promoted). */
  historicalDecision: "ACCEPT" | null;
  /** Current audit validity of the recorded promotion. */
  validity: "INVALID_PROVENANCE" | "QUARANTINED_PENDING_REEVALUATION";
  /** Concrete next action under the new protocol. */
  recommendedNextAction: string;
  /** All failing reason codes (stable, sortable). */
  reasonCodes: E2ReasonCode[];
  /** Per-check detail (stable ordering by code). */
  checks: E2AuditCheck[];
  baseline: E2AuditArtifactSnapshot;
  candidate: E2AuditArtifactSnapshot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(p: string): Promise<string | null> {
  try {
    const buf = await readFile(p);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/** Load the run-artifact file shape produced by the benchmark runner
 *  (`{ manifest, results }`). Returns null when missing/corrupt (fail-closed). */
async function loadArtifact(p: string): Promise<{ manifest: Record<string, unknown>; results: unknown[] } | null> {
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as {
      manifest?: Record<string, unknown>;
      results?: unknown[];
    };
    if (raw === null || typeof raw !== "object") return null;
    const manifest = raw.manifest ?? {};
    const results = Array.isArray(raw.results) ? raw.results : [];
    return { manifest, results };
  } catch {
    return null;
  }
}

/** Build a deterministic artifact snapshot from one run file. */
export async function snapshotArtifact(path: string): Promise<E2AuditArtifactSnapshot> {
  const exists = await fileExists(path);
  if (!exists) {
    return {
      path,
      exists: false,
      sha256: null,
      gitSha: null,
      dirty: null,
      caseCount: null,
      repetition: { repeat: null, interleaved: false },
    };
  }
  const sha256 = await sha256OfFile(path);
  const artifact = await loadArtifact(path);
  if (artifact === null) {
    return {
      path,
      exists: true,
      sha256,
      gitSha: null,
      dirty: null,
      caseCount: null,
      repetition: { repeat: null, interleaved: false },
    };
  }
  const manifest = artifact.manifest;
  const gitSha = typeof manifest.gitSha === "string" ? manifest.gitSha : null;
  const dirty = typeof manifest.dirty === "boolean" ? manifest.dirty : null;
  const repetition = manifest.repetition as { repeat?: unknown; interleaved?: unknown } | null | undefined;
  const repeat = repetition !== null && repetition !== undefined && typeof repetition.repeat === "number"
    ? repetition.repeat
    : null;
  const interleaved = repetition?.interleaved === true
    || typeof manifest.interleave === "object"
    || Array.isArray(manifest.interleave);
  return {
    path,
    exists: true,
    sha256,
    gitSha,
    dirty,
    caseCount: artifact.results.length,
    repetition: { repeat, interleaved },
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface E2BaselineAuditInput {
  /** The reviewed baseline git SHA this audit is judged against. */
  reviewBaselineSha: string;
  baselinePath: string;
  candidatePath: string;
  /** Whether the recorded champion promotion is currently `applied=true`.
   *  Used for the PRODUCTION_APPLICATION_UNPROVEN check. */
  championApplied?: boolean;
  /** Candidate id recorded in the candidate manifest (for reporting). */
  candidateId?: string | null;
}

/**
 * Run the deterministic E2 baseline audit over the on-disk artifacts.
 * Read-only and provider-free: no model calls, no state mutation, no
 * wall-clock timestamps in the payload.
 */
export async function auditBaselineEvidence(input: E2BaselineAuditInput): Promise<E2BaselineAuditResult> {
  const baseline = await snapshotArtifact(input.baselinePath);
  const candidate = await snapshotArtifact(input.candidatePath);

  const checks: E2AuditCheck[] = [];
  const fail = (code: E2ReasonCode, detail: string): void => {
    checks.push({ code, passed: false, detail });
  };
  const pass = (code: E2ReasonCode, detail: string): void => {
    checks.push({ code, passed: true, detail });
  };

  // 1. Artifacts must exist and be readable (fail-closed, never auto-valid).
  if (!baseline.exists) {
    fail("ARTIFACT_MISSING_OR_CORRUPT", `baseline artifact missing: ${input.baselinePath}`);
  } else if (baseline.gitSha === null) {
    fail("ARTIFACT_MISSING_OR_CORRUPT", `baseline artifact unreadable/corrupt: ${input.baselinePath}`);
  } else {
    pass("ARTIFACT_MISSING_OR_CORRUPT", `baseline artifact present (sha256 ${baseline.sha256?.slice(0, 12)}…)`);
  }
  if (!candidate.exists) {
    fail("ARTIFACT_MISSING_OR_CORRUPT", `candidate artifact missing: ${input.candidatePath}`);
  } else if (candidate.gitSha === null) {
    fail("ARTIFACT_MISSING_OR_CORRUPT", `candidate artifact unreadable/corrupt: ${input.candidatePath}`);
  } else {
    pass("ARTIFACT_MISSING_OR_CORRUPT", `candidate artifact present (sha256 ${candidate.sha256?.slice(0, 12)}…)`);
  }

  // 2. F-01a: recorded source must be clean (reconstructable).
  if (baseline.dirty === true) {
    fail("SOURCE_DIRTY", `baseline recorded dirty=true at ${baseline.gitSha} — executed source not reconstructable`);
  } else {
    pass("SOURCE_DIRTY", "baseline recorded source is clean");
  }
  if (candidate.dirty === true) {
    fail("SOURCE_DIRTY", `candidate recorded dirty=true at ${candidate.gitSha} — executed source not reconstructable`);
  } else {
    pass("SOURCE_DIRTY", "candidate recorded source is clean");
  }

  // 3. F-01b: baseline and candidate must come from the SAME recorded source
  //    (single-variable comparison).
  if (baseline.gitSha !== null && candidate.gitSha !== null && baseline.gitSha !== candidate.gitSha) {
    fail("SOURCE_SHA_MISMATCH", `baseline gitSha ${baseline.gitSha} != candidate gitSha ${candidate.gitSha} — different source, not attributable`);
  } else if (baseline.gitSha !== null && candidate.gitSha !== null) {
    pass("SOURCE_SHA_MISMATCH", `baseline and candidate both recorded at ${baseline.gitSha}`);
  } else {
    // One side unreadable — already reported by ARTIFACT_MISSING_OR_CORRUPT.
    fail("SOURCE_SHA_MISMATCH", "cannot verify same-source: one artifact has no recorded gitSha");
  }

  // 4. F-01c: the recorded execution source must be the reviewed baseline.
  if (candidate.gitSha !== null && candidate.gitSha !== input.reviewBaselineSha) {
    fail(
      "IMPLEMENTATION_NOT_IN_RECORDED_SOURCE",
      `candidate ran at ${candidate.gitSha}, not review baseline ${input.reviewBaselineSha} — implementation may not exist in the recorded source`,
    );
  } else if (candidate.gitSha === input.reviewBaselineSha) {
    pass("IMPLEMENTATION_NOT_IN_RECORDED_SOURCE", `candidate ran at the review baseline ${input.reviewBaselineSha}`);
  }

  // 5. F-02: a promotion requires a repeated/interleaved design, not one
  //    single run of each arm.
  const repeatedDesign = baseline.repetition.repeat !== null
    || candidate.repetition.repeat !== null
    || baseline.repetition.interleaved
    || candidate.repetition.interleaved;
  if (!repeatedDesign) {
    fail("SINGLE_RUN_INSUFFICIENT", "single independent run per arm, no repetition/interleave metadata (E2-05 required)");
  } else {
    pass("SINGLE_RUN_INSUFFICIENT", `repeated design present (baseline repeat=${baseline.repetition.repeat}, candidate repeat=${candidate.repetition.repeat}, interleaved=${baseline.repetition.interleaved || candidate.repetition.interleaved})`);
  }

  // 6. F-02b: a single-run ACCEPT conflicts with the repetition recommendation.
  const historicallyAccepted = input.championApplied === true;
  if (historicallyAccepted && !repeatedDesign) {
    fail(
      "REPETITION_RECOMMENDED_BUT_ACCEPTED",
      "champion records ACCEPT on a single-run pair — repetition was recommended but the decision did not require it",
    );
  } else if (historicallyAccepted) {
    pass("REPETITION_RECOMMENDED_BUT_ACCEPTED", "ACCEPT is backed by a repeated design");
  }

  // 7. F-06: `applied=true` in champion-state.json is only a document flag
  //    until the production harness consumes the state (E2-08).
  if (input.championApplied === true) {
    fail(
      "PRODUCTION_APPLICATION_UNPROVEN",
      "champion-state.json marks applied=true but no runtime config digest / harness consumption is recorded — production application unproven",
    );
  } else {
    pass("PRODUCTION_APPLICATION_UNPROVEN", "no production application claimed");
  }

  const reasonCodes = checks.filter((c) => !c.passed).map((c) => c.code);
  const valid = reasonCodes.length === 0;

  return {
    schemaVersion: E2_BASELINE_AUDIT_SCHEMA_VERSION,
    validForPromotion: valid,
    activeForProduction: "C0",
    historicalDecision: input.championApplied === true ? "ACCEPT" : null,
    validity: valid ? "QUARANTINED_PENDING_REEVALUATION" : "INVALID_PROVENANCE",
    recommendedNextAction: valid
      ? "evidence is reproducible — proceed to E2-06 statistical judgement and E2-07 promotion envelope"
      : "do not treat the recorded C1 as production-valid; quarantine to C0 and re-run under the E2 protocol (E2-01…E2-05, then E2-15 paid repeat only with explicit authorization)",
    reasonCodes,
    checks,
    baseline,
    candidate,
  };
}
