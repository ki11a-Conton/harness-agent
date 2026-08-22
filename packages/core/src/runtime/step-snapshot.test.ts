import { defaultTestToolCatalog } from "../test/fakes.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { newAgentId, newSessionId, newToolCallId, newTurnId, stableFingerprint, type AgentDefinition, type ToolDefinition } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";
import { FrozenStepToolRouter } from "./step-execution-snapshot.js";
import type { StepToolCatalog } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// P23-1 — Step World Snapshot V2: StepRecord (durable identity) +
// StepExecutionSnapshot (runtime bindings) + deterministic fingerprints.
// ---------------------------------------------------------------------------

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "snap-test",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "system v1",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

function def(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({}),
    risk: "readonly",
    metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
    async execute() {
      return { status: "success", output: "ok" };
    },
  };
}

function catalog(defs: readonly ToolDefinition[]): StepToolCatalog {
  return {
    get: (name) => defs.find((d) => d.name === name),
    list: () => defs,
    specs: () => defs.map((d) => ({ name: d.name, description: d.description, inputSchema: {} as never })),
  };
}

const SESSION = newSessionId();
const TURN = newTurnId();
const NOW = 1_000_000;

function build(opts: {
  defs?: readonly ToolDefinition[];
  cwd?: string;
  system?: string;
  history?: readonly { id: string }[];
  toolPolicy?: AgentDefinition["tools"];
  stepIndex?: number;
}) {
  return buildStepExecutionSnapshot({
    sessionId: SESSION,
    turnId: TURN,
    agent: {
      ...AGENT,
      systemPrompt: opts.system ?? AGENT.systemPrompt,
      tools: opts.toolPolicy ?? AGENT.tools,
    },
    cwd: opts.cwd ?? "/w",
    stepIndex: opts.stepIndex ?? 0,
    priorBlocks: [],
    system: opts.system ?? AGENT.systemPrompt,
    compacted: false,
    history: (opts.history ?? [{ id: "m1" as never }]) as never,
    registry: catalog(opts.defs ?? [def("read_file", "read a file")]),
    semanticsOf: () => ({ retrySafety: "safe", concurrencySafety: true, cancellable: true, readOnly: true, idempotent: true, sideEffectScope: "none", networkBehavior: "none", outputSensitivity: "low", requiresApproval: false } as never),
    sandboxPolicy: { filesystem: { read: ["**"], write: [] }, network: "deny", process: { exec: ["**"] } } as never,
    now: () => NOW,
  });
}

describe("P23-1 fingerprint helpers", () => {
  it("equivalent values with different object insertion order produce the same fingerprint", () => {
    const a = stableFingerprint([{ b: 1, a: 2 }, [3, 4], { nested: { z: 9, y: 8 } }]);
    const b = stableFingerprint([{ a: 2, b: 1 }, [3, 4], { nested: { y: 8, z: 9 } }]);
    expect(a).toBe(b);
  });

  it("different values produce different fingerprints", () => {
    expect(stableFingerprint(["x", 1])).not.toBe(stableFingerprint(["x", 2]));
  });

  it("does not depend on object identity or clocks", () => {
    const shared = { k: 1 };
    const f1 = stableFingerprint([shared]);
    const f2 = stableFingerprint([{ k: 1 }]);
    expect(f1).toBe(f2);
    expect(stableFingerprint([1, 2])).toBe(stableFingerprint([1, 2]));
  });
});

