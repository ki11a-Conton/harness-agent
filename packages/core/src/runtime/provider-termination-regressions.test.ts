import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, CheckpointData, CheckpointStore, VerificationResult } from "@ar/contracts";
import { assertToolProtocol, buildCheckpoint, newAgentId, newCheckpointId, newWorkingState } from "@ar/contracts";
import { OpenAICompatibleProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

// Real native provider and Runtime, with in-memory HTTP/storage/tool doubles.
// A dispatch count is evidence of routing, not a real filesystem mutation.
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const stop = sse({ choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] });
const toolIntent = sse({ choices: [{ delta: {
  content: "partial answer",
  tool_calls: [
    { index: 0, id: "call_write", function: { name: "write_file", arguments: '{"path":"a.txt","content":"partial"}' } },
    { index: 1, id: "call_read", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
  ],
} }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
const terminal = (reason: string): string => sse({ choices: [{ delta: {}, finish_reason: reason }] });

class MemoryCheckpointStore implements CheckpointStore {
  private checkpoints: CheckpointData[] = [];
  async save(checkpoint: CheckpointData): Promise<void> { this.checkpoints.push(checkpoint); }
  async loadLatest(): Promise<CheckpointData | undefined> { return this.checkpoints.at(-1); }
  async list(): Promise<CheckpointData[]> { return [...this.checkpoints].reverse(); }
}

function setup(firstResponse: string[] | null) {
  const fetch = vi.fn(async () => new Response(firstResponse === null ? null : firstResponse.join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  }));
  vi.stubGlobal("fetch", fetch);
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const orchestrator = new FakeOrchestrator();
  const checkpoints = new MemoryCheckpointStore();
  const agent: AgentDefinition = {
    id: newAgentId(), name: "termination-test", description: "offline", mode: "primary",
    model: { providerId: "openai", modelId: "offline" }, systemPrompt: "offline",
    tools: {}, permissions: { rules: [] }, skills: {}, limits: { maxToolCalls: 4 },
  };
  const verify = vi.fn(async (): Promise<VerificationResult> => ({
    level: 3, passed: true,
    checks: [{ id: "offline-check", kind: "requirement", description: "offline check", passed: true }],
    evidence: [], startedAt: 0, completedAt: 0,
  }));
  const runtime = new AgentRuntime({
    store, events, orchestrator, agents: [agent],
    modelProvider: new OpenAICompatibleProvider({ apiKey: "offline-test-key", baseUrl: "https://offline.invalid/v1", modelId: "offline" }),
    toolRegistry: defaultTestToolCatalog(), permissiveToolResolution: true,
    maxIterationsPerTurn: 3,
    recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
    task: { id: "offline-task", goal: "offline task", completionPolicy: { requiresVerification: true } },
    verifier: { verify },
    checkpointStore: checkpoints,
  });
  return { runtime, store, events, orchestrator, checkpoints, agent, verify, fetch };
}

afterEach(() => vi.unstubAllGlobals());

it("recovers a connection reset before any model output within the existing retry budget", async () => {
  const env = setup([stop]);
  env.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("socket reset before output")); } })));
  const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
  const turn = await env.runtime.startTurn(session.id, "finish this task");
  const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("completed");
  expect(env.fetch).toHaveBeenCalledTimes(2);
  expect(env.orchestrator.calls).toHaveLength(0);
  expect((await env.events.list(session.id)).filter(event => event.type === "model.retry")).toHaveLength(1);
});

it("recognizes a pre-output SSE context overflow and rebuilds context once instead of silently stopping", async () => {
  const overflow = sse({ error: { status: 400, message: "maximum context length exceeded" } });
  const env = setup([overflow]);
  env.fetch.mockResolvedValueOnce(new Response(overflow)); env.fetch.mockResolvedValue(new Response(stop));
  const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
  const turn = await env.runtime.startTurn(session.id, "continue coding after context reduction");
  const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  expect(outcome.status).toBe("completed"); expect(env.fetch).toHaveBeenCalledTimes(2);
  expect((await env.events.list(session.id)).filter(event => event.type === "context.compacted" && event.payload.reactive === true)).toHaveLength(1);
});

