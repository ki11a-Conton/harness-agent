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
/** REJECTS any write that lands on the live champion tree (direct
 *  self-modification). Only paths strictly inside the candidate's isolated copy
 *  are allowed. The champion root itself and its descendants are off-limits. */
export function gateModify(round, path) {
    if (isPathWithin(path, round.championRoot)) {
        return { allowed: false, reason: "direct self-modification of the live champion is forbidden" };
    }
    if (!isPathWithin(path, round.isolatedRoot)) {
        return { allowed: false, reason: "write outside the isolated working copy" };
    }
    return { allowed: true };
}
/** True when `child` equals or is nested inside `root` (both absolute). */
function isPathWithin(child, root) {
    if (root === "")
        return false;
    const c = normalizePath(child);
    const r = normalizePath(root);
    if (c === r)
        return true;
    const prefix = r.endsWith("/") ? r : `${r}/`;
    return c.startsWith(prefix);
}
function normalizePath(p) {
    if (p.startsWith("/"))
        return p.replace(/\/{2,}/g, "/");
    return `/${p.replace(/\/{2,}/g, "/")}`;
}
/** Snapshot the champion tree deterministically (sorted path → content), so an
 *  untouched champion compares equal and a mutation is detected. */
export function snapshotTree(files) {
    const keys = Object.keys(files).sort();
    return keys.map((k) => `${k}\u0000${files[k]}`).join("\n");
}
/** True when a snapshot is unchanged since a baseline hash. */
export function championUntouched(snapshotBefore, snapshotNow) {
    return snapshotBefore === snapshotNow;
}
/** Simple non-crypto hash for snapshots (deterministic, test-stable). */
export function snapshotHash(files) {
    let h = 0;
    const s = snapshotTree(files);
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
}
/**
 * Materialize a candidate change onto a FRESH champion snapshot (never the live
 * tree). Only after the isolated tests AND benchmarks pass is the patch merged;
 * otherwise the round is rejected and nothing is written to the champion.
 */
export function integratePatch(patch, gates, costBudgetMs) {
    if (!gates.testsPassed)
        return { status: "rejected", reason: "isolated tests failed" };
    if (!gates.benchmarksPassed)
        return { status: "rejected", reason: "isolated benchmarks failed" };
    void costBudgetMs;
    return { status: "merged" };
}
//# sourceMappingURL=self-mod-sandbox.js.map