import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify, type AgentEvent, type ModelClient, type ModelProvider, type ModelRef, type ProviderConfig, type SessionId } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { resolveHarnessConfig } from "@ar/harness";
import { resolveModelProvider } from "@ar/cli";
import { createHostTools } from "./host-tools.js";
import { createOwnerManager, type OwnerManager } from "./owners.js";
import { createWorkspaceService } from "./workspace.js";
import { createFilesService, workspaceReadTool, workspaceMkdirTool } from "./files.js";
import { createTerminalService } from "./terminal.js";
import { createSessionService } from "./session.js";
import { createCatalogService, type CatalogHost, type ModelProfile } from "./catalog.js";
import { createActivityService } from "./activity.js";
import { createDeliverablesService } from "./deliverables.js";
import { RemoteFailure, type DeepseekService } from "./transport.js";
import type { RequestTransform, RouteResolver } from "./routes.js";
import { createControlsService } from "./controls.js";

/** The production Web host composes services over the same Harness contracts as CLI. */
export interface DeepseekLaunchFacts {
  initialProviderProfiles?: Readonly<Record<string, ModelProfile>>;
  initialCredentials?: Readonly<Record<string, string>>;
  environment?: Readonly<Record<string, string | undefined>>;
}
/**
 * Wiring hooks. `installRouteResolver` hands the caller's own provider (the
 * adapter default the base harness was built with) the same catalogue route
 * lookup the workspace owners use, so a started base session can switch models
 * too. It is called once, before any request can arrive.
 */
