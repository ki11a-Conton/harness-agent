import { AgentError, errorInfo, newSkillId } from "@ar/contracts";
/**
 * SKILL-EVO-001: evidence-driven skill evolution (§70).
 *
 * Flow: createVersion → benchmark (caller arranges the §133 head-to-head) →
 * evaluate the BenchReport → promote or rollback through a SkillStoreLike.
 * Production skills are never overwritten blindly: evaluate() is the only
 * gate between a candidate and the active record, and a safety regression
 * (increased violations) always beats a success improvement (§50).
 */
export class SkillEvolver {
    makeSkillId;
    constructor(deps = {}) {
        this.makeSkillId = deps.newSkillId ?? newSkillId;
    }
    /**
     * Builds the v2 candidate: same skill lineage (path), fresh record id (so
     * both versions can coexist in the id-keyed store and rollback can deprecate
     * v2 while restoring v1), semantically bumped manifest.version, new body.
     */
    createVersion(base, newBody, deps = {}) {
        const version = bumpVersion(versionOf(base));
        const status = base.status === "deprecated" || base.status === "removed"
            ? "eligible"
            : base.status;
        return {
            id: this.makeSkillId(),
            path: base.path,
            manifest: { ...base.manifest, version },
            status,
            body: newBody,
            discoveredAt: (deps.now ?? Date.now)(),
            ...(base.headers !== undefined ? { headers: base.headers } : {}),
        };
    }
    /**
     * Compares the v1/v2 benchmark (§70: benchmark first, compare second).
     *
     * - safety regression (v2 has more violated cases) → rollback, even when
     *   v2 improved success
     * - success delta beyond threshold → promote / rollback
     * - delta within threshold → per-case winner counts decide (same margin)
     * - otherwise, or on an empty/throwing benchmark → hold (never a fabricated
     *   verdict; §10)
     */
    async evaluate(deps) {
        const { v1, v2, bench } = deps;
        const threshold = deps.threshold ?? 0;
        let report;
        try {
            report = await bench();
        }
        catch (err) {
            return {
                decision: "hold",
                reason: `benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (report.cases.length === 0) {
            return { decision: "hold", reason: "empty bench report: nothing to compare" };
        }
        const { a, b } = report.summary;
        if (b.safety < a.safety) {
            return {
                decision: "rollback",
                reason: `safety regression: v2 (${v2.manifest.version}) safety ${b.safety} ` +
                    `< v1 (${v1.manifest.version}) safety ${a.safety} (violations increased)`,
            };
        }
        const delta = b.success - a.success;
        if (delta > threshold) {
            return {
                decision: "promote",
                reason: `v2 (${v2.manifest.version}) success ${b.success} > v1 (${v1.manifest.version}) ` +
                    `success ${a.success} by ${delta}`,
            };
        }
        if (delta < -threshold) {
            return {
                decision: "rollback",
                reason: `v2 (${v2.manifest.version}) success ${b.success} < v1 (${v1.manifest.version}) ` +
                    `success ${a.success} by ${-delta}`,
            };
        }
        const winsB = report.cases.filter((entry) => entry.winner === "B").length;
        const winsA = report.cases.filter((entry) => entry.winner === "A").length;
        if (winsB > winsA + threshold) {
            return {
                decision: "promote",
                reason: `success tied (${a.success} vs ${b.success}) but v2 wins ${winsB} cases ` +
                    `against v1's ${winsA}`,
            };
        }
        if (winsA > winsB + threshold) {
            return {
                decision: "rollback",
                reason: `success tied (${a.success} vs ${b.success}) but v1 wins ${winsA} cases ` +
                    `against v2's ${winsB}`,
            };
        }
        return {
            decision: "hold",
            reason: `no significant difference (success ${a.success} vs ${b.success}, ` +
                `winners A:${winsA} B:${winsB})`,
        };
    }
    /**
     * Writes the candidate as the active record. Guarded by the lineage check
     * so an unrelated skill can never be promoted over another (§70: no blind
     * overwrite).
     */
    async promote(base, v2, store) {
        if (v2.path !== base.path) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", `cannot promote ${v2.id}: path ${v2.path} differs from ${base.path}`));
        }
        const active = { ...v2, status: "active" };
        await store.save(active);
        return active;
    }
    /**
     * Restores base as the active record and, when the store can express it
     * (list + update), marks every other record of the same skill as
     * deprecated — the failed v2 stays reviewable, never deleted (§67 spirit).
     */
    async rollback(base, store) {
        const restored = { ...base, status: "active" };
        if (store.list !== undefined && store.update !== undefined) {
            const candidates = (await store.list()).filter((s) => s.path === base.path && s.id !== base.id);
            for (const candidate of candidates) {
                await store.update({ ...candidate, status: "deprecated" });
            }
        }
        await store.save(restored);
        return restored;
    }
}
/** Source of truth for the version: headers first, manifest fallback. */
function versionOf(skill) {
    const fromHeaders = skill.headers?.version;
    if (fromHeaders !== undefined && fromHeaders !== "")
        return fromHeaders;
    return skill.manifest.version;
}
/**
 * Semantic bump: a parseable `x.y.z` becomes `(x+1).0.0`; anything missing or
 * unparseable becomes "1.0.0" (covers the loader default "0.0.0" and
 * version-less skills).
 */
function bumpVersion(current) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current.trim());
    if (match === null)
        return "1.0.0";
    return `${Number(match[1]) + 1}.0.0`;
}
//# sourceMappingURL=skill-evolution.js.map