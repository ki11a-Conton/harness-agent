import type { PermissionPolicy, SandboxPolicy } from "@ar/contracts";
import { defaultSandboxPolicy } from "@ar/core";
import type { HarnessFeatureFlags, HarnessProfile } from "./config.js";

/** §24 "build" profile: reads allowed; edits/exec/network ask for approval. */
const INTERACTIVE_PERMISSIONS: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "ask" },
    { action: "exec", resource: "command", effect: "ask" },
    { action: "exec", resource: "network", effect: "ask" },
  ],
};

/** Batch: like interactive, but network is denied (no interactive approval). */
const BATCH_PERMISSIONS: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "ask" },
    { action: "exec", resource: "command", effect: "ask" },
    { action: "exec", resource: "network", effect: "deny" },
  ],
};

/** Benchmark/test: reads and edits allowed, exec allowed (test runs), network
 *  denied — no interactive approval surface in benchmark runs. */
const BENCHMARK_PERMISSIONS: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "allow" },
    { action: "exec", resource: "command", effect: "allow" },
    { action: "exec", resource: "network", effect: "deny" },
  ],
};

export interface ProfilePreset {
  permissions: PermissionPolicy;
  sandbox: SandboxPolicy;
  /** Default feature flags for the profile; config overrides win. */
  defaultFeatureFlags: HarnessFeatureFlags;
}

/** Deferred (unwired in P0-3): mcp/plugins/learning flags stay false and are
 *  reported as such by the audit — no silent claims. Checkpoint is enabled by
 *  default for every profile; whether a store actually exists is decided by
 *  the dataDir (plan acceptance: Checkpoint = true when dataDir). */
const SHARED_DEFAULTS: Omit<
  HarnessFeatureFlags,
  "context" | "checkpoint" | "artifacts" | "memory" | "skills" | "delegation"
> = {
  learning: false,
  mcp: false,
  plugins: false,
  observability: true,
};

const PRESETS: Record<HarnessProfile, ProfilePreset> = {
  interactive: {
    permissions: INTERACTIVE_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: false,
      skills: true,
      delegation: false,
    },
  },
  batch: {
    permissions: BATCH_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: false,
      skills: true,
      delegation: false,
    },
  },
  benchmark: {
    permissions: BENCHMARK_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: false,
      skills: true,
      delegation: false,
    },
  },
  test: {
    permissions: BENCHMARK_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: false,
      skills: true,
      delegation: false,
    },
  },
  /**
   * P21-5: CHAMPION profile v1 — the production default preset. Trusted
   * surface defaults ON (context / checkpoint / artifacts / skills /
   * observability); evidence-gated mechanisms default OFF until P21-4 proves
   * them (memory / delegation / learning); trust-surface mechanisms default
   * OFF (mcp requires user-configured servers, plugins are same-process
   * trust risk). Permissions are batch-style: reads allowed, edits/exec ask,
   * network denied — safer than interactive by default.
   */
  champion: {
    permissions: BATCH_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: true,
      artifacts: true,
      memory: false,
      skills: true,
      delegation: false,
      learning: false,
    },
  },
  /** P16-4: explicit EPHEMERAL profile for tests / one-shot runs. No
   *  durability is claimed: checkpoint/artifacts default OFF, so without an
   *  explicit dataDir the harness is honestly in-memory and never audited as
   *  production-ready. Passing a dataDir upgrades it to a durable run — the
   *  profile only changes the DEFAULTS, never the capability truth. */
  ephemeral: {
    permissions: BENCHMARK_PERMISSIONS,
    sandbox: defaultSandboxPolicy(),
    defaultFeatureFlags: {
      ...SHARED_DEFAULTS,
      context: true,
      checkpoint: false,
      artifacts: false,
      memory: false,
      skills: true,
      delegation: false,
    },
  },
};

export function resolveProfile(profile: HarnessProfile): ProfilePreset {
  return PRESETS[profile];
}

/** Effective feature flags = profile defaults overridden by config. */
export function resolveFeatureFlags(
  profile: HarnessProfile,
  overrides: Partial<HarnessFeatureFlags> | undefined,
): HarnessFeatureFlags {
  return { ...PRESETS[profile].defaultFeatureFlags, ...overrides };
}