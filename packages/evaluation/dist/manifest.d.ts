/**
 * Benchmark run manifest (plan.md P0-6). Every benchmark run records enough
 * identity that a reported result can be reproduced and attributed:
 *
 * - gitSha / dirty: the harness source revision the run executed against.
 *   `null` means the information was not available (e.g. not a git checkout);
 *   `dirty: false` is a real answer, `dirty: null` means unknown.
 * - model / provider / temperature: the exact model invocation. `temperature`
 *   is `null` when the run did not set one explicitly (provider default).
 * - suiteVersion: the version of the benchmark suite definitions.
 * - judgeVersion: the judge logic version (the case's own judgeVersion wins;
 *   the manifest records the version the harness defaulted to).
 * - runtimeConfigHash: sha256 over the stable-serialized harness runtime
 *   configuration — two runs with the same hash executed the same runtime
 *   wiring (permissions / sandbox / context budget / tool set / limits).
 * - timestamp / platform / nodeVersion: when and where the run happened.
 */
export interface RunManifest {
    gitSha: string | null;
    dirty: boolean | null;
    model: string;
    provider: string;
    temperature: number | null;
    suiteVersion: string;
    judgeVersion: string;
    runtimeConfigHash: string;
    timestamp: string;
    platform: string;
    nodeVersion: string;
}
/** Suite definition version. P0-6 adds the integrity layer (manifest, failure
 *  classification, ordered execution) on top of the Phase 6.5 four-suite split;
 *  bump when the suite definitions or their judging semantics change. */
export declare const BENCHMARK_SUITE_VERSION = "2.1.0";
export interface BuildRunManifestOptions {
    model: string;
    provider: string;
    /** Explicit temperature (null/undefined → null: provider default). */
    temperature?: number | null;
    suiteVersion?: string;
    judgeVersion?: string;
    /** sha256 over the harness runtime config (computeRuntimeConfigHash). */
    runtimeConfigHash: string;
    /** Injectable timestamp (ISO string) for deterministic tests. */
    timestamp?: string;
    /** Injectable git info for deterministic tests; when absent, probed via git. */
    gitInfo?: {
        sha: string | null;
        dirty: boolean | null;
    };
    now?: () => number;
}
/** Best-effort git identity probe. Any failure (no git, not a repo, timeout)
 *  yields `null` — never a fabricated sha. */
export declare function buildRunManifest(opts: BuildRunManifestOptions): Promise<RunManifest>;
/**
 * sha256 over a stable serialization of the runtime config. The serialization
 * is key-ordered and value-stable, so the same logical config always hashes
 * the same regardless of key insertion order. Any change to the harness wiring
 * (permissions, sandbox policy, budget, tool set, limits, …) changes the hash,
 * which is exactly the reproducibility signal the manifest needs.
 */
export declare function computeRuntimeConfigHash(config: unknown): string;
/** Deterministic key-ordered serialization (Q-5 stable serialization). */
export declare function stableStringify(value: unknown): string;
//# sourceMappingURL=manifest.d.ts.map