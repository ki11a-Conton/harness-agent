import type { LearningCandidate } from "./candidate.js";
/**
 * P2-7: learning candidate sandbox. A candidate (prompt rule / workflow /
 * skill / tool preference) runs in an isolated configuration before any
 * promotion gate: its own scratch directory, a read-only champion snapshot,
 * and a post-run mutation check against that snapshot. Candidates can never
 * reach champion global state directly — the sandbox is the only handle.
 */
export interface SandboxContext {
    /** The candidate under evaluation (read-only). */
    candidate: LearningCandidate;
    /** Isolated scratch directory for the candidate run. */
    scratchDir: string;
    /** Read-only champion snapshot captured before the run. */
    readChampion(): unknown;
    /** Write a file inside the scratch directory (relative path). */
    writeScratch(relPath: string, content: string): Promise<string>;
}
export type SandboxViolationKind = "champion_mutation" | "scratch_escape" | "throw";
export interface SandboxViolation {
    kind: SandboxViolationKind;
    detail: string;
}
export interface SandboxResult<T> {
    /** Runner output (undefined when the runner threw). */
    result: T | undefined;
    /** Runner error, re-raised to the caller after cleanup. */
    error?: unknown;
    /** Violations detected by the sandbox. */
    violations: SandboxViolation[];
    /** Elapsed wall time of the run (ms). */
    elapsedMs: number;
    /** True when the runner threw (cleanup still ran). */
    threw: boolean;
}
export interface CandidateSandboxDeps {
    /** Scratch root; defaults to the system temp dir. */
    scratchRoot?: string;
    /** Injectable clock. */
    now?: () => number;
}
export interface SandboxRunDeps<T> {
    /** The candidate to run in isolation. */
    candidate: LearningCandidate;
    /** Reads the champion's global state; the sandbox snapshots it before the
     *  run and diffes it after. Required for the mutation check. May be async —
     *  the digest is always computed over the resolved value. */
    championState: () => unknown | Promise<unknown>;
    /** The isolated run. */
    runner: (ctx: SandboxContext) => Promise<T>;
}
/** Deterministic digest of champion state (stable key order). */
export declare function championDigest(state: unknown): string;
export declare class CandidateSandbox {
    private readonly scratchRoot;
    private readonly now;
    constructor(deps?: CandidateSandboxDeps);
    /**
     * Run the candidate in isolation: scratch dir → champion snapshot →
     * runner → champion re-check → cleanup. Cleanup and the mutation check
     * run even when the runner throws; the error is re-thrown afterwards.
     */
    run<T>(deps: SandboxRunDeps<T>): Promise<SandboxResult<T>>;
}
//# sourceMappingURL=sandbox.d.ts.map