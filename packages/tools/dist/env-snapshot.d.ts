import type { WorkingState } from "@ar/contracts";
export interface RuntimeVersion {
    name: string;
    version: string | null;
    found: boolean;
}
export interface GitState {
    available: boolean;
    branch: string | null;
    head: string | null;
    dirtyFiles: number;
    remote: string | null;
}
export interface PackageManagerInfo {
    detected: string | null;
    lockfile: string | null;
    version: string | null;
}
export interface EnvironmentSnapshot {
    capturedAt: number;
    os: {
        platform: string;
        arch: string;
        release: string;
        type: string;
        logicalCpus: number;
    };
    cwd: string;
    workspaceRoot?: string;
    harnessProfile?: string;
    runtimes: RuntimeVersion[];
    packageManager: PackageManagerInfo;
    git: GitState;
    /** Supplied by caller — never probed via the network. */
    network: {
        mode: string;
    };
    tools: {
        available: string[];
        count: number;
    };
    security: {
        /** Names (redacted) of sensitive env keys present; values are NEVER captured. */
        sensitiveEnvKeysPresent: string[];
        envValuesRedacted: boolean;
    };
}
export interface EnvSnapshotOptions {
    cwd: string;
    /** Supplied by the caller. */
    networkMode?: string;
    /** Supplied by the caller (registry tool names). */
    availableTools?: string[];
    /** Host wiring facts (P0-7): profile + workspace root, never env values. */
    workspaceRoot?: string;
    harnessProfile?: string;
    /** Restrict runtime probes (useful in tests / minimal environments). */
    probeLimit?: number;
}
/** Build a snapshot of the environment. Read-only, time-boxed, network-free. */
export declare function snapshotEnvironment(opts: EnvSnapshotOptions): Promise<EnvironmentSnapshot>;
/** A compact "one-liner" summary for prompts / WorkingState facts. */
export declare function snapshotSummary(s: EnvironmentSnapshot): string;
/** Record the snapshot summary into WorkingState.importantFacts (deduped). */
export declare function noteSnapshotInWorkingState(state: WorkingState, snap: EnvironmentSnapshot): void;
//# sourceMappingURL=env-snapshot.d.ts.map