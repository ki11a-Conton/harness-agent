import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildLocalEnvironmentSnapshot,
  buildSkillSnapshot,
  stableFingerprint,
  errorInfo,
  newAgentId,
  newSessionId,
  newTurnId,
  type AgentDefinition,
  type InstructionSource,
  type ModelEvent,
  type ModelProvider,
  type ToolDefinition,
  type ToolSemantics,
} from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";
import { buildStepExecutionSnapshot } from "./step-snapshot-factory.js";
import type { StepToolCatalog } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// P34-1 — World-snapshot conformance suite.
//
// Top-level invariant: MODEL_VISIBLE_WORLD(step N) == TOOL_EXECUTION_WORLD(step N),
// frozen BEFORE the model call; a mid-run change to ANY world dimension can
// only affect step N+1. Every case asserts either "old Step immutable" or
// "new Step updated" on a REAL runtime loop or the REAL snapshot builder.
//
// Dimensions covered (plan.md P34-1):
//   1. tool catalog drift        2. MCP drift
//   3. policy drift              4. instruction drift
//   5. skill drift               6. model switch
//   7. context compaction        8. environment drift
// ---------------------------------------------------------------------------

const AGENT = {
  id: newAgentId(),
  name: "conformance",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "system v1",
  tools: {},
  permissions: { rules: [] as const },
  skills: {},
  limits: { maxToolCalls: 20 },
} satisfies AgentDefinition;

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

function makeRuntime(
  provider: ModelProvider,
  registry: StepToolCatalog,
  opts: { agent?: typeof AGENT; permissive?: boolean } = {},
) {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: provider,
    orchestrator: new FakeOrchestrator(),
    agents: [opts.agent ?? AGENT],
    toolRegistry: registry,
    ...(opts.permissive !== undefined ? { permissiveToolResolution: opts.permissive } : {}),
  });
  return { runtime, store, events };
}

async function runTurn(runtime: AgentRuntime, store: MemorySessionStore, text = "task", agent = AGENT) {
  const session = await runtime.createSession({ agent, cwd: "/w" });
  const turn = await runtime.startTurn(session.id, text);
  return runtime.runTurn(session.id, turn.id, new AbortController().signal);
}

type SnapshotInput = Parameters<typeof buildStepExecutionSnapshot>[0];

function baseSnapshotInput(over: Partial<SnapshotInput> = {}) {
  return {
    sessionId: newSessionId(),
    turnId: newTurnId(),
    agent: AGENT,
    cwd: "/w",
    stepIndex: 0,
    priorBlocks: [],
    system: "system v1",
    compacted: false,
    history: [],
    registry: fakeCatalogWith([def("read_file", "r")]),
    semanticsOf: () => ({} as never),
    now: () => 0,
    ...over,
  } as SnapshotInput;
}

