import { defaultSandboxPolicy } from "@ar/core";
/** §24 "build" profile: reads allowed; edits/exec/network ask for approval. */
const INTERACTIVE_PERMISSIONS = {
    rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "ask" },
        { action: "exec", resource: "command", effect: "ask" },
        { action: "exec", resource: "network", effect: "ask" },
    ],
};
/** Batch: like interactive, but network is denied (no interactive approval). */
const BATCH_PERMISSIONS = {
    rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "ask" },
        { action: "exec", resource: "command", effect: "ask" },
        { action: "exec", resource: "network", effect: "deny" },
    ],
};
/** Benchmark/test: reads and edits allowed, exec allowed (test runs), network
 *  denied — no interactive approval surface in benchmark runs. */
const BENCHMARK_PERMISSIONS = {
    rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "allow" },
        { action: "exec", resource: "command", effect: "allow" },
        { action: "exec", resource: "network", effect: "deny" },
    ],
};
/** Deferred (unwired in P0-3): mcp/plugins/learning flags stay false and are
 *  reported as such by the audit — no silent claims. Checkpoint is enabled by
 *  default for every profile; whether a store actually exists is decided by
 *  the dataDir (plan acceptance: Checkpoint = true when dataDir). */
const SHARED_DEFAULTS = {
    learning: false,
    mcp: false,
    plugins: false,
    observability: true,
};
const PRESETS = {
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
};
export function resolveProfile(profile) {
    return PRESETS[profile];
}
/** Effective feature flags = profile defaults overridden by config. */
export function resolveFeatureFlags(profile, overrides) {
    return { ...PRESETS[profile].defaultFeatureFlags, ...overrides };
}
//# sourceMappingURL=profiles.js.map