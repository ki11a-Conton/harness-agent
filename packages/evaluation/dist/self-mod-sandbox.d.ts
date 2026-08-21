/**
 * P3-9 — Self-Modification Sandbox.
 *
 * A mechanism-CANDIDATE experiment (no main-runtime refactor). If an agent is
 * ever allowed to modify the harness itself, plan.md P3-9 requires a hard
 * isolation boundary:
 *
 *   Champion repo
 *     └→ clone / worktree  (isolated copy)
 *         Challenger modifies ONLY the isolated copy
 *           → tests
 *           → benchmarks
 *           → promotion
 *
 * The one thing that is absolutely forbidden is the live champion mutating its
 * own tree and continuing. This module encodes that boundary as a path + mode
 * gate: a candidate may touch paths strictly inside its isolated working copy,
 * and only after the isolated tests + benchmarks pass may the change be merged
 * back onto a frozen champion snapshot.
 *
 * The champion is treated as immutable during any modification round; a change
 * is materialized only as a *proposed patch* against the isolated copy, and the
 * integration step applies it to a fresh champion clone — never to the running
 * tree.
 */
/** A candidate's modification round. `isolatedRoot` is where it may write. */
export interface ModificationRound {
    candidateId: string;
    /** Root of the candidate's isolated copy. Writes are confined to here. */
    isolatedRoot: string;
    /** Root of the champion (immutable while a candidate works). */
    championRoot: string;
}
export interface ModifyOutput {
    path: string;
    content: string;
}
export interface ModifyGate {
    /** True when the write is allowed (inside the isolated copy, not the champion). */
    allowed: boolean;
    reason?: string;
}
/** REJECTS any write that lands on the live champion tree (direct
 *  self-modification). Only paths strictly inside the candidate's isolated copy
 *  are allowed. The champion root itself and its descendants are off-limits. */
export declare function gateModify(round: ModificationRound, path: string): ModifyGate;
/** Snapshot the champion tree deterministically (sorted path → content), so an
 *  untouched champion compares equal and a mutation is detected. */
export declare function snapshotTree(files: Record<string, string>): string;
/** True when a snapshot is unchanged since a baseline hash. */
export declare function championUntouched(snapshotBefore: string, snapshotNow: string): boolean;
/** Simple non-crypto hash for snapshots (deterministic, test-stable). */
export declare function snapshotHash(files: Record<string, string>): string;
export type RoundStatus = "drafting" | "testing" | "benchmarking" | "merged" | "rejected";
export interface MergeInput {
    round: ModificationRound;
    /** The candidate's writes against its isolated copy. */
    patch: ModifyOutput[];
    /** Tests pass gate. */
    testsPassed: boolean;
    /** Benchmarks pass gate (cost-aware). */
    benchmarksPassed: boolean;
}
/**
 * Materialize a candidate change onto a FRESH champion snapshot (never the live
 * tree). Only after the isolated tests AND benchmarks pass is the patch merged;
 * otherwise the round is rejected and nothing is written to the champion.
 */
export declare function integratePatch(patch: ModifyOutput[], gates: {
    testsPassed: boolean;
    benchmarksPassed: boolean;
}, costBudgetMs?: number): {
    status: "merged" | "rejected";
    reason?: string;
};
//# sourceMappingURL=self-mod-sandbox.d.ts.map