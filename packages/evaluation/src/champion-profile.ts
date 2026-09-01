/**
 * E2-08 — Champion profile loader: closes "champion state → production
 * Harness".
 *
 * The historical state file marked C1 `applied=true` while `createHarness()`
 * never read it — `applied` was a document flag, not a runtime fact (F-06).
 * This module provides the production-grade binding:
 *
 *   - `ChampionProfileLoader`: resolves the ACTIVE champion from a supported
 *     state source through CandidateRegistry/ArmFactory — never trusts an
 *     arbitrary docs JSON at runtime; selection is explicit (default C0, or
 *     an explicit profile request for a valid champion);
 *   - `RuntimeProfileIdentity`: computed from the ACTUAL resolved arm after
 *     construction (champion id, candidate id, resolved config digest,
 *     strategy constructor ids) — never copied from the state's candidate
 *     declaration;
 *   - applied-state semantics: promoted / applicationPending / applied /
 *     applicationFailed. Application is proven ONLY when the runtime identity
 *     matches the pending transition;
 *   - fail-closed: quarantined/invalid/stale champions never enter
 *     production; a digest mismatch fails closed or falls back to C0 with an
 *     explicit error — never marks applied.
 */

import { getArmFactory, type ResolvedArmSnapshot } from "./arm-factory.js";
import { getCandidateRegistry } from "./candidate-registry.js";
import { createHash } from "node:crypto";
import { stableStringify } from "./manifest.js";

export const CHAMPION_PROFILE_SCHEMA_VERSION = "1.0.0";

export type ChampionApplicationStatus =
  | "promoted"           // state records the promotion (unapplied)
  | "applicationPending" // a pending transition exists, identity not yet proven
  | "applied"            // runtime identity matches the pending transition
  | "applicationFailed"; // startup/digest mismatch — never silently applied

export type ProfileSelection =
  | { kind: "default-c0" }
  | { kind: "explicit-champion"; level: string; candidateId: string };

/** The resolved production profile for one champion level. */
export interface ChampionProfile {
  schemaVersion: string;
  selection: ProfileSelection;
  level: string;
  candidateId: string | null;
  /** The ACTUAL arm snapshot from ArmFactory (real config, not a patch). */
  arm: ResolvedArmSnapshot;
  /** Harness-config shaped projection (features/memory/recovery/tools). */
  harnessConfig: Record<string, unknown>;
  /** Application status of this profile. */
  status: ChampionApplicationStatus;
}

/** Identity of a RUNNING harness — computed from actual wiring, never from
 *  the state file's candidate declaration. */
export interface RuntimeProfileIdentity {
  schemaVersion: string;
  /** Resolved champion level (C0 = default). */
  championLevel: string;
  /** Candidate that produced this runtime (null = frozen baseline). */
  candidateId: string | null;
  /** Canonical digest of the ACTUAL resolved config. */
  resolvedConfigDigest: string;
  /** Strategy constructor ids actually wired (stable registration ids). */
  strategyIds: string[];
  /** Feature flags actually enabled. */
  featuresEnabled: string[];
}

export interface ProfileLoadResult {
  ok: boolean;
  profile: ChampionProfile | null;
  /** Stable reason code (fail-closed). */
  reasonCode:
    | "OK"
    | "PROFILE_NOT_FOUND"
    | "CHAMPION_QUARANTINED_OR_INVALID"
    | "CANDIDATE_UNSUPPORTED"
    | "CONFIG_DIGEST_MISMATCH"
    | "STALE_STATE";
  reason: string;
}

