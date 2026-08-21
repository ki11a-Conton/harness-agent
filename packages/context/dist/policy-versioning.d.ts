/**
 * P2-17 Policy Config Versioning.
 *
 * Retry / compaction / memory-ranking / scheduler / verification / permission
 * defaults / tool semantics are all configuration that silently changes agent
 * behaviour. Anonymous, unversioned policy configs make benchmark results
 * untraceable — a number regresses "somewhere" with no record of which policy
 * changed, to what, or why.
 *
 * This registry version every named policy's config object so a benchmark
 * result can be traced to an exact policy fingerprint:
 *
 *   policy / version / hash / change reason / candidate source / benchmark evidence
 *
 * and supports rollback. `hash` is the sha256 of a **stable serialization** of
 * the config object (keys sorted recursively), so the fingerprint is
 * independent of object key order and identical config yields an identical
 * hash (a stable identity, not a source diff).
 *
 * "让 benchmark 结果可追溯": `exportTrace()` returns the policy→(version, hash,
 * change) mapping to embed in a run manifest, so any policy change that moved
 * a benchmark number can be located and, if needed, `rollback`'d.
 */
/** A versioned, per-policy configuration. */
export interface PolicyVersion {
    /** Named policy: "retry", "compaction", "scheduler", "verification", ... */
    policy: string;
    /** Monotonic version per policy, 1-based. */
    version: number;
    /** The versioned config object; immutable after publication. */
    config: Record<string, unknown>;
    /** sha256(stable serialize(config)), hex. */
    hash: string;
    changeReason: string;
    candidateSource?: string;
    benchmarkEvidence: {
        benchmark?: {
            suite: string;
            caseId: string;
            beforeScore: number;
            afterScore: number;
        };
        note?: string;
    }[];
    createdAt: number;
    active: boolean;
}
export interface ProvisionPolicyConfig {
    policy: string;
    config: Record<string, unknown>;
    changeReason: string;
    candidateSource?: string;
    benchmarkEvidence?: {
        benchmark?: {
            suite: string;
            caseId: string;
            beforeScore: number;
            afterScore: number;
        };
        note?: string;
    }[];
}
export declare class PolicyVersionError extends Error {
    readonly code: "empty-policy" | "empty-config" | "empty-reason" | "duplicate-config" | "not-found";
    constructor(code: "empty-policy" | "empty-config" | "empty-reason" | "duplicate-config" | "not-found", message: string);
}
/** Stable, key-sorted JSON so equal configs hash equal regardless of key order. */
export declare function stableSerializeConfig(config: Record<string, unknown>): string;
/** Stable config fingerprint (hex). */
export declare function hashPolicyConfig(config: Record<string, unknown>): string;
export declare class PolicyConfigRegistry {
    private versions;
    list(policy?: string): PolicyVersion[];
    getActive(policy: string): PolicyVersion | undefined;
    getVersion(policy: string, version: number): PolicyVersion | undefined;
    count(policy?: string): number;
    /** Publish a new version of a policy config; becomes the active one. */
    publish(input: ProvisionPolicyConfig): PolicyVersion;
    /** Rollback a policy to a prior version; every newer version of it deactivates. */
    rollback(policy: string, targetVersion: number): PolicyVersion;
    /** Recompute hashes; flag any policy version whose config was mutated in place. */
    verifyIntegrity(): {
        ok: boolean;
        violated: Array<{
            policy: string;
            version: number;
        }>;
    };
    /** policy → (version, hash, change) mapping to embed in a benchmark trace. */
    exportTrace(): Record<string, {
        version: number;
        hash: string;
        changeReason: string;
    }>;
    exportSnapshot(): PolicyVersion[];
    importSnapshot(snapshot: PolicyVersion[]): void;
}
//# sourceMappingURL=policy-versioning.d.ts.map