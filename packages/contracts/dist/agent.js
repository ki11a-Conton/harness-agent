/** P0-1: runtime-relevant policy check — a tool is allowed unless it is
 *  deny-listed, or allow-listed and missing from the allow list. Fail-closed
 *  for unknown tools when an allow list is set. */
export function isToolAllowedByPolicy(policy, toolName) {
    if (policy.deny?.includes(toolName))
        return false;
    if (policy.allow !== undefined && !policy.allow.includes(toolName))
        return false;
    return true;
}
/** Key under which the effective config is stored in the session state
 *  snapshot (covers SessionStore.saveStateSnapshot). */
export const EFFECTIVE_AGENT_SNAPSHOT_KEY = "effectiveAgent";
/** Deep-enough copy of the policy containers so that mutating the caller's
 *  AgentDefinition after createSession can never change the frozen session
 *  policy (P0-1: freeze must be immune to later mutation). */
function copyPolicy(policy) {
    const copy = { ...policy };
    for (const key of ["allow", "deny"]) {
        const value = copy[key];
        if (Array.isArray(value))
            copy[key] = [...value];
    }
    return copy;
}
export function snapshotEffectiveConfig(agent) {
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
export const RUNTIME_POLICY_SNAPSHOT_KEY = "runtimePolicy";
//# sourceMappingURL=agent.js.map