describe("R1: incomplete native-provider output never reaches tools or successful verification", () => {
  const abnormal = [
    { name: "content_filter", suffix: [terminal("content_filter")] },
    { name: "unknown finish reason", suffix: [terminal("unexpected")] },
    { name: "natural EOF", suffix: [] },
    { name: "DONE without finish reason", suffix: ["data: [DONE]\n\n"] },
  ];
  for (const fixture of abnormal) {
    it(`settles complete JSON read/write intents after ${fixture.name}, then permits a protocol-valid new turn`, async () => {
      const env = setup([toolIntent, ...fixture.suffix]);
      // A normal response is available to a later turn, but an incomplete
      // response must not automatically call it in this turn.
      env.fetch.mockResolvedValueOnce(new Response([toolIntent, ...fixture.suffix].join("")));
      env.fetch.mockResolvedValue(new Response(stop));
      const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
      const turn = await env.runtime.startTurn(session.id, "first task");
      const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      expect(outcome.status).toBe("failed");
      expect(outcome.terminationReason).toBe("model_error");
      expect(outcome.error).toMatchObject({ code: "MODEL_ERROR", retryable: false, safeToRetry: false });
      expect(env.fetch).toHaveBeenCalledTimes(1);
      expect(env.orchestrator.calls).toHaveLength(0);
      expect(env.verify).not.toHaveBeenCalled();
      const messages = await env.store.listMessages(session.id);
      expect(messages.find((message) => message.role === "assistant")?.content).toBe("partial answer");
      expect(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["call_write", "call_read"]);
      for (const message of messages.filter((message) => message.role === "tool")) expect(message.content).toContain("not executed");
      expect(() => assertToolProtocol(messages)).not.toThrow();
      const firstEvents = await env.events.list(session.id);
      expect(firstEvents.some((event) => event.type === "verification.completed" || event.type === "turn.completed")).toBe(false);
      expect(firstEvents.filter((event) => event.type === "model.completed")[0]?.payload.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, source: "measured" });
      const next = await env.runtime.startTurn(session.id, "next task");
      expect((await env.runtime.runTurn(session.id, next.id, new AbortController().signal)).status).toBe("completed");
      expect(env.fetch).toHaveBeenCalledTimes(2);
      expect(env.orchestrator.calls).toHaveLength(0);
      expect(() => assertToolProtocol(env.store.messages)).not.toThrow();
    });
  }

  it.each([
    { name: "content filter", parts: [sse({ choices: [{ delta: { content: "partial answer" }, finish_reason: "content_filter" }] })] },
    { name: "DONE-only text", parts: [sse({ choices: [{ delta: { content: "partial answer" } }] }), "data: [DONE]\n\n"] },
    { name: "missing body", parts: null },
  ])("does not invoke a passing verification gate for $name", async ({ parts }) => {
    const env = setup(parts);
    const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
    const turn = await env.runtime.startTurn(session.id, "task");
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(env.verify).not.toHaveBeenCalled();
    expect(env.orchestrator.calls).toHaveLength(0);
  });

  it.each(["", toolIntent, sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "broken", function: { name: "write_file", arguments: '{"path":"x' } }] } }] })])("ends a length-capped turn without executing any truncated intent or passing verification (%s)", async intent => {
    const env = setup([...(intent === toolIntent ? [] : [sse({ choices: [{ delta: { content: "partial answer" } }] })]), intent, terminal("length")]);
    const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
    const turn = await env.runtime.startTurn(session.id, "first task");
    const outcome = await env.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed"); expect(outcome.error).toBeUndefined();
    expect(outcome.grade).toBe("unverified_complete"); expect(outcome.terminationReason).toBe("context_limit");
    expect(env.verify).not.toHaveBeenCalled(); expect(env.orchestrator.calls).toHaveLength(0);
    expect(env.store.messages.some(message => message.role === "assistant" && message.content === "partial answer")).toBe(true);
    expect(() => assertToolProtocol(env.store.messages)).not.toThrow();
    env.fetch.mockResolvedValue(new Response(stop));
    const next = await env.runtime.startTurn(session.id, "continue");
    expect((await env.runtime.runTurn(session.id, next.id, new AbortController().signal)).status).toBe("completed");
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not replay rejected intents when resuming the pre-model checkpoint", async () => {
    const env = setup([toolIntent]);
    env.fetch.mockResolvedValueOnce(new Response(toolIntent));
    env.fetch.mockResolvedValue(new Response(stop));
    const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
    const turn = await env.runtime.startTurn(session.id, "task");
    // Seed the durable boundary directly: CheckpointPolicy has no
    // before-model hook, and a rejected first model response runs no tools.
    await env.checkpoints.save(buildCheckpoint({
      checkpointId: newCheckpointId(), schemaVersion: 1, sessionId: session.id,
      turnId: turn.id, agentId: env.agent.id, createdAt: 0,
      reason: "offline:before_model", phase: "thinking", iteration: 0,
      state: newWorkingState("task"), toolLedger: [], childSessions: [],
      lastEventSequence: (await env.events.list(session.id)).at(-1)!.sequence,
      effectiveAgentConfigRef: "effectiveAgent", contextRefs: [],
    }));
    expect((await env.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("failed");
    expect(env.orchestrator.calls).toHaveLength(0);
    const resumed = await env.runtime.resumeTurn(session.id, new AbortController().signal);
    expect(resumed.outcome.status).toBe("completed");
    expect(resumed.unresolvedTools).toEqual([]);
    expect(resumed.committedSideEffects).toEqual([]);
    expect(env.orchestrator.calls).toHaveLength(0);
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(() => assertToolProtocol(env.store.messages)).not.toThrow();
  });

  it("still executes a normally terminated tool batch exactly once per requested call", async () => {
    const env = setup([toolIntent, terminal("tool_calls")]);
    env.fetch.mockResolvedValueOnce(new Response(toolIntent + terminal("tool_calls")));
    env.fetch.mockResolvedValue(new Response(stop));
    const session = await env.runtime.createSession({ agent: env.agent, cwd: "/offline" });
    const turn = await env.runtime.startTurn(session.id, "task");
    expect((await env.runtime.runTurn(session.id, turn.id, new AbortController().signal)).status).toBe("completed");
    expect(env.orchestrator.calls.map(({ request }) => request.call.id)).toEqual(["call_write", "call_read"]);
    expect(env.verify).toHaveBeenCalledTimes(1);
    expect(env.fetch).toHaveBeenCalledTimes(2);
    expect(() => assertToolProtocol(env.store.messages)).not.toThrow();
  });
});
