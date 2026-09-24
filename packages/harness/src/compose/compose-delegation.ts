/**
 * P22-1 — composition helper: DELEGATION.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * Two-phase by design: the scheduler is created BEFORE the runtime (it has no
 * runtime dependency), the delegator AFTER it (it binds the runtime). No
 * delegate* tool is registered here — the model-callable delegation tools are
 * composed by compose-tools (P3), reported honestly by the audit.
 */
import type { AgentDefinition, EventStore, SandboxPolicy, SessionId, SessionStore } from "@ar/contracts";
import { AgentRuntime } from "@ar/core";
import { AgentExecutionScheduler, Delegator, ParallelDelegator } from "@ar/agents";
import { subagentDefinition } from "../worker-agent.js";
import { DefaultChildWorkspaceManager } from "../workspace-manager.js";
import { PRODUCTION_TOOL_NAMES } from "../tool-names.js";
import type { HarnessConfig } from "../config.js";

export function schedulerLimits(delegation: NonNullable<HarnessConfig["delegation"]> | undefined): {
  maxGlobalAgents?: number;
  maxAgentsPerRoot?: number;
  maxDepth?: number;
} {
  return {
    ...(delegation?.maxGlobalAgents !== undefined ? { maxGlobalAgents: delegation.maxGlobalAgents } : {}),
    ...(delegation?.maxAgentsPerRoot !== undefined ? { maxAgentsPerRoot: delegation.maxAgentsPerRoot } : {}),
    ...(delegation?.maxDepth !== undefined ? { maxDepth: delegation.maxDepth } : {}),
  };
}

export function delegationLimits(delegation: NonNullable<HarnessConfig["delegation"]> | undefined): {
  maxDepth?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxToolCalls?: number;
} {
  return {
    ...(delegation?.maxDepth !== undefined ? { maxDepth: delegation.maxDepth } : {}),
    ...(delegation?.maxConcurrent !== undefined ? { maxConcurrent: delegation.maxConcurrent } : {}),
    ...(delegation?.timeoutMs !== undefined ? { timeoutMs: delegation.timeoutMs } : {}),
    ...(delegation?.maxToolCalls !== undefined ? { maxToolCalls: delegation.maxToolCalls } : {}),
  };
}

/** Phase 1: the tree scheduler (created before the runtime). */
export function composeScheduler(
  config: HarnessConfig,
  delegationEnabled: boolean,
  store: SessionStore,
): AgentExecutionScheduler | undefined {
  return delegationEnabled
    ? new AgentExecutionScheduler({ store, limits: schedulerLimits(config.delegation) })
    : undefined;
}

export interface ComposedDelegation {
  delegator: Delegator | undefined;
  parallelDelegator: ParallelDelegator | undefined;
  /** The subagent definition that was added to the agents list (if any). */
  subagent: AgentDefinition | undefined;
}

export interface ComposeDelegatorsDeps {
  config: HarnessConfig;
  runtime: AgentRuntime;
  store: SessionStore;
  events: EventStore;
  scheduler: AgentExecutionScheduler | undefined;
  agents: AgentDefinition[];
  mcpToolNames: string[];
  delegationToolNames: string[];
  /** P3-6: admit/revoke per-child isolated sandbox roots. */
  childWorkspaceRoots: Map<SessionId, string>;
  /** The effective parent sandbox policy (config override or profile preset). */
  sandboxPolicy: SandboxPolicy;
}

/** Phase 2: the delegators (created after the runtime; binds it). */
export function composeDelegators(deps: ComposeDelegatorsDeps): ComposedDelegation {
  const { config, runtime, store, events, scheduler, agents, mcpToolNames, delegationToolNames, childWorkspaceRoots, sandboxPolicy } = deps;
  let delegator: Delegator | undefined;
  let parallelDelegator: ParallelDelegator | undefined;
  let subagent: AgentDefinition | undefined;
  if (scheduler !== undefined) {
    subagent = subagentDefinition(config);
    agents.push(subagent);
    // P14-4: the parent's conferred capability = the main agent's sandbox
    // policy + its full tool allow-list. Every delegation that declares a
    // non-tool capability must NARROW this bound (EffectiveCapability =
    // Conferred ∩ Declared); widening is a typed denial before any child
    // session exists.
    const parentGrant = {
      policy: sandboxPolicy,
      toolAllowlist: [...PRODUCTION_TOOL_NAMES, ...mcpToolNames, ...delegationToolNames],
    };
    delegator = new Delegator({
      runtime,
      store,
      agentId: subagent.id,
      limits: delegationLimits(config.delegation),
      events,
      scheduler,
      // P3-4: write-capable children run in isolated workspaces; read-only
      // children share the parent root. Enables P3-5 patch-based merging.
      workspaceManager: new DefaultChildWorkspaceManager(),
      parentCapability: parentGrant,
      // P3-6: admit/revoke the isolated root in the child's sandbox.
      onChildWorkspace: (childSessionId, root) => {
        childWorkspaceRoots.set(childSessionId, root);
      },
      onChildWorkspaceDisposed: (childSessionId) => {
        childWorkspaceRoots.delete(childSessionId);
      },
    });
    parallelDelegator = new ParallelDelegator({
      runtime,
      store,
      agentId: subagent.id,
      limits: delegationLimits(config.delegation),
      events,
      scheduler,
      workspaceManager: new DefaultChildWorkspaceManager(),
      onChildWorkspace: (childSessionId, root) => {
        childWorkspaceRoots.set(childSessionId, root);
      },
      onChildWorkspaceDisposed: (childSessionId) => {
        childWorkspaceRoots.delete(childSessionId);
      },
    });
  }
  return { delegator, parallelDelegator, subagent };
}
