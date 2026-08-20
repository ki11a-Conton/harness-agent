import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  newAgentId,
  newEventId,
  type AgentDefinition,
  type ApprovalStore,
  type ArtifactStore,
  type AskUserStore,
  type CheckpointStore,
  type ContextBudget,
  type EventStore,
  type InboxStore,
  type MemoryScope,
  type MemoryStore,
  type MemoryType,
  type SessionStore,
} from "@ar/contracts";
import { AgentRuntime, InMemoryArtifactStore, type SkillDiscovery, type SkillSecurityDenialRecord } from "@ar/core";
import { DurableCheckpointStore } from "@ar/checkpoint";
import { ContextPipeline } from "@ar/context";
import { JsonlMemoryStore, retrieveMemories, SqliteMemoryStore, type RetrieveResult } from "@ar/memory";
import { budgetForCapabilities, resolveCapabilities } from "@ar/model";
import {
  detectPromptInjection,
  DurableApprovalStore,
  InMemoryApprovalStore,
  StoreApprovalResolver,
  redactSecrets,
} from "@ar/security";
import {
  JSONLAskUserStore,
  JSONLInboxStore,
  JSONLSessionStore,
  MemInboxStore,
  SessionService,
} from "@ar/session";
import { JSONLEventStore } from "@ar/events";
import { FileSkillLoader } from "@ar/skills";
import {
  capabilityOf,
  createProductionTools,
  semanticsOf,
  ToolOrchestrator,
  ToolRegistry,
} from "@ar/tools";
import { AgentExecutionScheduler, Delegator } from "@ar/agents";
import { MemEventStore, MemSessionStore } from "./mem-stores.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type HarnessConfig,
  type HarnessFeatureFlags,
  type HarnessProfile,
} from "./config.js";
import type { HarnessIntrospection } from "./introspection.js";
import { Lifecycle, MemoryStoreCloser } from "./lifecycle.js";
import { resolveFeatureFlags, resolveProfile } from "./profiles.js";

/** Tool profile shared by every production harness (plan.md P0-5 single
 *  source: packages/tools/src/production-tools.ts). ask_user is a core
 *  runtime phase — ASK_GATE_TOOL — and must NOT be registered as a
 *  ToolDefinition. */
export const PRODUCTION_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "grep_search",
  "repo_tree",
  "symbol_search",
  "repo_map",
  "discover_commands",
  "env_snapshot",
  "exec",
  "update_plan",
] as const;

export const READONLY_TOOL_NAMES = [
  "read_file",
  "search_files",
  "grep_search",
  "repo_tree",
  "symbol_search",
  "repo_map",
  "discover_commands",
  "env_snapshot",
] as const;

/** Minimal memory bridge for P0-3: store creation + retrieval. The full
 *  pre-turn injection bridge (context blocks from memory) is P2-1. */
export interface MemoryBridge {
  store: MemoryStore;
  retrieve(query: string, scope: MemoryScope, opts?: { k?: number; type?: MemoryType }): Promise<RetrieveResult>;
}

export interface Harness {
  runtime: AgentRuntime;
  store: SessionStore;
  events: EventStore;
  registry: ToolRegistry;
  sessionService: SessionService;
  agents: AgentDefinition[];

  memory?: MemoryBridge;
  scheduler?: AgentExecutionScheduler;
  delegator?: Delegator;

  approvalStore: ApprovalStore;
  inbox: InboxStore;
  askUserStore?: AskUserStore;
  checkpointStore?: CheckpointStore;
  artifactStore?: ArtifactStore;

  context: {
    pipeline: ContextPipeline;
    budget: ContextBudget;
    /** True when the model's context window was unknown and the conservative
     *  fallback budget was used (audit/doctor should surface a warning). */
    budgetFallback: boolean;
  };

  profile: HarnessProfile;
  config: HarnessConfig;

  introspect(): HarnessIntrospection;
  close(): Promise<void>;
}

