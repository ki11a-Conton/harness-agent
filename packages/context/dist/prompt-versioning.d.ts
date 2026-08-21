/**
 * P2-16 Prompt Rule Versioning.
 *
 * The system prompt / runtime rule was an anonymous string: change it and
 * there is no record of what changed, why, or whether it was benchmarked.
 * This registry makes every rule version explicit:
 *
 *   version / hash / change reason / candidate source / benchmark evidence
 *
 * and supports rollback. A rule (or full system prompt) is provisioned through
 * the registry, which stamps it with an increasing `version`, a content hash,
 * the human-readable `changeReason`, where the idea came from
 * (`candidateSource`), and any `benchmarkEvidence` that justifies it.
 * Publishing a new version is a hard, immutable append — the old content is
 * never mutated, it just stops being the active one. `rollback` re-activates a
 * prior version, so a regressing prompt is one call away from being undone —
 * provenance intact.
 *
 * Integrity: `hash` is bound to `content` at write time and is recomputed by
 * `verifyIntegrity()`, so a string that was mutated in memory (outside the
 * registry) can be detected instead of being silently sent to the model.
 */
export interface RuleChangeEvidence {
    /** "the benchmark that justified/detected the need for this change". */
    benchmark?: {
        suite: string;
        caseId: string;
        beforeScore: number;
        afterScore: number;
    };
    /** Free-form note (e.g. linked regression id). */
    note?: string;
}
export interface VersionedRule {
    /** Monotonic version, 1-based. */
    version: number;
    /** The rule / system-prompt text. Immutable after publication. */
    content: string;
    /** sha256(content) as hex. Binds provenance to exact bytes. */
    hash: string;
    /** Why this version was published (required). */
    changeReason: string;
    /** Where the prompt/rule candidate came from (e.g. benchmark, human, migration). */
    candidateSource?: string;
    /** Benchmark evidence justifying this version. */
    benchmarkEvidence?: RuleChangeEvidence[];
    createdAt: number;
    /** Only the latest published (or rolled-back) version is active. */
    active: boolean;
}
export interface ProvisionRuleInput {
    content: string;
    changeReason: string;
    candidateSource?: string;
    benchmarkEvidence?: RuleChangeEvidence[];
}
/** Thrown by the registry on invalid publish / rollback / integrity failures. */
export declare class RuleVersionError extends Error {
    readonly code: "empty-content" | "duplicate-content" | "version-not-found" | "integrity-violation" | "invalid-candidate-version";
    constructor(code: "empty-content" | "duplicate-content" | "version-not-found" | "integrity-violation" | "invalid-candidate-version", message: string);
}
/** Stable content fingerprint (hex). */
export declare function hashRuleContent(content: string): string;
export declare class PromptVersionRegistry {
    private rules;
    /** list versions oldest → newest. */
    list(): VersionedRule[];
    getVersion(version: number): VersionedRule | undefined;
    /** The currently active version, or undefined when none exists. */
    getActive(): VersionedRule | undefined;
    count(): number;
    /**
     * Publish a new version. The previous active version is deactivated and the
     * new one becomes active. Publishing content identical to an existing
     * version is rejected (no-op churn and a hash collision are never wanted).
     */
    publish(input: ProvisionRuleInput): VersionedRule;
    /**
     * Rollback: make `targetVersion` the active version again. Every version
     * newer than it is deactivated; older versions stay in history untouched.
     * Rolling back to the already-active version is a no-op.
     */
    rollback(targetVersion: number): VersionedRule;
    /**
     * Recompute hashes and compare against the recorded ones. Any rule whose
     * content was mutated in place (outside the registry) fails.
     */
    verifyIntegrity(): {
        ok: boolean;
        violated: number[];
    };
    /** Serializable snapshot (e.g. for persistence / migration). */
    exportSnapshot(): VersionedRule[];
    /** Restore from a snapshot; replaces current state. */
    importSnapshot(snapshot: VersionedRule[]): void;
}
//# sourceMappingURL=prompt-versioning.d.ts.map