import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { composeStores } from "./compose/compose-stores.js";
import { composeTools, registerToolLookup } from "./compose/compose-tools.js";
import { composeMcp } from "./compose/compose-mcp.js";
import { composeContext } from "./compose/compose-context.js";
import { composeVerification } from "./compose/compose-verification.js";
import { composeScheduler, composeDelegators } from "./compose/compose-delegation.js";
import { introspectHarness, type IntrospectionInput } from "./compose/compose-observability.js";
import { PRODUCTION_TOOL_NAMES } from "./tool-names.js";
import {
  AgentError,
  errorInfo,
  fileConflictKey,
  newAgentId,
  newEventId,
  type AgentDefinition,
  type ApprovalStore,
  type ArtifactStore,
  type AskUserStore,
  type CheckpointStore,
  type ContextBlock,
  type ContextBudget,
  type EventStore,
  type InboxStore,
  type MemoryScope,
  type MemoryId,
  type MemoryStore,
  type MemoryType,
  type SessionId,
  type SessionStore,
  type TurnId,
} from "@ar/contracts";
import {
  AgentRuntime,
  DefaultLoadedSessionManager,
  InMemoryArtifactStore,
  type LoadedSessionManager,
  type SkillDiscovery,
  type SkillSecurityDenialRecord,
} from "@ar/core";
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
import type { GrantedCapability } from "@ar/security";
import {
  JSONLAskUserStore,
  JSONLInboxStore,
  JSONLSessionStore,
  MemInboxStore,
  SessionService,
} from "@ar/session";
import { JSONLEventStore } from "@ar/events";
import { SqliteRuntimeStore } from "@ar/store";
import { FileSkillLoader } from "@ar/skills";
import {
  createProductionTools,
  createToolLookupTool,
  decideSchemaAdvert,
  semanticsOf,
  ToolOrchestrator,
  ToolRegistry,
} from "@ar/tools";
import { AgentExecutionScheduler, Delegator, ParallelDelegator } from "@ar/agents";
import { connectMcpServer, type McpServerConnection } from "@ar/mcp";
import { TaskVerifier } from "@ar/tools";
import { MemEventStore, MemSessionStore } from "./mem-stores.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type HarnessConfig,
  type HarnessFeatureFlags,
  type HarnessProfile,
} from "./config.js";
import type { AgentEvent } from "@ar/contracts";
import { eventSinkFromStore } from "@ar/contracts";
import type { HarnessIntrospection } from "./introspection.js";
import { Lifecycle, MemoryStoreCloser } from "./lifecycle.js";
import { CommandDiscoveryService } from "./command-discovery-service.js";
import { resolveFeatureFlags, resolveProfile } from "./profiles.js";
import {
  MemoryRuntimeBridge,
  memoryIdsOfBlocks,
  type RetrievedMemoryContext,
} from "./memory-runtime-bridge.js";
import { resolveRepositoryIdentity, memoryScopeFor } from "./scope-resolver.js";
import { PostTurnReflector, type ReflectionRunResult } from "./reflection-runner.js";
import { JsonlCandidateStore, type LearningCandidateStore } from "./candidate-store.js";
import {
  createSkillBodyBlockProvider,
  type SkillBodyBlockProvider,
} from "./skill-context.js";
import { createDelegationTools } from "./delegation-tools.js";
import type { LearningCandidate } from "@ar/learning";
import { DefaultChildWorkspaceManager } from "./workspace-manager.js";
import { createVerificationPlanner } from "./verification-planner.js";
import { resolveHarnessConfig, type ResolvedConfig } from "./config-resolver.js";
import {
  evaluateConfigDrift,
  normalizeForComparison,
  type DriftDecision,
} from "./config-drift.js";
import { explainConfig, type ConfigExplainResult } from "./config-explainer.js";

/** Tool profile shared by every production harness — defined in tool-names.ts
 *  (P22-1). Re-exported for backward compatibility. */
export { PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES } from "./tool-names.js";

export interface Harness {
  runtime: AgentRuntime;
  store: SessionStore;
  events: EventStore;
  registry: ToolRegistry;
  sessionService: SessionService;
  agents: AgentDefinition[];