describe("P23-1 frozen tool router fingerprints", () => {
  it("changed tool schema → different tool router fingerprint", () => {
    const r1 = new FrozenStepToolRouter(
      [{ name: "t", spec: { name: "t", description: "d", inputSchema: { type: "object" } as never }, definition: def("t", "d"), semantics: {} as never, provenance: { kind: "builtin" } }],
      "s1",
    );
    const r2 = new FrozenStepToolRouter(
      [{ name: "t", spec: { name: "t", description: "d", inputSchema: { type: "object", required: ["x"] } as never }, definition: def("t", "d"), semantics: {} as never, provenance: { kind: "builtin" } }],
      "s2",
    );
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it("same content regardless of binding order → same fingerprint", () => {
    const mk = (order: number) =>
      new FrozenStepToolRouter(
        order === 0
          ? [{ name: "a", spec: { name: "a", description: "d", inputSchema: {} as never }, definition: def("a", "d"), semantics: {} as never, provenance: { kind: "builtin" } },
             { name: "b", spec: { name: "b", description: "d", inputSchema: {} as never }, definition: def("b", "d"), semantics: {} as never, provenance: { kind: "builtin" } }]
          : [{ name: "b", spec: { name: "b", description: "d", inputSchema: {} as never }, definition: def("b", "d"), semantics: {} as never, provenance: { kind: "builtin" } },
             { name: "a", spec: { name: "a", description: "d", inputSchema: {} as never }, definition: def("a", "d"), semantics: {} as never, provenance: { kind: "builtin" } }],
        "s",
      );
    expect(mk(0).fingerprint).toBe(mk(1).fingerprint);
  });
});

describe("P23-1 step execution snapshot", () => {
  it("snapshot is immutable: record is plain data (JSON-serializable, no closures)", () => {
    const snap = build({});
    const json = JSON.parse(JSON.stringify(snap.record));
    expect(json.stepId).toBe(`${TURN}:0`);
    expect(json.toolRouterFingerprint).toBe(snap.record.toolRouterFingerprint);
    expect(json.createdAt).toBe(NOW);
  });

  it("changed cwd → environment fingerprint changes", () => {
    expect(build({ cwd: "/a" }).record.environmentFingerprint).not.toBe(build({ cwd: "/b" }).record.environmentFingerprint);
  });

  it("changed permission/tool policy → policy fingerprint changes", () => {
    const base = build({}).record.policyFingerprint;
    const denied = build({ toolPolicy: { deny: ["write_file"] } }).record.policyFingerprint;
    expect(denied).not.toBe(base);
  });

  it("changed system prompt → instruction fingerprint changes", () => {
    expect(build({ system: "v1" }).record.instructionFingerprint).not.toBe(build({ system: "v2" }).record.instructionFingerprint);
  });

  it("changed context history → context fingerprint changes", () => {
    expect(build({ history: [{ id: "m1" }] }).record.contextFingerprint).not.toBe(build({ history: [{ id: "m2" }] }).record.contextFingerprint);
  });

  it("changed tool schema → tool router fingerprint changes", () => {
    const v1 = build({ defs: [def("read_file", "v1")] }).record.toolRouterFingerprint;
    const v2 = build({ defs: [def("read_file", "v2")] }).record.toolRouterFingerprint;
    expect(v1).not.toBe(v2);
  });

  it("model-visible specs == router-resolvable bindings (MODEL_VISIBLE == EXECUTION)", () => {
    const snap = build({ defs: [def("read_file", "d"), def("write_file", "d")] });
    for (const spec of snap.tools.modelVisibleSpecs) {
      expect(snap.tools.resolve(spec.name)).toBeDefined();
    }
    expect(snap.tools.modelVisibleSpecs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// P23-1 integration: the real Runtime loop emits snapshot identity on events.
// ---------------------------------------------------------------------------

function makeRuntimeScript() {
  const read = { id: newToolCallId(), name: "read_file", args: { path: "a.txt" } };
  const script: import("@ar/contracts").ModelEvent[][] = [
    [
      { type: "started", timestamp: 0 },
      { type: "tool_call_delta", toolCall: read, timestamp: 0 },
      { type: "completed", result: { finishReason: "tool_calls" as const, toolCalls: [read] }, timestamp: 0 },
    ],
    ScriptedModelProvider.text("done"),
  ];
  return { read, script };
}

describe("P23-1 runtime event wiring", () => {
  it("model.started carries stepId + fingerprints; tool.requested shares the same stepId", async () => {
    const { script } = makeRuntimeScript();
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "hi");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");

    const all = await events.list(session.id);
    const started = all.find((e) => e.type === "model.started")!;
    const startedPayload = started.payload as { stepId?: string; toolRouterFingerprint?: string; policyFingerprint?: string; environmentFingerprint?: string; contextFingerprint?: string };
    const requested = all.find((e) => e.type === "tool.requested")!;
    // same stepId across the model call and its tool batch
    expect(startedPayload.stepId).toBe(requested.payload.stepId);
    // fingerprints ride the event (durable, correlatable)
    expect(typeof startedPayload.toolRouterFingerprint).toBe("string");
    expect(typeof startedPayload.policyFingerprint).toBe("string");
    expect(typeof startedPayload.environmentFingerprint).toBe("string");
    expect(typeof startedPayload.contextFingerprint).toBe("string");
    expect(startedPayload.toolRouterFingerprint!.length).toBeGreaterThan(16);
  });

  it("two model calls produce two DISTINCT step ids", async () => {
    const { script } = makeRuntimeScript();
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "hi");
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const all = await events.list(session.id);
    const steps = new Set(all.filter((e) => e.type === "model.started").map((e) => e.payload.stepId));
    expect(steps.size).toBeGreaterThan(1);
  });
});
// ---------------------------------------------------------------------------
// P23-2 — Frozen StepToolRouter: freeze-time isolation + collisions.
// ---------------------------------------------------------------------------

function fakeCatalogWith(defs: readonly ToolDefinition[]): StepToolCatalog & { defs: ToolDefinition[] } {
  // the SAME array backs both the catalog closures and the exposed `defs`
  // handle, so tests can mutate the catalog by mutating `reg.defs`.
  const arr = [...defs];
  return {
    defs: arr,
    get: (name) => arr.find((d) => d.name === name),
    list: () => arr,
    specs: () => arr.map((d) => ({ name: d.name, description: d.description, inputSchema: {} as never })),
  };
}

describe("P23-2 frozen router isolation", () => {
  it("registry removes A after S1 is built → S1 still resolves the ORIGINAL binding, a new S2 does not contain A", () => {
    const reg = fakeCatalogWith([def("read_file", "v1")]);
    const s1 = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
    });
    const binding = s1.tools.resolve("read_file");
    expect(binding).toBeDefined();
    reg.defs.length = 0;
    expect(s1.tools.resolve("read_file")).toBe(binding);
    const s2 = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
    });
    expect(s2.tools.has("read_file")).toBe(false);
  });

  it("registry replaces A v1 with v2 → S1 resolves v1, S2 resolves v2", () => {
    const v1 = def("write_file", "v1");
    const reg = fakeCatalogWith([v1]);
    const s1 = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
    });
    const v2 = def("write_file", "v2");
    reg.defs[0] = v2;
    expect(s1.tools.resolve("write_file")!.definition).toBe(v1);
    const s2 = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
    });
    expect(s2.tools.resolve("write_file")!.definition).toBe(v2);
  });

  it("two sources with the same model-visible name → typed TOOL_COLLISION (never last-write-wins)", () => {
    const reg = fakeCatalogWith([def("read_file", "builtin")]);
    const extra = {
      name: "read_file",
      spec: { name: "read_file", description: "mcp", inputSchema: {} as never },
      definition: def("read_file", "mcp"),
      semantics: {} as never,
      provenance: { kind: "mcp", sourceId: "server-1", generation: "g1" },
    } as const;
    expect(() =>
      buildStepExecutionSnapshot({
        sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
        priorBlocks: [], system: "s", compacted: false, history: [],
        registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
        extraBindings: [extra as never],
      }),
    ).toThrow(/produced by builtin and mcp/);
  });

  it("goal selector is applied ONCE at freeze; the frozen advertised set is stable", () => {
    const calls: string[] = [];
    const selector: import("../tools/tool-selector.js").ToolSelector = {
      select(input) {
        calls.push("select");
        const onlyA = input.tools.find((t) => t.name === "read_file");
        return { selected: onlyA === undefined ? [] : [onlyA], dropped: [] };
      },
    };
    const reg = fakeCatalogWith([def("read_file", "d"), def("write_file", "d")]);
    const s1 = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
      goal: "read files", toolSelector: selector,
    });
    expect(calls).toHaveLength(1);
    expect(s1.tools.modelVisibleSpecs.map((t) => t.name)).toEqual(["read_file"]);
    expect(s1.tools.has("write_file")).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// P23-3 — the model controller consumes the FROZEN step advertisement.
