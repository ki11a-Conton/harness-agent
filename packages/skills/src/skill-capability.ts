import type { Skill, ToolPolicy } from "@ar/contracts";
import { isToolAllowedByPolicy } from "@ar/contracts";

/**
 * P14-4 — skill boundary: declared tool dependencies must be a NARROWING of
 * the host's conferred tool policy.
 *
 * A skill's SKILL.md frontmatter may declare `requiredTools`. That list is
 * the skill's DECLARED tool capability. The host agent's ToolPolicy is the
 * CONFERED upper bound. The monotonicity rule therefore reads:
 *
 *   requiredTools ⊆ { t : isToolAllowedByPolicy(toolPolicy, t) }
 *
 * A skill that requires a tool the host does not allow must never be injected:
 * its body could instruct the model to call a tool outside the agent's tool
 * policy. The check reuses `isToolAllowedByPolicy` — the exact predicate the
 * runtime uses to gate every tool call — so the skill gate and the runtime
 * gate share one semantic (no second source of truth).
 *
 * An undefined policy behaves like an allow-everything policy (`allow`
 * undefined is "no allow restriction"), matching `isToolAllowedByPolicy`
 * semantics for an unconfigured agent; a skill declaring tools under an
 * explicit allow-list is still bound by it.
 */
export interface SkillRequiredToolsVerdict {
  allowed: boolean;
  /** Declared requiredTools that the host policy does not allow. */
  missing: readonly string[];
}

export function checkSkillRequiredTools(
  skill: Pick<Skill, "manifest">,
  toolPolicy: ToolPolicy | undefined,
): SkillRequiredToolsVerdict {
  const required = skill.manifest.requiredTools ?? [];
  if (required.length === 0) return { allowed: true, missing: [] };
  const missing = required.filter((tool) => !isToolAllowedByPolicy(toolPolicy ?? {}, tool));
  return { allowed: missing.length === 0, missing };
}

/** Render the required-tools denial into the shared skill-security record
 *  shape so the existing SKILL_DENIED code / security.skill_denied event
 *  surface applies unchanged (P14-4 typed denial + security event). */
export function requiredToolsDenial(
  skill: Pick<Skill, "path">,
  verdict: SkillRequiredToolsVerdict,
): {
  detection: "required-tools";
  reasons: string[];
  content: string;
  path: string;
  source: string;
} {
  return {
    detection: "required-tools",
    reasons: verdict.missing.map((tool) => `required tool not allowed by host policy: ${tool}`),
    content: "",
    path: skill.path,
    source: "skill-capability",
  };
}
