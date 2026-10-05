import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDefinition,
  AskId,
  AskUserReply,
  AskUserRequest,
  AskUserStore,
  Message,
  SessionId,
} from "@ar/contracts";
import {
  DEFAULT_TOOL_SEMANTICS,
  errorInfo,
  findSerializedWireIssues,
  newAgentId,
  type AgentEvent,
} from "@ar/contracts";
import { OpenAICompatibleProvider } from "@ar/model";
import { ContextPipeline } from "@ar/context";
import { AgentRuntime } from "./runtime.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

/**
 * F7 / R6 — runtime → REAL provider → STRICT LOCAL STUB, asserting the
 * SERIALIZED WIRE BODY of every model request.
 *
 * Nothing here asserts "a function was called": each scenario parses the raw
 * body the local stub received and checks the assistant `tool_calls` /
 * `tool` result pairing message by message, plus the physical request count.
 * Coverage: normal tool block, parallel tools, stall recovery, ask_user +
 * answer resume, cancel, cross-turn resume, history trim, and a genuinely
 * corrupt durable transcript that must be refused locally with HTTP 0.
 *
 * LOCAL STUB ONLY (127.0.0.1, throwaway key). No relay, no paid provider.
 */

const STUB_KEY = "sk-local-stub-not-a-real-credential";
const MODEL = "local-stub-model";

interface Captured {
  method: string;
  path: string;
  authorization?: string;
  body: string;
  json: Record<string, unknown>;
}

class StrictStub {
  readonly requests: Captured[] = [];
  private queue: string[] = [];
  private server: Server;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(body) as Record<string, unknown>;
        } catch {
          /* recorded raw */
        }
        this.requests.push({
          method: req.method ?? "",
          path: req.url ?? "",
          ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
          body,
          json,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? textSse("ok")));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  script(sse: string): void {
    this.queue.push(sse);
  }

  /** Clear queued responses AND captured history (per-test isolation). */
  reset(): void {
    this.queue = [];
    this.requests.length = 0;
  }
}

