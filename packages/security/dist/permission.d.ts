import type { PermissionDecision, PermissionEffect, PermissionEngine, PermissionPolicy, PermissionRequest } from "@ar/contracts";
export { matchGlob } from "./glob.js";
/**
 * Deterministic PermissionEngine per AGENT_ARCHITECTURE_PLAN §15–§17.
 * Precedence: global → project → agent → session → tool → call.
 * Most specific matching rule wins; on equal specificity, deny wins.
 * No matching rule → policy.defaultEffect (default "ask").
 */
export declare class DeterministicPermissionEngine implements PermissionEngine {
    evaluate(request: PermissionRequest, policy: PermissionPolicy): Promise<PermissionDecision>;
}
export declare function defaultEffectForRisk(risk: string): PermissionEffect;
//# sourceMappingURL=permission.d.ts.map