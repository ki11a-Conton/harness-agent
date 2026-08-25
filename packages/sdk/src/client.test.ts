/**
 * P30-3/4 — SDK reducer-truth and abort tests.
 *
 * P30-3: An exact event fixture reduced through the MANUAL reducer and through
 * `Thread.run()` (which is itself a reducer over `runStreamed()`) must produce
 * IDENTICAL items/finalResponse/usage/status. Any divergence means a second,
 * parallel code path crept in.
 *
 * P30-4: `AbortSignal` must map to a server-side `turn/interrupt` invoke, not
 * merely stop local reading.
 */
import { describe, expect, it } from "vitest";
import type { ThreadItem, TurnEvent } from "@ar/protocol";
import { HarnessClient, reduceTurnEvents, SdkError } from "./client.js";
import { MemoryHarnessTransport, type TransportInvoke } from "./transport.js";

// ---------------------------------------------------------------------------
// Fixture — a complete turn's worth of wire events, in stream order.
// Mirrors what ProtocolEventMapper emits (see packages/protocol mapper.test).
// ---------------------------------------------------------------------------

let seq = 0;
function turnEvent(type: TurnEvent["type"], overrides: Record<string, unknown> = {}): TurnEvent {
  const base = {
    sequence: ++seq,
    threadId: "thr-1",
    turnId: "turn-1",
    type,
  } as TurnEvent;
  return { ...base, ...overrides } as TurnEvent;
}

function delta(text: string): TurnEvent {
  return turnEvent("item/delta", { delta: { text } });
}
function completed(item: Partial<ThreadItem> & { kind: ThreadItem["kind"] }): TurnEvent {
  return turnEvent("item/completed", { item });
}
function turnCompleted(): TurnEvent {
  return turnEvent("turn/completed", {});
}
function turnFailed(code = "INTERNAL_ERROR", retryable = false): TurnEvent {
  return turnEvent("turn/failed", {
    error: { code, message: "boom", retryable },
  });
}
function turnInterrupted(): TurnEvent {
  return turnEvent("turn/interrupted", {});
}

/** Full clean turn: greeting + one tool round-trip + final answer.
 *  Items follow the protocol DTO shape: no runtime-only `id`/`toolCallId`
 *  fields — identity is `sequence`, tools carry `tool`+`callIndex`. */
