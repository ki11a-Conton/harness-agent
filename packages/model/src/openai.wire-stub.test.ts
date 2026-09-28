import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Message, ModelEvent, ModelRequest, ToolSpec } from "@ar/contracts";
import { AgentError, newMessageId, newSessionId } from "@ar/contracts";
import { OpenAICompatibleProvider } from "./openai.js";

/**
 * F7 / R6 — STRICT LOCAL STUB at the real request boundary.
 *
 * A counting HTTP server (the only transport) records every POST /v1/chat/completions:
 * method, path, Authorization header and the RAW serialized body. Assertions are
 * made on the parsed body, never on "a function was called", and every refusal
 * case asserts the physical request count is exactly 0.
 *
 * LOCAL STUB ONLY: no relay, no paid provider, one throwaway in-process key.
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
  /** SSE lines queued for the next response(s); the last entry repeats. */
  private queue: string[] = [];
  private failure: { status: number; body: string } | undefined;
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
          // recorded raw; assertions on `json` will fail loudly
        }
        this.requests.push({
          method: req.method ?? "",
          path: req.url ?? "",
          ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
          body,
          json,
        });
        const failure = this.failure;
        if (failure !== undefined) {
          res.writeHead(failure.status, { "Content-Type": "application/json" });
          res.end(failure.body);
          return;
        }
        const script = this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? defaultSse());
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(script);
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

  /** Queue one SSE response; the final entry repeats once consumed. */
  script(sse: string): void {
    this.queue.push(sse);
  }

  /** Drop queued responses and any scripted failure (per-test isolation). */
  reset(): void {
    this.queue = [];
    this.failure = undefined;
  }

  failWith(status: number, body: string): void {
    this.failure = { status, body };
  }

  bodies(): Array<Record<string, unknown>> {
    return this.requests.map((request) => request.json);
  }

  lastBody(): Record<string, unknown> {
    return this.requests[this.requests.length - 1]!.json;
  }
}

function defaultSse(): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

/** SSE that returns a tool request (the "returned tool requests" driver). */
function toolCallSse(id: string, name: string, args: Record<string, unknown>): string {
  return (
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

const sessionId = newSessionId();

function message(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { id: newMessageId(), sessionId, role, content, createdAt: 0, ...extra };
}

const assistantCalls = (ids: readonly string[], names: readonly string[] = []): Message =>
  message("assistant", "calling", {
    toolCalls: ids.map((id, at) => ({ id: id as never, name: names[at] ?? "read_file", args: { path: "a" } })),
  });

const toolResult = (id: string, content = "ok"): Message =>
  message("tool", content, { toolCallId: id as never });

function makeProvider(stub: StrictStub): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ apiKey: STUB_KEY, baseUrl: stub.baseUrl(), modelId: MODEL });
}

async function generate(provider: OpenAICompatibleProvider, request: ModelRequest, signal: AbortSignal): Promise<ModelEvent[]> {
  // Identity comes from the constructor; the runtime calls createClient(ref, {}).
  const client = provider.createClient({ providerId: "openai", modelId: "ignored" }, {});
  const events: ModelEvent[] = [];
  for await (const ev of client.generate(request, signal)) events.push(ev);
  return events;
}

/** Run and return the (expected) AgentError without failing the test. */
async function rejection(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AgentError) return err;
    throw err;
  }
  throw new Error("expected the provider to refuse the request locally");
}

const spec = (name: string): ToolSpec => ({ name, description: `stub ${name}`, inputSchema: { type: "object" } });

let stub: StrictStub;
beforeAll(async () => {
  stub = new StrictStub();
  await stub.start();
});
beforeEach(() => {
  stub.reset();
});
afterAll(async () => {
  await stub.stop();
});

