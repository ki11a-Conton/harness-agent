import type { AgentId } from "./ids.js";
import type { ModelRef } from "./model.js";
import type { PermissionPolicy } from "./permission.js";

export type AgentMode = "primary" | "subagent";

export type PromptSource = string;

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

/** P0-1: runtime-relevant policy check — a tool is allowed unless it is
 *  deny-listed, or allow-listed and missing from the allow list. Fail-closed
 *  for unknown tools when an allow list is set. */
export function isToolAllowedByPolicy(policy: ToolPolicy, toolName: string): boolean {
  if (policy.deny?.includes(toolName)) return false;
  if (policy.allow !== undefined && !policy.allow.includes(toolName)) return false;
  return true;
}

export interface SkillPolicy {
  allow?: string[];
  deny?: string[];
}

export interface AgentLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxOutputChars?: number;
  maxRetries?: number;
  maxSubagents?: number;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  description: string;
  mode: AgentMode;
  model: ModelRef;
  systemPrompt: PromptSource;
  tools: ToolPolicy;
  permissions: PermissionPolicy;
  skills: SkillPolicy;
  limits: AgentLimits;
}

/**
 * P0-1: the frozen per-session effective configuration. Captured at session
 * creation from the AgentDefinition actually passed to the runtime (which may
 * already be a delegation-narrowed child agent), persisted with the session,
 * and honored by runTurn instead of re-reading the registry — so later registry
 * updates can never silently widen a running session's permissions.
 *
 * Deliberately a subset of AgentDefinition: only the fields the runtime
 * consults for behavior/security. Metadata (name/description/mode) is
 * cosmetic and not part of the security boundary.
 */
export interface EffectiveAgentConfig {
  agentId: AgentId;
  model: ModelRef;
  systemPrompt: PromptSource;
  tools: ToolPolicy;
  permissions: PermissionPolicy;
  skills: SkillPolicy;
  limits: AgentLimits;
}

/** Key under which the effective config is stored in the session state
 *  snapshot (covers SessionStore.saveStateSnapshot). */
export const EFFECTIVE_AGENT_SNAPSHOT_KEY = "effectiveAgent" as const;

/** Deep-enough copy of the policy containers so that mutating the caller's
 *  AgentDefinition after createSession can never change the frozen session
 *  policy (P0-1: freeze must be immune to later mutation). */
function copyPolicy<T extends object>(policy: T): T {
  const copy = { ...policy } as Record<string, unknown>;
  for (const key of ["allow", "deny"] as const) {
    const value = copy[key];
    if (Array.isArray(value)) copy[key] = [...value];
  }
  return copy as T;
}

export function snapshotEffectiveConfig(agent: AgentDefinition): EffectiveAgentConfig {
  return {
    agentId: agent.id,
    model: { ...agent.model },
    systemPrompt: agent.systemPrompt,
    tools: copyPolicy(agent.tools),
    permissions: copyPolicy(agent.permissions),
    skills: copyPolicy(agent.skills),
    limits: { ...agent.limits },
  };
}

export interface BuiltinAgentProfile {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly model: ModelRef;
  readonly permissions: PermissionPolicy;
  readonly tools: ToolPolicy;
  readonly skills: SkillPolicy;
  readonly limits: AgentLimits;
}