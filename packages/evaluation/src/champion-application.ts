/**
 * E4-07 — AppliedProof and champion application verification (pure layer).
 *
 * `champion promote` may only record `applicationPending` (applied=false).
 * `applied` becomes true ONLY when a real process startup has:
 *   1. resolved the champion profile,
 *   2. passed its config into the actual `createHarness`,
 *   3. verified that the harness's FINAL resolved config really carries the
 *      champion's values — with each champion-controlled key's ORIGIN being the
 *      runtime layer (so a default fallback or an environment override cannot
 *      be laundered into "applied"), and
 *   4. CAS-written a proof binding the state generation, the target hash and
 *      the hash computed from createHarness's own resolved config.
 *
 * This module is pure and harness-agnostic: the app layer (which owns the
 * HarnessConfig / ResolvedConfig types) projects the resolved config into
 * `ChampionFieldCheckV1` records and hands them here. The same verification
 * path is therefore shared by CLI and Web.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const APPLIED_PROOF_SCHEMA_VERSION = "1.0.0";

/** Evidence that a real runtime actually applied a champion profile. */
export interface AppliedProofV1 {
  schemaVersion: typeof APPLIED_PROOF_SCHEMA_VERSION;
  /** Content digest of the champion state this proof applies to — the
   *  generation token. A newer state has a different digest, so a stale proof
   *  cannot authorize a current promotion. */
  stateDigest: string;
  /** Champion level the proof applies to (e.g. "C1"). */
  level: string;
  /** Candidate whose profile was applied. */
  candidateId: string;
  /** Hash of the champion's INTENDED config projection. */
  targetConfigHash: string;
  /** Hash of the config createHarness ACTUALLY resolved (same projection). */
  appliedConfigHash: string;
  /** Which production entrypoint applied it. CLI and Web share one path. */
  runtimeEntrypoint: "cli" | "web";
  /** Source/build sha the runtime was built from. */
  sourceSha: string | null;
  /** Process / startup identifier distinguishing this application run. */
  processId: string;
  appliedAt: string;
  /** Canonical digest over everything above (self-excluding). */
  proofDigest: string;
}

/** Recorded when a real startup TRIED to apply the champion and could not.
 *  The promotion claim is preserved (never silently dropped, never claimed as
 *  applied) so an operator sees why the runtime is not running the champion. */
export interface ChampionApplicationFailureV1 {
  schemaVersion: typeof APPLIED_PROOF_SCHEMA_VERSION;
  failedAt: string;
  runtimeEntrypoint: "cli" | "web";
  processId: string;
  /** Human-readable cause (drift keys, origin overrides, createHarness error). */
  reason: string;
  mismatchedKeys: string[];
  overriddenKeys: string[];
  targetConfigHash: string;
  appliedConfigHash: string;
}

/** One champion-controlled config key, as projected from the real harness. */
export interface ChampionFieldCheckV1 {
  /** Dotted path, e.g. "featureFlags.memory". */
  key: string;
  /** What the champion profile asked for. */
  intended: unknown;
  /** What createHarness's resolved config actually carries. */
  actual: unknown;
  /** Which layer supplied the winning value ("runtime" | "environment" | ...). */
  origin: string;
}