  /** P25-2: live session actors — the SINGLE owner of active turn state. The
   *  RPC/gateway path routes session.run/cancel/steer/followup through it
   *  (replaces the RPC-local Map<sessionId:turnId, ActiveRun>). */
  sessions: LoadedSessionManager;

  scheduler?: AgentExecutionScheduler;
  delegator?: Delegator;
  /** P2-1: full pre-turn memory bridge (retrieve → context blocks → feedback). */
  memoryBridge?: MemoryRuntimeBridge;
  /** P22-2: the real memory store (replaces the removed P0-3 harness.memory
   *  legacy bridge). Exposed so hosts/tests can seed and inspect memories. */
  memoryStore?: MemoryStore;
  /** P2-6: durable learning-candidate queue (reflection output, pre-promotion). */
  candidates?: LearningCandidateStore;
  /** P2-5: post-turn reflection runner (journal + candidate queue). */
  reflector?: PostTurnReflector;
  /** P2-8: skill body provider (progressive disclosure + effectiveness). */
  skillBodies?: SkillBodyBlockProvider;
  /** P0-3: real MCP transports connected at harness creation. */
  /** P24-1: MCP runtime V2 — `lazy: true` means NO server connects at
   *  startup; connections happen per step via dependency resolution.
   *  `failures` records observed mcp.connect_failed events (serverId+error). */
  mcp?: { servers: number; tools: string[]; lazy?: boolean; failures: Array<{ serverId: string; error: unknown }> };

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

  /**
   * P27-2/4: the resolved config stack (layers + per-key origins +
   * fingerprint) the harness was created with. Drift detection (P27-4)
   * freezes the fingerprint per session and compares it on resume — the step
   * snapshot is never silently mutated.
   */
  resolvedConfig: import("./config-resolver.js").ResolvedConfig<HarnessConfig>;

  /** P27-4: freeze the current effective config fingerprint for a session
   *  (stored via the existing durable state snapshot). */
  freezeConfigFingerprint(sessionId: SessionId): Promise<void>;

  /** P27-4: compare a session's frozen config against the current effective
   *  config; returns a lifecycle-aware drift decision (fail-closed: a changed
   *  session_frozen key with unknown direction → reject). */
  checkSessionConfigDrift(sessionId: SessionId): Promise<import("./config-drift.js").DriftDecision>;

  /** P27-2/5: explain config origins (redacted, no secrets). `key` = dotted
   *  path (e.g. "sandboxPolicy.network"); omitted → whole config. */
  configExplain(key?: string): import("./config-explainer.js").ConfigExplainResult;

  introspect(): HarnessIntrospection;
  close(): Promise<void>;
}

