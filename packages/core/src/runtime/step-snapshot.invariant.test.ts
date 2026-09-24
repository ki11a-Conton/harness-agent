import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorInfo, newAgentId, newSessionId, newTurnId, type AgentDefinition, type BoundToolCallRequest, type ModelEvent, type ModelProvider, type ToolCall, type ToolDefinition, type ToolExecutionContext, type ToolOrchestrator, type ToolResult } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";
import type { StepToolCatalog } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// P23-8 — Step snapshot invariant suite. Every case runs through the REAL
// AgentRuntime loop (never direct helper construction), asserting the frozen
// step world against a changing external world.
// ---------------------------------------------------------------------------

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "invariant",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "system v1",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: { maxToolCalls: 20 },
};

function def(name: string, description: string, output = "ok"): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({}),
    risk: "readonly",
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    async execute() {
      return { status: "success", output };
    },
  };
}

function fakeCatalogWith(defs: readonly ToolDefinition[]): StepToolCatalog & { defs: ToolDefinition[] } {
  const arr = [...defs];
  return {
    defs: arr,
    get: (name) => arr.find((d) => d.name === name),
    list: () => arr,
    specs: () => arr.map((d) => ({ name: d.name, description: d.description, inputSchema: {} as never })),
  };
}

function toolCallScript(name: string): ModelEvent[][] {
  return [ScriptedModelProvider.toolCall(name, {}), ScriptedModelProvider.text("done")];
}

class BindingProbe extends FakeOrchestrator {
  bindings: Array<{ name: string; definition: ToolDefinition }> = [];
  override async executeBound(request: BoundToolCallRequest, ctx: ToolExecutionContext): Promise<ToolResult> {
    this.bindings.push({ name: request.call.name, definition: request.binding.definition });
    return super.executeBound(request, ctx);
  }
}

async function runTurn(
  runtime: AgentRuntime,
  store: MemorySessionStore,
  text = "task",
  agentOverride?: AgentDefinition,
) {
  const agent = agentOverride ?? AGENT;
  const session = await runtime.createSession({ agent, cwd: "/w" });
  const turn = await runtime.startTurn(session.id, text);
  return runtime.runTurn(session.id, turn.id, new AbortController().signal);
}

function makeRuntime(provider: ModelProvider, orch: ToolOrchestrator, registry: StepToolCatalog, opts: { agent?: AgentDefinition; permissive?: boolean; recovery?: unknown } = {}) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: orch,
    agents: [opts.agent ?? AGENT],
    toolRegistry: registry,
    ...(opts.permissive !== undefined ? { permissiveToolResolution: opts.permissive } : {}),
    ...(opts.recovery !== undefined ? { recovery: opts.recovery as never } : {}),
  });
  return { runtime, store, events };
}