function textSse(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

function toolCallSse(id: string, name: string, args: Record<string, unknown>, index = 0): string {
  return (
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

/** One assistant turn requesting SEVERAL tools in parallel (same delta). */
function parallelToolCallSse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string {
  return (
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "wire-e2e-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "openai", modelId: MODEL },
  systemPrompt: "you are a test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

class MemoryAskStore implements AskUserStore {
  private readonly reqs = new Map<string, AskUserRequest>();
  async create(request: AskUserRequest): Promise<void> {
    this.reqs.set(request.id, request);
  }
  async get(id: AskId): Promise<AskUserRequest | undefined> {
    return this.reqs.get(id);
  }
  async listPending(sessionId: SessionId): Promise<AskUserRequest[]> {
    return [...this.reqs.values()].filter((r) => r.sessionId === sessionId && r.status === "pending");
  }
  async markAnswered(id: AskId, reply: AskUserReply): Promise<void> {
    const r = this.reqs.get(id);
    if (r && r.status === "pending") {
      this.reqs.set(id, { ...r, status: "answered", answerText: reply.text, answeredAt: reply.answeredAt });
    }
  }
  async markWithdrawn(id: AskId): Promise<void> {
    const r = this.reqs.get(id);
    if (r && r.status === "pending") {
      this.reqs.set(id, { ...r, status: "withdrawn" });
    }
  }
}

interface Harness {
  runtime: AgentRuntime;
  store: MemorySessionStore;
  events: MemoryEventStore;
}

function makeHarness(
  stub: StrictStub,
  orchestrator: FakeOrchestrator,
  opts: {
    maxIterationsPerTurn?: number;
    maxRepeatedIdenticalToolCalls?: number;
    maxStallRecoveries?: number;
    maxTokens?: number;
    askUserStore?: AskUserStore;
  } = {},
): Harness {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider: new OpenAICompatibleProvider({ apiKey: STUB_KEY, baseUrl: stub.baseUrl(), modelId: MODEL }),
    orchestrator,
    agents: [AGENT],
    ...(opts.maxIterationsPerTurn !== undefined ? { maxIterationsPerTurn: opts.maxIterationsPerTurn } : {}),
    ...(opts.maxRepeatedIdenticalToolCalls !== undefined
      ? { maxRepeatedIdenticalToolCalls: opts.maxRepeatedIdenticalToolCalls }
      : {}),
    ...(opts.maxStallRecoveries !== undefined ? { maxStallRecoveries: opts.maxStallRecoveries } : {}),
    // These synthetic tools are side-effect-free doubles; declare them as such
    // so the assertions are about protocol shape, not fail-closed semantics.
    toolSemanticsOf: () => ({ ...DEFAULT_TOOL_SEMANTICS, sideEffectScope: "none" }),
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    ...(opts.maxTokens !== undefined
      ? {
          context: {
            pipeline: new ContextPipeline(),
            budget: {
              maxTokens: opts.maxTokens,
              reserved: { system: 0, task: 0, output: 0 },
              dynamic: 0,
            },
          },
        }
      : {}),
    ...(opts.askUserStore !== undefined ? { askUserStore: opts.askUserStore } : {}),
  });
  return { runtime, store, events };
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

function bodyMessages(body: Record<string, unknown>): WireMessage[] {
  return (body.messages ?? []) as WireMessage[];
}

/**
 * The central assertion: the body the stub received is wire-legal AND every
 * assistant `tool_calls` block is followed by exactly its results, contiguously.
 */
function assertWireLegalBody(body: Record<string, unknown>, label: string): WireMessage[] {
  const messages = bodyMessages(body);
  expect(findSerializedWireIssues(messages), `${label}: unified wire check`).toEqual([]);

  const answered = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const requested = message.tool_calls.map((call) => String(call.id));
    for (const id of requested) answered.add(id);
    let cursor = i + 1;
    const seen: string[] = [];
    while (cursor < messages.length && messages[cursor]!.role === "tool") {
      seen.push(String(messages[cursor]!.tool_call_id));
      cursor += 1;
    }
    expect(seen, `${label}: assistant[${i}] results must be contiguous and in order`).toEqual(requested);
  }

  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role !== "tool") continue;
    const isAfterAssistantBlock =
      i > 0 &&
      messages[i - 1]!.role === "assistant" &&
      (messages[i - 1]!.tool_calls?.length ?? 0) > 0;
    const insideRun = i > 0 && messages[i - 1]!.role === "tool";
    expect(
      isAfterAssistantBlock || insideRun,
      `${label}: tool message at ${i} must directly follow its assistant block`,
    ).toBe(true);
  }
  return messages;
}

function assertAllBodiesLegal(stub: StrictStub, label: string, expectedSystem?: string): void {
  expect(stub.requests.length, `${label}: at least one request`).toBeGreaterThan(0);
  stub.requests.forEach((request, index) => {
    const messages = assertWireLegalBody(request.json, `${label} request#${index + 1}`);
    if (expectedSystem !== undefined) {
      expect(messages[0], `${label} request#${index + 1}: assembled system bytes`).toEqual({
        role: "system",
        content: expectedSystem,
      });
    }
  });
}

function rolesOf(body: Record<string, unknown>): string[] {
  return bodyMessages(body).map((m) => (m.tool_calls?.length ? "assistant+tool_calls" : m.role));
}

function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

let stub: StrictStub;
beforeAll(async () => {
  stub = new StrictStub();
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
beforeEach(() => {
  stub.reset();
});

describe("F7/R6 runtime → real provider → strict local stub (serialized wire body)", () => {
  it("e2e-normal: a tool block is persisted contiguously and replayed contiguously", async () => {
    stub.script(toolCallSse("call_1", "read_file", { path: "a.ts" }));
    stub.script(textSse("done"));
    const orch = new FakeOrchestrator({ status: "success", output: "file-body" });
    const { runtime, store } = makeHarness(stub, orch);

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "read a.ts");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    expect(orch.calls.map((c) => c.request.call.name)).toEqual(["read_file"]);
    expect(stub.requests).toHaveLength(2);
    expect(rolesOf(stub.requests[0]!.json)).toEqual(["system", "user"]);
    expect(rolesOf(stub.requests[1]!.json)).toEqual(["system", "user", "assistant+tool_calls", "tool"]);
    // Without a context pipeline the compiled system is exactly the agent prompt.
    assertAllBodiesLegal(stub, "e2e-normal", AGENT.systemPrompt);

    // The tool result on the wire answers the SAME id the assistant requested.
    const second = bodyMessages(stub.requests[1]!.json);
    const assistant = second[2]!;
    expect(assistant.tool_calls![0]!.id).toBe("call_1");
    expect(second[3]!.tool_call_id).toBe("call_1");
    expect(second[3]!.content).toContain("file-body");

    // The durable transcript agrees with the wire (P2-41 kept intact).
    const persisted = await store.listMessages(session.id);
    // The separately assembled system must not be inserted into durable history.
    expect(persisted.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const assistantIndex = persisted.findIndex((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(persisted[assistantIndex + 1]!.role).toBe("tool");
    expect(persisted[assistantIndex + 1]!.toolCallId).toBe(persisted[assistantIndex]!.toolCalls![0]!.id);
  });

  it("e2e-parallel: two tools in one assistant message yield exactly two contiguous results", async () => {
    stub.script(
      parallelToolCallSse([
        { id: "call_a", name: "read_file", args: { path: "a.ts" } },
        { id: "call_b", name: "read_file", args: { path: "b.ts" } },
      ]),
    );
    stub.script(textSse("done"));
    const orch = new FakeOrchestrator({ status: "success", output: "ok" });
    const { runtime } = makeHarness(stub, orch, {});

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "read both");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    expect(outcome.toolCalls).toBe(2);
    expect(stub.requests).toHaveLength(2);
    const second = bodyMessages(stub.requests[1]!.json);
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(second[2]!.tool_calls!.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(second[3]!.tool_call_id).toBe("call_a");
    expect(second[4]!.tool_call_id).toBe("call_b");
    assertAllBodiesLegal(stub, "e2e-parallel", AGENT.systemPrompt);
  });

  it("e2e-stall-recovery: the stall observation never splits an assistant tool block", async () => {
    // 3 identical (name+args) calls trigger the stall recovery; the 4th call
    // answers with text. The recovery observation is appended AFTER the whole
    // block, so the request that carries it must still be wire-legal.
    const same = toolCallSse("call_same", "read_file", { path: "same.ts" });
    stub.script(same);
    stub.script(same);
    stub.script(same);
    stub.script(textSse("done"));
    const orch = new FakeOrchestrator({ status: "success", output: "same" });
    const { runtime, events } = makeHarness(stub, orch, {
      maxRepeatedIdenticalToolCalls: 3,
      maxStallRecoveries: 1,
    });

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "loop");
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    const stored = await events.list(session.id);
    expect(eventTypes(stored)).toContain("retry.stallRecovery");
    expect(stub.requests.length).toBeGreaterThanOrEqual(4);
    assertAllBodiesLegal(stub, "e2e-stall-recovery");

    // The request carrying the stall observation puts it after the completed
    // tool block, never between the assistant call and its result.
    const withObservation = stub.requests.filter((request) =>
      bodyMessages(request.json).some((m) => m.role === "system" && (m.content ?? "").includes("[stall recovery")),
    );
    expect(withObservation.length).toBeGreaterThan(0);
    for (const request of withObservation) {
      const messages = bodyMessages(request.json);
      const stallIndex = messages.findIndex((m) => m.role === "system" && (m.content ?? "").includes("[stall recovery"));
      const before = messages[stallIndex - 1]!;
      // The observation must land AFTER the block closed. Immediately before it
      // is either the (completed) tool run — legal — or the preceding turn's
      // text; it must never be the assistant message that is still awaiting
      // results, because that is exactly the split the upstream rejects.
      expect(before.role).not.toBe("assistant");
    }
    // Every block in those bodies is complete (assertAllBodiesLegal above), so
    // an observation following a tool run cannot be hiding an unanswered id.
  });

  it("e2e-ask-user: the parked ask keeps a complete block and the resumed reply is legal", async () => {
    const askStore = new MemoryAskStore();
    stub.script(toolCallSse("call_ask", "ask_user", { question: "which file?", reason: "choice_required" }));
    const { runtime, store } = makeHarness(stub, new FakeOrchestrator(), {
      askUserStore: askStore,
      maxIterationsPerTurn: 1,
    });

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "task");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("waiting_for_user");
    expect(outcome.pendingAsk).toBeDefined();
    expect(stub.requests).toHaveLength(1);
    assertAllBodiesLegal(stub, "e2e-ask-user (parked)");

    // The parked turn persisted the ask_user result so the block is complete.
    const persisted = await store.listMessages(session.id);
    const assistantIndex = persisted.findIndex((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(persisted[assistantIndex + 1]!.role).toBe("tool");
    expect(persisted[assistantIndex + 1]!.toolCallId).toBe(persisted[assistantIndex]!.toolCalls![0]!.id);

    // Answer + resume: the next request must carry the reply AFTER the block.
    stub.reset();
    stub.script(textSse("answered"));
    const resumed = await runtime.submitUserAnswer(session.id, turn.id, outcome.pendingAsk!.id, "a.ts");
    expect(resumed.resumed).toBe(true);
    await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(stub.requests.length).toBeGreaterThanOrEqual(1);
    assertAllBodiesLegal(stub, "e2e-ask-user (resumed)");
    const last = bodyMessages(stub.requests[stub.requests.length - 1]!.json);
    const lastAssistant = last.findIndex((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(last[lastAssistant + 1]!.role).toBe("tool");
    expect(last.some((m) => m.role === "user" && (m.content ?? "").includes("a.ts"))).toBe(true);
  });

  it("e2e-cancel: an aborted turn never emits a wire-illegal body", async () => {
    const controller = new AbortController();
    stub.script(toolCallSse("call_cancel", "read_file", { path: "a.ts" }));
    // The orchestrator aborts the run as the tool completes; the runtime must
    // stop before building a next request, and any request already built must
    // be legal.
    const orch = new (class extends FakeOrchestrator {
      override async execute(...args: Parameters<FakeOrchestrator["execute"]>) {
        controller.abort();
        return await super.execute(...args);
      }
    })();
    const { runtime } = makeHarness(stub, orch);

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn = await runtime.startTurn(session.id, "cancel me");
    const outcome = await runtime.runTurn(session.id, turn.id, controller.signal);

    // Observed: the abort after the tool batch settles the turn as cancelled.
    expect(outcome.status).toBe("cancelled");
    assertAllBodiesLegal(stub, "e2e-cancel");
  });

  it("e2e-resume: a second turn replays the persisted block contiguously", async () => {
    stub.script(toolCallSse("call_1", "read_file", { path: "a.ts" }));
    stub.script(textSse("first-done"));
    const orch = new FakeOrchestrator({ status: "success", output: "first" });
    const { runtime } = makeHarness(stub, orch);

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const turn1 = await runtime.startTurn(session.id, "turn one");
    await runtime.runTurn(session.id, turn1.id, new AbortController().signal);
    expect(stub.requests).toHaveLength(2);

    // Second turn on the SAME session: the replayed transcript is the wire body.
    stub.reset();
    stub.script(textSse("second-done"));
    const turn2 = await runtime.startTurn(session.id, "turn two");
    const outcome2 = await runtime.runTurn(session.id, turn2.id, new AbortController().signal);

    expect(outcome2.status).toBe("completed");
    expect(stub.requests).toHaveLength(1);
    const replayed = bodyMessages(stub.requests[0]!.json);
    expect(replayed.map((m) => (m.tool_calls?.length ? "assistant+tool_calls" : m.role))).toEqual([
      "system",
      "user",
      "assistant+tool_calls",
      "tool",
      "assistant", // turn 1's final text
      "user", // turn 2's goal
    ]);
    expect(replayed[2]!.tool_calls![0]!.id).toBe(replayed[3]!.tool_call_id);
    assertAllBodiesLegal(stub, "e2e-resume", AGENT.systemPrompt);
  });

  it("e2e-trim: the message-history trim path never leaves an orphan tool result", async () => {
    stub.script(toolCallSse("call_1", "read_file", { path: "a.ts" }));
    stub.script(textSse("after-trim"));
    const orch = new FakeOrchestrator({ status: "success", output: "x".repeat(12_000) });
    const { runtime, events } = makeHarness(stub, orch, { maxTokens: 5_000 });
    // The context pipeline reads instruction docs from cwd, so it must be real.
    const cwd = await mkdtemp(join(tmpdir(), "r6-wire-trim-"));
    try {
      const session = await runtime.createSession({ agent: AGENT, cwd });
      const turn = await runtime.startTurn(session.id, "big output");
      await runtime.runTurn(session.id, turn.id, new AbortController().signal);

      const stored = await events.list(session.id);
      expect(eventTypes(stored)).toContain("context.compacted");
      assertAllBodiesLegal(stub, "e2e-trim");
      for (const request of stub.requests) {
        const messages = bodyMessages(request.json);
        for (let i = 0; i < messages.length; i += 1) {
          if (messages[i]!.role !== "tool") continue;
          const previous = messages[i - 1];
          expect(
            previous !== undefined &&
              (previous.role === "tool" || (previous.role === "assistant" && (previous.tool_calls?.length ?? 0) > 0)),
            `trim left an orphan tool result at index ${i}`,
          ).toBe(true);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("e2e-corrupt-transcript: a corrupt durable transcript is refused LOCALLY with physical HTTP 0", async () => {
    // Seed the store with a tool result no assistant message ever requested. The
    // runtime can only fail this truthfully: fabricating a success or rewriting
    // the durable transcript would hide corruption.
    stub.script(textSse("should-never-be-sent"));
    const { runtime, store, events } = makeHarness(stub, new FakeOrchestrator());

    const session = await runtime.createSession({ agent: AGENT, cwd: "C:\\work" });
    const corrupt: Message = {
      id: "msg-corrupt-orphan" as Message["id"],
      sessionId: session.id,
      role: "tool",
      content: "orphan result with no requesting assistant",
      toolCallId: "call_never_requested" as never,
      createdAt: 0,
    };
    await store.appendMessage(corrupt);

    const turn = await runtime.startTurn(session.id, "go");
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("failed");
    const stored = await events.list(session.id);
    const failed = stored.find((e) => e.type === "model.failed");
    expect(failed).toBeDefined();
    const info = failed!.payload.error as ReturnType<typeof errorInfo>;
    expect(info.code).toBe("MODEL_ERROR");
    expect(info.retryable).toBe(false);
    expect(info.safeToRetry).toBe(false);
    expect(info.provider?.kind).toBe("protocol");
    const bundle = JSON.parse(info.evidence ?? "{}") as { reason?: string; status?: number | null };
    expect(bundle.reason).toBe("wire_protocol_violation");
    expect(bundle.status).toBeNull();

    // Not retried, and — the point of the whole exercise — no request at all.
    expect(eventTypes(stored)).not.toContain("model.retry");
    expect(stub.requests).toHaveLength(0);
  });
});
