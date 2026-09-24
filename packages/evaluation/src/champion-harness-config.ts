/**
 * E3-08 — Champion → HarnessConfig mapper: takes a resolved ChampionProfile
 * from the ArmFactory and produces a HarnessConfig-shaped override that the
 * production `createHarness` can consume.
 *
 * This is the LAST step in the champion promotion pipeline:
 *   champion eval → DecisionArtifactV3 → promotion envelope → champion state
 *   → champion profile → champion harness config → createHarness
 *
 * The mapper is a PURE function: it maps the profile's `harnessConfig` (which
 * carries the ArmFactory's feature flags and mechanism config) and
 * `runtimeMechanisms` (which carries the typed injection points) into
 * domain-specific HarnessConfig fields (featureFlags, memory, delegation,
 * toolSelector, contextBudget, completionPolicy).
 *
 * The default C0 profile yields the baseline harness (no memory, no
 * delegation, no champion-specific mechanisms). An explicit champion profile
 * (PROVEN validity) enables the mechanisms the candidate resolved.
 */

import { getArmFactory } from "./arm-factory.js";
import { resolveChampionProfile, runtimeIdentityOf, proveApplication, type ChampionProfile } from "./champion-profile.js";
import type { RuntimeMechanisms } from "./arm-factory.js";

export const CHAMPION_HARNESS_CONFIG_VERSION = "e3-08-v1";

// ---------------------------------------------------------------------------
// Champion harness config projection
// ---------------------------------------------------------------------------

export interface ChampionHarnessConfig {
  schemaVersion: string;
  /** Feature flags (memory, delegation, learning, skills, mcp, etc.). */
  featureFlags: Record<string, boolean>;
  /** Memory config when memoryRetrieval is enabled. */
  memory?: { enabled: boolean; dbPath?: string };
  /** Delegation config when delegation is enabled (future: champion may enable). */
  delegation?: { enabled: boolean };
  /** Tool selector strategy (e.g. "deferred-schema" for deferred schema). */
  toolSelector?: { strategy: string };
  /** Context budget (adaptive dynamic headroom). */
  contextBudget?: { dynamic: number };
  /** Recovery planner identity. */
  recovery?: string | null;
  /** Completion policy (budget-aware). */
  completionPolicy?: string;
  /** Whether bundle/completion guidance is injected. */
  budgetAwareCompletion?: boolean;
  /** Runtime mechanisms digest for audit. */
  runtimeDigest: string;
}

/**
 * Map a resolved ChampionProfile's arm snapshot into a HarnessConfig-shaped
 * override. Pure: never reads I/O or state.
 */
export function championHarnessConfigFromProfile(
  profile: ChampionProfile,
  opts?: { dataDir?: string },
): ChampionHarnessConfig {
  const arm = profile.arm;
  const harnessConfig = arm.harnessConfig as Record<string, unknown>;
  const features = (harnessConfig.features as Record<string, boolean> | undefined) ?? {};
  // Resolve the typed runtime mechanisms for this arm's candidate from the
  // real ArmFactory (the snapshot itself does not carry runtimeMechanisms).
  const rc = getArmFactory().resolveRuntimeMechanisms(arm.candidateId);

  const config: ChampionHarnessConfig = {
    schemaVersion: CHAMPION_HARNESS_CONFIG_VERSION,
    featureFlags: {
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: features.memory === true,
      learning: features.memory === true, // learning typically paired with memory
      skills: true,
      delegation: false,
      mcp: false,
      plugins: false,
      observability: true,
    },
    runtimeDigest: arm.digest,
  };

  // Memory: enabled when the arm's runtime enables memory retrieval.
  if (rc.memoryRetrieval) {
    config.memory = { enabled: true, ...(opts?.dataDir ? { dbPath: opts.dataDir } : {}) };
  }

  // Tool selector: deferred schema from the arm.
  const toolSelector = harnessConfig.toolSelector as Record<string, unknown> | undefined;
  if (toolSelector?.strategy === "deferred-schema") {
    config.toolSelector = { strategy: "deferred-schema" };
  }

  // Context budget: adaptive dynamic headroom.
  if (rc.adaptiveContextDynamic > 0) {
    config.contextBudget = { dynamic: rc.adaptiveContextDynamic };
  }

  // Recovery planner.
  if (rc.recoveryPlanner !== null) {
    config.recovery = rc.recoveryPlanner;
  }

  // Completion policy.
  if (rc.budgetAwareCompletion) {
    config.completionPolicy = "budget_aware";
    config.budgetAwareCompletion = true;
  }

  return config;
}

/**
 * Resolve a champion profile for a given level and candidate, then compute
 * its runtime identity and prove the application. This is the production
 * entry point: given a validated champion state (level, candidateId, validity,
 * applied), it returns either a ready-to-use ChampionHarnessConfig + identity
 * proof, or a fail-closed reason.
 */
export function resolveChampionHarness(
  state: {
    level: string;
    candidateId: string | null;
    validity: "PROVEN" | "QUARANTINED_PENDING_REEVALUATION" | "INVALID_PROVENANCE";
    applied: boolean;
  } | null,
  selection: { level: string; candidateId: string },
  opts?: { dataDir?: string; allowPendingApplication?: boolean },
): {
  ok: boolean;
  harnessConfig?: ChampionHarnessConfig;
  identity?: ReturnType<typeof runtimeIdentityOf>;
  proof?: { proven: boolean; status: string; reason: string };
  reason?: string;
} {
  const profileResult = resolveChampionProfile(state, {
    kind: "explicit-champion",
    level: selection.level,
    candidateId: selection.candidateId,
  }, { allowPendingApplication: opts?.allowPendingApplication === true });
  if (!profileResult.ok || profileResult.profile === null) {
    return { ok: false, reason: profileResult.reason };
  }

  const profile = profileResult.profile;
  const identity = runtimeIdentityOf(profile.arm);
  const proof = proveApplication(identity, {
    championLevel: selection.level,
    candidateId: selection.candidateId,
    expectedConfigDigest: profile.arm.digest,
  });

  const harnessConfig = championHarnessConfigFromProfile(profile, opts);
  return { ok: true, harnessConfig, identity, proof };
}