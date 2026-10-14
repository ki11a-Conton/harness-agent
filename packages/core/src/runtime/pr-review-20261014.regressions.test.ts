// PR-A (task-12) — focused regressions for two independently-confirmed defects.
//
// DEFECT-1 (M5, trace lies): the legacy recovery ladder emitted
//   `recovery.decided{action:"retry_safe"}` BEFORE consulting the tool's
//   `retrySafety` gate, so a tool that was never re-dispatched still left a
//   "retry_safe / retrying" record behind. Fixed by resolving the reported
//   action before emitting: `retry_safe` only when a retry IS dispatched, and
//   `retry_refused` when the safety gate declines the escalation.
//
// DEFECT-2 (M8, missing security event): a `denied` result returned by the
//   orchestrator emitted no `security.*_denied` event, so a refusal from the
//   real permission engine / sandbox / write-safety guard was invisible to
//   `packages/evaluation/src/security-evidence-execution.ts`, which builds
//   POLICY_DENIED from exactly those events. Fixed by classifying the denial
//   code onto a security event, with a fail-closed fallback.

import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  ModelEvent,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  ToolSemantics,
} from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, errorInfo, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "recovery-trace-security-agent",
  description: "task-12 focused regressions",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a trace/security conformance agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const READ_ONLY_SAFE: ToolSemantics = {
  ...DEFAULT_TOOL_SEMANTICS,
  retrySafety: "safe",
  readOnly: true,
  idempotent: true,
};

interface Harness {
  runtime: AgentRuntime;
  store: MemorySessionStore;
  events: MemoryEventStore;
  orch: CountingOrchestrator;
}

/** Counts every dispatch, so "did it really retry?" is answerable without
 *  trusting the event stream (the whole point of DEFECT-1). */
class CountingOrchestrator extends FakeOrchestrator {
  dispatched = 0;
  constructor(fixed: ToolResult) {
    super(fixed);
  }
  override async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
    this.dispatched += 1;
    return super.execute(request, context);
  }
}

async function makeHarness(opts: {
  scripts: ModelEvent[][];
  orch: CountingOrchestrator;
  recovery?: RecoveryPolicy;
  toolSemantics?: (name: string) => ToolSemantics;
}): Promise<Harness> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider(opts.scripts),
    orchestrator: opts.orch,
    agents: [{ ...AGENT, limits: {} }],
    recovery: opts.recovery ?? new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
    ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
  });
  return { runtime, store, events, orch: opts.orch };
}

async function run(h: Harness, text = "go"): Promise<{ status: string; all: AgentEvent[] }> {
  const session = await h.runtime.createSession({ agent: AGENT, cwd: process.cwd() });
  const turn = await h.runtime.startTurn(session.id, text);
  const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { status: outcome.status, all: await h.events.list(session.id) };
}

function decisions(all: AgentEvent[]) {
  return all
    .filter((e) => e.type === "recovery.decided")
    .map((e) => e.payload as { action: string; tool?: string; reason?: string });
}

describe("Independent PR5 denial telemetry review", () => {
  it("positive control: unmapped denial emits one actual security event", async () => {
    const h = await makeHarness({ scripts: [ScriptedModelProvider.toolCall("write_file", { path: "x", content: "x" }), ScriptedModelProvider.text("done")], orch: new CountingOrchestrator({ status: "denied", error: { code: "UNKNOWN_CODE" as never, message: "denied", retryable: false, safeToRetry: false } }) });
    const { all } = await run(h);
    expect(all.filter(e => typeof e.type === "string" && e.type.startsWith("security.")).length).toBe(1);
  });
  it("PR5 inherited object property must use the unknown-code fallback", async () => {
    const h = await makeHarness({ scripts: [ScriptedModelProvider.toolCall("write_file", { path: "x", content: "x" }), ScriptedModelProvider.text("done")], orch: new CountingOrchestrator({ status: "denied", error: errorInfo("constructor" as never, "denied") }) });
    const { all } = await run(h);
    expect(all.filter(e => e.type === "security.permission_denied").length).toBe(1);
  });
  it("PR5 injected host denial may not silently disappear by error code", async () => {
    const h = await makeHarness({ scripts: [ScriptedModelProvider.toolCall("write_file", { path: "x", content: "x" }), ScriptedModelProvider.text("done")], orch: new CountingOrchestrator({ status: "denied", error: errorInfo("PERMISSION_DENIED", "denied") }) });
    const { all } = await run(h);
    expect(all.filter(e => typeof e.type === "string" && e.type.startsWith("security.")).length).toBe(1);
  });
  it("PR5 deadline refusal after journaling cannot claim a dispatched retry", async () => {
    const orch = new CountingOrchestrator({ status: "failed", error: errorInfo("PROCESS_ERROR", "retryable read failure") });
    const h = await makeHarness({ scripts: [ScriptedModelProvider.toolCall("read_file", { path: "x" }), ScriptedModelProvider.text("done")], orch, toolSemantics: () => READ_ONLY_SAFE });
    // Exercise the actual controller's declared clock/deadline dependencies.
    // Preserve the real event store and dispatcher; advance the clock at the
    // real decision commit boundary before the existing deadline guard runs.
    let now = 0;
    const deps = (h.runtime as any).toolCallController.deps;
    const emit = deps.emit;
    deps.now = () => now;
    deps.dispatchDeadlineAtMs = () => 5;
    deps.emit = async (...args: any[]) => {
      const recorded = await emit(...args);
      if (args[1] === "recovery.decided" && args[2].action === "retry_safe") now = 6;
      return recorded;
    };
    const { all } = await run(h);
    const advertised = all.filter(e => e.type === "recovery.decided" && e.payload.action === "retry_safe");
    expect(advertised.length).toBe(orch.dispatched - 1);
  });
});