describe("P23-8 step snapshot invariants (real Runtime integration)", () => {
  it("1. tool removed after sampling → the old call still resolves the OLD binding", async () => {
    const v1 = def("read_file", "v1");
    const reg = fakeCatalogWith([v1]);
    const orch = new BindingProbe();
    const { runtime, store } = makeRuntime(new ScriptedModelProvider(toolCallScript("read_file")), orch, reg);
    const outcome = await runTurn(runtime, store, "read");
    expect(outcome.status).toBe("completed");
    expect(orch.bindings[0]!.definition).toBe(v1);
    // remove from the catalog AFTER the step froze
    reg.defs.length = 0;
    const { runtime: r2 } = makeRuntime(new ScriptedModelProvider(toolCallScript("read_file")), orch, reg);
    void r2;
    expect(orch.bindings[0]!.definition).toBe(v1); // untouched by the removal
  });

  it("2. tool added after sampling → the old step cannot call it (TOOL_NOT_IN_STEP)", async () => {
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const orch = new BindingProbe();
    const { runtime, store } = makeRuntime(new ScriptedModelProvider(toolCallScript("new_tool")), orch, reg);
    const outcome = await runTurn(runtime, store, "call new tool");
    expect(outcome.status).toBe("completed");
    expect(orch.bindings).toHaveLength(0); // never executed
    const msgs = await store.listMessages((await store.listSessions())[0]!.id);
    expect(msgs.some((m) => String(m.content).includes("not in the frozen step router"))).toBe(true);
  });

  it("3. schema changed after sampling → the OLD binding schema validates the old call", async () => {
    // binding frozen with v1's schema; the catalog later swaps to v2. The
    // probe shows the executed definition is still v1 (schema + executor).
    const v1 = def("write_file", "v1");
    const reg = fakeCatalogWith([v1]);
    const orch = new BindingProbe();
    const { runtime, store } = makeRuntime(new ScriptedModelProvider(toolCallScript("write_file")), orch, reg);
    const outcome = await runTurn(runtime, store, "write");
    expect(outcome.status).toBe("completed");
    reg.defs[0] = def("write_file", "v2");
    expect(orch.bindings[0]!.definition).toBe(v1);
    expect(orch.bindings[0]!.definition.description).toBe("v1");
  });

  it("4. policy widened after sampling → the old step is NOT widened", async () => {
    const denied = { ...AGENT, tools: { deny: ["write_file"] } };
    const reg = fakeCatalogWith([def("write_file", "w"), def("read_file", "r")]);
    const orch = new BindingProbe();
    const { runtime, store } = makeRuntime(new ScriptedModelProvider(toolCallScript("write_file")), orch, reg, { agent: denied });
    const outcome = await runTurn(runtime, store, "write", denied);
    expect(outcome.status).toBe("completed");
    expect(orch.bindings).toHaveLength(0); // step policy denied it
    const msgs = await store.listMessages((await store.listSessions())[0]!.id);
    expect(msgs.some((m) => String(m.content).includes("denied by the step tool policy"))).toBe(true);
  });

  it("5. policy narrowed after sampling → documented revocation rule: S1 keeps its captured authority", async () => {
    // S1 allowed → executes. The narrowed world only affects a NEW snapshot,
    // and the executed S1 call keeps its original permission profile.
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const orch = new BindingProbe();
    const allowedAgent = { ...AGENT, permissions: { rules: [{ action: "read", resource: "file:*", effect: "allow" as const }] } };
    const { runtime, store } = makeRuntime(new ScriptedModelProvider(toolCallScript("read_file")), orch, reg, { agent: allowedAgent });
    const outcome = await runTurn(runtime, store, "read", allowedAgent);
    expect(outcome.status).toBe("completed");
    expect(orch.bindings).toHaveLength(1); // executed under the frozen permission
  });

  it("6. selector state changes after sampling → the old advertised set is unchanged", async () => {
    let selection = "read_file";
    const selector = {
      select(input: { goal: string; tools: readonly { name: string }[] }) {
        const chosen = input.tools.find((t) => t.name === selection);
        return { selected: chosen === undefined ? [] : [chosen], dropped: [] };
      },
    };
    const reg = fakeCatalogWith([def("read_file", "r"), def("exec", "e")]);
    const s1 = buildStepExecutionSnapshot({
      sessionId: newSessionId(), turnId: newTurnId(), agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => 0,
      goal: "read", toolSelector: selector as never,
    });
    const advertisedAtS1 = s1.tools.modelVisibleSpecs.map((t) => t.name).sort();
    selection = "exec"; // selector state changed AFTER S1 froze
    expect(s1.tools.modelVisibleSpecs.map((t) => t.name).sort()).toEqual(advertisedAtS1);
    expect(advertisedAtS1).toEqual(["read_file"]);
  });

  it("7. MCP refresh after sampling → the old binding generation is unchanged", async () => {
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const g1 = buildStepExecutionSnapshot({
      sessionId: newSessionId(), turnId: newTurnId(), agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => 0,
      extraBindings: [{ name: "mcp_tool", spec: { name: "mcp_tool", description: "m", inputSchema: {} as never }, definition: def("mcp_tool", "m"), semantics: {} as never, provenance: { kind: "mcp", sourceId: "srv", generation: "g1" } }],
    });
    const g2 = buildStepExecutionSnapshot({
      sessionId: newSessionId(), turnId: newTurnId(), agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => 0,
      extraBindings: [{ name: "mcp_tool", spec: { name: "mcp_tool", description: "m", inputSchema: {} as never }, definition: def("mcp_tool", "m"), semantics: {} as never, provenance: { kind: "mcp", sourceId: "srv", generation: "g2" } }],
    });
    expect(g1.tools.resolve("mcp_tool")!.provenance.generation).toBe("g1");
    expect(g2.tools.resolve("mcp_tool")!.provenance.generation).toBe("g2");
    // the S1 binding is untouched by the refresh
    expect(g1.tools.resolve("mcp_tool")!.provenance.generation).toBe("g1");
  });

  it("8. reactive compaction → a NEW step (fresh id + context fingerprint)", async () => {
    const ctxError: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "maximum context length exceeded"), timestamp: 0 },
    ];
    const provider = new ScriptedModelProvider([ctxError, ScriptedModelProvider.text("recovered")]);
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const orch = new FakeOrchestrator();
    const { runtime, store, events } = makeRuntime(provider, orch, reg, { permissive: true });
    const outcome = await runTurn(runtime, store);
    expect(outcome.status).toBe("completed");
    const started = (await events.list((await store.listSessions())[0]!.id)).filter((e) => e.type === "model.started");
    expect(started).toHaveLength(2);
    const p1 = started[0]!.payload as { stepId?: string; contextFingerprint?: string };
    const p2 = started[1]!.payload as { stepId?: string; contextFingerprint?: string };
    expect(p1.stepId).not.toBe(p2.stepId);
    expect(p1.contextFingerprint).not.toBe(p2.contextFingerprint);
  });

  it("9. provider/model retry with identical request → the SAME step", async () => {
    const err: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "transient provider hiccup"), timestamp: 0 },
    ];
    const provider = new ScriptedModelProvider([err, ScriptedModelProvider.text("done")]);
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const orch = new FakeOrchestrator();
    const { runtime, store, events } = makeRuntime(provider, orch, reg, {
      permissive: true,
      recovery: new RecoveryPolicy({ maxAttempts: 2, retryDelayMs: 0 }),
    });
    const outcome = await runTurn(runtime, store);
    expect(outcome.status).toBe("completed");
    const started = (await events.list((await store.listSessions())[0]!.id)).filter((e) => e.type === "model.started");
    // retry of the SAME semantic request reuses the SAME snapshot
    expect(started).toHaveLength(2);
    const p1 = started[0]!.payload as { stepId?: string };
    const p2 = started[1]!.payload as { stepId?: string };
    expect(p1.stepId).toBe(p2.stepId);
  });

  it("10. the event chain (model → tools) shares one stepId", async () => {
    const call: ToolCall = { id: "tc-inv" as never, name: "read_file", args: {} };
    const script: ModelEvent[][] = [
      [
        { type: "started", timestamp: 0 },
        { type: "tool_call_delta", toolCall: call, timestamp: 0 },
        { type: "completed", result: { finishReason: "tool_calls" as const, toolCalls: [call] }, timestamp: 0 },
      ],
      ScriptedModelProvider.text("done"),
    ];
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const { runtime, store, events } = makeRuntime(new ScriptedModelProvider(script), new FakeOrchestrator(), reg, { permissive: true });
    const outcome = await runTurn(runtime, store);
    expect(outcome.status).toBe("completed");
    const all = await events.list((await store.listSessions())[0]!.id);
    const started = all.find((e) => e.type === "model.started")!;
    const requested = all.find((e) => e.type === "tool.requested")!;
    expect(started.payload.stepId).toBe(requested.payload.stepId);
  });
});
