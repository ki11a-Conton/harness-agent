import type { Skill, SkillId } from "@ar/contracts";
import type { BenchReport } from "@ar/evaluation";
import type { SkillStoreLike } from "./skill-store.js";
export type EvolutionDecision = "promote" | "rollback" | "hold";
export interface EvolutionVerdict {
    decision: EvolutionDecision;
    reason: string;
}
export interface SkillEvolverDeps {
    /** Injectable SkillId generator for candidate versions; defaults to contracts newSkillId. */
    newSkillId?: () => SkillId;
}
export interface CreateVersionDeps {
    /** Injectable clock for the candidate's discoveredAt; defaults to Date.now. */
    now?: () => number;
}
export interface EvaluateDeps {
    /** The current active version (baseline). */
    v1: Skill;
    /** The candidate version produced by createVersion. */
    v2: Skill;
    /** Head-to-head benchmark of v1 vs v2 (§133); must run before comparing. */
    bench: () => Promise<BenchReport>;
    /** Margin a success/winner delta must exceed to count; default 0. */
    threshold?: number;
}
/**
 * SKILL-EVO-001: evidence-driven skill evolution (§70).
 *
 * Flow: createVersion → benchmark (caller arranges the §133 head-to-head) →
 * evaluate the BenchReport → promote or rollback through a SkillStoreLike.
 * Production skills are never overwritten blindly: evaluate() is the only
 * gate between a candidate and the active record, and a safety regression
 * (increased violations) always beats a success improvement (§50).
 */
export declare class SkillEvolver {
    private readonly makeSkillId;
    constructor(deps?: SkillEvolverDeps);
    /**
     * Builds the v2 candidate: same skill lineage (path), fresh record id (so
     * both versions can coexist in the id-keyed store and rollback can deprecate
     * v2 while restoring v1), semantically bumped manifest.version, new body.
     */
    createVersion(base: Skill, newBody: string, deps?: CreateVersionDeps): Skill;
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
    evaluate(deps: EvaluateDeps): Promise<EvolutionVerdict>;
    /**
     * Writes the candidate as the active record. Guarded by the lineage check
     * so an unrelated skill can never be promoted over another (§70: no blind
     * overwrite).
     */
    promote(base: Skill, v2: Skill, store: SkillStoreLike): Promise<Skill>;
    /**
     * Restores base as the active record and, when the store can express it
     * (list + update), marks every other record of the same skill as
     * deprecated — the failed v2 stays reviewable, never deleted (§67 spirit).
     */
    rollback(base: Skill, store: SkillStoreLike): Promise<Skill>;
}
//# sourceMappingURL=skill-evolution.d.ts.map