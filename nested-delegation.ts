import type {
  AgentDefinition,
  AgentId,
  DelegationLimits,
  EventStore,
  SessionStore,
} from "@ar/contracts";
import {
  AgentError,
  DEFAULT_DELEGATION_LIMITS,
  errorInfo,
} from "@ar/contracts";
import type { AgentRuntime } from "@ar/core";
import { Delegator, type DelegatorDeps } from "./delegator.js";
import type { DelegationRequest, DelegationResult } from "./delegation.js";

/** §56 delegation roles. */
export type DelegationRole = "leaf" | "orchestrator";

/** Annotation marker appended to a result summary when a delegation chain
 *  nested deeper than the first level. */
export const NESTED_MARKER = "[nested delegation]";

/**
 * Convention: a line of this shape in a child's final message requests a
 * nested delegation of that goal. The last matching line wins. The marker is
 * what NestedDelegator can observe — the child runs through
 * Delegator.delegate, so only its structured result (summary) is visible.
 */
const DELEGATE_RE = /^\s*DELEGATE:\s*(.+)$/gm;

/** AgentDefinition widened with the SUBAGENT-003 runtime marker. */
type LeafMarked = AgentDefinition & { canDelegate?: boolean };

/**
 * SUBAGENT-003: §56 leaf agent factory. Marks the definition as a leaf — a
 * subagent that must never delegate further (Hermes-style, plan §54/§56).
 *
 * The marker is a SUBAGENT-003-added convention: `canDelegate: false` lives
 * on the definition object at runtime only (AgentDefinition has no such
 * field, and @ar/contracts is not modified). `createLeafAgent` forces
 * `mode: "subagent"` so a leaf can never be used as a primary agent.
 */
export function createLeafAgent(def: AgentDefinition): AgentDefinition {
  const leaf: LeafMarked & { canDelegate: false } = {
    ...def,
    mode: "subagent",
    canDelegate: false,
  };
  return leaf;
}

/**
 * §56 role judgment: "leaf" when the agent is marked `canDelegate: false`,
 * or when the delegation depth is exhausted (`depth >= maxDepth`) — at the
 * depth boundary an orchestrator becomes effectively a leaf. Anything else
 * is an "orchestrator" that may delegate within the depth/concurrency limits.
 */
export function resolveRole(
  def: AgentDefinition,
  depth: number,
  maxDepth: number,
): DelegationRole {
  if (depth >= maxDepth) return "leaf";
  return (def as LeafMarked).canDelegate === false ? "leaf" : "orchestrator";
}

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
export class NestedDelegator {
  private readonly delegator: Delegator;
  private readonly runtime: AgentRuntime;
  private readonly agentId: AgentId;
  private readonly limits: DelegationLimits;
  private readonly roleOverride?: (def: AgentDefinition, depth: number) => DelegationRole;

  constructor(deps: NestedDelegatorDeps) {
    this.delegator = new Delegator(deps);
    this.runtime = deps.runtime;
    this.agentId = deps.agentId;
    this.limits = { ...DEFAULT_DELEGATION_LIMITS, ...deps.limits };
    this.roleOverride = deps.resolveRole;
  }

  /**
   * Delegates `req`, chaining further delegations while children request
   * them. `depth` is the caller-provided starting depth of the parent
   * session (default 0 = a root parent). Each nested level runs through
   * Delegator.delegate with the same AbortSignal, so caller cancellation
   * propagates through the whole chain.
   */
  async delegateNested(
    req: DelegationRequest,
    signal: AbortSignal,
    depth = 0,
  ): Promise<DelegationResult> {
    const chain: DelegationResult[] = [];
    const top = await this.spawnChain(req, signal, depth, chain);
    return this.annotateChain(top, chain);
  }

  /** Spawns one level and recurses while the child requests nesting.
   *  `chain` accumulates every level's result, top level first. */
  private async spawnChain(
    req: DelegationRequest,
    signal: AbortSignal,
    depth: number,
    chain: DelegationResult[],
  ): Promise<DelegationResult> {
    const limits: DelegationLimits = { ...this.limits, ...req.limits };
    const agentId = req.agentId ?? this.agentId;
    const def = this.runtime.getAgent(agentId);
    if (def === undefined) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", `unknown agent ${agentId}: cannot delegate`),
      );
    }
    if (this.roleOf(def, depth, limits.maxDepth) === "leaf") {
      throw new AgentError(
        errorInfo("RESOURCE_LIMIT", `leaf agent cannot delegate (depth ${depth})`),
      );
    }

    const top = await this.delegator.delegate(req, signal);
    chain.push(top);
    if (top.status !== "success") return top;

    const marker = parseDelegateMarker(top.summary);
    if (marker === undefined) return top;

    await this.spawnChain(this.nestedRequest(req, top, def), signal, depth + 1, chain);
    return top;
  }

  private roleOf(def: AgentDefinition, depth: number, maxDepth: number): DelegationRole {
    if (this.roleOverride !== undefined) return this.roleOverride(def, depth);
    return resolveRole(def, depth, maxDepth);
  }

  /** The nested request inherits the parent request's toolPolicy and limits
   *  (so per-request restrictions constrain the whole subtree) and runs the
   *  grandchild in the child's own agent. */
  private nestedRequest(
    req: DelegationRequest,
    child: DelegationResult,
    childDef: AgentDefinition,
  ): DelegationRequest {
    const marker = parseDelegateMarker(child.summary)!;
    return {
      parentSessionId: child.childSessionId,
      goal: marker.goal,
      agentId: childDef.id,
      ...(req.toolPolicy !== undefined ? { toolPolicy: req.toolPolicy } : {}),
      ...(req.limits !== undefined ? { limits: req.limits } : {}),
    };
  }

  /** Marks the top result with the full chain; propagates the deepest
   *  non-success status/error so failures are never masked. */
  private annotateChain(
    top: DelegationResult,
    chain: DelegationResult[],
  ): DelegationResult {
    if (chain.length <= 1) return top;
    const deepest = chain[chain.length - 1]!;
    const chainText = chain.map((r) => `${r.childSessionId}:${r.status}`).join(" → ");
    const summary = `${top.summary}\n${NESTED_MARKER} chain: ${chainText}`;
    if (deepest.status === "success") return { ...top, summary };
    return {
      ...top,
      status: deepest.status,
      summary,
      ...(deepest.error !== undefined ? { error: deepest.error } : {}),
    };
  }
}

function parseDelegateMarker(
  summary: string,
): { goal: string } | undefined {
  let goal: string | undefined;
  for (const match of summary.matchAll(DELEGATE_RE)) {
    goal = match[1]!.trim();
  }
  return goal === undefined || goal.length === 0 ? undefined : { goal };
}