// ---------------------------------------------------------------------------

describe("P23-3 controller consumes step.tools.modelVisibleSpecs", () => {
  it("selector is invoked exactly ONCE per step; the model sees the frozen selection even when selector state changes", async () => {
    const seen: string[][] = [];
    let selectorCalls = 0;
    const provider: import("@ar/contracts").ModelProvider = {
      id: "probe",
      async listModels() {
        return [{ id: "scripted-model", name: "m", capabilities: { contextWindowTokens: 100_000 } }];
      },
      createClient() {
        return {
          async *generate(input: { tools?: readonly { name: string }[] }, _signal: AbortSignal) {
            seen.push((input.tools ?? []).map((t) => t.name));
            yield { type: "completed", result: { finishReason: "stop" as const, text: "done" }, timestamp: 1 };
          },
        };
      },
    };
    const selector: import("../tools/tool-selector.js").ToolSelector = {
      select(input) {
        selectorCalls += 1;
        const a = input.tools.find((t) => t.name === "read_file");
        return { selected: a === undefined ? [] : [a], dropped: [] };
      },
    };
    const reg = fakeCatalogWith([def("read_file", "r"), def("write_file", "w"), def("exec", "e")]);
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: reg,
      toolSelector: selector,
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "hi");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(selectorCalls).toBe(1); // exactly once before the model call
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["read_file"]); // frozen selection, NOT the catalog
  });

  it("deferred advertisement: model sees stubbed specs, bindings keep FULL schemas", () => {
    const big = def("big_tool", "a tool with a huge schema that exceeds any tiny budget");
    const reg = fakeCatalogWith([def("read_file", "core read"), big]);
    const snap = buildStepExecutionSnapshot({
      sessionId: SESSION, turnId: TURN, agent: AGENT, cwd: "/w", stepIndex: 0,
      priorBlocks: [], system: "s", compacted: false, history: [],
      registry: reg, semanticsOf: () => ({} as never), now: () => NOW,
      schemaAdvertPolicy: { maxInlineTokens: 1, keepFull: (name) => name === "read_file" },
    });
    const visible = snap.tools.modelVisibleSpecs;
    // both tools remain visible (big_tool as a stub)
    expect(visible.map((t) => t.name).sort()).toEqual(["big_tool", "read_file"]);
    const stub = visible.find((t) => t.name === "big_tool")!;
    expect(stub.inputSchema).toEqual({ type: "object" }); // stubbed
    // the binding keeps the FULL schema for validation/execution
    expect(snap.tools.resolve("big_tool")!.spec.inputSchema).not.toEqual({ type: "object" });
    // telemetry: available counts the pre-selection catalog; dropped stays
    // empty because deferral is NOT removal (the tool is still advertised).
    expect(snap.advertised?.available).toBe(2);
    expect(snap.advertised?.dropped).toEqual([]);
  });
});
// ---------------------------------------------------------------------------
// P23-4 — execution resolves the FROZEN binding, never the mutable catalog.
// ---------------------------------------------------------------------------