// P27-4: durable session snapshot keys for the frozen config fingerprint.
const CONFIG_FP_KEY = "p27.configFingerprint";
const CONFIG_VALUE_KEY = "p27.configValue";

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

  // P27-2: resolve the effective config stack (defaults → profile →
  // runtime overrides) with per-key origins + fingerprint. The caller's
  // `config` is the highest-precedence runtime layer — the resolved value
  // is exactly what this harness uses (drift detection freezes it per
  // session, P27-4).
  const resolvedConfig = resolveHarnessConfig({ profile: config.profile, overrides: config });

  const preset = resolveProfile(config.profile);
  const features: HarnessFeatureFlags = resolveFeatureFlags(config.profile, config.featureFlags);

  // --- stores (P22-1: compose/compose-stores) --------------------------------
  const stores = composeStores(config, features);
  const sqliteStore = stores.sqliteStore;
  const store = stores.store;
  const events = stores.events;
  const approvalStore = stores.approvalStore;
  const inbox = stores.inbox;
  const askUserStore = stores.askUserStore;
  const checkpointStore = stores.checkpointStore;
  const artifactStore = stores.artifactStore;
  const now = stores.now;
  const appendHarnessEvent = stores.appendHarnessEvent;
  // --- tools (P22-1: compose/compose-tools) ----------------------------------
  const composedTools = composeTools(config, features, cwd);
  const registry = composedTools.registry;
  const delegationEnabled = composedTools.delegationEnabled;
  const memoryEnabled = composedTools.memoryEnabled;
  const productionTools = composedTools.productionTools;
  const delegationToolNames = composedTools.delegationToolNames;
  const workerAgent = composedTools.workerAgent;
  // P3-1 deferred delegation binding refs (set after the runtime exists).
  const boundDelegator = composedTools.refs.delegator;
  const boundParallelDelegator = composedTools.refs.parallelDelegator;
  // --- MCP runtime V2 (P24-1/5: catalog ≠ connection ≠ binding) -------------
  // composeMcp no longer connects anything at startup — a server connects
  // lazily when a step's dependency resolution actually needs it. The
  // binding provider feeds the step snapshot factory per model call.
  const mcp = composeMcp(config, (e) => {
    void appendHarnessEvent("", "mcp.connect_failed", { serverId: e.serverId, error: String(e.error) });
  });
  // P24-1: ONLY explicitly-eager servers connect at startup (opt-in).
  await mcp.connectEager();
  const mcpToolNames: string[] = []; // dynamic per-step (P24-5)
  // --- orchestrator (permission → approval → sandbox, plan §24) -------------
  // P3-6: per-session sandbox roots — a write-capable child's isolated
  // workspace is admitted into its own sandbox while it runs and removed on
  // disposal, so the child can write its workspace and nothing outside it.
  const childWorkspaceRoots = new Map<SessionId, string>();
  const orchestrator = new ToolOrchestrator({
    registry,
    approval: new StoreApprovalResolver(approvalStore),
    workspaceRoot: cwd,
    sandboxExtraRoots: (sessionId) => {
      const root = childWorkspaceRoots.get(sessionId);
      return root !== undefined ? [root] : [];
    },
    events: {
      async emit(sessionId, type, payload, turnId) {
        await appendHarnessEvent(sessionId, type as AgentEvent["type"], payload ?? {}, {
          ...(turnId !== undefined ? { turnId } : {}),
        });
      },
    },
    // P16-1: durable tool intent BEFORE the side effect — the event store is
    // the durable record; append is awaited (a failure FAILS CLOSED, so the
    // side effect never runs). The clock is the injected host clock.
    persistIntent: async (intent) => {
      await appendHarnessEvent(
        intent.sessionId,
        "tool.intent_persisted",
        { ...intent },
        { ...(intent.turnId !== undefined ? { turnId: intent.turnId } : {}), timestamp: intent.startedAt },
      );
    },
  });

  // --- context pipeline + budget (P22-1: compose/compose-context) ------------
  const context = await composeContext(config, features, cwd, dataDir, appendHarnessEvent);
  const pipeline = context.pipeline;
  const { budget, budgetFallback } = context;
  // --- skills (P22-1: compose/compose-context) --------------------------------
  const pendingSkillSecurity = context.pendingSkillSecurity;
  const skillLoader = context.skillLoader;
  const discoverSkills = context.discoverSkills;
  const commandDiscovery = context.commandDiscovery;
  // --- agents (main; subagent added below once runtime exists) ---------------
  // P18-2: deferred schema advertisement. The built-in set always advertises
  // in full; when MCP/plugin servers push the schema token budget past the
  // threshold, the bulk is stubbed (name + description) and `tool_lookup`
  // provides the full schema on demand.
  const builtinToolNames = new Set<string>([
    ...productionTools.map((t) => t.name),
    ...delegationToolNames,
  ]);
  let schemaAdvert = decideSchemaAdvert(registry.specs(), {
    keepFull: (name) => builtinToolNames.has(name),
  });
  const toolLookupName: string | undefined = schemaAdvert.mode === "deferred" ? "tool_lookup" : undefined;
  if (toolLookupName !== undefined) {
    registry.register(createToolLookupTool(registry));
    builtinToolNames.add(toolLookupName);
    // Re-decide so tool_lookup's own schema is advertised in full and the
    // advertised set is exactly what the model sees.
    schemaAdvert = decideSchemaAdvert(registry.specs(), {
      keepFull: (name) => builtinToolNames.has(name),
    });
  }
  const agents: AgentDefinition[] = [
    mainAgent(config, mcpToolNames, delegationToolNames, toolLookupName),
    ...(workerAgent !== undefined ? [workerAgent] : []),
  ];
  const scheduler = composeScheduler(config, delegationEnabled, store);


  // --- memory (P2-1 bridge + P2-3 scope resolution) --------------------------
  let memoryStore: MemoryStore | undefined;
  let memoryBridge: MemoryRuntimeBridge | undefined;
  // P2-4: which memories were injected per session this process saw — the
  // outcome feedback target at turn end.
  const memoryInjectedBySession = new Map<SessionId, MemoryId[]>();
  if (memoryEnabled) {
    const memoryDataDir = config.memory?.dbPath ?? dataDir;
    if (memoryDataDir === undefined) {
      throw new Error("memory is enabled but no dataDir (or memory.dbPath) is configured — refusing to write memories into the workspace");
    }
    memoryStore =
      config.memory?.dbPath !== undefined
        ? new SqliteMemoryStore({ dataDir: config.memory.dbPath })
        : new JsonlMemoryStore({ dataDir: memoryDataDir });
    // P2-3: the memory scope is derived from the repository identity (git →
    // repository-scoped, else workspace-scoped), never a bare cwd string.
    const identity = await resolveRepositoryIdentity(cwd);
    const scope = memoryScopeFor(identity, config.memory?.scope);
    memoryBridge = new MemoryRuntimeBridge({
      store: memoryStore,
      scope,
      topK: config.memory?.topK,
    });
  }

  // --- learning pipeline (P2-5/P2-6): post-turn reflection → candidate queue.
  // The queue is durable when a dataDir exists; promotion is never automatic
  // (P2-7 — explicit `agent learn` commands consume it).
  const candidateStore: LearningCandidateStore | undefined =
    dataDir !== undefined && (features.learning || memoryEnabled)
      ? new JsonlCandidateStore({ dataDir })
      : undefined;
  const reflector: PostTurnReflector | undefined =
    candidateStore !== undefined && dataDir !== undefined
      ? new PostTurnReflector({ events, candidateStore, dataDir })
      : undefined;

  // --- skill bodies (P2-8) + effectiveness ledger (P2-9) --------------------
  let skillBodyProvider: SkillBodyBlockProvider | undefined;
  const skillUseBySession = new Map<SessionId, string[]>();
  if (features.skills && dataDir !== undefined) {
    // P14-4: the skill boundary receives the same conferred tool capability
    // as the main agent — a skill declaring requiredTools outside it is
    // denied at load (typed denial recorded + surfaced, never injected).
    const skillToolPolicy: import("@ar/contracts").ToolPolicy = {
      allow: [...PRODUCTION_TOOL_NAMES, ...mcpToolNames, ...delegationToolNames],
    };
    skillBodyProvider = createSkillBodyBlockProvider({
      loader: skillLoader,
      discover: async () => (await discoverSkills()).skills,
      dataDir,
      toolPolicy: skillToolPolicy,
      // P32-2: cache identity includes the resolved config fingerprint + cwd
      // so a same-cwd harness with different enabled/disabled skill config
      // never reuses another harness's discovery/body cache (no cross-session
      // skill leakage). Two harnesses with identical config share the cache.
      cacheKey: `skill:${resolvedConfig.fingerprint}:${cwd}`,
      onRequiredToolsDenied: (event) => {
        pendingSkillSecurity.value.push({
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
  }

  // --- verification plan auto-orchestration (P8-1; P22-1:
  // compose/compose-verification) -------------------------------------------
  const { verificationPlanner, verifier } = composeVerification(
    config,
    commandDiscovery,
    appendHarnessEvent,
  );
  // --- runtime --------------------------------------------------------------
  const runtime = new AgentRuntime({
    store,
    events,
    // P26-3: the harness event store IS the durability fence — the runtime
    // flushes the journal before acking turn completion. Honest level comes
    // from the store (JSONL crash_safe / SQLite process / memory fake).
    durabilityFence: events as EventStore & import("@ar/contracts").DurabilityFenceStore,
    modelProvider: config.modelProvider,
    orchestrator,
    agents,
    // P16-5: the runtime shares the harness's injected clock so event
    // timestamps are deterministic under test (never a bare Date.now()).
    ...(config.now !== undefined ? { now: config.now } : {}),
    // P23-1: the process catalog is read ONCE per step to freeze the step's
    // tool world; the runtime never consults it mid-step.
    toolRegistry: registry,
    // P24-5: per-step MCP binding — the runtime asks for the servers THIS
    // step needs and freezes their tools into the step router.
    mcpBindingProvider: (input) => mcp.bindingProvider(input),
    sandboxPolicy: config.sandboxPolicy ?? preset.sandbox,
    context: {
      pipeline,
      budget,
      instructionOpts: { maxBytesPerFile: 50_000, maxDocuments: 4 },
    },
    // P8-1: task verification gate — explicit specs win, else the
    // auto-orchestrated plan built from the change set + discovered commands.
    ...(config.task !== undefined ? { task: config.task } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
    ...(config.task !== undefined ? { verificationPlanner } : {}),
    ...(checkpointStore !== undefined ? { checkpointStore } : {}),
    ...(artifactStore !== undefined ? { artifactStore } : {}),
    ...(dataDir !== undefined ? { toolOutputBudget: { maxInlineBytes: 64 * 1024, artifactDir: dataDir } } : {}),
    inbox,
    ...(askUserStore !== undefined ? { askUserStore } : {}),
    skills: features.skills ? discoverSkills : undefined,
    ...(config.toolSelector !== undefined ? { toolSelector: config.toolSelector } : {}),
    ...(config.skillSelector !== undefined ? { skillSelector: config.skillSelector } : {}),
    // P2-2: pre-turn memory retrieval — one call per turn, rendered blocks
    // enter the context pipeline as memory prior data; the injected memory
    // ids are remembered for the P2-4 outcome feedback at turn end.
    ...(memoryBridge !== undefined
      ? {
          memoryBlocks: async (input: { sessionId: SessionId; turnId: TurnId; goal: string; cwd: string }) => {
            const retrieved: RetrievedMemoryContext = await memoryBridge.retrieve({
              sessionId: input.sessionId,
              goal: input.goal,
              cwd: input.cwd,
            });
            const ids = memoryIdsOfBlocks(retrieved.blocks);
            memoryInjectedBySession.set(input.sessionId, ids);
            // P2-4: blocks handed to the runtime are injected into context.
            await memoryBridge.recordInjected(ids);
            return retrieved.blocks;
          },
        }
      : {}),
    // P2-8: progressive skill disclosure — bodies of the selected skills.
    ...(skillBodyProvider !== undefined
      ? {
          skillBodyBlocks: async (input: { sessionId: SessionId; turnId: TurnId; names: string[] }) => {
            const blocks = await skillBodyProvider.load(input.names);
            const used = skillUseBySession.get(input.sessionId) ?? [];
            for (const name of input.names) {
              if (!used.includes(name)) used.push(name);
            }
            skillUseBySession.set(input.sessionId, used);
            return blocks;
          },
        }
      : {}),
    // P2-4/P2-5/P2-6/P2-9: turn-end feedback + reflection + skill outcome.
    ...(memoryBridge !== undefined || reflector !== undefined || skillBodyProvider !== undefined
      ? {
          onTurnComplete: async (input: {
            sessionId: SessionId;
            turnId: TurnId;
            outcome: { status: string; state?: { goal?: string } };
          }) => {
            const succeeded = input.outcome.status === "completed";
            // P2-4: usefulness outcome feedback for the injected memories.
            if (memoryBridge !== undefined) {
              const ids = memoryInjectedBySession.get(input.sessionId) ?? [];
              memoryInjectedBySession.delete(input.sessionId);
              await memoryBridge.recordOutcome(ids, {
                sessionId: input.sessionId,
                succeeded,
              });
            }
            // P2-5/P2-6: deterministic reflection → journal + candidate queue.
            if (reflector !== undefined) {
              try {
                const result = await reflector.reflect({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  outcome: input.outcome,
                });
                if (result.outputs > 0 || result.candidates > 0) {
                  await appendHarnessEvent(
                    input.sessionId,
                    "reflection.completed",
                    {
                      turnId: input.turnId,
                      outcome: input.outcome.status,
                      outputs: result.outputs,
                      candidates: result.candidates,
                    },
                    { turnId: input.turnId },
                  );
                }
              } catch (cause) {
                process.stderr.write(
                  `[harness] reflection failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
                );
              }
            }
            // P2-9: skill effectiveness task-outcome feedback.
            if (skillBodyProvider !== undefined) {
              const used = skillUseBySession.get(input.sessionId) ?? [];
              skillUseBySession.delete(input.sessionId);
              for (const name of used) {
                await skillBodyProvider.record(
                  name,
                  succeeded ? { kind: "taskCompleted" } : { kind: "taskFailed" },
                );
              }
            }
            // P7-6: lazy command discovery on the first code-changing turn —
            // test/typecheck/build hints persist for verification planning
            // (P8-1) without the model having to call discover_commands.
            if (commandDiscovery !== undefined) {
              const state = input.outcome.state as { filesChanged?: string[] } | undefined;
              const filesChanged = state?.filesChanged ?? [];
              if (succeeded && filesChanged.length > 0) {
                const hints = await commandDiscovery.onCodeChange(cwd, filesChanged).catch((err) => {
                  // P14-6: discovery hint failure is non-fatal — reported.
                  process.stderr.write(`[degraded] command-discovery.onCodeChange: ${err instanceof Error ? err.message : String(err)}\n`);
                  return undefined;
                });
                if (hints !== undefined) {
                  await appendHarnessEvent(
                    input.sessionId,
                    "command.discovered",
                    { cwd: hints.cwd, commands: hints.commands },
                    { turnId: input.turnId },
                  ).catch((err) =>
                    process.stderr.write(`[degraded] command-discovered.append: ${err instanceof Error ? err.message : String(err)}
`),
                  );
                }
              }
            }
          },
        }
      : {}),
    // P18-2/P23-3: the deferred-advertisement policy is frozen per STEP by
    // the snapshot factory (tool_lookup's schema is kept full). The runtime
    // no longer receives a pre-computed toolSpecs advertisement.
    schemaAdvertPolicy: {
      keepFull: (name) => builtinToolNames.has(name),
    },
    toolSemanticsOf: (name) => semanticsOf(registry.get(name)),
    // P18-6: same-resource file mutations never run in parallel — the batch
    // planner splits calls whose conflict key (canonical path) matches.
    resourceConflictOf: (call) => {
      const p = call.args.path;
      return typeof p === "string" ? fileConflictKey(resolve(cwd, p)) : undefined;
    },
    injectionDetector: (content) => detectPromptInjection(content),
    outputRedactor: (content) => redactSecrets(content),
    // P3-9: adaptive recovery's delegate_specialist ACTUALLY delegates to a
    // read-only specialist subagent when the delegator is wired (budget and
    // scope checks live inside Delegator.enforceBounds); otherwise it reports
    // unavailability and the runtime keeps the legacy observation message.
    ...(delegationEnabled
      ? {
          delegateSpecialist: async (input: {
            sessionId: SessionId;
            turnId: TurnId;
            goal: string;
            tool: string;
            failure: string;
            signal: AbortSignal;
          }) => {
            if (boundDelegator.value === undefined) return undefined;
            try {
              const result = await boundDelegator.value.delegate(
                {
                  parentSessionId: input.sessionId,
                  goal:
                    `Investigate why tool "${input.tool}" keeps failing (${input.failure}) and ` +
                    `report findings with evidence refs.\nParent goal: ${input.goal}`,
                  writable: false,
                },
                input.signal,
              );
              if (result.status !== "success") {
                return { delegated: false, summary: `delegation ended ${result.status}` };
              }
              return { delegated: true, summary: result.summary };
            } catch (cause) {
              return {
                delegated: false,
                summary: cause instanceof Error ? cause.message : String(cause),
              };
            }
          },
        }
      : {}),
    // P3-10: route per-call token usage into the tree budget (the delegator
    // binds each child session to its root; parent turns without a binding
    // are simply not tree-accounted).
    ...(scheduler !== undefined
      ? {
          // P20-1: the runtime's finalizeUsage() record (with provenance) is
          // the SINGLE usage source for the tree budget — the scheduler never
          // recomputes or guesses token numbers on its own.
          reportModelUsage: (sessionId: SessionId, usage: import("@ar/contracts").UsageSnapshot) => {
            scheduler.reportUsageBySession(sessionId, usage);
          },
        }
      : {}),
  });

  // --- delegation (P22-1: compose/compose-delegation) -----------------------
  const composedDelegation = composeDelegators({
    config,
    runtime,
    store,
    events,
    scheduler,
    agents,
    mcpToolNames,
    delegationToolNames,
    childWorkspaceRoots,
    sandboxPolicy: config.sandboxPolicy ?? preset.sandbox,
  });
  const delegator = composedDelegation.delegator;
  const parallelDelegator = composedDelegation.parallelDelegator;
  // P3-1: bind the lazily-resolved delegation tools to the real delegator.
  boundDelegator.value = delegator;
  boundParallelDelegator.value = parallelDelegator;
  const sessionService = new SessionService({ store });
  // P25-2: live session actors — the single owner of active turn state. The
  // actor enforces activeTurn ∈ {0,1} per session and routes steer/followup
  // through the durable inbox (P25-4/P25-5).
  const baseSessions = new DefaultLoadedSessionManager({
    runtime,
    store,
    ...(inbox !== undefined ? { inbox } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
    // P38.1-12/13: keep the durable event stream complete when a starting turn
    // is revoked before promotion (the runtime is uninvolved → actor seam).
    emit: eventSinkFromStore(events, config.now),
  });

  // P27-4: freeze the CURRENT effective-config fingerprint for a session
  // (stored via the existing durable state snapshot).
  const freezeConfigFingerprint = async (sessionId: SessionId): Promise<void> => {
    const prev = await store.loadStateSnapshot(sessionId);
    await store.saveStateSnapshot(sessionId, {
      ...(prev ?? {}),
      [CONFIG_FP_KEY]: resolvedConfig.fingerprint,
      [CONFIG_VALUE_KEY]: JSON.stringify(normalizeForComparison(resolvedConfig.value)),
    });
  };

  // P27-4: compare a session's frozen config against the current effective
  // config; returns a lifecycle-aware drift decision (fail-closed: a changed
  // session_frozen key with unknown direction → reject).
  const checkSessionConfigDrift = async (sessionId: SessionId): Promise<DriftDecision> => {
    const snap = await store.loadStateSnapshot(sessionId);
    const fp = snap?.[CONFIG_FP_KEY];
    const valueJson = snap?.[CONFIG_VALUE_KEY];
    if (typeof fp !== "string") {
      // No frozen snapshot → nothing to compare (fresh session / legacy).
      return {
        severity: "none" as const,
        changed: [],
        frozenChanged: false,
        fingerprint: { prev: "", next: resolvedConfig.fingerprint },
      };
    }
    let prevValue: unknown;
    try {
      prevValue = valueJson !== undefined ? JSON.parse(valueJson as string) : undefined;
    } catch {
      prevValue = undefined;
    }
    const prevResolved: ResolvedConfig<HarnessConfig> = {
      value: prevValue as HarnessConfig,
      layers: [],
      origins: new Map(),
      fingerprint: fp,
    };
    return evaluateConfigDrift(prevResolved, resolvedConfig);
  };

  // P27-4: wire the config-drift gate into the ONE production session-load
  // path (rpc/CLI/web all go through LoadedSessionManager.load). fail-closed:
  // a drifted frozen key rejects the load; otherwise every successful load
  // re-freezes the baseline for the next resume.
  // NOTE: explicit delegation (not spread) — class methods live on the
  // prototype and would be lost by object spread.
  const sessions: LoadedSessionManager = {
    load: async (id: SessionId) => {
      const decision = await checkSessionConfigDrift(id);
      if (decision.severity === "reject" || decision.severity === "restart_required") {
        const names = decision.changed
          .filter((c) => c.lifecycle === "process_static" || c.lifecycle === "session_frozen")
          .map((c) => c.key);
        await appendHarnessEvent(
          id,
          "policy.changed_on_resume",
          {
            contextPolicyChanged: true,
            driftKeys: names,
            severity: decision.severity,
          },
          {},
        );
        throw new AgentError(
          errorInfo(
            "CONFIG_DRIFT_REJECTED",
            `session ${id} config drifted: ${names.join(", ")} (${decision.severity}); restart or new session required`,
          ),
        );
      }
      const actor = await baseSessions.load(id);
      // Re-freeze after every successful load: the next resume compares
      // against this load's effective config. (A fresh session has no frozen
      // snapshot → the check above returns "none" and this becomes its baseline.)
      await freezeConfigFingerprint(id);
      return actor;
    },
    unload: (id: SessionId) => baseSessions.unload(id),
    listLoaded: () => baseSessions.listLoaded(),
    close: () => baseSessions.close(),
  };

  const lifecycle = new Lifecycle();
  if (sqliteStore !== undefined) {
    lifecycle.add({ close: async () => sqliteStore!.close() });
  }
  if (memoryStore !== undefined) lifecycle.add(new MemoryStoreCloser(memoryStore));
  // P24-2: harness close closes every connected MCP generation (no orphans).
  lifecycle.add({ close: () => mcp.close() });
  // P25-6: harness close unloads every loaded session actor (idempotent).
  lifecycle.add({ close: () => sessions.close() });

  const harness: Harness = {
    runtime,
    store,
    events,
    registry,
    sessionService,
    sessions,
    agents,
      ...(memoryBridge !== undefined ? { memoryBridge } : {}),
    ...(memoryStore !== undefined ? { memoryStore } : {}),
    ...(candidateStore !== undefined ? { candidates: candidateStore } : {}),
    ...(reflector !== undefined ? { reflector } : {}),
    ...(skillBodyProvider !== undefined ? { skillBodies: skillBodyProvider } : {}),
    ...(scheduler !== undefined ? { scheduler } : {}),
    ...(delegator !== undefined ? { delegator } : {}),
    ...(mcp.catalog.size > 0 ? { mcp: { servers: mcp.catalog.size, tools: mcpToolNames, lazy: true, failures: mcp.failures } } : {}),
    approvalStore,
    inbox,
    ...(askUserStore !== undefined ? { askUserStore } : {}),
    ...(checkpointStore !== undefined ? { checkpointStore } : {}),
    ...(artifactStore !== undefined ? { artifactStore } : {}),
    context: { pipeline, budget, budgetFallback },
    profile: config.profile,
    config,
    // P27-2/4/5: resolved config stack + per-session drift freeze/check.
    resolvedConfig,
    freezeConfigFingerprint,
    checkSessionConfigDrift,
    configExplain: (key?: string): ConfigExplainResult => explainConfig(resolvedConfig, key),
    introspect: () =>
      introspectHarness({
        profile: config.profile,
        registry,
        store,
        events,
        approvalStore,
        askUserStore,
        checkpointStore,
        artifactStore,
        memoryStore,
        features,
        delegator,
        scheduler,
        mcpTools: mcpToolNames,
        mcpServers: mcp.catalog.size,
      }),
    close: () => lifecycle.close(),
  };
  return harness;
}

function mainAgent(
  config: HarnessConfig,
  mcpToolNames: string[] = [],
  delegationToolNames: string[] = [],
  toolLookupName?: string,
): AgentDefinition {
  return {
    id: newAgentId(),
    name: "main",
    description: "default harness agent",
    mode: "primary",
    model: config.model,
    systemPrompt:
      toolLookupName !== undefined
        ? `${DEFAULT_MAIN_SYSTEM_PROMPT}\n\nDeferred tool schemas: some tools are advertised with a stub schema. Before calling one, fetch its full input schema with ${toolLookupName}({"names": ["<tool>"]}).`
        : DEFAULT_MAIN_SYSTEM_PROMPT,
    tools: {
      allow: [
        ...PRODUCTION_TOOL_NAMES,
        ...mcpToolNames,
        ...delegationToolNames,
        ...(toolLookupName !== undefined ? [toolLookupName] : []),
      ],
    },
    permissions: resolveProfile(config.profile).permissions,
    skills: {},
    limits: { maxToolCalls: 50, ...config.limits },
  };
}

// P22-1: composition refactor — the domain helpers live in compose/ and
// worker-agent.ts; these re-exports keep the create-harness public surface
// stable for downstream importers (no migration needed).
export { subagentDefinition, workerAgentDefinition } from "./worker-agent.js";
export { schedulerLimits, delegationLimits } from "./compose/compose-delegation.js";
export { resolveContextBudget } from "./compose/compose-context.js";
export { introspectHarness } from "./compose/compose-observability.js";