export const DEFAULT_MAIN_SYSTEM_PROMPT = [
  "You are the harness agent running inside a workspace.",
  "",
  "Capabilities:",
  "- read_file / search_files / grep_search / repo_tree / symbol_search / repo_map / discover_commands / env_snapshot: inspect the workspace (allowed automatically)",
  "- write_file / edit_file: modify workspace files (require approval)",
  "- exec: run commands in the workspace shell (requires approval)",
  "",
  "State-changing actions ask for approval and are denied until approved.",
  "When a tool result reports [denied], do not retry it blindly — report the outcome.",
].join("\n");

export async function createHarness(config: HarnessConfig): Promise<Harness> {
  const cwd = config.cwd;
  const dataDir = config.dataDir;
  if (dataDir !== undefined) await mkdir(dataDir, { recursive: true });

  const preset = resolveProfile(config.profile);
  const features: HarnessFeatureFlags = resolveFeatureFlags(config.profile, config.featureFlags);

  // --- stores ---------------------------------------------------------------
  const store: SessionStore = dataDir !== undefined ? new JSONLSessionStore({ dataDir }) : new MemSessionStore();
  const events: EventStore = dataDir !== undefined ? new JSONLEventStore({ dataDir }) : new MemEventStore();
  const approvalStore: ApprovalStore =
    dataDir !== undefined ? new DurableApprovalStore(join(dataDir, "approval-store.json")) : new InMemoryApprovalStore();
  const inbox: InboxStore = dataDir !== undefined ? new JSONLInboxStore({ dataDir }) : new MemInboxStore();
  // P1-5: durable ask-user store under a dataDir (crash-safe pending questions).
  const askUserStore: AskUserStore | undefined =
    dataDir !== undefined ? new JSONLAskUserStore({ dataDir }) : undefined;
  const checkpointStore: CheckpointStore | undefined =
    dataDir !== undefined && features.checkpoint ? new DurableCheckpointStore({ dataDir }) : undefined;
  const artifactStore: ArtifactStore | undefined = features.artifacts ? new InMemoryArtifactStore() : undefined;

  // --- tools ----------------------------------------------------------------
  const registry = new ToolRegistry();
  const productionTools = createProductionTools({
    networkMode: () => "deny",
    availableTools: () => registry.names(),
    workspaceRoot: () => cwd,
    harnessProfile: () => config.profile,
  });
  for (const tool of productionTools) registry.register(tool);

  // --- orchestrator (permission → approval → sandbox, plan §24) -------------
  const orchestrator = new ToolOrchestrator({
    registry,
    approval: new StoreApprovalResolver(approvalStore),
    workspaceRoot: cwd,
    events: {
      async emit(sessionId, type, payload, turnId) {
        await events.append({
          id: newEventId(),
          sessionId,
          ...(turnId !== undefined ? { turnId } : {}),
          sequence: 0, // JSONL and Mem stores assign the real sequence
          timestamp: Date.now(),
          type,
          payload,
        });
      },
    },
  });

  // --- context pipeline + budget --------------------------------------------
  const pipeline = new ContextPipeline();
  const { budget, budgetFallback } = await resolveContextBudget(config);

  // --- skills ---------------------------------------------------------------
  let pendingSkillSecurity: SkillSecurityDenialRecord[] = [];
  const skillLoader = new FileSkillLoader({
    onSecurityDenied: (event) => {
      pendingSkillSecurity.push({
        detection: event.detection,
        reasons: event.reasons,
        path: event.path,
        source: event.source,
      });
      process.stderr.write(
        `[skill denied] detection=${event.detection} target=${event.path} reasons=${event.reasons.join(",")}\n`,
      );
    },
  });
  const skillRoots = (process.env.AR_SKILL_ROOTS ?? "")
    .split(";")
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  const discoverSkills: () => Promise<SkillDiscovery> = async () => {
    pendingSkillSecurity = [];
    const found = await skillLoader.discover({ roots: skillRoots, maxSkills: 100 });
    const security = pendingSkillSecurity;
    return { skills: found, security };
  };

  // --- agents (main; subagent added below once runtime exists) ---------------
  const agents: AgentDefinition[] = [mainAgent(config)];
  // delegation/memory features are enabled either by the profile/flag default
  // or explicitly by their config section — config intent wins.
  const delegationEnabled = features.delegation || config.delegation?.enabled === true;
  const memoryEnabled = features.memory || config.memory?.enabled === true;
  const scheduler =
    delegationEnabled
      ? new AgentExecutionScheduler({ store, limits: schedulerLimits(config.delegation) })
      : undefined;

  // --- memory ---------------------------------------------------------------
  let memoryBridge: MemoryBridge | undefined;
  if (memoryEnabled) {
    const memoryDataDir = config.memory?.dbPath ?? dataDir;
    if (memoryDataDir === undefined) {
      throw new Error("memory is enabled but no dataDir (or memory.dbPath) is configured — refusing to write memories into the workspace");
    }
    const memoryStore: MemoryStore =
      config.memory?.dbPath !== undefined
        ? new SqliteMemoryStore({ dataDir: config.memory.dbPath })
        : new JsonlMemoryStore({ dataDir: memoryDataDir });
    memoryBridge = {
      store: memoryStore,
      retrieve(query, scope, opts) {
        return retrieveMemories(memoryStore, query, scope, { k: opts?.k ?? config.memory?.topK, type: opts?.type });
      },
    };
  }

  // --- runtime --------------------------------------------------------------
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: config.modelProvider,
    orchestrator,
    agents,
    sandboxPolicy: preset.sandbox,
    context: {
      pipeline,
      budget,
      instructionOpts: { maxBytesPerFile: 50_000, maxDocuments: 4 },
    },
    ...(checkpointStore !== undefined ? { checkpointStore } : {}),
    ...(artifactStore !== undefined ? { artifactStore } : {}),
    ...(dataDir !== undefined ? { toolOutputBudget: { maxInlineBytes: 64 * 1024, artifactDir: dataDir } } : {}),
    inbox,
    ...(askUserStore !== undefined ? { askUserStore } : {}),
    skills: features.skills ? discoverSkills : undefined,
    toolSpecs: registry.specs(),
    toolCapabilityOf: (name) => capabilityOf(registry.get(name)),
    toolSemanticsOf: (name) => semanticsOf(registry.get(name)),
    injectionDetector: (content) => detectPromptInjection(content),
    outputRedactor: (content) => redactSecrets(content),
  });

  // --- delegation: scheduler is created before the runtime (no runtime dep),
  // the delegator AFTER it (binds runtime). No delegate* tool is registered —
  // a model-callable delegation tool is P3, reported honestly by the audit.
  let delegator: Delegator | undefined;
  if (delegationEnabled && scheduler !== undefined) {
    const subagent = subagentDefinition(config);
    agents.push(subagent);
    delegator = new Delegator({
      runtime,
      store,
      agentId: subagent.id,
      limits: delegationLimits(config.delegation),
      events,
      scheduler,
    });
  }

  const sessionService = new SessionService({ store });

  const lifecycle = new Lifecycle();
  if (memoryBridge !== undefined) lifecycle.add(new MemoryStoreCloser(memoryBridge.store));

  const harness: Harness = {
    runtime,
    store,
    events,
    registry,
    sessionService,
    agents,
    ...(memoryBridge !== undefined ? { memory: memoryBridge } : {}),
    ...(scheduler !== undefined ? { scheduler } : {}),
    ...(delegator !== undefined ? { delegator } : {}),
    approvalStore,
    inbox,
    ...(askUserStore !== undefined ? { askUserStore } : {}),
    ...(checkpointStore !== undefined ? { checkpointStore } : {}),
    ...(artifactStore !== undefined ? { artifactStore } : {}),
    context: { pipeline, budget, budgetFallback },
    profile: config.profile,
    config,
    introspect: () =>
      introspectHarness({
        profile: config.profile,
        registry,
        store,
        events,
        approvalStore,
        checkpointStore,
        artifactStore,
        memoryStore: memoryBridge?.store,
        features,
        delegator,
        scheduler,
      }),
    close: () => lifecycle.close(),
  };
  return harness;
}

