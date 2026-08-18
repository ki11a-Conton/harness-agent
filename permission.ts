import type {
  PermissionDecision,
  PermissionEffect,
  PermissionEngine,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
} from "@ar/contracts";

const SCOPE_RANK: Record<PermissionScope, number> = {
  global: 0,
  project: 1,
  agent: 2,
  session: 3,
  tool: 4,
  call: 5,
};

import { matchGlob } from "./glob.js";
export { matchGlob } from "./glob.js";

/**
 * Deterministic PermissionEngine per AGENT_ARCHITECTURE_PLAN §15–§17.
 * Precedence: global → project → agent → session → tool → call.
 * Most specific matching rule wins; on equal specificity, deny wins.
 * No matching rule → policy.defaultEffect (default "ask").
 */
export class DeterministicPermissionEngine implements PermissionEngine {
  async evaluate(request: PermissionRequest, policy: PermissionPolicy): Promise<PermissionDecision> {
    const matches = policy.rules.filter((r) => ruleMatches(r, request));
    if (matches.length === 0) {
      const fallback = policy.defaultEffect ?? "ask";
      return {
        effect: fallback,
        reason: `no rule matched ${request.action}:${request.resource}; fallback '${fallback}'`,
      };
    }

    let best: PermissionRule = matches[0]!;
    let bestScore = ruleScore(best);
    let conflictDeny = false;

    for (const rule of matches) {
      const score = ruleScore(rule);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
        conflictDeny = false;
      } else if (score === bestScore && rule.effect !== best.effect) {
        conflictDeny = true;
      }
    }

    const effect = conflictDeny ? "deny" : best.effect;
    return {
      effect,
      rule: conflictDeny ? undefined : best,
      reason: conflictDeny
        ? `conflicting equally-specific rules; deny wins`
        : `rule '${best.id ?? "anon"}' (${best.effect}) matched`,
    };
  }
}

function ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
  if (rule.action !== "*" && rule.action !== request.action) return false;
  if (rule.resource !== "*" && rule.resource !== request.resource) return false;
  if (rule.pattern !== undefined && rule.pattern !== "") {
    if (request.target === undefined) return false;
    if (!matchGlob(rule.pattern, request.target)) return false;
  }
  return true;
}

function ruleScore(rule: PermissionRule): number {
  const scope = rule.scope ?? "global";
  return SCOPE_RANK[scope] + (rule.pattern !== undefined ? 0.5 : 0);
}

export function defaultEffectForRisk(risk: string): PermissionEffect {
  switch (risk) {
    case "readonly":
      return "allow";
    case "side_effect":
      return "ask";
    case "elevated":
      return "ask";
    case "critical":
      return "deny";
    default:
      return "ask";
  }
}