function cleanFixture(): TurnEvent[] {
  seq = 0;
  return [
    delta("hel"),
    delta("lo "),
    completed({
      kind: "agent_message",
      sequence: 1,
      text: "hello",
      final: false,
    }),
    completed({
      kind: "tool_call",
      sequence: 2,
      tool: "bash",
      callIndex: 0,
      args: { cmd: "ls" },
    }),
    completed({
      kind: "tool_result",
      sequence: 3,
      tool: "bash",
      callIndex: 0,
      ok: true,
    }),
    completed({
      kind: "agent_message",
      sequence: 4,
      text: "done",
      final: true,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    turnCompleted(),
  ];
}

// ---------------------------------------------------------------------------
// Transport wiring
// ---------------------------------------------------------------------------

/** Re-emits recorded events back to subscribers (single-run transport). */
function makeTransport(
  events: TurnEvent[],
  opts: { onInvoke?: (method: string, params: Record<string, unknown>) => void } = {},
): MemoryHarnessTransport {
  let transport!: MemoryHarnessTransport;
  const handler = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<TransportInvoke<unknown>> => {
    opts.onInvoke?.(method, params);
    switch (method) {
      case "initialize":
        return {
          result: {
            protocolVersion: "1",
            serverInfo: { name: "harness-test", version: "0.1.0" },
            capabilities: { session: { maxConcurrent: 1 } },
          },
        };
      case "thread/start":
        return { result: { id: "thr-1" } };
      case "thread/loaded/list":
        return { result: { threads: [] } };
      case "thread/read":
        return { result: { items: [] } };
      case "turn/interrupt":
        return { result: {} };
      case "turn/start":
        return { result: { turnId: "turn-1" } };
      case "turn/run": {
        // The event stream is delivered asynchronously: emit on a microtask so
        // the run() reducer consumes exactly `events`.
        queueMicrotask(() => {
          for (const e of events) transport.emit(e);
        });
        await new Promise((r) => setTimeout(r, 0));
        return { result: {} };
      }
      default:
        return { error: { code: "METHOD_NOT_FOUND", message: `unknown ${method}`, retryable: false } };
    }
  };
  transport = new MemoryHarnessTransport(handler);
  return transport;
}

// ---------------------------------------------------------------------------
// P30-3 — reducer truth
// ---------------------------------------------------------------------------

describe("P30-3 reducer truth", () => {
  it("manual reducer and SDK run() produce identical items/finalResponse/usage/status", async () => {
    const manual = await reduceTurnEvents(cleanFixture());
    const transport = makeTransport(cleanFixture());
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const result = await thread.run("do it");

    expect(result.items).toEqual(manual.items);
    expect(result.items.map((i) => i.sequence)).toEqual(manual.items.map((i) => i.sequence));
    expect(result.finalResponse).toBe(manual.finalResponse);
    expect(result.usage).toEqual(manual.usage);
    expect(result.status).toBe(manual.status);

    // sanity on the fixture itself
    expect(manual.items).toHaveLength(4);
    expect(manual.finalResponse).toBe("done");
    expect(manual.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("a failed turn yields failed status + error via both paths", async () => {
    seq = 0;
    const fixture: TurnEvent[] = [delta("x"), turnFailed(), turnCompleted()];
    const manual = await reduceTurnEvents(fixture);
    const transport = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const result = await thread.run("go");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.status).toBe(manual.status);
    expect(result.error?.message).toBe(manual.error?.message);
  });
});

// ---------------------------------------------------------------------------
// P30-4 — abort maps to turn/interrupt
// ---------------------------------------------------------------------------

describe("P30-4 abort → turn/interrupt", () => {
  it("aborting mid-run invokes turn/interrupt with the right turnId", async () => {
    seq = 0;
    const called: Record<string, unknown>[] = [];
    const transport = makeTransport([delta("start"), turnInterrupted()], {
      onInvoke: (m, p) => {
        if (m === "turn/interrupt") called.push(p);
      },
    });
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });

    const ac = new AbortController();
    const { done } = await thread.runStreamed("hello", { signal: ac.signal });
    await Promise.resolve();
    ac.abort();

    const result = await done;
    expect(called.length).toBeGreaterThanOrEqual(1);
    expect(called[0]).toMatchObject({ threadId: "thr-1", turnId: "turn-1", reason: "aborted" });
    expect(result.status).toBe("interrupted");
  });

  it("an already-aborted signal interrupts immediately", async () => {
    seq = 0;
    const called: Record<string, unknown>[] = [];
    const transport = makeTransport([], {
      onInvoke: (m, p) => {
        if (m === "turn/interrupt") called.push(p);
      },
    });
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const ac = new AbortController();
    ac.abort();
    const { done } = await thread.runStreamed("hi", { signal: ac.signal });
    const result = await done;
    expect(called.length).toBeGreaterThanOrEqual(1);
    expect(called[0]).toMatchObject({ reason: "aborted" });
    expect(result.status).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// Error plumbing
// ---------------------------------------------------------------------------

describe("SDK error plumbing", () => {
  it("throws SdkError on method failure", async () => {
    // initialize succeeds; later methods fail — SdkError must surface.
    const transport = new MemoryHarnessTransport(async (method) => {
      if (method === "initialize") {
        return {
          result: {
            protocolVersion: "1",
            serverInfo: { name: "harness-test", version: "0.1.0" },
            capabilities: { session: { maxConcurrent: 1 } },
          },
        };
      }
      return { error: { code: "SERVER_OVERLOADED", message: "busy", retryable: true } };
    });
    const client = await HarnessClient.connect(transport);
    await expect(client.startThread({ agentName: "a", cwd: "/tmp" })).rejects.toMatchObject({
      name: "SdkError",
      code: "SERVER_OVERLOADED",
      retryable: true,
    });
  });

  it("thread.run surfaces turn failure as RunResult.status=failed (not throw)", async () => {
    seq = 0;
    const transport = makeTransport([turnFailed()]);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const result = await thread.run("x");
    expect(result.status).toBe("failed");
    expect(result.error?.retryable).toBe(false);
  });
});