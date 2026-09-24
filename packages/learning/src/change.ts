import { createHash } from "node:crypto";

/**
 * P10-1: a learning candidate's change must be expressible as a patch —
 * "improve the prompt" is not a patch. Every promoted candidate carries an
 * explicit, reverable change (prompt rule, policy, skill, memory or tool
 * preference) plus provenance, so promotion is auditable and the change is
 * frozen while it is evaluated (P10-2).
 */

export type HarnessCandidateChangeKind =
  | "prompt_rule"
  | "policy"
  | "skill"
  | "memory"
  | "tool_preference";

export interface HarnessCandidateChange {
  id: string;
  kind: HarnessCandidateChangeKind;
  patch: CandidatePatch;
  provenance: {
    candidateId: string;
    author: "reflection" | "human";
    createdAt: number;
  };
}

export type CandidatePatch =
  | PromptRulePatch
  | PolicyPatch
  | SkillPatch
  | MemoryPatch
  | ToolPreferencePatch;

/** A new/changed deterministic prompt rule the model context applies. */
export interface PromptRulePatch {
  rule: string;
  /** Context this rule applies to (memory/skill/tool output/...). */
  scope?: string;
  priority?: number;
}

/** A permission/policy delta (allow/deny/resource). */
export interface PolicyPatch {
  action: "allow" | "deny";
  resource: string;
  target: string;
  reason?: string;
}

/** A skill body addition or replacement. */
export interface SkillPatch {
  skillName: string;
  /** The new SKILL.md body (or undefined to drop the skill). */
  body?: string;
  description?: string;
}

/** A memory entry to write (with scope/type/importance). */
export interface MemoryPatch {
  content: string;
  scope?: string;
  type?: "explicit" | "episodic" | "procedural";
  importance?: number;
}

/** A tool preference (rank/affinity) change. */
export interface ToolPreferencePatch {
  tool: string;
  /** -1..1 affinity delta (positive = prefer, negative = avoid). */
  affinityDelta: number;
  reason?: string;
}

/** Stable JSON (sorted keys) — the canonical serialization for hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** P10-2: deterministic config fingerprint — freezes a harness profile for
 *  the duration of an evaluation (champion vs challenger must share or differ
 *  only by the candidate patch, and both must be pinned). */
export function configHash(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 16);
}

/** P10-6: platform-sensitivity of a candidate patch. Patches touching paths,
 *  filesystem, process or store behavior must pass BOTH Linux and Windows CI
 *  before promotion; pure-prompt/tool-preference patches are platform-neutral.
 *  The gate returns the platforms the patch is sensitive to (empty = neutral). */
export function platformSensitivity(patch: CandidatePatch): { sensitive: boolean; platforms: string[] } {
  const kind = patchTypeOf(patch);
  if (kind === "policy" || kind === "memory") {
    return { sensitive: true, platforms: ["linux", "windows"] };
  }
  return { sensitive: false, platforms: [] };
}

function patchTypeOf(patch: CandidatePatch): HarnessCandidateChangeKind {
  if ("rule" in patch) return "prompt_rule";
  if ("action" in patch && "resource" in patch) return "policy";
  if ("skillName" in patch) return "skill";
  if ("content" in patch) return "memory";
  return "tool_preference";
}