export interface DeepseekCompositionHooks {
  installRouteResolver?: (resolver: RouteResolver) => void;
  installRequestTransform?: (transform: RequestTransform) => void;
}
export async function createDeepseekComposition(base: Harness, dataDir?: string, facts: DeepseekLaunchFacts = {},
  hooks: DeepseekCompositionHooks = {}) {
  const cwd = base.config.cwd;
  const bootstrapTools = createHostTools(base, cwd, dataDir);
  const initialProviderProfiles = structuredClone(facts.initialProviderProfiles ?? {});
  // A profile already captured for an owner remains immutable. Adding another
  // route is safe; changing a live route needs a versioned owner migration.
  const usedProfiles = new Map(Object.entries(initialProviderProfiles).map(([key, profile]) => [key, stableStringify(profile)]));
  const usedCredentials = new Map<string, string>();
  const catalogHost: CatalogHost = { harness: base, cwd, dataDir, ...bootstrapTools,
    initialProviderProfiles,
    initialCredentials: facts.initialCredentials ?? {},
    environment: facts.environment ?? {},
    validateModelProfiles: async (profiles, signal) => {
      signal.throwIfAborted();
      for (const [route, frozen] of usedProfiles) if (stableStringify(profiles[route]) !== frozen) {
        throw new RemoteFailure("settings/provider-in-use", "An existing owner uses this model profile; add a new provider route instead", { provider: route });
      }
    },
    validateCredentials: async (values, _prior, signal) => {
      signal.throwIfAborted();
      for (const [ref, frozen] of usedCredentials) if (values[ref] !== frozen) {
        throw new RemoteFailure("credentials/reference-in-use", "An existing owner uses this credential reference; add another reference instead", { ref });
      }
    },
  };
  const catalog = createCatalogService(catalogHost);
  const neverAborted = new AbortController().signal;
  /**
   * The catalogue lookup behind both owner creation and live model switches:
   * the same route/credential resolution and adapter fingerprint the workspace
   * owner index has always been built from, so a switch reuses exactly the
   * frozen identity that index keys on.
   */
  const resolveRoute = async (selection: { providerKey: string; modelId: string }, signal: AbortSignal) => {
    const profile = (await catalog.resolvedModelProfiles(signal))[selection.providerKey];
    if (profile === undefined || profile.api !== "openai-completions" || !profile.apiKey || !profile.baseURL
      || !profile.models?.some(model => model.id === selection.modelId)) throw new RemoteFailure("session/model-unavailable", "The requested model does not have a configured adapter and credential");
    const billing = await resolveModelProvider({ apiKey: profile.apiKey, baseUrl: profile.baseURL, modelId: selection.modelId });
    if (billing.provider.id === "stub") throw new RemoteFailure("session/model-unavailable", "The model provider could not be constructed");
    const { apiKey, ...publicProfile } = profile;
    usedProfiles.set(selection.providerKey, stableStringify(publicProfile));
    if (profile.apiKeyEnv !== undefined) usedCredentials.set(profile.apiKeyEnv, apiKey);
    const nativeModel = { providerId: billing.provider.id, modelId: selection.modelId };
    // Preserve the actual adapter's complete frozen configuration identity,
    // while routing the public model selection by its configured route key.
    const adapterFingerprint = resolveHarnessConfig({ profile: base.profile, overrides: { ...base.config, modelProvider: billing.provider, model: nativeModel } }).fingerprint;
    const configuredModels = profile.models.map(model => {
      const contextWindow = model.contextWindow ?? profile.defaultContextWindow;
      const maxTokens = model.maxTokens ?? profile.defaultMaxTokens;
      return { id: model.id, ...(model.name === undefined ? {} : { name: model.name }),
        ...(contextWindow === undefined ? {} : { contextSize: contextWindow }),
        capabilities: { ...(contextWindow === undefined ? {} : { contextWindowTokens: contextWindow }),
          ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }) } };
    });
    return { ...selection, billing, nativeModel, adapterFingerprint,
      configuredModels, configuredLimits: configuredModels.map(({ id, capabilities }) => {
        const reasoningEfforts = profile.models?.find(model => model.id === id)?.reasoningEfforts;
        return { id, ...capabilities, ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) };
      }) };
  };
  type Route = Awaited<ReturnType<typeof resolveRoute>>;
  const routeClient = (route: Route, model: ModelRef, config: ProviderConfig): ModelClient => {
    const client = route.billing.provider.createClient({ ...model, providerId: route.billing.provider.id }, config);
    const maximum = route.configuredModels.find(item => item.id === model.modelId)?.capabilities.maxOutputTokens;
    return { generate: async function* (request, signal) {
      request = await transformRequest(request, model, signal);
      yield* client.generate(maximum === undefined ? request : { ...request, maxTokens: Math.min(request.maxTokens ?? maximum, maximum) }, signal);
    } };
  };
  const transformRequest = async (request: import("@ar/contracts").ModelRequest, model: ModelRef, signal: AbortSignal) => {
    if (controls === undefined) return request;
    const transformed = await controls.transform(request);
    const nativeId = request.messages.at(-1)?.sessionId;
    if (nativeId === undefined) return transformed;
    const selected = (await controls.read(owners.externalSessionId(nativeId))).reasoning;
    if (selected?.provider !== model.providerId || selected.model !== model.modelId || selected.effort === undefined) return transformed;
    const efforts = (await catalog.resolvedModelProfiles(signal))[model.providerId]?.models?.find(item => item.id === model.modelId)?.reasoningEfforts;
    const wire = efforts && efforts[selected.effort as keyof typeof efforts];
    return typeof wire === "string" ? { ...transformed, reasoningEffort: wire } : transformed;
  };
  hooks.installRequestTransform?.((request, model) => transformRequest(request, model, neverAborted));
  hooks.installRouteResolver?.(async (providerKey, modelId, signal) => {
    if (providerKey === base.config.modelProvider.id && modelId === base.config.model.modelId) return undefined;
    const route = await resolveRoute({ providerKey, modelId }, signal ?? neverAborted);
    return { provider: route.billing.provider, maximumOutputTokens: route.configuredModels.find(item => item.id === modelId)?.capabilities.maxOutputTokens };
  });
  let workspace!: ReturnType<typeof createWorkspaceService>;
  const observed = new WeakSet<Harness>();
  let activity: ReturnType<typeof createActivityService> | undefined;
  let controls: ReturnType<typeof createControlsService> | undefined;
  let boundOwners: OwnerManager | undefined;
  let capture: ((event: AgentEvent) => Promise<void>) | undefined;
  const observers = new Set<(event: AgentEvent) => Promise<void>>();
  const configureOwner = (harness: Harness): void => {
    controls?.attach(harness);
    for (const tool of activity?.modelTools ?? []) {
      if (!harness.registry.has(tool.name)) harness.registry.register(tool);
      for (const agent of harness.agents) if (agent.tools.allow !== undefined && !agent.tools.allow.includes(tool.name)) agent.tools.allow = [...agent.tools.allow, tool.name];
    }
    if (observed.has(harness)) return; observed.add(harness);
    const append = harness.events.appendNew.bind(harness.events);
    harness.events.appendNew = async event => {
      const committed = await append(event);
      const projected = boundOwners === undefined ? committed : await boundOwners.projectEvent(committed);
      if (projected !== undefined) {
        controls?.observe(projected);
        await capture?.(projected);
        for (const observer of observers) await observer(projected);
      }
      return committed;
    };
  };
  const owners = await createOwnerManager(base, {
    dataDir, executeHostTool: bootstrapTools.executeHostTool,
    newSessionsUseChildren: true,
    extraSandboxPaths: [resolve(dataDir ?? cwd, "deepseek", "schedules.json")],
    draftBlockers: async (id, signal) => {
      signal.throwIfAborted();
      if (boundOwners === undefined) return ["owner-starting"];
      const journal = await boundOwners.harnessFacade.events.list(id as SessionId);
      // The actual journal covers completed and uncertain private side effects,
      // including durable staged uploads after a host restart.
      const blockers = journal.filter(event => event.type === "tool.intent_persisted"
        && ["web_upload_write", "web_activity_metadata", "web_terminal_create", "web_terminal_control"].includes(String(event.payload.tool)))
        .map(event => String(event.payload.tool));
      const terminalWork = terminal?.active(id) ?? [];
      if (terminalWork.length) blockers.push("terminal");
      if (activity !== undefined) {
        const scheduled = await activity.sessionActivity(id, signal);
        if (scheduled.activeSchedules || scheduled.pendingDispatches || scheduled.unresolvedClaims) blockers.push("schedule");
        if (scheduled.jobs.some(job => job.status === "running")) blockers.push("job");
      }
      return [...new Set(blockers)];
    },
    workspace: async id => { const selected = await workspace.workspace(id); return { path: selected.path, workspaceId: selected.id }; },
    resolveSelection: async (selection, signal) => {
      if (selection.providerKey === base.config.modelProvider.id && selection.modelId === base.config.model.modelId) return { modelProvider: base.config.modelProvider, model: base.config.model };
      const route = await resolveRoute(selection, signal);
      const modelProvider: ModelProvider = {
        id: selection.providerKey,
        getConfigIdentity: () => ({ implementation: "harness-web-openai-route-v2", route: selection.providerKey, adapterFingerprint: route.adapterFingerprint, configuredLimits: route.configuredLimits }),
        listModels: async () => structuredClone(route.configuredModels),
        createClient: (model, config) => model.providerId === selection.providerKey && model.modelId === selection.modelId
          ? routeClient(route, model, config)
          // The owner identity stays frozen while a live session may have
          // switched to another model, so that route is resolved on demand
          // instead of being sent to this route's upstream.
          : { generate: async function* (request, requestSignal) {
            yield* routeClient(await resolveRoute({ providerKey: model.providerId, modelId: model.modelId }, requestSignal), model, config)
              .generate(request, requestSignal);
          } },
      };
      return { modelProvider, model: { providerId: selection.providerKey, modelId: selection.modelId } };
    },
    configureOwner,
  });
  boundOwners = owners;
  let terminal: ReturnType<typeof createTerminalService> | undefined;
  try {
  const harness = owners.harnessFacade;
  const tools = createHostTools(harness, cwd, dataDir, owners.ownerOf, owners.nativeSessionId,
    (id, definition, context, execute) => controls === undefined ? execute(context) : controls.controlled(id, definition, context, execute));
  for (const definition of bootstrapTools.registeredTools()) tools.registerTool(definition);
  Object.assign(catalogHost, { harness, ...tools,
    selectModel: async (sessionId: string, selected: import("./catalog.js").CatalogSelection, signal: AbortSignal) => {
      await owners.selectModel(sessionId, { providerKey: selected.provider, modelId: selected.model }, signal);
      await controls!.selectReasoning(sessionId, selected, signal); return selected;
    },
  });
  tools.registerTool(workspaceReadTool); tools.registerTool(workspaceMkdirTool);
  const workspaceHost: import("./workspace.js").WorkspaceHost = { harness, cwd, dataDir, ...tools, withSessionLock: owners.withSessionLock };
  workspace = createWorkspaceService(workspaceHost);
  await workspace.call("workspace/initializeDefault", {}, new AbortController().signal);
  const files = createFilesService(workspaceHost);
  terminal = createTerminalService({ ...workspaceHost, externalSessionId: owners.externalSessionId, withSessionLock: owners.withSessionLock });
  for (const tool of terminal.tools) tools.registerTool(tool);
  let deliverables!: ReturnType<typeof createDeliverablesService>;
  const sessionHost = { harness, cwd, dataDir, rpc: owners.rpcFacade, ...tools,
    withSessionLock: owners.withSessionLock,
    beforePrompt: (id: string, requestId: string) => controls?.beforePrompt(id, requestId) ?? Promise.resolve(),
    resolveWorkspace: (id: string, signal: AbortSignal) => workspace.workspace(id, signal),
    createSession: async (workspaceId, signal) => {
      const session = await owners.createSession(workspaceId, signal);
      await workspace.accountSession(session.id, session.cwd, workspaceId, new AbortController().signal); return session;
    },
    resolveUpload: (sessionId: string, receiptId: string, signal: AbortSignal) => deliverables.resolveUpload(sessionId, receiptId, signal),
  } satisfies import("./session.js").SessionHost;
  const sessions = createSessionService(sessionHost);
  const submitPrompt = async (request: { sessionId: string; requestId: string; mode: "queue" | "steer"; content: Array<{ type: "text"; text: string }> }, signal: AbortSignal) => {
    await sessions.call("session/prompt", { request }, signal);
    const promptId = (await sessions.metadata.read(request.sessionId)).requests[request.requestId]?.promptId;
    if (promptId === undefined) throw new RemoteFailure("session/admission-uncertain", "No durable inbox receipt was committed");
    return { messageId: promptId };
  };
  controls = createControlsService({ ...sessionHost, externalSessionId: owners.externalSessionId, submitPrompt, resolveHarness: owners.ownerOf, nativeSessionId: owners.nativeSessionId });
  deliverables = createDeliverablesService({ ...workspaceHost, sourceSequence: sessions.sourceSequence, withSessionLock: owners.withSessionLock });
  for (const tool of deliverables.tools) tools.registerTool(tool);
  capture = deliverables.observe;
  const boot = JSON.parse(await readFile(fileURLToPath(new URL("../../public/deepseek/boot-manifest.json", import.meta.url)), "utf8")) as { entries: { id: string }[] };
  catalogHost.publish = (topic, args) => sessions.publish(topic, args);
  activity = createActivityService({ ...sessionHost, controls, pluginEntries: boot.entries, resolveHarness: owners.ownerOf,
    externalSessionId: owners.externalSessionId,
    publish: (topic, args) => sessions.publish(topic, args),
    submitPrompt,
  });
  // Recovered owners are constructed before the activity service. Register its
  // real tools too, without changing any existing session's frozen tool set.
  for (const owner of owners.ownerList()) configureOwner(owner.harness);
  const terminalService = terminal;
  const ownedSessionIds = async (id: string): Promise<string[]> => {
    const rows = await harness.store.listSessions(); const ids = new Set([id]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (row.parentId !== undefined && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; } }
    return [...ids];
  };
  workspaceHost.sessionActivity = async (id, signal) => {
    const result: Array<{ kind: string; items?: Array<{ id: string; label?: string }> }> = [];
    for (const ownedId of await ownedSessionIds(id)) {
      signal.throwIfAborted();
      const turns = await harness.store.listTurns(ownedId as SessionId);
      if (turns.some(turn => ["running", "waiting_for_user", "waiting_for_approval"].includes(turn.status))) result.push({ kind: ownedId === id ? "turn" : "subagent", items: [{ id: ownedId }] });
      const queued = (await harness.inbox.listAll(ownedId as SessionId)).filter(prompt => prompt.status !== "consumed");
      if (queued.length) result.push({ kind: "queued-prompt", items: queued.map(prompt => ({ id: prompt.id })) });
      const terminals = terminalService.active(ownedId); if (terminals.length) result.push({ kind: "terminal", items: terminals });
      const active = await activity!.sessionActivity(ownedId, signal);
      if (active.activeSchedules || active.pendingDispatches || active.unresolvedClaims) result.push({ kind: "schedule" });
      if (active.jobs.some(job => job.status === "running")) result.push({ kind: "job", items: active.jobs.filter(job => job.status === "running").map(job => ({ id: job.id, label: job.label })) });
      if ((await controls!.read(ownedId)).goal?.phase === "active") result.push({ kind: "goal" });
    }
    return result;
  };
  workspaceHost.stopSessionActivity = async (id, signal) => {
    for (const ownedId of (await ownedSessionIds(id)).reverse()) {
      signal.throwIfAborted();
      await controls!.stopGoal(ownedId);
      await activity!.stopSessionActivity(ownedId, signal);
      await terminalService.closeSession(ownedId, signal);
      await sessions.call("session/cancel", { request: { sessionId: ownedId } }, signal);
    }
    // Pending inbox records remain a visible blocker until the owner supports
    // atomic queue cancellation. Archive never claims those records stopped.
  };
  await activity.start();
  await controls.start();
  const services: DeepseekService[] = [sessions, workspace, files, { ...terminal, close: terminal.dispose }, catalog, activity, deliverables];
  let closing: Promise<void> | undefined;
  return { services, owners, harness, sessions, workspace, files, terminal, catalog, activity, deliverables, tools, controls,
    http: deliverables.fetch,
    observe(callback: (event: AgentEvent) => Promise<void>): void { observers.add(callback); },
    close: (): Promise<void> => closing ??= (async () => {
      try { await controls?.close(); await activity?.close(); }
      finally {
        try { await terminalService.dispose(); }
        finally { try { await sessions.close(); } finally { await owners.close(); } }
      }
    })(),
  };
  } catch (error) {
    const results = await Promise.allSettled([controls?.close(), activity?.close(), terminal?.dispose(), owners.close()]);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError([error, ...failures.map(result => (result as PromiseRejectedResult).reason)], "DeepSeek composition startup and cleanup failed");
    throw error;
  }
}