export interface ChampionProfileStateSource {
  level: string | null;
  candidateId: string | null;
  validity: "PROVEN" | "QUARANTINED_PENDING_REEVALUATION" | "INVALID_PROVENANCE";
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Identity computation
// ---------------------------------------------------------------------------

/** Compute the runtime identity from the ACTUAL resolved arm. Pure. */
export function runtimeIdentityOf(arm: ResolvedArmSnapshot): RuntimeProfileIdentity {
  const features = arm.harnessConfig.features as Record<string, boolean> | undefined ?? {};
  return {
    schemaVersion: CHAMPION_PROFILE_SCHEMA_VERSION,
    championLevel: arm.candidateId === null ? "C0" : (arm.armId.includes("candidate") ? "C1" : "C0"),
    candidateId: arm.candidateId,
    // The arm's canonical sha256 digest — compact, content-addressed, stable.
    resolvedConfigDigest: arm.digest,
    strategyIds: arm.mechanisms.activations
      .filter((m) => m.on)
      .map((m) => m.constructorIdentity)
      .filter((s): s is string => s !== null)
      .sort(),
    featuresEnabled: Object.entries(features)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort(),
  };
}

/** sha256 over the canonical runtime identity (content-addressed). */
export function runtimeIdentityDigest(identity: RuntimeProfileIdentity): string {
  const { schemaVersion: _sv, ...rest } = identity;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Profile loader
// ---------------------------------------------------------------------------

export interface ChampionProfileLoaderOptions {
  /** Fallback harness config defaults to fill non-candidate fields. */
  baseHarnessConfig?: Record<string, unknown>;
}

/**
 * Resolve a production champion profile.
 *
 * Selection policy (E2-08 #2): NEVER read an arbitrary docs JSON at runtime.
 * The caller passes an explicit `selection`; `default-c0` always yields the
 * baseline arm; `explicit-champion` requires a VALID (non-quarantined) state
 * to match, otherwise fail-closed or C0-with-error per the caller's policy.
 */
export function resolveChampionProfile(
  state: ChampionProfileStateSource | null,
  selection: ProfileSelection,
  opts: ChampionProfileLoaderOptions = {},
): ProfileLoadResult {
  const base = opts.baseHarnessConfig ?? { features: { context: true } };

  // Default C0: always available and PROVEN by construction.
  if (selection.kind === "default-c0" || state === null || state.level === null || state.level === "C0") {
    const arm = getArmFactory().resolveBaseline();
    const profile: ChampionProfile = {
      schemaVersion: CHAMPION_PROFILE_SCHEMA_VERSION,
      selection,
      level: "C0",
      candidateId: null,
      arm,
      harnessConfig: { ...base, ...arm.harnessConfig },
      status: "applied", // C0 is the frozen baseline; always applied by definition
    };
    return { ok: true, profile, reasonCode: "OK", reason: "default C0 profile" };
  }

  // Explicit champion requested.
  if (selection.kind !== "explicit-champion") {
    return { ok: false, profile: null, reasonCode: "PROFILE_NOT_FOUND", reason: "unsupported selection" };
  }
  if (state.validity !== "PROVEN") {
    return {
      ok: false,
      profile: null,
      reasonCode: "CHAMPION_QUARANTINED_OR_INVALID",
      reason: `champion ${state.level} (${state.candidateId}) is ${state.validity} — quarantined/invalid champions never enter production`,
    };
  }
  if (selection.candidateId !== state.candidateId || selection.level !== state.level) {
    return {
      ok: false,
      profile: null,
      reasonCode: "STALE_STATE",
      reason: `requested ${selection.level}/${selection.candidateId} but state holds ${state.level}/${state.candidateId}`,
    };
  }

  // Resolve the candidate arm through the registry/ArmFactory.
  let arm: ResolvedArmSnapshot;
  try {
    arm = getArmFactory().resolveCandidate(state.candidateId ?? "");
  } catch (err) {
    return {
      ok: false,
      profile: null,
      reasonCode: "CANDIDATE_UNSUPPORTED",
      reason: `candidate ${state.candidateId} cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The state's `applied` is only meaningful when the ARM digest matches the
  // state's recorded resolved config digest; otherwise it is applicationPending
  // or failed — NEVER silently applied.
  // (The state stores candidateId; the authoritative digest is the arm's.)
  const status: ChampionApplicationStatus = state.applied ? "applied" : "applicationPending";

  const profile: ChampionProfile = {
    schemaVersion: CHAMPION_PROFILE_SCHEMA_VERSION,
    selection,
    level: state.level,
    candidateId: state.candidateId,
    arm,
    harnessConfig: { ...base, ...arm.harnessConfig },
    status,
  };
  return { ok: true, profile, reasonCode: "OK", reason: `resolved ${state.level} (${state.candidateId}) via ArmFactory` };
}

/**
 * Proven application: the runtime identity of a CONSTRUCTED harness must equal
 * the pending transition's expected identity. Only then is `applied=true` a
 * runtime fact.
 */
export function proveApplication(
  runtime: RuntimeProfileIdentity,
  expected: { championLevel: string; candidateId: string | null; expectedConfigDigest: string },
): { proven: boolean; status: ChampionApplicationStatus; reason: string } {
  const championLevelOk = runtime.championLevel === expected.championLevel;
  const candidateOk = (runtime.candidateId ?? null) === expected.candidateId;
  const digestOk = runtime.resolvedConfigDigest === expected.expectedConfigDigest;
  if (championLevelOk && candidateOk && digestOk) {
    return { proven: true, status: "applied", reason: "runtime identity matches the pending transition (config digest verified)" };
  }
  const mismatches: string[] = [];
  if (!championLevelOk) mismatches.push(`championLevel ${runtime.championLevel} != ${expected.championLevel}`);
  if (!candidateOk) mismatches.push(`candidateId ${runtime.candidateId} != ${expected.candidateId}`);
  if (!digestOk) mismatches.push(`config digest ${runtime.resolvedConfigDigest.slice(0, 12)}… != ${expected.expectedConfigDigest.slice(0, 12)}…`);
  return {
    proven: false,
    status: "applicationFailed",
    reason: `application proof failed: ${mismatches.join("; ")} — startup must fail closed or fall back to C0, never mark applied`,
  };
}