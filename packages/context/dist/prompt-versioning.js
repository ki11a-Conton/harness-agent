import { createHash } from "node:crypto";
/** Thrown by the registry on invalid publish / rollback / integrity failures. */
export class RuleVersionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "RuleVersionError";
    }
}
/** Stable content fingerprint (hex). */
export function hashRuleContent(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
export class PromptVersionRegistry {
    rules = [];
    /** list versions oldest → newest. */
    list() {
        return [...this.rules].sort((a, b) => a.version - b.version);
    }
    getVersion(version) {
        return this.rules.find((r) => r.version === version);
    }
    /** The currently active version, or undefined when none exists. */
    getActive() {
        return this.rules.find((r) => r.active);
    }
    count() {
        return this.rules.length;
    }
    /**
     * Publish a new version. The previous active version is deactivated and the
     * new one becomes active. Publishing content identical to an existing
     * version is rejected (no-op churn and a hash collision are never wanted).
     */
    publish(input) {
        const content = input.content;
        if (typeof content !== "string" || content.trim() === "") {
            throw new RuleVersionError("empty-content", "a rule cannot be empty");
        }
        const changeReason = input.changeReason;
        if (typeof changeReason !== "string" || changeReason.trim() === "") {
            throw new RuleVersionError("invalid-candidate-version", "a change reason is required");
        }
        const hash = hashRuleContent(content);
        if (this.rules.some((r) => r.hash === hash)) {
            throw new RuleVersionError("duplicate-content", `content identical to an existing version (hash ${hash.slice(0, 12)})`);
        }
        for (const v of this.rules)
            v.active = false;
        const next = this.rules.reduce((max, r) => Math.max(max, r.version), 0) + 1;
        const record = {
            version: next,
            content,
            hash,
            changeReason,
            ...(input.candidateSource !== undefined ? { candidateSource: input.candidateSource } : {}),
            ...(input.benchmarkEvidence !== undefined
                ? { benchmarkEvidence: input.benchmarkEvidence }
                : {}),
            createdAt: Date.now(),
            active: true,
        };
        this.rules.push(record);
        return record;
    }
    /**
     * Rollback: make `targetVersion` the active version again. Every version
     * newer than it is deactivated; older versions stay in history untouched.
     * Rolling back to the already-active version is a no-op.
     */
    rollback(targetVersion) {
        const target = this.rules.find((r) => r.version === targetVersion);
        if (target === undefined) {
            throw new RuleVersionError("version-not-found", `no version ${targetVersion}`);
        }
        for (const v of this.rules)
            v.active = false;
        target.active = true;
        return target;
    }
    /**
     * Recompute hashes and compare against the recorded ones. Any rule whose
     * content was mutated in place (outside the registry) fails.
     */
    verifyIntegrity() {
        const violated = this.rules.filter((r) => hashRuleContent(r.content) !== r.hash);
        return { ok: violated.length === 0, violated: violated.map((r) => r.version) };
    }
    /** Serializable snapshot (e.g. for persistence / migration). */
    exportSnapshot() {
        return this.list();
    }
    /** Restore from a snapshot; replaces current state. */
    importSnapshot(snapshot) {
        this.rules = snapshot.map((r) => ({ ...r }));
    }
}
//# sourceMappingURL=prompt-versioning.js.map