export interface ChampionApplicationEvaluation {
  ok: boolean;
  status: "applied" | "applicationFailed";
  targetConfigHash: string;
  appliedConfigHash: string;
  /** Keys whose value drifted from the champion's intent. */
  mismatchedKeys: string[];
  /** Keys that were NOT supplied by the runtime (champion) layer — i.e. the
   *  value came from defaults / profile / environment instead. */
  overriddenKeys: string[];
  reason: string | null;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Canonical hash of one side of the projection (intended or actual). */
export function hashChampionConfigProjectionV1(
  checks: readonly ChampionFieldCheckV1[],
  side: "intended" | "actual",
): string {
  const rows = checks
    .map((c) => ({ key: c.key, value: side === "intended" ? c.intended : c.actual }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha256(stableStringify(rows));
}

/**
 * Verify that the real harness config equals the champion target. Fails closed
 * on: a createHarness error, an empty projection (nothing was actually
 * champion-controlled — cannot prove application of nothing), any value drift,
 * any key whose winning origin is not the runtime layer, or a hash mismatch.
 */
export function evaluateChampionApplicationV1(opts: {
  checks: readonly ChampionFieldCheckV1[];
  /** The layer id that must win for a champion-controlled key. */
  requiredOrigin?: string;
  /** Present when createHarness itself threw. */
  createHarnessError?: string;
}): ChampionApplicationEvaluation {
  const requiredOrigin = opts.requiredOrigin ?? "runtime";
  const targetConfigHash = hashChampionConfigProjectionV1(opts.checks, "intended");
  const appliedConfigHash = hashChampionConfigProjectionV1(opts.checks, "actual");
  const mismatchedKeys: string[] = [];
  const overriddenKeys: string[] = [];

  if (opts.createHarnessError !== undefined) {
    return {
      ok: false, status: "applicationFailed", targetConfigHash, appliedConfigHash,
      mismatchedKeys, overriddenKeys,
      reason: `createHarness failed: ${opts.createHarnessError}`,
    };
  }
  if (opts.checks.length === 0) {
    return {
      ok: false, status: "applicationFailed", targetConfigHash, appliedConfigHash,
      mismatchedKeys, overriddenKeys,
      reason: "no champion-controlled config keys were projected — application cannot be proven from an empty config",
    };
  }
  for (const c of opts.checks) {
    if (stableStringify(c.intended) !== stableStringify(c.actual)) mismatchedKeys.push(c.key);
    if (c.origin !== requiredOrigin) overriddenKeys.push(`${c.key} (origin=${c.origin || "none"})`);
  }
  if (mismatchedKeys.length > 0 || overriddenKeys.length > 0 || targetConfigHash !== appliedConfigHash) {
    const parts: string[] = [];
    if (mismatchedKeys.length > 0) parts.push(`config drift: ${mismatchedKeys.join(", ")}`);
    if (overriddenKeys.length > 0) parts.push(`not supplied by the ${requiredOrigin} layer: ${overriddenKeys.join(", ")}`);
    if (targetConfigHash !== appliedConfigHash) parts.push(`target ${targetConfigHash.slice(0, 12)}… != applied ${appliedConfigHash.slice(0, 12)}…`);
    return {
      ok: false, status: "applicationFailed", targetConfigHash, appliedConfigHash,
      mismatchedKeys, overriddenKeys, reason: parts.join("; "),
    };
  }
  return {
    ok: true, status: "applied", targetConfigHash, appliedConfigHash,
    mismatchedKeys, overriddenKeys, reason: null,
  };
}

/** The champion identity a proof attests to. Deliberately EXCLUDES `applied`,
 *  `validity`, the proof itself and any failure record — those are what the
 *  application transition changes, so the generation token must be stable
 *  across `applicationPending -> applied` for the same promotion. */
export interface ChampionApplicationTargetFieldsV1 {
  schemaVersion: string;
  level: string;
  candidateId: string | null;
  configPatch: Record<string, unknown>;
  evidenceRef: string | null;
  history: readonly unknown[];
}

/** Generation token for a promotion: content digest of the champion identity.
 *  A new promotion (different level / candidate / history) yields a different
 *  digest, so a proof can never authorize a promotion other than its own. */
export function championApplicationTargetDigestV1(state: ChampionApplicationTargetFieldsV1): string {
  return sha256(stableStringify({
    schemaVersion: state.schemaVersion,
    level: state.level,
    candidateId: state.candidateId,
    configPatch: state.configPatch,
    evidenceRef: state.evidenceRef,
    history: state.history,
  }));
}

/** Build a proof, computing its canonical digest over every other field. */
export function buildAppliedProofV1(input: Omit<AppliedProofV1, "proofDigest">): AppliedProofV1 {
  return { ...input, proofDigest: computeAppliedProofDigestV1(input) };
}

/** Recompute a proof's digest from its own fields (self-excluding). */
export function computeAppliedProofDigestV1(proof: unknown): string {
  const { proofDigest: _p, ...base } = (proof ?? {}) as Record<string, unknown>;
  return sha256(stableStringify(base));
}

export interface AppliedProofVerification {
  ok: boolean;
  issues: string[];
}

/**
 * Strictly verify a stored proof: schema, digest integrity, and that it still
 * describes the CURRENT state (generation), level, candidate and target hash.
 * A proof from a previous generation never authorizes a newer promotion.
 */
export function verifyAppliedProofV1(
  proof: unknown,
  expected: { stateDigest: string; level: string; candidateId: string; targetConfigHash: string },
): AppliedProofVerification {
  const issues: string[] = [];
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, issues: ["appliedProof is missing or not an object"] };
  }
  const p = proof as Record<string, unknown>;
  if (p["schemaVersion"] !== APPLIED_PROOF_SCHEMA_VERSION) {
    issues.push(`appliedProof schemaVersion ${String(p["schemaVersion"])} != ${APPLIED_PROOF_SCHEMA_VERSION}`);
  }
  if (typeof p["proofDigest"] !== "string" || computeAppliedProofDigestV1(p) !== p["proofDigest"]) {
    issues.push("appliedProof proofDigest does not recompute (tampered or stale)");
  }
  if (p["stateDigest"] !== expected.stateDigest) {
    issues.push(`appliedProof stateDigest ${String(p["stateDigest"])} != current state ${expected.stateDigest} (proof is from an older generation)`);
  }
  if (p["level"] !== expected.level) issues.push(`appliedProof level ${String(p["level"])} != ${expected.level}`);
  if (p["candidateId"] !== expected.candidateId) issues.push(`appliedProof candidateId ${String(p["candidateId"])} != ${expected.candidateId}`);
  if (p["targetConfigHash"] !== expected.targetConfigHash) {
    issues.push(`appliedProof targetConfigHash ${String(p["targetConfigHash"])} != resolved target ${expected.targetConfigHash}`);
  }
  if (p["appliedConfigHash"] !== p["targetConfigHash"]) {
    issues.push("appliedProof appliedConfigHash != targetConfigHash");
  }
  if (p["runtimeEntrypoint"] !== "cli" && p["runtimeEntrypoint"] !== "web") {
    issues.push(`appliedProof runtimeEntrypoint ${String(p["runtimeEntrypoint"])} must be "cli" or "web"`);
  }
  for (const field of ["processId", "appliedAt"] as const) {
    if (typeof p[field] !== "string" || p[field] === "") issues.push(`appliedProof ${field} must be a non-empty string`);
  }
  return { ok: issues.length === 0, issues };
}