describe("F7/R6 strict stub — the serialized wire body", () => {
  it("wire-01 sends a legal two-result block and the BODY is the exact expected shape", async () => {
    stub.script(defaultSse());
    const before = stub.requests.length;
    const messages = [
      message("user", "go"),
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a", "A"),
      toolResult("call_b", "B"),
      message("assistant", "done"),
    ];
    await generate(makeProvider(stub), { messages, tools: [spec("read_file")] }, new AbortController().signal);

    expect(stub.requests.length).toBe(before + 1);
    const request = stub.requests[stub.requests.length - 1]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.authorization).toBe(`Bearer ${STUB_KEY}`);
    expect(request.json.model).toBe(MODEL);
    expect(request.json.stream).toBe(true);
    // The WIRE BODY, element by element.
    expect(request.json.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
        ],
      },
      { role: "tool", content: "A", tool_call_id: "call_a" },
      { role: "tool", content: "B", tool_call_id: "call_b" },
      { role: "assistant", content: "done" },
    ]);
    expect((request.json.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe("read_file");
  });

  it("wire-02 returns a tool request from the stub (tool_call_delta + completed)", async () => {
    stub.script(toolCallSse("call_1", "read_file", { path: "x" }));
    const events = await generate(
      makeProvider(stub),
      { messages: [message("user", "go")], tools: [spec("read_file")] },
      new AbortController().signal,
    );
    const delta = events.find((e) => e.type === "tool_call_delta");
    expect(delta).toBeDefined();
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    if (completed?.type === "completed") {
      expect(completed.result.finishReason).toBe("tool_calls");
      expect(completed.result.toolCalls?.[0]).toMatchObject({ id: "call_1", name: "read_file", args: { path: "x" } });
    }
  });

  it("wire-03 cancelled signal completes as cancelled with ZERO requests", async () => {
    const before = stub.requests.length;
    const controller = new AbortController();
    controller.abort();
    const events = await generate(makeProvider(stub), { messages: [message("user", "go")] }, controller.signal);
    expect(events.some((e) => e.type === "completed" && e.result.finishReason === "cancelled")).toBe(true);
    expect(stub.requests.length).toBe(before);
  });
});

describe("F7/R6 strict stub — tool names (P2-43 kept intact and strengthened)", () => {
  const cases: Array<{ case: string; name: string; legal: boolean }> = [
    { case: "name-01 legal snake_case", name: "read_file", legal: true },
    { case: "name-02 legal MCP underscore form (identity mapping)", name: "mcp_data_source_read", legal: true },
    { case: "name-03 length boundary 64 accepted", name: "a".repeat(64), legal: true },
    { case: "name-04 length boundary 65 rejected", name: "a".repeat(65), legal: false },
    { case: "name-05 dotted MCP name rejected", name: "mcp_data_source.read", legal: false },
    { case: "name-06 empty name rejected", name: "", legal: false },
    { case: "name-07 Unicode name rejected", name: "工具_read", legal: false },
    { case: "name-08 newline name rejected", name: "read\nfile", legal: false },
  ];

  for (const { case: caseName, name, legal } of cases) {
    it(`${caseName}`, async () => {
      const before = stub.requests.length;
      if (legal) {
        stub.script(defaultSse());
        await generate(makeProvider(stub), { messages: [message("user", "go")], tools: [spec(name)] }, new AbortController().signal);
        expect(stub.requests.length).toBe(before + 1);
        const sent = (stub.lastBody().tools as Array<{ function: { name: string } }>)[0]!.function.name;
        // Identity mapping: the advertised name is the wire name, verbatim and
        // therefore reversible and collision-free by construction.
        expect(sent).toBe(name);
        return;
      }
      const err = await rejection(
        generate(makeProvider(stub), { messages: [message("user", "go")], tools: [spec(name)] }, new AbortController().signal),
      );
      expect(err.info.code).toBe("MODEL_ERROR");
      expect(err.info.retryable).toBe(false);
      expect(err.info.safeToRetry).toBe(false);
      expect(err.info.provider?.kind).toBe("protocol");
      expect(err.message).toMatch(/not a valid provider function name/);
      // PHYSICAL HTTP = 0
      expect(stub.requests.length).toBe(before);
    });
  }

  it("name-09 an illegal advertised name never reaches the socket even with a non-empty message view", async () => {
    const before = stub.requests.length;
    const err = await rejection(
      generate(
        makeProvider(stub),
        { messages: [message("user", "go")], tools: [spec("mcp.bad.name")] },
        new AbortController().signal,
      ),
    );
    expect(err.info.provider?.kind).toBe("protocol");
    const bundle = JSON.parse(err.info.evidence ?? "{}") as Record<string, unknown>;
    expect(bundle.reason).toBe("tool_name_not_in_grammar");
    expect(stub.requests.length).toBe(before);
  });
});

