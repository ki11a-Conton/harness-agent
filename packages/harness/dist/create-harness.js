import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newAgentId, newEventId, } from "@ar/contracts";
import { AgentRuntime, InMemoryArtifactStore } from "@ar/core";
import { DurableCheckpointStore } from "@ar/checkpoint";
import { ContextPipeline } from "@ar/context";
import { JsonlMemoryStore, retrieveMemories, SqliteMemoryStore } from "@ar/memory";
import { budgetForCapabilities, resolveCapabilities } from "@ar/model";
import { detectPromptInjection, DurableApprovalStore, InMemoryApprovalStore, StoreApprovalResolver, redactSecrets, } from "@ar/security";
import { JSONLAskUserStore, JSONLInboxStore, JSONLSessionStore, MemInboxStore, SessionService, } from "@ar/session";
import { JSONLEventStore } from "@ar/events";
import { SqliteRuntimeStore } from "@ar/store";
import { FileSkillLoader } from "@ar/skills";
import { capabilityOf, createProductionTools, semanticsOf, ToolOrchestrator, ToolRegistry, } from "@ar/tools";
import { AgentExecutionScheduler, Delegator, ParallelDelegator } from "@ar/agents";
import { connectMcpServer } from "@ar/mcp";
import { TaskVerifier } from "@ar/tools";
import { MemEventStore, MemSessionStore } from "./mem-stores.js";
import { DEFAULT_CONTEXT_BUDGET, } from "./config.js";
import { Lifecycle, MemoryStoreCloser } from "./lifecycle.js";
import { CommandDiscoveryService } from "./command-discovery-service.js";
import { resolveFeatureFlags, resolveProfile } from "./profiles.js";
import { MemoryRuntimeBridge, memoryIdsOfBlocks, } from "./memory-runtime-bridge.js";
import { resolveRepositoryIdentity, memoryScopeFor } from "./scope-resolver.js";
import { PostTurnReflector } from "./reflection-runner.js";
import { JsonlCandidateStore } from "./candidate-store.js";
import { createSkillBodyBlockProvider, } from "./skill-context.js";
import { createDelegationTools } from "./delegation-tools.js";
import { DefaultChildWorkspaceManager } from "./workspace-manager.js";
import { createVerificationPlanner } from "./verification-planner.js";
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
];
export const READONLY_TOOL_NAMES = [
    "read_file",
    "search_files",
    "grep_search",
    "repo_tree",
    "symbol_search",
    "repo_map",
    "discover_commands",
    "env_snapshot",
];
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
export async function createHarness(config) {
    const cwd = config.cwd;
    const dataDir = config.dataDir;
    if (dataDir !== undefined)
        await mkdir(dataDir, { recursive: true });
    const preset = resolveProfile(config.profile);
    const features = resolveFeatureFlags(config.profile, config.featureFlags);
    // --- stores ---------------------------------------------------------------
    // P5-3: `dataStore: "sqlite"` replaces the five JSONL runtime stores with a
    // single SqliteRuntimeStore (WAL) — same contracts, one file, one close.
    const useSqliteStore = config.dataStore === "sqlite" && dataDir !== undefined;
    const sqliteStore = useSqliteStore
        ? new SqliteRuntimeStore({ dataDir })
        : undefined;
    const store = sqliteStore ?? (dataDir !== undefined ? new JSONLSessionStore({ dataDir }) : new MemSessionStore());
    const events = sqliteStore ?? (dataDir !== undefined ? new JSONLEventStore({ dataDir }) : new MemEventStore());
    const approvalStore = dataDir !== undefined ? new DurableApprovalStore(join(dataDir, "approval-store.json")) : new InMemoryApprovalStore();
    const inbox = sqliteStore ?? (dataDir !== undefined ? new JSONLInboxStore({ dataDir }) : new MemInboxStore());
    // P1-5: durable ask-user store under a dataDir (crash-safe pending questions).
    const askUserStore = sqliteStore?.askUser ??
        (dataDir !== undefined ? new JSONLAskUserStore({ dataDir }) : undefined);
    const checkpointStore = sqliteStore?.checkpoints ??
        (dataDir !== undefined && features.checkpoint ? new DurableCheckpointStore({ dataDir }) : undefined);
    const artifactStore = features.artifacts ? new InMemoryArtifactStore() : undefined;
    // --- tools ----------------------------------------------------------------
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
    for (const tool of productionTools)
        registry.register(tool);
    // P3-1/P3-7: model-callable delegation tools are registered BEFORE the
    // runtime (their specs must be part of the advertised tool set), but the
    // delegator is only constructed after the runtime — the tools resolve it
    // lazily at execute time (P0-3 DeferredDelegationService pattern).
    let boundDelegator;
    let boundParallelDelegator;
    let workerAgent;
    const delegationToolNames = [];
    if (delegationEnabled) {
        workerAgent = workerAgentDefinition(config);
        for (const tool of createDelegationTools({
            delegator: () => {
                if (boundDelegator === undefined) {
                    throw new Error("delegation is enabled but the delegator is not wired");
                }
                return boundDelegator;
            },
            parallelDelegator: () => {
                if (boundParallelDelegator === undefined) {
                    throw new Error("delegation is enabled but the parallel delegator is not wired");
                }
                return boundParallelDelegator;
            },
            readonlyToolNames: READONLY_TOOL_NAMES,
            // P3-6: delegate_worker is exposed only with the isolation gate closed
            // (isolated workspace + sandbox extra roots wired above).
            workerAgentId: () => workerAgent.id,
            workspaceManager: () => new DefaultChildWorkspaceManager(),
        })) {
            delegationToolNames.push(tool.name);
            registry.register(tool);
        }
    }
    // --- MCP transport wiring (P0-3) ----------------------------------------
    // Each configured server is connected over its REAL transport (http →
    // JSON-RPC over fetch; stdio → spawned child process), its advertised tools
    // are adapted into the registry, and the main agent is granted them. A
    // connection/registration failure aborts harness creation — a misconfigured
    // server is never silently dropped. Tool descriptions are injection-scanned
    // fail-closed at registration (P0-8); rejections surface as
    // security.mcp_denied events when a session is known.
    const mcpConfigs = config.mcp ?? [];
    const mcpEnabled = features.mcp || mcpConfigs.length > 0;
    const mcpToolNames = [];
    const mcpConnections = [];
    if (mcpEnabled && mcpConfigs.length > 0) {
        const sink = {
            async emit(sessionId, type, payload, turnId) {
                await events.append({
                    id: newEventId(),
                    sessionId,
                    ...(turnId !== undefined ? { turnId } : {}),
                    sequence: 0,
                    timestamp: Date.now(),
                    type,
                    payload,
                });
            },
        };
        for (const server of mcpConfigs) {
            const conn = await connectMcpServer(server, {
                events: sink,
                trust: "untrusted",
                networkBoundary: server.kind === "stdio" ? "loopback" : "internet",
            });
            for (const tool of conn.tools) {
                registry.register(tool);
                mcpToolNames.push(tool.name);
            }
            mcpConnections.push(conn);
        }
    }
    // --- orchestrator (permission → approval → sandbox, plan §24) -------------
    // P3-6: per-session sandbox roots — a write-capable child's isolated
    // workspace is admitted into its own sandbox while it runs and removed on
    // disposal, so the child can write its workspace and nothing outside it.
    const childWorkspaceRoots = new Map();
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
    // P6-3: context selection telemetry — the pipeline reports facts, the
    // harness routes them into the event stream (never content, only
    // source/priority/tokens/reason).
    const pipeline = new ContextPipeline({
        onTelemetry: (event) => {
            // candidate facts without a quarantine reason are noise — skip.
            if (event.sessionId === undefined || (event.phase === "candidate" && event.reason !== "quarantine-envelope")) {
                return;
            }
            const type = event.phase === "compacted"
                ? "context.compacted"
                : event.phase === "selected"
                    ? "context.selected"
                    : event.phase === "dropped"
                        ? "context.dropped"
                        : "context.candidate";
            void events.append({
                id: newEventId(),
                sessionId: event.sessionId,
                sequence: 0,
                timestamp: Date.now(),
                type: type,
                payload: {
                    source: event.source,
                    ...(event.id !== undefined ? { id: event.id } : {}),
                    ...(event.priority !== undefined ? { priority: event.priority } : {}),
                    ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
                    ...(event.reason !== undefined ? { reason: event.reason } : {}),
                },
            }).catch(() => { });
        },
    });
    const { budget, budgetFallback } = await resolveContextBudget(config);
    // --- skills ---------------------------------------------------------------
    let pendingSkillSecurity = [];
    const skillLoader = new FileSkillLoader({
        onSecurityDenied: (event) => {
            pendingSkillSecurity.push({
                detection: event.detection,
                reasons: event.reasons,
                path: event.path,
                source: event.source,
            });
            process.stderr.write(`[skill denied] detection=${event.detection} target=${event.path} reasons=${event.reasons.join(",")}\n`);
        },
    });
    const skillRoots = (process.env.AR_SKILL_ROOTS ?? "")
        .split(";")
        .map((root) => root.trim())
        .filter((root) => root.length > 0);
    const discoverSkills = async () => {
        pendingSkillSecurity = [];
        const found = await skillLoader.discover({ roots: skillRoots, maxSkills: 100 });
        const security = pendingSkillSecurity;
        return { skills: found, security };
    };
    // --- agents (main; subagent added below once runtime exists) ---------------
    const agents = [
        mainAgent(config, mcpToolNames, delegationToolNames),
        ...(workerAgent !== undefined ? [workerAgent] : []),
    ];
    const scheduler = delegationEnabled
        ? new AgentExecutionScheduler({ store, limits: schedulerLimits(config.delegation) })
        : undefined;
    // --- memory (P2-1 bridge + P2-3 scope resolution) --------------------------
    let legacyMemoryBridge;
    let memoryBridge;
    // P2-4: which memories were injected per session this process saw — the
    // outcome feedback target at turn end.
    const memoryInjectedBySession = new Map();
    if (memoryEnabled) {
        const memoryDataDir = config.memory?.dbPath ?? dataDir;
        if (memoryDataDir === undefined) {
            throw new Error("memory is enabled but no dataDir (or memory.dbPath) is configured — refusing to write memories into the workspace");
        }
        const memoryStore = config.memory?.dbPath !== undefined
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
        // P0-3 compatibility surface (harness.memory) + introspection store ref.
        legacyMemoryBridge = {
            store: memoryStore,
            retrieve(query, scopeForQuery, opts) {
                return retrieveMemories(memoryStore, query, scopeForQuery, { k: opts?.k ?? config.memory?.topK, type: opts?.type });
            },
        };
    }
    // --- learning pipeline (P2-5/P2-6): post-turn reflection → candidate queue.
    // The queue is durable when a dataDir exists; promotion is never automatic
    // (P2-7 — explicit `agent learn` commands consume it).
    const candidateStore = dataDir !== undefined && (features.learning || memoryEnabled)
        ? new JsonlCandidateStore({ dataDir })
        : undefined;
    const reflector = candidateStore !== undefined && dataDir !== undefined
        ? new PostTurnReflector({ events, candidateStore, dataDir })
        : undefined;
    // --- skill bodies (P2-8) + effectiveness ledger (P2-9) --------------------
    let skillBodyProvider;
    const skillUseBySession = new Map();
    if (features.skills && dataDir !== undefined) {
        skillBodyProvider = createSkillBodyBlockProvider({
            loader: skillLoader,
            discover: async () => (await discoverSkills()).skills,
            dataDir,
        });
    }
    // P7-6: lazy command discovery for code-changing turns (persisted hints).
    const commandDiscovery = dataDir !== undefined ? new CommandDiscoveryService({ dataDir }) : new CommandDiscoveryService();
    if (dataDir !== undefined) {
        await commandDiscovery.loadPersisted().catch(() => { });
    }
    // --- verification plan auto-orchestration (P8-1) --------------------------
    // When the host supplies a task, the harness wires a TaskVerifier (P8-2:
    // every step emits verification.step_started/step_completed) and a plan
    // builder that derives specs from the change set + discovered commands when
    // the task declares none. Explicit task.verification always wins.
    const verificationPlanner = config.verification?.planner ??
        createVerificationPlanner({
            commands: () => commandDiscovery.maybeDiscover(cwd),
        });
    const verifier = config.verification?.verifier ??
        (config.task !== undefined
            ? new TaskVerifier({
                onStep: (event) => {
                    if (event.sessionId === undefined)
                        return;
                    void events
                        .append({
                        id: newEventId(),
                        sessionId: event.sessionId,
                        sequence: 0,
                        timestamp: Date.now(),
                        type: (event.phase === "started" ? "verification.step_started" : "verification.step_completed"),
                        payload: {
                            ref: event.ref,
                            kind: event.kind,
                            ...(event.description !== undefined ? { description: event.description } : {}),
                            ...(event.passed !== undefined ? { passed: event.passed } : {}),
                            ...(event.detail !== undefined ? { detail: event.detail } : {}),
                        },
                    })
                        .catch(() => { });
                },
            })
            : undefined);
    // --- runtime --------------------------------------------------------------
    const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: config.modelProvider,
        orchestrator,
        agents,
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
                memoryBlocks: async (input) => {
                    const retrieved = await memoryBridge.retrieve({
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
                skillBodyBlocks: async (input) => {
                    const blocks = await skillBodyProvider.load(input.names);
                    const used = skillUseBySession.get(input.sessionId) ?? [];
                    for (const name of input.names) {
                        if (!used.includes(name))
                            used.push(name);
                    }
                    skillUseBySession.set(input.sessionId, used);
                    return blocks;
                },
            }
            : {}),
        // P2-4/P2-5/P2-6/P2-9: turn-end feedback + reflection + skill outcome.
        ...(memoryBridge !== undefined || reflector !== undefined || skillBodyProvider !== undefined
            ? {
                onTurnComplete: async (input) => {
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
                                await events.append({
                                    id: newEventId(),
                                    sessionId: input.sessionId,
                                    turnId: input.turnId,
                                    sequence: 0,
                                    timestamp: Date.now(),
                                    type: "reflection.completed",
                                    payload: {
                                        turnId: input.turnId,
                                        outcome: input.outcome.status,
                                        outputs: result.outputs,
                                        candidates: result.candidates,
                                    },
                                });
                            }
                        }
                        catch (cause) {
                            process.stderr.write(`[harness] reflection failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
                        }
                    }
                    // P2-9: skill effectiveness task-outcome feedback.
                    if (skillBodyProvider !== undefined) {
                        const used = skillUseBySession.get(input.sessionId) ?? [];
                        skillUseBySession.delete(input.sessionId);
                        for (const name of used) {
                            await skillBodyProvider.record(name, succeeded ? { kind: "taskCompleted" } : { kind: "taskFailed" });
                        }
                    }
                    // P7-6: lazy command discovery on the first code-changing turn —
                    // test/typecheck/build hints persist for verification planning
                    // (P8-1) without the model having to call discover_commands.
                    if (commandDiscovery !== undefined) {
                        const state = input.outcome.state;
                        const filesChanged = state?.filesChanged ?? [];
                        if (succeeded && filesChanged.length > 0) {
                            const hints = await commandDiscovery.onCodeChange(cwd, filesChanged).catch(() => undefined);
                            if (hints !== undefined) {
                                await events.append({
                                    id: newEventId(),
                                    sessionId: input.sessionId,
                                    turnId: input.turnId,
                                    sequence: 0,
                                    timestamp: Date.now(),
                                    type: "command.discovered",
                                    payload: { cwd: hints.cwd, commands: hints.commands },
                                }).catch(() => { });
                            }
                        }
                    }
                },
            }
            : {}),
        toolSpecs: registry.specs(),
        toolCapabilityOf: (name) => capabilityOf(registry.get(name)),
        toolSemanticsOf: (name) => semanticsOf(registry.get(name)),
        injectionDetector: (content) => detectPromptInjection(content),
        outputRedactor: (content) => redactSecrets(content),
        // P3-9: adaptive recovery's delegate_specialist ACTUALLY delegates to a
        // read-only specialist subagent when the delegator is wired (budget and
        // scope checks live inside Delegator.enforceBounds); otherwise it reports
        // unavailability and the runtime keeps the legacy observation message.
        ...(delegationEnabled
            ? {
                delegateSpecialist: async (input) => {
                    if (boundDelegator === undefined)
                        return undefined;
                    try {
                        const result = await boundDelegator.delegate({
                            parentSessionId: input.sessionId,
                            goal: `Investigate why tool "${input.tool}" keeps failing (${input.failure}) and ` +
                                `report findings with evidence refs.\nParent goal: ${input.goal}`,
                            writable: false,
                        }, input.signal);
                        if (result.status !== "success") {
                            return { delegated: false, summary: `delegation ended ${result.status}` };
                        }
                        return { delegated: true, summary: result.summary };
                    }
                    catch (cause) {
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
                reportModelUsage: (sessionId, inputTokens, outputTokens) => {
                    scheduler.reportUsageBySession(sessionId, inputTokens, outputTokens);
                },
            }
            : {}),
    });
    // --- delegation: scheduler is created before the runtime (no runtime dep),
    // the delegator AFTER it (binds runtime). No delegate* tool is registered —
    // a model-callable delegation tool is P3, reported honestly by the audit.
    let delegator;
    let parallelDelegator;
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
            // P3-4: write-capable children run in isolated workspaces; read-only
            // children share the parent root. Enables P3-5 patch-based merging.
            workspaceManager: new DefaultChildWorkspaceManager(),
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
        // P3-1: bind the lazily-resolved delegation tools to the real delegator.
        boundDelegator = delegator;
        boundParallelDelegator = parallelDelegator;
    }
    const sessionService = new SessionService({ store });
    const lifecycle = new Lifecycle();
    if (sqliteStore !== undefined) {
        lifecycle.add({ close: async () => sqliteStore.close() });
    }
    if (legacyMemoryBridge !== undefined)
        lifecycle.add(new MemoryStoreCloser(legacyMemoryBridge.store));
    for (const conn of mcpConnections) {
        lifecycle.add({ close: () => conn.close() });
    }
    const harness = {
        runtime,
        store,
        events,
        registry,
        sessionService,
        agents,
        ...(legacyMemoryBridge !== undefined ? { memory: legacyMemoryBridge } : {}),
        ...(memoryBridge !== undefined ? { memoryBridge } : {}),
        ...(candidateStore !== undefined ? { candidates: candidateStore } : {}),
        ...(reflector !== undefined ? { reflector } : {}),
        ...(skillBodyProvider !== undefined ? { skillBodies: skillBodyProvider } : {}),
        ...(scheduler !== undefined ? { scheduler } : {}),
        ...(delegator !== undefined ? { delegator } : {}),
        ...(mcpConnections.length > 0 ? { mcp: { servers: mcpConnections.length, tools: mcpToolNames } } : {}),
        approvalStore,
        inbox,
        ...(askUserStore !== undefined ? { askUserStore } : {}),
        ...(checkpointStore !== undefined ? { checkpointStore } : {}),
        ...(artifactStore !== undefined ? { artifactStore } : {}),
        context: { pipeline, budget, budgetFallback },
        profile: config.profile,
        config,
        introspect: () => introspectHarness({
            profile: config.profile,
            registry,
            store,
            events,
            approvalStore,
            checkpointStore,
            artifactStore,
            memoryStore: legacyMemoryBridge?.store,
            features,
            delegator,
            scheduler,
            mcpTools: mcpToolNames,
            mcpServers: mcpConnections.length,
        }),
        close: () => lifecycle.close(),
    };
    return harness;
}
function mainAgent(config, mcpToolNames = [], delegationToolNames = []) {
    return {
        id: newAgentId(),
        name: "main",
        description: "default harness agent",
        mode: "primary",
        model: config.model,
        systemPrompt: DEFAULT_MAIN_SYSTEM_PROMPT,
        tools: { allow: [...PRODUCTION_TOOL_NAMES, ...mcpToolNames, ...delegationToolNames] },
        permissions: resolveProfile(config.profile).permissions,
        skills: {},
        limits: { maxToolCalls: 50, ...config.limits },
    };
}
function subagentDefinition(config) {
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
/** P3-6: write-capable worker agent. Registered only when delegation is
 *  enabled; its sandbox admits the per-child isolated workspace (the harness
 *  wires the extra roots), so the worker can edit/exec inside its own copy —
 *  and nothing outside it (network stays denied). */
function workerAgentDefinition(config) {
    return {
        id: newAgentId(),
        name: "worker-w",
        description: "write-capable delegated worker (isolated workspace copy)",
        mode: "subagent",
        model: config.model,
        systemPrompt: "You are a write-capable worker in an ISOLATED copy of the parent workspace. " +
            "Make the requested changes in this workspace only. On success they are merged back under conflict detection.",
        tools: { allow: [...PRODUCTION_TOOL_NAMES] },
        permissions: {
            rules: [
                { action: "read", resource: "file", effect: "allow" },
                { action: "edit", resource: "file", effect: "allow" },
                { action: "exec", resource: "command", effect: "allow" },
                { action: "exec", resource: "network", effect: "deny" },
            ],
        },
        skills: {},
        limits: { maxToolCalls: 50 },
    };
}
function schedulerLimits(delegation) {
    return {
        ...(delegation?.maxGlobalAgents !== undefined ? { maxGlobalAgents: delegation.maxGlobalAgents } : {}),
        ...(delegation?.maxAgentsPerRoot !== undefined ? { maxAgentsPerRoot: delegation.maxAgentsPerRoot } : {}),
        ...(delegation?.maxDepth !== undefined ? { maxDepth: delegation.maxDepth } : {}),
    };
}
function delegationLimits(delegation) {
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
export async function resolveContextBudget(config) {
    if (config.contextBudget !== undefined)
        return { budget: config.contextBudget, budgetFallback: false };
    let info;
    try {
        const infos = await config.modelProvider.listModels();
        info = infos.find((m) => m.id === config.model.modelId);
    }
    catch {
        info = undefined; // provider listModels failure → conservative fallback
    }
    const caps = resolveCapabilities(config.model, info, undefined);
    const windowTokens = budgetForCapabilities(caps);
    if (windowTokens === undefined) {
        process.stderr.write(`[harness] context budget: model capabilities unknown for ${config.model.providerId}/${config.model.modelId} — using conservative fallback ${DEFAULT_CONTEXT_BUDGET.maxTokens}\n`);
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
/** Honest wiring facts: store implementations by constructor name, registered
 *  tool names, and feature flags — exactly what P0-1's audit consumes. */
export function introspectHarness(input) {
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
            mcp: input.features.mcp || (input.mcpServers ?? 0) > 0,
            plugins: input.features.plugins,
            skills: input.features.skills,
            usageAccounting: false,
            runBudget: false,
        },
        ...(input.mcpServers !== undefined && (input.mcpServers ?? 0) > 0
            ? { mcp: { servers: input.mcpServers, tools: input.mcpTools ?? [] } }
            : {}),
    };
}
//# sourceMappingURL=create-harness.js.map