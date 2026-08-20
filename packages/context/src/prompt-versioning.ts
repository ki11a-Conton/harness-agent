import { createHash } from "node:crypto";

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
  benchmark?: { suite: string; caseId: string; beforeScore: number; afterScore: number };
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
export class RuleVersionError extends Error {
  constructor(
    readonly code:
      | "empty-content"
      | "duplicate-content"
      | "version-not-found"
      | "integrity-violation"
      | "invalid-candidate-version",
    message: string,
  ) {
    super(message);
    this.name = "RuleVersionError";
  }
}

/** Stable content fingerprint (hex). */
export function hashRuleContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class PromptVersionRegistry {
  private rules: VersionedRule[] = [];

  /** list versions oldest → newest. */
  list(): VersionedRule[] {
    return [...this.rules].sort((a, b) => a.version - b.version);
  }

  getVersion(version: number): VersionedRule | undefined {
    return this.rules.find((r) => r.version === version);
  }

  /** The currently active version, or undefined when none exists. */
  getActive(): VersionedRule | undefined {
    return this.rules.find((r) => r.active);
  }

  count(): number {
    return this.rules.length;
  }

  /**
   * Publish a new version. The previous active version is deactivated and the
   * new one becomes active. Publishing content identical to an existing
   * version is rejected (no-op churn and a hash collision are never wanted).
   */
  publish(input: ProvisionRuleInput): VersionedRule {
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
      throw new RuleVersionError(
        "duplicate-content",
        `content identical to an existing version (hash ${hash.slice(0, 12)})`,
      );
    }
    for (const v of this.rules) v.active = false;

    const next = this.rules.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    const record: VersionedRule = {
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
  rollback(targetVersion: number): VersionedRule {
    const target = this.rules.find((r) => r.version === targetVersion);
    if (target === undefined) {
      throw new RuleVersionError("version-not-found", `no version ${targetVersion}`);
    }
    for (const v of this.rules) v.active = false;
    target.active = true;
    return target;
  }

  /**
   * Recompute hashes and compare against the recorded ones. Any rule whose
   * content was mutated in place (outside the registry) fails.
   */
  verifyIntegrity(): { ok: boolean; violated: number[] } {
    const violated = this.rules.filter((r) => hashRuleContent(r.content) !== r.hash);
    return { ok: violated.length === 0, violated: violated.map((r) => r.version) };
  }

  /** Serializable snapshot (e.g. for persistence / migration). */
  exportSnapshot(): VersionedRule[] {
    return this.list();
  }

  /** Restore from a snapshot; replaces current state. */
  importSnapshot(snapshot: VersionedRule[]): void {
    this.rules = snapshot.map((r) => ({ ...r }));
  }
}