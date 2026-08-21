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
export declare function isToolAllowedByPolicy(policy: ToolPolicy, toolName: string): boolean;
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
export declare const EFFECTIVE_AGENT_SNAPSHOT_KEY: "effectiveAgent";
export declare function snapshotEffectiveConfig(agent: AgentDefinition): EffectiveAgentConfig;
/** P1-6: runtime-wide policy snapshot captured at session creation so a
 *  resume against a differently-configured host can be detected (safe-resume
 *  gate). Absent entries mean "not versioned by this host". */
export interface EffectiveRuntimePolicySnapshot {
    version: 1;
    contextPolicyHash?: string;
    retryPolicyHash?: string;
    schedulerPolicyHash?: string;
    toolSemanticsHash?: string;
    promptVersion?: string;
    verificationPolicyHash?: string;
    createdAt: number;
}
export declare const RUNTIME_POLICY_SNAPSHOT_KEY: "runtimePolicy";
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
//# sourceMappingURL=agent.d.ts.map