function mainAgent(config: HarnessConfig): AgentDefinition {
  return {
    id: newAgentId(),
    name: "main",
    description: "default harness agent",
    mode: "primary",
    model: config.model,
    systemPrompt: DEFAULT_MAIN_SYSTEM_PROMPT,
    tools: { allow: [...PRODUCTION_TOOL_NAMES] },
    permissions: resolveProfile(config.profile).permissions,
    skills: {},
    limits: { maxToolCalls: 50, ...config.limits },
  };
}

function subagentDefinition(config: HarnessConfig): AgentDefinition {
  return {
    id: newAgentId(),
    name: "worker",
    description: "delegated subagent (read-only workspace exploration)",
    mode: "subagent",
    model: config.model,
    systemPrompt: "You are a subagent working inside a delegated session. Complete the goal and report findings.",
    tools: { allow: [...READONLY_TOOL_NAMES] },
    permissions: {
      rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "deny" },
        { action: "exec", resource: "command", effect: "deny" },
        { action: "exec", resource: "network", effect: "deny" },
      ],
    },
    skills: {},
    limits: { maxToolCalls: 30 },
  };
}

function schedulerLimits(delegation: NonNullable<HarnessConfig["delegation"]> | undefined): {
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

function delegationLimits(delegation: NonNullable<HarnessConfig["delegation"]> | undefined): {
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

/**
 * Context budget from the model's known capabilities; conservative fallback
 * when unknown (plan.md P0-4: never hardcode 32000 when capability known).
 * The fallback decision is surfaced for doctor/audit.
 */
export async function resolveContextBudget(config: HarnessConfig): Promise<{
  budget: ContextBudget;
  budgetFallback: boolean;
}> {
  if (config.contextBudget !== undefined) return { budget: config.contextBudget, budgetFallback: false };
  let info;
  try {
    const infos = await config.modelProvider.listModels();
    info = infos.find((m) => m.id === config.model.modelId);
  } catch {
    info = undefined; // provider listModels failure → conservative fallback
  }
  const caps = resolveCapabilities(config.model, info, undefined);
  const windowTokens = budgetForCapabilities(caps);
  if (windowTokens === undefined) {
    process.stderr.write(
      `[harness] context budget: model capabilities unknown for ${config.model.providerId}/${config.model.modelId} — using conservative fallback ${DEFAULT_CONTEXT_BUDGET.maxTokens}\n`,
    );
    return { budget: DEFAULT_CONTEXT_BUDGET, budgetFallback: true };
  }
  return {
    budget: {
      maxTokens: windowTokens,
      reserved: { system: 1_500, task: 2_000, output: 2_000 },
      dynamic: 0,
    },
    budgetFallback: false,
  };
}

interface IntrospectionInput {
  profile: string;
  registry: ToolRegistry;
  store: SessionStore;
  events: EventStore;
  approvalStore: ApprovalStore;
  checkpointStore?: CheckpointStore;
  artifactStore?: ArtifactStore;
  memoryStore?: MemoryStore;
  features: HarnessFeatureFlags;
  delegator?: Delegator;
  scheduler?: AgentExecutionScheduler;
}

/** Honest wiring facts: store implementations by constructor name, registered
 *  tool names, and feature flags — exactly what P0-1's audit consumes. */
export function introspectHarness(input: IntrospectionInput): HarnessIntrospection {
  return {
    profile: input.profile,
    registeredTools: input.registry.names(),
    stores: {
      session: input.store.constructor.name,
      events: input.events.constructor.name,
      ...(input.checkpointStore !== undefined ? { checkpoint: input.checkpointStore.constructor.name } : {}),
      ...(input.memoryStore !== undefined ? { memory: input.memoryStore.constructor.name } : {}),
      approval: input.approvalStore.constructor.name,
      ...(input.artifactStore !== undefined ? { artifacts: input.artifactStore.constructor.name } : {}),
    },
    features: {
      context: input.features.context,
      verifier: false,
      checkpoint: input.checkpointStore !== undefined,
      artifacts: input.artifactStore !== undefined,
      memory: input.memoryStore !== undefined,
      learning: input.features.learning,
      delegation: input.delegator !== undefined,
      scheduler: input.scheduler !== undefined,
      mcp: input.features.mcp,
      plugins: input.features.plugins,
      skills: input.features.skills,
      usageAccounting: false,
      runBudget: false,
    },
  };
}