import { createHash } from "node:crypto";

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
  benchmarkEvidence: { benchmark?: { suite: string; caseId: string; beforeScore: number; afterScore: number }; note?: string }[];
  createdAt: number;
  active: boolean;
}

export interface ProvisionPolicyConfig {
  policy: string;
  config: Record<string, unknown>;
  changeReason: string;
  candidateSource?: string;
  benchmarkEvidence?: { benchmark?: { suite: string; caseId: string; beforeScore: number; afterScore: number }; note?: string }[];
}

export class PolicyVersionError extends Error {
  constructor(
    readonly code:
      | "empty-policy"
      | "empty-config"
      | "empty-reason"
      | "duplicate-config"
      | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "PolicyVersionError";
  }
}

/** Stable, key-sorted JSON so equal configs hash equal regardless of key order. */
export function stableSerializeConfig(config: Record<string, unknown>): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sortKeys(config));
}

/** Stable config fingerprint (hex). */
export function hashPolicyConfig(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableSerializeConfig(config), "utf8").digest("hex");
}

export class PolicyConfigRegistry {
  private versions: PolicyVersion[] = [];

  list(policy?: string): PolicyVersion[] {
    const all = [...this.versions].sort((a, b) =>
      a.policy === b.policy ? a.version - b.version : a.policy < b.policy ? -1 : 1,
    );
    return policy === undefined ? all : all.filter((v) => v.policy === policy);
  }

  getActive(policy: string): PolicyVersion | undefined {
    return this.versions.find((v) => v.policy === policy && v.active);
  }

  getVersion(policy: string, version: number): PolicyVersion | undefined {
    return this.versions.find((v) => v.policy === policy && v.version === version);
  }

  count(policy?: string): number {
    return this.list(policy).length;
  }

  /** Publish a new version of a policy config; becomes the active one. */
  publish(input: ProvisionPolicyConfig): PolicyVersion {
    if (typeof input.policy !== "string" || input.policy.trim() === "") {
      throw new PolicyVersionError("empty-policy", "policy name is required");
    }
    if (
      input.config === undefined ||
      input.config === null ||
      typeof input.config !== "object"
    ) {
      throw new PolicyVersionError("empty-config", "a config object is required");
    }
    if (typeof input.changeReason !== "string" || input.changeReason.trim() === "") {
      throw new PolicyVersionError("empty-reason", "a change reason is required");
    }
    const hash = hashPolicyConfig(input.config);
    if (this.versions.some((v) => v.policy === input.policy && v.hash === hash)) {
      throw new PolicyVersionError(
        "duplicate-config",
        `${input.policy}: config identical to an existing version (hash ${hash.slice(0, 12)})`,
      );
    }
    // Deactivate this policy's own previous active version.
    for (const v of this.versions) {
      if (v.policy === input.policy) v.active = false;
    }
    const next =
      this.versions.reduce(
        (max, v) => (v.policy === input.policy ? Math.max(max, v.version) : max),
        0,
      ) + 1;
    const record: PolicyVersion = {
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
  rollback(policy: string, targetVersion: number): PolicyVersion {
    const target = this.getVersion(policy, targetVersion);
    if (target === undefined) {
      throw new PolicyVersionError("not-found", `${policy}: no version ${targetVersion}`);
    }
    for (const v of this.versions) {
      if (v.policy === policy) v.active = false;
    }
    target.active = true;
    return target;
  }

  /** Recompute hashes; flag any policy version whose config was mutated in place. */
  verifyIntegrity(): { ok: boolean; violated: Array<{ policy: string; version: number }> } {
    const violated = this.versions
      .filter((v) => hashPolicyConfig(v.config) !== v.hash)
      .map((v) => ({ policy: v.policy, version: v.version }));
    return { ok: violated.length === 0, violated };
  }

  /** policy → (version, hash, change) mapping to embed in a benchmark trace. */
  exportTrace(): Record<string, { version: number; hash: string; changeReason: string }> {
    const trace: Record<string, { version: number; hash: string; changeReason: string }> = {};
    for (const v of this.versions) {
      if (!v.active) continue;
      trace[v.policy] = { version: v.version, hash: v.hash, changeReason: v.changeReason };
    }
    return trace;
  }

  exportSnapshot(): PolicyVersion[] {
    return this.list();
  }

  importSnapshot(snapshot: PolicyVersion[]): void {
    this.versions = snapshot.map((v) => ({ ...v, benchmarkEvidence: [...v.benchmarkEvidence] }));
  }
}