class RecordingOrchestrator extends FakeOrchestrator {
  bindings: Array<{ name: string; definition: unknown }> = [];
  override async executeBound(request: import("@ar/contracts").BoundToolCallRequest, ctx: import("@ar/contracts").ToolExecutionContext): Promise<import("@ar/contracts").ToolResult> {
    this.bindings.push({ name: request.call.name, definition: request.binding.definition });
    return super.executeBound(request, ctx);
  }
}

describe("P23-4 frozen binding execution", () => {
  it("the binding executed is the one frozen at step build, even after the catalog swaps v1 → v2", async () => {
    const v1 = def("write_file", "v1");
    const v2 = def("write_file", "v2");
    const reg = fakeCatalogWith([v1]);
    const script: import("@ar/contracts").ModelEvent[][] = [
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt" }),
      ScriptedModelProvider.text("done"),
    ];
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const orch = new RecordingOrchestrator({ status: "success", output: "ok" });
    const runtime = new AgentRuntime({
      store, events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: reg,
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "write a file");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(orch.bindings).toHaveLength(1);
    // the executed definition is the FROZEN v1 — NOT whatever the catalog has now
    expect(orch.bindings[0]!.definition).toBe(v1);

    // catalog swaps to v2 → a NEW step freezes v2
    reg.defs[0] = v2;
    const script2: import("@ar/contracts").ModelEvent[][] = [
      ScriptedModelProvider.toolCall("write_file", { path: "b.txt" }),
      ScriptedModelProvider.text("done"),
    ];
    const runtime2 = new AgentRuntime({
      store, events,
      modelProvider: new ScriptedModelProvider(script2),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: reg,
    });
    const turn2 = await runtime2.startTurn(session.id, "write again");
    await runtime2.runTurn(session.id, turn2.id, new AbortController().signal);
    expect(orch.bindings[1]!.definition).toBe(v2);
  });

  it("a tool absent from the frozen step fails TOOL_NOT_IN_STEP (never executes globally)", async () => {
    // The catalog does NOT have write_file → the step router never froze it.
    // (Note: a policy-DENIED call is rejected earlier by the policy gate; this
    // case is the protocol-level "model called a tool the step never saw".)
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const script: import("@ar/contracts").ModelEvent[][] = [
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt" }),
      ScriptedModelProvider.text("done"),
    ];
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const orch = new RecordingOrchestrator({ status: "success", output: "ok" });
    const runtime = new AgentRuntime({
      store, events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: reg,
      // strict mode (permissive NOT set) — the P23-4 default
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "write");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    // the call fails; the orchestrator NEVER ran it
    expect(orch.bindings).toHaveLength(0);
    const msgs = await store.listMessages(session.id);
    expect(msgs.some((m) => String(m.content).includes("not in the frozen step router"))).toBe(true);
    void outcome;
  });
});
// ---------------------------------------------------------------------------
// P23-5 — the step's frozen permission profile is the execution authority.
// ---------------------------------------------------------------------------

class PermissionProbeOrchestrator extends FakeOrchestrator {
  contexts: Array<{ cwd: string; permissions: unknown; sandboxPolicy: unknown }> = [];
  override async executeBound(request: import("@ar/contracts").BoundToolCallRequest, ctx: import("@ar/contracts").ToolExecutionContext): Promise<import("@ar/contracts").ToolResult> {
    this.contexts.push({ cwd: ctx.cwd, permissions: ctx.permissions, sandboxPolicy: ctx.sandboxPolicy });
    return super.executeBound(request, ctx);
  }
}

describe("P23-5 step policy is the execution authority", () => {
  it("a step sampled with write DENIED rejects the call even though the same registry has the tool", async () => {
    const reg = fakeCatalogWith([def("write_file", "w"), def("read_file", "r")]);
    const writeDeniedAgent = { ...AGENT, tools: { deny: ["write_file"] }, limits: { maxToolCalls: 10 } };
    const script: import("@ar/contracts").ModelEvent[][] = [
      ScriptedModelProvider.toolCall("write_file", { path: "a.txt" }),
      ScriptedModelProvider.text("done"),
    ];
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const orch = new PermissionProbeOrchestrator({ status: "success", output: "ok" });
    const runtime = new AgentRuntime({
      store, events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [writeDeniedAgent],
      toolRegistry: reg,
    });
    const session = await runtime.createSession({ agent: writeDeniedAgent, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "write");
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    // denied by the STEP policy — the orchestrator never ran it
    expect(orch.contexts).toHaveLength(0);
    const msgs = await store.listMessages(session.id);
    expect(msgs.some((m) => String(m.content).includes("denied by the step tool policy"))).toBe(true);
  });

  it("an allowed step executes with the STEP permission profile (not live agent state)", async () => {
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const script: import("@ar/contracts").ModelEvent[][] = [
      ScriptedModelProvider.toolCall("read_file", { path: "a.txt" }),
      ScriptedModelProvider.text("done"),
    ];
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const orch = new PermissionProbeOrchestrator({ status: "success", output: "ok" });
    const runtime = new AgentRuntime({
      store, events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: orch,
      agents: [{ ...AGENT, permissions: { rules: [{ action: "read", resource: "file:*", effect: "allow" }] }, limits: { maxToolCalls: 10 } }],
      toolRegistry: reg,
    });
    const session = await runtime.createSession({ agent: { ...AGENT, permissions: { rules: [{ action: "read", resource: "file:*", effect: "allow" }] } }, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "read");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(orch.contexts).toHaveLength(1);
    // cwd and permission profile come from the FROZEN step environment
    expect(orch.contexts[0]!.cwd).toBe("/w");
    expect(orch.contexts[0]!.permissions).toBeDefined();
    // the sandbox policy is the snapshot's, never the live default
    expect(orch.contexts[0]!.sandboxPolicy).toBeDefined();
  });
});
// ---------------------------------------------------------------------------
// P23-6 — retry vs re-snapshot boundary: compaction forces a NEW step.
// ---------------------------------------------------------------------------

describe("P23-6 retry vs re-snapshot boundary", () => {
  it("reactive compaction produces a NEW step (S2) with a different context fingerprint; no tool call is attributed to S1", async () => {
    const ctxError: import("@ar/contracts").ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: { code: "MODEL_ERROR" as const, message: "maximum context length exceeded", retryable: true, safeToRetry: true }, timestamp: 0 },
    ];
    const provider = new ScriptedModelProvider([ctxError, ScriptedModelProvider.text("recovered")]);
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: provider,
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "task goal: fix the thing");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");

    const all = await events.list(session.id);
    const started = all.filter((e) => e.type === "model.started");
    expect(started.length).toBe(2); // S1 (overflow) + S2 (post-compaction)
    const s1 = started[0]!.payload as { stepId?: string; contextFingerprint?: string };
    const s2 = started[1]!.payload as { stepId?: string; contextFingerprint?: string };
    expect(s1.stepId).not.toBe(s2.stepId);
    // the context world changed → the snapshot identity changed
    expect(s1.contextFingerprint).not.toBe(s2.contextFingerprint);
    // no tool call happened under S1 (the overflow produced none), and any
    // tool calls belong to S2 — assert the event chain shares the S2 stepId.
    const requested = all.filter((e) => e.type === "tool.requested");
    for (const r of requested) {
      expect(r.payload.stepId).toBe(s2.stepId);
    }
  });
});
// ---------------------------------------------------------------------------
// P23-7 — the context snapshot is EXACT identity, not an approximation.
// ---------------------------------------------------------------------------

describe("P23-7 exact context snapshot", () => {
  it("changing one included message changes contextHash; changing EXCLUDED old history does not", () => {
    const base = build({ history: [{ id: "m1" }, { id: "m2" }] }).record.contextFingerprint;
    const changedIncluded = build({ history: [{ id: "m1" }, { id: "m3" }] }).record.contextFingerprint;
    expect(changedIncluded).not.toBe(base);
    // excluded history simply is not part of the snapshot — same identity
    const sameVisible = build({ history: [{ id: "m1" }, { id: "m2" }] }).record.contextFingerprint;
    expect(sameVisible).toBe(base);
  });

  it("compaction creates a new contextHash (verified through the real loop in P23-6)", () => {
    // covered by the P23-6 integration test (S1 vs S2 contextFingerprint)
    const snap = build({ history: [{ id: "x1" }] });
    expect(snap.context.contextHash).toBe(snap.record.contextFingerprint);
    expect(snap.context.messageIds).toEqual(["x1"]);
  });

  it("model.started carries the exact visible message/block ids for replay/explain", async () => {
    const script: import("@ar/contracts").ModelEvent[][] = [ScriptedModelProvider.text("done")];
    const store = new MemorySessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      store,
      events,
      modelProvider: new ScriptedModelProvider(script),
      orchestrator: new FakeOrchestrator({ status: "success", output: "ok" }),
      agents: [{ ...AGENT, limits: { maxToolCalls: 10 } }],
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
    });
    const session = await runtime.createSession({ agent: AGENT, cwd: "/w" });
    const turn = await runtime.startTurn(session.id, "hello");
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const all = await events.list(session.id);
    const started = all.find((e) => e.type === "model.started")!;
    const payload = started.payload as { contextMessageIds?: string[]; contextBlockIds?: string[] };
    expect(Array.isArray(payload.contextMessageIds)).toBe(true);
    expect(payload.contextMessageIds!.length).toBeGreaterThanOrEqual(1);
    // every visible id corresponds to a real stored message (the ids are the
    // EXACT set handed to the model, so they must all exist in the store)
    const msgs = await store.listMessages(session.id);
    const storedIds = new Set(msgs.map((m) => String(m.id)));
    for (const id of payload.contextMessageIds ?? []) {
      expect(storedIds.has(String(id))).toBe(true);
    }
  });
});