describe("F7/R6 strict stub — wire-illegal message views are refused with HTTP 0", () => {
  const invalidViews: Array<{ case: string; messages: () => Message[]; expected: string }> = [
    {
      case: "invalid-01 orphan result with no preceding assistant",
      messages: () => [message("user", "u"), toolResult("call_orphan")],
      expected: "orphan_tool_result",
    },
    {
      case: "invalid-02 assistant[a,b] followed by only a",
      messages: () => [assistantCalls(["call_a", "call_b"]), toolResult("call_a")],
      expected: "missing_tool_result",
    },
    {
      case: "invalid-03 duplicate result for the same call id",
      messages: () => [assistantCalls(["call_a"]), toolResult("call_a"), toolResult("call_a", "again")],
      expected: "duplicate_tool_result",
    },
    {
      case: "invalid-04 extra result whose id was never requested",
      messages: () => [
        assistantCalls(["call_a", "call_b"]),
        toolResult("call_a"),
        toolResult("call_b"),
        toolResult("call_c"),
      ],
      expected: "unexpected_tool_result",
    },
    {
      case: "invalid-05 duplicate tool_call_id in one assistant message",
      messages: () => [assistantCalls(["call_a", "call_a"]), toolResult("call_a")],
      expected: "duplicate_tool_call_id",
    },
    {
      case: "invalid-06 inserted system message splitting the block",
      messages: () => [
        assistantCalls(["call_a", "call_b"]),
        toolResult("call_a"),
        message("system", "[stall recovery]"),
        toolResult("call_b"),
      ],
      expected: "missing_tool_result",
    },
    {
      case: "invalid-07 tool result with no tool_call_id",
      messages: () => [assistantCalls(["call_a"]), message("tool", "ok")],
      expected: "tool_result_without_id",
    },
    {
      case: "invalid-08 assistant echoes a dotted tool name (not in tools[])",
      messages: () => [assistantCalls(["call_a"], ["mcp_data_source.read"]), toolResult("call_a")],
      expected: "invalid_tool_call_name",
    },
  ];

  for (const { case: caseName, messages, expected } of invalidViews) {
    it(`${caseName} → local non-retryable refusal, HTTP 0`, async () => {
      const before = stub.requests.length;
      const err = await rejection(
        generate(makeProvider(stub), { messages: messages(), tools: [spec("read_file")] }, new AbortController().signal),
      );

      expect(err.info.code).toBe("MODEL_ERROR");
      expect(err.info.retryable).toBe(false);
      expect(err.info.safeToRetry).toBe(false);
      expect(err.info.provider?.kind).toBe("protocol");
      expect(err.message).toContain(expected);
      // The last point before the socket refused it: NO physical request.
      expect(stub.requests.length).toBe(before);

      const bundle = JSON.parse(err.info.evidence ?? "{}") as {
        reason?: string;
        status?: number | null;
        request?: { messageCount?: number; toolCallCount?: number; toolResultCount?: number; roles?: string[] };
        redacted?: boolean;
        contentRetained?: boolean;
      };
      expect(bundle.reason).toBe("wire_protocol_violation");
      expect(bundle.status).toBeNull();
      expect(bundle.redacted).toBe(true);
      expect(bundle.contentRetained).toBe(false);
      expect(bundle.request?.messageCount).toBe(messages().length);
    });
  }
});

