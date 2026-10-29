import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent, AgentId, SessionId, ToolCallId, ToolDefinition, ToolExecutionContext, ToolResult } from "@ar/contracts";
import { newEventId, toToolSemantics } from "@ar/contracts";
import type { Harness } from "@ar/harness";
import { resolveProfile } from "@ar/harness";
import { ToolOrchestrator, ToolRegistry } from "@ar/tools";
import { StoreApprovalResolver } from "@ar/security";
import { RemoteFailure } from "./transport.js";

/** UI-only tools never enter the model-visible catalog. Contexts are minted here. */
export function createHostTools(harness: Harness, cwd: string, dataDir?: string, ownerOf?: (sessionId: string) => Promise<Harness> | Harness,
  nativeSessionId?: (sessionId: string) => SessionId,
  controlProjectTool?: (sessionId: string, definition: ToolDefinition, context: ToolExecutionContext, execute: (context: ToolExecutionContext) => Promise<ToolResult>) => Promise<ToolResult>) {
  const root = resolve(dataDir ?? cwd, "deepseek");
  const registry = new ToolRegistry();
  const hidden = new Set<string>();
  let hostSession: Promise<SessionId> | undefined;
  const identity = (): Promise<SessionId> => hostSession ??= (async () => {
    const agent = harness.agents[0];
    if (!agent) throw new RemoteFailure("gateway/unavailable", "No host agent is registered");
    const session = await harness.runtime.createSession({ agent, cwd, initialStatus: "failed" });
    hidden.add(session.id); return session.id;
  })();
  const hostOrchestrators = new WeakMap<Harness, ToolOrchestrator>();
  function hostOrchestrator(owner: Harness): ToolOrchestrator {
    let orchestrator = hostOrchestrators.get(owner);
    if (orchestrator !== undefined) return orchestrator;
    orchestrator = new ToolOrchestrator({ registry, workspaceRoot: root,
      persistIntent: async intent => {
        // Contexts and private intents belong to the physical owner. The Web
        // facade intentionally refuses a replacement native ID from a client.
        await owner.events.appendNew({ id: newEventId(), sessionId: intent.sessionId as SessionId, timestamp: Date.now(), type: "tool.intent_persisted", payload: { ...intent, hostOnly: true } });
      },
    });
    hostOrchestrators.set(owner, orchestrator); return orchestrator;
  }
  const projectOrchestrators = new Map<string, ToolOrchestrator>();
  function projectOrchestrator(workspaceRoot: string, owner: Harness): ToolOrchestrator {
    const key = `${workspaceRoot}\0${owner.agents[0]?.id}`;
    let orchestrator = projectOrchestrators.get(key);
    if (orchestrator !== undefined) return orchestrator;
    orchestrator = new ToolOrchestrator({
    registry, workspaceRoot, approval: new StoreApprovalResolver(owner.approvalStore),
    events: { emit: async (sessionId, type, payload, turnId) => {
      // Successful private read polling is not a model tool execution. Retain
      // actual denials/errors, but do not grow history for each UI refresh.
      const definition = typeof payload.tool === "string" ? registry.get(payload.tool) : undefined;
      if (definition?.risk === "readonly" && type !== "tool.failed" && type !== "security.permission_denied") return;
      await owner.events.appendNew({ id: newEventId(), sessionId, timestamp: Date.now(), type: type as AgentEvent["type"], payload: { ...payload, hostOnly: true }, ...(turnId === undefined ? {} : { turnId }) });
    } },
    persistIntent: async intent => { await owner.events.appendNew({ id: newEventId(), sessionId: intent.sessionId as SessionId, timestamp: Date.now(), type: "tool.intent_persisted", payload: { ...intent, hostOnly: true } }); },
    });
    projectOrchestrators.set(key, orchestrator); return orchestrator;
  }
  function bound(definition: ToolDefinition, sessionId: SessionId, agentId: AgentId, args: Record<string, unknown>) {
    const id = randomUUID() as ToolCallId;
    return { id, sessionId, agentId, call: { id, name: definition.name, args }, binding: {
      name: definition.name, spec: { name: definition.name, description: definition.description, inputSchema: {} }, definition,
      semantics: toToolSemantics(definition.metadata, definition.risk), provenance: { kind: "builtin" as const, sourceId: "web-host" },
    } };
  }
  return {
    hidden,
    registeredTools(): readonly ToolDefinition[] { return registry.list(); },
    registerTool(definition: ToolDefinition): void {
      const prior = registry.get(definition.name);
      if (prior === definition) return;
      if (prior !== undefined) throw new Error(`Private host tool is already registered: ${definition.name}`);
      registry.register(definition);
    },
    async executeHostTool(sessionId: string | undefined, definition: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
      signal.throwIfAborted();
      // Only server-owned definitions and fixed metadata paths use the host privilege.
      if (!definition.name.startsWith("web_") || !definition.metadata.filesystem || definition.metadata.process || definition.metadata.network
        || typeof args.path !== "string") throw new RemoteFailure("gateway/forbidden", "Invalid host metadata operation");
      const target = resolve(args.path); const delta = relative(root, target);
      const memoryMetadata = dataDir === undefined && target === resolve(cwd, ".deepseek-memory-metadata");
      if (!memoryMetadata && (delta === "" || isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`))) throw new RemoteFailure("gateway/forbidden", "Metadata path is outside the fixed host directory");
      const owner = sessionId === undefined ? await identity() : sessionId as SessionId;
      const actualOwner = await ownerOf?.(owner) ?? harness;
      const physicalId = nativeSessionId?.(owner) ?? owner;
      if (!await actualOwner.store.getSession(physicalId)) throw new RemoteFailure("session/not-found", "Metadata owner does not exist");
      // Observers also authorize tools while a terminal event is publishing.
      // Resolve frozen policy without reentering that event's recovery lock.
      const agent = await actualOwner.runtime.getSessionAgentPolicy(physicalId);
      const context: ToolExecutionContext = { sessionId: physicalId, agentId: agent.id, cwd: root, signal,
        permissions: { defaultEffect: "deny", rules: [{ action: definition.risk === "readonly" ? "read" : "edit", resource: "file", effect: "allow", scope: "call", pattern: target }] },
        sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [target] }, network: { mode: "deny" }, process: { allowedCommands: [] } } };
      return hostOrchestrator(actualOwner).executeBound(bound(definition, physicalId, agent.id, args), context);
    },
    async executeTool(sessionId: string | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
      signal.throwIfAborted();
      const definition = registry.get(name);
      if (!definition) throw new RemoteFailure("gateway/not-found", `Private host tool is unavailable: ${name}`);
      const owner = sessionId === undefined ? await identity() : sessionId as SessionId;
      const actualOwner = await ownerOf?.(owner) ?? harness;
      const physicalId = nativeSessionId?.(owner) ?? owner;
      const session = await actualOwner.store.getSession(physicalId);
      if (!session) throw new RemoteFailure("session/not-found", "Tool session does not exist");
      const agent = await actualOwner.runtime.getSessionAgentPolicy(physicalId);
      const sandboxPolicy = actualOwner.config.sandboxPolicy ?? resolveProfile(actualOwner.profile).sandbox;
      let context: ToolExecutionContext = { sessionId: physicalId, agentId: agent.id, cwd: session.cwd, permissions: agent.permissions, sandboxPolicy, signal };
      if (sessionId === undefined && name === "web_workspace_read" && args.operation === "directoryList" && typeof args.path === "string" && isAbsolute(args.path)) {
        // The local human folder picker lists directories. It cannot read file contents
        // or grant these navigation privileges to any model session.
        context = { ...context, cwd: resolve(args.path), permissions: { defaultEffect: "deny", rules: [{ action: "read", resource: "file", effect: "allow" }] },
          sandboxPolicy: { filesystem: { mode: "read-only", allowedPaths: [resolve(args.path)] }, network: { mode: "deny" }, process: { allowedCommands: [] } } };
      }
      if (sessionId === undefined && name === "web_workspace_mkdir" && typeof args.path === "string" && isAbsolute(args.path)) {
        context = { ...context, cwd: dirname(resolve(args.path)), permissions: { defaultEffect: "deny", rules: [{ action: "edit", resource: "file", effect: "allow" }] },
          sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [resolve(args.path)] }, network: { mode: "deny" }, process: { allowedCommands: [] } } };
      }
      if (sessionId === undefined && name === "web_model_discovery" && typeof args.url === "string") {
        // The models dialog verifies the endpoint the local human just typed. That
        // call belongs to the invisible host session, so the approval it would
        // otherwise raise has no surface to appear on: the dialog can only wait the
        // approval out and then report a failure. The click is the authorisation, so
        // allow this one call and pin the sandbox to exactly the requested host.
        const endpoint = hostOf(args.url);
        if (endpoint !== undefined) context = { ...context, permissions: { defaultEffect: "deny", rules: [{ action: "exec", resource: "network", effect: "allow", scope: "call" }] },
          sandboxPolicy: { filesystem: { mode: "read-only", allowedPaths: [root] }, network: { mode: "allowlist", hosts: [endpoint] }, process: { allowedCommands: [] } } };
      }
      const execute = (next: ToolExecutionContext) => projectOrchestrator(next.cwd, actualOwner).executeBound(bound(definition, physicalId, agent.id, args), next);
      // Human cleanup of an already owned terminal retains the original
      // permission/sandbox/ownership checks. A restrictive task mode must not
      // trap a resource that the human is trying to stop; new input/create
      // operations still traverse the session control policy below.
      const cleanup = name === "web_terminal_control" && args.operation === "close";
      return sessionId === undefined || controlProjectTool === undefined || cleanup ? execute(context) : controlProjectTool(sessionId, definition, context, execute);
    },
  };
}

/** Host of an absolute endpoint URL; undefined when the argument is not one. */
function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}