describe("P34-1 world snapshot conformance (old immutable / new updated)", () => {
  it("1.1 tool catalog drift — removal/schema change freezes the OLD binding", async () => {
    const v1 = def("read_file", "v1");
    const reg = fakeCatalogWith([v1]);
    const s1 = buildStepExecutionSnapshot(baseSnapshotInput({ registry: reg }));
    expect(s1.tools.resolve("read_file")!.definition).toBe(v1);
    reg.defs.length = 0; // world changes AFTER S1 froze
    expect(s1.tools.resolve("read_file")!.definition).toBe(v1); // old immutable
    const s2 = buildStepExecutionSnapshot(baseSnapshotInput({ registry: reg }));
    expect(s2.tools.resolve("read_file")).toBeUndefined(); // new updated
  });

  it("1.2 MCP drift — generations never bleed across snapshots", async () => {
    const mk = (gen: string) =>
      buildStepExecutionSnapshot(
        baseSnapshotInput({
          extraBindings: [
            {
              name: "mcp_tool",
              spec: { name: "mcp_tool", description: "m", inputSchema: {} as never },
              definition: def("mcp_tool", "m"),
              semantics: {} as never,
              provenance: { kind: "mcp", sourceId: "srv", generation: gen },
            },
          ],
        }),
      );
    const g1 = mk("g1");
    const g2 = mk("g2");
    expect(g1.tools.resolve("mcp_tool")!.provenance.generation).toBe("g1");
    expect(g2.tools.resolve("mcp_tool")!.provenance.generation).toBe("g2");
    expect(g1.tools.resolve("mcp_tool")!.provenance.generation).toBe("g1"); // S1 untouched
  });

  it("1.3 policy drift — a policy change re-fingerprints the NEXT step; the old step keeps its signed authority", () => {
    const allow = { ...AGENT, permissions: { rules: [{ action: "read" as const, resource: "file:*" as const, effect: "allow" as const }] } };
    const s1 = buildStepExecutionSnapshot(baseSnapshotInput({ agent: allow }));
    const s2 = buildStepExecutionSnapshot(baseSnapshotInput());
    expect(s1.record.policyFingerprint).not.toBe(s2.record.policyFingerprint); // new updated
    expect(s1.permissions.fingerprint).toBe(s1.record.policyFingerprint); // old signed authority
  });

  it("1.4 instruction drift — source change re-fingerprints the NEXT step, never mutates the current", () => {
    const src = (path: string): InstructionSource => ({
      kind: "project_instruction",
      source: path,
      path,
      contentHash: stableFingerprint([path]),
    });
    const s1 = buildStepExecutionSnapshot(baseSnapshotInput({ instructionSources: [src("AGENTS.md")] }));
    const fp1 = s1.record.instructionFingerprint;
    const s2 = buildStepExecutionSnapshot(baseSnapshotInput({ instructionSources: [src("/docs/NEW.md")] }));
    expect(s1.instructions.sources[0]!.path).toBe("AGENTS.md"); // old immutable
    expect(s2.record.instructionFingerprint).not.toBe(fp1); // new updated
  });

  it("1.5 skill drift — body-hash change re-fingerprints the NEXT step; old skill snapshot immutable", () => {
    const base = { name: "s", source: "pkg", requiredTools: [], requiredMcpServers: [] };
    const s1 = buildStepExecutionSnapshot(
      baseSnapshotInput({ skills: buildSkillSnapshot([{ ...base, bodyHash: "aaa" }]) }),
    );
    const fp1 = s1.record.skillSnapshotFingerprint!;
    const s2 = buildStepExecutionSnapshot(
      baseSnapshotInput({ skills: buildSkillSnapshot([{ ...base, bodyHash: "bbb" }]) }),
    );
    expect(s1.skills!.selected[0]!.bodyHash).toBe("aaa"); // old immutable
    expect(s2.record.skillSnapshotFingerprint).not.toBe(fp1); // new updated
    // P32 contract: object KEY order is irrelevant (canonical json), but the
    // selected ARRAY order is significant — selection order is part of the
    // model-visible prompt surface, so reordering re-fingerprints.
    const ab = buildSkillSnapshot([
      { name: "a", source: "p", bodyHash: "h", requiredTools: [], requiredMcpServers: [] },
      { name: "b", source: "p", bodyHash: "h", requiredTools: [], requiredMcpServers: [] },
    ]);
    const ba = buildSkillSnapshot([
      { name: "b", source: "p", bodyHash: "h", requiredTools: [], requiredMcpServers: [] },
      { name: "a", source: "p", bodyHash: "h", requiredTools: [], requiredMcpServers: [] },
    ]);
    expect(ab.fingerprint).not.toBe(ba.fingerprint);
  });

  it("1.6 model switch — mid-run model change only affects the NEXT step", () => {
    const s1 = buildStepExecutionSnapshot(baseSnapshotInput());
    expect(s1.model).toEqual({ providerId: "scripted", modelId: "scripted-model" });
    const switched = { ...AGENT, model: { providerId: "scripted", modelId: "other" } };
    const s2 = buildStepExecutionSnapshot(baseSnapshotInput({ agent: switched }));
    expect(s2.model).toEqual({ providerId: "scripted", modelId: "other" }); // new updated
    expect(s1.model).toEqual({ providerId: "scripted", modelId: "scripted-model" }); // old immutable
  });

  it("1.7 context compaction — reactive compaction produces a NEW step (fresh id + fingerprint)", async () => {
    const ctxError: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "maximum context length exceeded"), timestamp: 0 },
    ];
    const provider = new ScriptedModelProvider([ctxError, ScriptedModelProvider.text("recovered")]);
    const reg = fakeCatalogWith([def("read_file", "r")]);
    const { runtime, store, events } = makeRuntime(provider, reg, { permissive: true });
    const outcome = await runTurn(runtime, store);
    expect(outcome.status).toBe("completed");
    const started = (await events.list((await store.listSessions())[0]!.id)).filter((e) => e.type === "model.started");
    expect(started).toHaveLength(2);
    const p1 = started[0]!.payload as { stepId?: string; contextFingerprint?: string };
    const p2 = started[1]!.payload as { stepId?: string; contextFingerprint?: string };
    expect(p1.stepId).not.toBe(p2.stepId);
    expect(p1.contextFingerprint).not.toBe(p2.contextFingerprint);
  });

  it("1.8 environment drift — workspace-set change re-fingerprints the NEXT step; old env immutable", async () => {
    const base = { cwd: "/w", shell: "bash", permissionsFingerprint: "pol" };
    const env1 = buildLocalEnvironmentSnapshot({ ...base, workspaceRoots: ["/w"] });
    const env2 = buildLocalEnvironmentSnapshot({ ...base, workspaceRoots: ["/w", "/shared"] });
    expect(env1.fingerprint).not.toBe(env2.fingerprint);
    const s1 = buildStepExecutionSnapshot(baseSnapshotInput({ environment: env1 }));
    const s2 = buildStepExecutionSnapshot(baseSnapshotInput({ environment: env2 }));
    expect(s1.environment.fingerprint).toBe(env1.fingerprint); // old immutable
    expect(s2.environment.fingerprint).toBe(env2.fingerprint); // new updated
    expect(s2.environment.fingerprint).not.toBe(s1.environment.fingerprint);
  });
});