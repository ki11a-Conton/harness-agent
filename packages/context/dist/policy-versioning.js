import { createHash } from "node:crypto";
export class PolicyVersionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "PolicyVersionError";
    }
}
/** Stable, key-sorted JSON so equal configs hash equal regardless of key order. */
export function stableSerializeConfig(config) {
    const sortKeys = (value) => {
        if (Array.isArray(value))
            return value.map(sortKeys);
        if (value !== null && typeof value === "object") {
            const out = {};
            for (const key of Object.keys(value).sort()) {
                out[key] = sortKeys(value[key]);
            }
            return out;
        }
        return value;
    };
    return JSON.stringify(sortKeys(config));
}
/** Stable config fingerprint (hex). */
export function hashPolicyConfig(config) {
    return createHash("sha256").update(stableSerializeConfig(config), "utf8").digest("hex");
}
export class PolicyConfigRegistry {
    versions = [];
    list(policy) {
        const all = [...this.versions].sort((a, b) => a.policy === b.policy ? a.version - b.version : a.policy < b.policy ? -1 : 1);
        return policy === undefined ? all : all.filter((v) => v.policy === policy);
    }
    getActive(policy) {
        return this.versions.find((v) => v.policy === policy && v.active);
    }
    getVersion(policy, version) {
        return this.versions.find((v) => v.policy === policy && v.version === version);
    }
    count(policy) {
        return this.list(policy).length;
    }
    /** Publish a new version of a policy config; becomes the active one. */
    publish(input) {
        if (typeof input.policy !== "string" || input.policy.trim() === "") {
            throw new PolicyVersionError("empty-policy", "policy name is required");
        }
        if (input.config === undefined ||
            input.config === null ||
            typeof input.config !== "object") {
            throw new PolicyVersionError("empty-config", "a config object is required");
        }
        if (typeof input.changeReason !== "string" || input.changeReason.trim() === "") {
            throw new PolicyVersionError("empty-reason", "a change reason is required");
        }
        const hash = hashPolicyConfig(input.config);
        if (this.versions.some((v) => v.policy === input.policy && v.hash === hash)) {
            throw new PolicyVersionError("duplicate-config", `${input.policy}: config identical to an existing version (hash ${hash.slice(0, 12)})`);
        }
        // Deactivate this policy's own previous active version.
        for (const v of this.versions) {
            if (v.policy === input.policy)
                v.active = false;
        }
        const next = this.versions.reduce((max, v) => (v.policy === input.policy ? Math.max(max, v.version) : max), 0) + 1;
        const record = {
            policy: input.policy,
            version: next,
            config: input.config,
            hash,
            changeReason: input.changeReason,
            ...(input.candidateSource !== undefined ? { candidateSource: input.candidateSource } : {}),
            benchmarkEvidence: input.benchmarkEvidence ?? [],
            createdAt: Date.now(),
            active: true,
        };
        this.versions.push(record);
        return record;
    }
    /** Rollback a policy to a prior version; every newer version of it deactivates. */
    rollback(policy, targetVersion) {
        const target = this.getVersion(policy, targetVersion);
        if (target === undefined) {
            throw new PolicyVersionError("not-found", `${policy}: no version ${targetVersion}`);
        }
        for (const v of this.versions) {
            if (v.policy === policy)
                v.active = false;
        }
        target.active = true;
        return target;
    }
    /** Recompute hashes; flag any policy version whose config was mutated in place. */
    verifyIntegrity() {
        const violated = this.versions
            .filter((v) => hashPolicyConfig(v.config) !== v.hash)
            .map((v) => ({ policy: v.policy, version: v.version }));
        return { ok: violated.length === 0, violated };
    }
    /** policy → (version, hash, change) mapping to embed in a benchmark trace. */
    exportTrace() {
        const trace = {};
        for (const v of this.versions) {
            if (!v.active)
                continue;
            trace[v.policy] = { version: v.version, hash: v.hash, changeReason: v.changeReason };
        }
        return trace;
    }
    exportSnapshot() {
        return this.list();
    }
    importSnapshot(snapshot) {
        this.versions = snapshot.map((v) => ({ ...v, benchmarkEvidence: [...v.benchmarkEvidence] }));
    }
}
//# sourceMappingURL=policy-versioning.js.map