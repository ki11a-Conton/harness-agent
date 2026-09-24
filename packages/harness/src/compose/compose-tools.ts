/**
 * P22-1 — composition helper: TOOLS.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * Owns the tool registry, production tool registration, and the model-callable
 * delegation tools (P0-3 DeferredDelegationService: registered before the
 * runtime, resolved lazily at execute time).
 */
import type { AgentDefinition, ToolDefinition } from "@ar/contracts";
import {
  createProductionTools,
  createToolLookupTool,
  decideSchemaAdvert,
  ToolRegistry,
} from "@ar/tools";
import { Delegator, ParallelDelegator } from "@ar/agents";
import { READONLY_TOOL_NAMES } from "../tool-names.js";
import { workerAgentDefinition } from "../worker-agent.js";
import { createDelegationTools } from "../delegation-tools.js";
import { DefaultChildWorkspaceManager } from "../workspace-manager.js";
import type { HarnessConfig, HarnessFeatureFlags } from "../config.js";

/** Mutable refs the composition root binds AFTER the runtime exists
 *  (delegator construction depends on the runtime). */
export interface DelegatorRefs {
  delegator: { value: Delegator | undefined };
  parallelDelegator: { value: ParallelDelegator | undefined };
}

export interface ComposedTools {
  registry: ToolRegistry;
  delegationEnabled: boolean;
  memoryEnabled: boolean;
  productionTools: ToolDefinition[];
  delegationToolNames: string[];
  workerAgent: AgentDefinition | undefined;
  /** P3-1 deferred delegation binding refs (set after the runtime). */
  refs: DelegatorRefs;
}

/** P22-1 — compose the tool registry + production/delegation tools. */
export function composeTools(
  config: HarnessConfig,
  features: HarnessFeatureFlags,
  cwd: string,
): ComposedTools {
  const registry = new ToolRegistry();
  // delegation/memory features are enabled either by the profile/flag default
  // or explicitly by their config section — config intent wins.
  const delegationEnabled = features.delegation || config.delegation?.enabled === true;
  const memoryEnabled = features.memory || config.memory?.enabled === true;
  const productionTools = createProductionTools({
    networkMode: () => "deny",
    availableTools: () => registry.names(),
    workspaceRoot: () => cwd,
    harnessProfile: () => config.profile,
  });
  for (const tool of productionTools) registry.register(tool);

  // P3-1/P3-7: model-callable delegation tools are registered BEFORE the
  // runtime (their specs must be part of the advertised tool set), but the
  // delegator is only constructed after the runtime — the tools resolve it
  // lazily at execute time (P0-3 DeferredDelegationService pattern).
  const refs: DelegatorRefs = {
    delegator: { value: undefined },
    parallelDelegator: { value: undefined },
  };
  let workerAgent: AgentDefinition | undefined;
  const delegationToolNames: string[] = [];
  if (delegationEnabled) {
    workerAgent = workerAgentDefinition(config);
    for (const tool of createDelegationTools({
      delegator: () => {
        if (refs.delegator.value === undefined) {
          throw new Error("delegation is enabled but the delegator is not wired");
        }
        return refs.delegator.value;
      },
      parallelDelegator: () => {
        if (refs.parallelDelegator.value === undefined) {
          throw new Error("delegation is enabled but the parallel delegator is not wired");
        }
        return refs.parallelDelegator.value;
      },
      readonlyToolNames: READONLY_TOOL_NAMES,
      // P3-6: delegate_worker is exposed only with the isolation gate closed
      // (isolated workspace + sandbox extra roots wired above).
      workerAgentId: () => workerAgent!.id,
      workspaceManager: () => new DefaultChildWorkspaceManager(),
    })) {
      delegationToolNames.push(tool.name);
      registry.register(tool);
    }
  }

  return {
    registry,
    delegationEnabled,
    memoryEnabled,
    productionTools,
    delegationToolNames,
    workerAgent,
    refs,
  };
}

/** P22-1 — register the deferred-schema tool_lookup and re-decide the advert.
 *  Extracted so schema advertisement stays next to the registry it reads. */
export function registerToolLookup(
  registry: ToolRegistry,
  builtinToolNames: Set<string>,
): { schemaAdvert: ReturnType<typeof decideSchemaAdvert>; toolLookupName: string | undefined } {
  const initial = decideSchemaAdvert(registry.specs(), {
    keepFull: (name) => builtinToolNames.has(name),
  });
  const toolLookupName: string | undefined = initial.mode === "deferred" ? "tool_lookup" : undefined;
  if (toolLookupName !== undefined) {
    registry.register(createToolLookupTool(registry));
    builtinToolNames.add(toolLookupName);
  }
  return {
    schemaAdvert: decideSchemaAdvert(registry.specs(), {
      keepFull: (name) => builtinToolNames.has(name),
    }),
    toolLookupName,
  };
}
