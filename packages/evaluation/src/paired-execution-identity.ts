/**
 * E4-R01 — execution identity for paired benchmarks.
 *
 * The schedule digest (computePairedPlanDigest) only describes the AB/BA grid:
 * two experiments that order the same cases and repetitions identically share
 * it. That is NOT an experiment identity. Binding a resume to it let a journal
 * written under one candidate / provider / model / case content / source tree /
 * policy / isolation posture be reused by a different experiment (defect F01).
 *
 * `PairedExecutionIdentityV1` is the single identity a resume and promotion
 * evidence must bind to. Secrets never enter it — only non-sensitive effective
 * configuration or a fingerprint of it.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION = "e4-r01";

export interface PairedExecutionLimitsV1 {
  /** `null` = unlimited, `0` = forbid, positive = cap (E4-01 semantics). */
  maxLogicalRuns: number | null;
  maxModelCalls: number | null;
  maxEstimatedTokens: number | null;
  maxEstimatedCostUsd: number | null;
}

export interface PairedExecutionIdentityV1 {
  schemaVersion: typeof PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION;
  /** The AB/BA schedule grid digest — one component, kept distinct. */
  scheduleDigest: string;
  suite: string;
  judgeVersion: string;
  repetitions: number;
  orderSeed: number;
  modelSeed: number | null;
  /** Ordered case id set. */
  caseIds: readonly string[];
  /** Per-case INPUT fingerprint: editing a case file without changing its id
   *  still invalidates a stored journal. */
  caseFingerprints: Readonly<Record<string, string>>;
  /** Baseline and candidate arm identities. */
  baselineConfigHash: string;
  candidate: string | null;
  candidateConfigHash: string | null;
  /** Provider/model identity and effective model parameters. */
  providerId: string;
  modelId: string;
  effectiveModelParams: Readonly<Record<string, unknown>>;
  /** Source snapshot identity: full sourceSha and/or a code-tree fingerprint. */
  sourceSha: string | null;
  treeFingerprint: string | null;
  limits: PairedExecutionLimitsV1;
  billingClass: string;
  isolationBackendId: string;
  isolationStrength: string;
  /** Isolation SELF-TEST identity, so a fake backend cannot be copied into
   *  another run's evidence as if it proved OS confinement. */
  isolationSelfTestId: string | null;
  promotionEligible: boolean;
  /** The pre-registered decision policy and its digest. */
  decisionPolicy: Readonly<object>;
  thresholdDigest: string;
}

function identityBody(id: PairedExecutionIdentityV1): Record<string, unknown> {
  const { schemaVersion, ...rest } = id;
  return { schemaVersion, ...rest };
}

export function computeExecutionIdentityDigestV1(id: PairedExecutionIdentityV1): string {
  return createHash("sha256").update(stableStringify(identityBody(id)), "utf8").digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sha256Short(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

/** Compact, secret-free rendering of a differing value. */
function describe(v: unknown): string {
  if (v === undefined) return "<absent>";
  if (v === null) return "null";
  if (typeof v === "object") {
    const s = stableStringify(v);
    return s.length > 80 ? sha256Short(s) + "(len " + String(s.length) + ")" : s;
  }
  return String(v);
}

/**
 * Field-level comparison for resume validation. Returns a stable list of what
 * differs (field path + compact values only, never secret material); empty
 * means the stored journal belongs to exactly this experiment. A journal with no
 * identity at all (written before this fix) is refused and left in place.
 */
export function executionIdentityViolationsV1(
  stored: PairedExecutionIdentityV1 | null | undefined,
  current: PairedExecutionIdentityV1,
): string[] {
  if (stored === null || stored === undefined) {
    return ["journal carries no execution identity (pre-R01 or unwritten) — refusing to resume"];
  }
  const issues: string[] = [];
  const walk = (path: string, x: unknown, y: unknown): void => {
    if (x === y) return;
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const key of keys) {
        walk(path === "" ? key : path + "." + key, (x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key]);
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        issues.push(path + ": length " + String(x.length) + " != " + String(y.length));
        return;
      }
      for (let i = 0; i < x.length; i += 1) walk(path + "[" + i + "]", x[i], y[i]);
      return;
    }
    issues.push(path + ": journal " + describe(x) + " != current " + describe(y));
  };
  walk("", identityBody(stored), identityBody(current));
  return issues;
}

/** Stable digest of one case's INPUT (its fixture/request/verification content). */
export function caseInputFingerprintV1(parts: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableStringify(parts), "utf8").digest("hex");
}

/** Input to `buildExecutionIdentityV1` — everything except derived defaults. */
export type ExecutionIdentityInputV1 = Omit<
  PairedExecutionIdentityV1,
  "schemaVersion" | "baselineConfigHash" | "candidateConfigHash" | "effectiveModelParams" | "treeFingerprint" | "isolationSelfTestId"
> &
  Partial<Pick<PairedExecutionIdentityV1, "baselineConfigHash" | "candidateConfigHash" | "effectiveModelParams" | "treeFingerprint" | "isolationSelfTestId">>;

/**
 * The single canonical constructor, so the preflight that gets confirmed and
 * the executor that resumes cannot drift into building two different "same"
 * identities. Fields with no security meaning default to the inert values below.
 */
export function buildExecutionIdentityV1(input: ExecutionIdentityInputV1): PairedExecutionIdentityV1 {
  return {
    schemaVersion: PAIRED_EXECUTION_IDENTITY_SCHEMA_VERSION,
    scheduleDigest: input.scheduleDigest,
    suite: input.suite,
    judgeVersion: input.judgeVersion,
    repetitions: input.repetitions,
    orderSeed: input.orderSeed,
    modelSeed: input.modelSeed,
    caseIds: [...input.caseIds],
    caseFingerprints: { ...input.caseFingerprints },
    baselineConfigHash: input.baselineConfigHash ?? "baseline",
    candidate: input.candidate,
    candidateConfigHash: input.candidateConfigHash ?? null,
    providerId: input.providerId,
    modelId: input.modelId,
    effectiveModelParams: { ...input.effectiveModelParams },
    sourceSha: input.sourceSha,
    treeFingerprint: input.treeFingerprint ?? null,
    limits: { ...input.limits },
    billingClass: input.billingClass,
    isolationBackendId: input.isolationBackendId,
    isolationStrength: input.isolationStrength,
    isolationSelfTestId: input.isolationSelfTestId ?? null,
    promotionEligible: input.promotionEligible,
    decisionPolicy: { ...input.decisionPolicy },
    thresholdDigest: input.thresholdDigest,
  };
}
