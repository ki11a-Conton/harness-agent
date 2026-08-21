import type { PermissionPolicy, SandboxPolicy } from "@ar/contracts";
import type { HarnessFeatureFlags, HarnessProfile } from "./config.js";
export interface ProfilePreset {
    permissions: PermissionPolicy;
    sandbox: SandboxPolicy;
    /** Default feature flags for the profile; config overrides win. */
    defaultFeatureFlags: HarnessFeatureFlags;
}
export declare function resolveProfile(profile: HarnessProfile): ProfilePreset;
/** Effective feature flags = profile defaults overridden by config. */
export declare function resolveFeatureFlags(profile: HarnessProfile, overrides: Partial<HarnessFeatureFlags> | undefined): HarnessFeatureFlags;
//# sourceMappingURL=profiles.d.ts.map