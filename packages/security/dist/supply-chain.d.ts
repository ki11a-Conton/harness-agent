/**
 * P2-25 Dependency / Supply Chain safety.
 *
 * In agent coding, these are high-risk side effects and must NOT all collapse
 * into one generic "run a command" permission bucket:
 *
 *   dependency_install      npm install / pip install / cargo add … mutates the
 *                           lockfile and node_modules/vendor tree (supply chain).
 *   remote_code_execution   curl | sh / bash <(curl …) / wget -O- | sh / running
 *                           a downloaded script — executes attacker-influenced
 *                           code fetched over the network.
 *
 * `classifySupplyChain(command)` returns one of these or "command" (ordinary),
 * and the ToolOrchestrator surfaces it as its OWN permission `resource`
 * (`exec:dependency_install`, `exec:remote_code_execution`) distinct from
 * ordinary `exec:command`, so operators can gate them independently.
 *
 * `supplyChainRisk()` escalates remote_code_execution to the "critical" risk
 * tier (deny by default via `defaultEffectForRisk`), because piping untrusted
 * remote content into a shell is a class of action an agent should never take
 * without an explicit grant.
 *
 * Like network-gate / process-gate this is a STATIC classifier: it inspects the
 * command STRING, it does not observe what the process does at runtime.
 */
export type SupplyChainCategory = "dependency_install" | "remote_code_execution" | "command";
/** Classify a command string against the supply-chain categories. */
export declare function classifySupplyChain(command: string): SupplyChainCategory;
/** Escalate the risk tier for the most dangerous category. */
export type SupplyChainRisk = "elevated" | "critical";
export declare function supplyChainRisk(category: SupplyChainCategory): SupplyChainRisk;
//# sourceMappingURL=supply-chain.d.ts.map