describe("F7/R6 strict stub — a REAL provider error carries the redaction-safe bundle", () => {
  it("http-400/11148: status, reason, and tool call/result correlation are recorded without content", async () => {
    stub.failWith(
      400,
      JSON.stringify({
        code: 11148,
        msg: "tool calls and tool results do not match, please start a new conversation",
      }),
    );
    const userSecret = "F7-USER-SECRET-CONTENT-9f3a";
    const toolSecret = "F7-TOOL-OUTPUT-SECRET-77c1";
    const messages = [
      message("user", userSecret),
      assistantCalls(["call_a", "call_b"]),
      toolResult("call_a", toolSecret),
      toolResult("call_b", "B"),
    ];
    const events = await generate(makeProvider(stub), { messages }, new AbortController().signal);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type !== "error") throw new Error("unreachable");

    expect(error.error.provider).toMatchObject({ kind: "http", status: 400 });
    const bundle = JSON.parse(error.error.evidence ?? "{}") as {
      reason?: string;
      status?: number | null;
      endpointDigest?: string;
      modelDigest?: string;
      toolCallIdCorrelation?: Array<{ callId: string; resultCount: number; name: string }>;
      unansweredToolCallIds?: string[];
      orphanToolResultIndexes?: number[];
      request?: { toolCallCount?: number; toolResultCount?: number; contentBytes?: number; toolOutputBytes?: number };
    };
    expect(bundle.reason).toBe("http_status");
    expect(bundle.status).toBe(400);
    expect(bundle.toolCallIdCorrelation).toEqual([
      { callIndex: 1, callId: "call_a", name: "read_file", resultCount: 1, resultIndexes: [2], duplicatedRequest: false },
      { callIndex: 1, callId: "call_b", name: "read_file", resultCount: 1, resultIndexes: [3], duplicatedRequest: false },
    ]);
    expect(bundle.unansweredToolCallIds).toEqual([]);
    expect(bundle.orphanToolResultIndexes).toEqual([]);
    expect(bundle.request?.toolCallCount).toBe(2);
    expect(bundle.request?.toolResultCount).toBe(2);

    // Redaction: no key, no user content, no tool output — only SIZES.
    const serialized = JSON.stringify(error.error);
    expect(serialized).not.toContain(STUB_KEY);
    expect(serialized).not.toContain(userSecret);
    expect(serialized).not.toContain(toolSecret);
    expect(serialized).not.toContain("sk-");
    expect(bundle.request?.contentBytes).toBeGreaterThan(0);
    expect(bundle.request?.toolOutputBytes).toBeGreaterThan(0);
    // Digests are stable and non-reversible.
    expect(bundle.endpointDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.modelDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.endpointDigest).not.toContain(String(stub.port));
  });

  it("http-400 bundle records the 11148 SIGNATURE (unanswered ids) when the relay rejects a blocked request", async () => {
    stub.failWith(400, JSON.stringify({ code: 11148, msg: "tool calls and tool results do not match" }));
    // A legal body as far as the harness validator is concerned; the relay's
    // complaint is recorded as correlation data so the NEXT occurrence is not a
    // hypothesis (the E4-N8 §6.1 gap).
    const messages = [assistantCalls(["call_a"]), toolResult("call_a")];
    const events = await generate(makeProvider(stub), { messages }, new AbortController().signal);
    const error = events.find((e) => e.type === "error");
    if (error?.type !== "error") throw new Error("expected an error event");
    const bundle = JSON.parse(error.error.evidence ?? "{}") as {
      toolCallIdCorrelation?: unknown[];
      request?: { roles?: string[] };
    };
    expect(bundle.toolCallIdCorrelation).toHaveLength(1);
    expect(bundle.request?.roles).toEqual(["assistant+tool_calls", "tool"]);
  });
});
