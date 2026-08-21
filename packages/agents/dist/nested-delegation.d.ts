import type { AgentDefinition } from "@ar/contracts";
import { type DelegatorDeps } from "./delegator.js";
import type { DelegationRequest, DelegationResult } from "./delegation.js";
/** §56 delegation roles. */
export type DelegationRole = "leaf" | "orchestrator";
/** Annotation marker appended to a result summary when a delegation chain
 *  nested deeper than the first level. */
export declare const NESTED_MARKER = "[nested delegation]";
/**
 * SUBAGENT-003: §56 leaf agent factory. Marks the definition as a leaf — a
 * subagent that must never delegate further (Hermes-style, plan §54/§56).
 *
 * The marker is a SUBAGENT-003-added convention: `canDelegate: false` lives
 * on the definition object at runtime only (AgentDefinition has no such
 * field, and @ar/contracts is not modified). `createLeafAgent` forces
 * `mode: "subagent"` so a leaf can never be used as a primary agent.
 */
export declare function createLeafAgent(def: AgentDefinition): AgentDefinition;
/**
 * §56 role judgment: "leaf" when the agent is marked `canDelegate: false`,
 * or when the delegation depth is exhausted (`depth >= maxDepth`) — at the
 * depth boundary an orchestrator becomes effectively a leaf. Anything else
 * is an "orchestrator" that may delegate within the depth/concurrency limits.
 */
export declare function resolveRole(def: AgentDefinition, depth: number, maxDepth: number): DelegationRole;
export interface NestedDelegatorDeps extends DelegatorDeps {
    /** §56: injectable leaf/orchestrator judgment. Defaults to `resolveRole`,
     *  which honors the `canDelegate: false` marker and the depth boundary. */
    resolveRole?: (def: AgentDefinition, depth: number) => DelegationRole;
}
/**
 * SUBAGENT-003: recursive delegation (§56, §55, INV-009).
 *
 * A wrapper around Delegator that chains delegations: when a child's result
 * summary carries a `DELEGATE: <goal>` line (and the child is an
 * "orchestrator" within maxDepth), the goal is delegated one level deeper
 * under the child's session. The returned result is the top-level one,
 * annotated with the full chain (`NESTED_MARKER` + `childSessionId:status`
 * per level).
 *
 * Role enforcement happens at every level before any session is created:
 * a leaf agent (or an orchestrator past the depth boundary) rejects with
 * AgentError RESOURCE_LIMIT. Depth bounds are additionally enforced per
 * level by the inner Delegator's enforceBounds (INV-009, maxDepth).
 *
 * A non-success outcome in the chain (failed / cancelled / timeout) is never
 * masked: the deepest terminal status and error propagate to the top result,
 * while the summary still records the full chain.
 */
export declare class NestedDelegator {
    private readonly delegator;
    private readonly runtime;
    private readonly agentId;
    private readonly limits;
    private readonly roleOverride?;
    constructor(deps: NestedDelegatorDeps);
    /**
     * Delegates `req`, chaining further delegations while children request
     * them. `depth` is the caller-provided starting depth of the parent
     * session (default 0 = a root parent). Each nested level runs through
     * Delegator.delegate with the same AbortSignal, so caller cancellation
     * propagates through the whole chain.
     */
    delegateNested(req: DelegationRequest, signal: AbortSignal, depth?: number): Promise<DelegationResult>;
    /** Spawns one level and recurses while the child requests nesting.
     *  `chain` accumulates every level's result, top level first. */
    private spawnChain;
    private roleOf;
    /** The nested request inherits the parent request's toolPolicy and limits
     *  (so per-request restrictions constrain the whole subtree) and runs the
     *  grandchild in the child's own agent. */
    private nestedRequest;
    /** Marks the top result with the full chain; propagates the deepest
     *  non-success status/error so failures are never masked. */
    private annotateChain;
}
//# sourceMappingURL=nested-delegation.d.ts.map