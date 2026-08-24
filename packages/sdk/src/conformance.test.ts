/**
 * P34-6 — SDK conformance over the SAME protocol fixture.
 *
 * The App Server wire contract (P29 / P34-5) is asserted from three
 * consumption surfaces, all fed by the identical TurnEvent stream:
 *
 *   1. RAW client — bare wire invokes + manual subscription + hand-rolled
 *      reducer (what any host must be able to do with zero SDK sugar);
 *   2. SDK runStreamed — streaming-first surface, events consumed as they
 *      flow;
 *   3. SDK run — the convenience reducer over runStreamed (P30-3).
 *
 * Invariant: all three reach the SAME final state — same items (by
 * sequence/order), same finalResponse, same usage, same status. If any
 * consumption path diverges, the SDK and the wire tell different stories.
 */
import { describe, expect, it } from "vitest";
import type { ThreadItem, TurnEvent } from "@ar/protocol";
import { HarnessClient, reduceTurnEvents, type RunResult } from "./client.js";
import { MemoryHarnessTransport, type TransportInvoke } from "./transport.js";

// ---------------------------------------------------------------------------
// Shared fixture — a full clean turn: greeting, one tool round-trip, final
// answer. The SAME event array feeds every path.
// ---------------------------------------------------------------------------

let seq = 0;
function ev(type: TurnEvent["type"], overrides: Record<string, unknown> = {}): TurnEvent {
  const base = { sequence: ++seq, threadId: "thr-c", turnId: "turn-c", type } as TurnEvent;
  return { ...base, ...overrides } as TurnEvent;
}
function delta(text: string): TurnEvent {
  return ev("item/delta", { delta: { text } });
}
function itemCompleted(item: Partial<ThreadItem> & { kind: ThreadItem["kind"] }): TurnEvent {
  return ev("item/completed", { item });
}
function turnCompleted(): TurnEvent {
  return ev("turn/completed", {});
}

/** Identical stream given to all three consumers. */
function sharedFixture(): TurnEvent[] {
  seq = 0;
  return [
    delta("hel"),
    delta("lo "),
    itemCompleted({
      kind: "agent_message",
      sequence: 1,
      text: "hello",
      final: false,
    }),
    itemCompleted({
      kind: "tool_call",
      sequence: 2,
      tool: "bash",
      callIndex: 0,
      args: { cmd: "ls" },
    }),
    itemCompleted({
      kind: "tool_result",
      sequence: 3,
      tool: "bash",
      callIndex: 0,
      ok: true,
    }),
    itemCompleted({
      kind: "agent_message",
      sequence: 4,
      text: "done",
      final: true,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    turnCompleted(),
  ];
}

/** Transport whose turn/run emits the shared fixture, in order. */
function transportFor(events: TurnEvent[]): {
  transport: MemoryHarnessTransport;
  invoked: string[];
} {
  let t!: MemoryHarnessTransport;
  const invoked: string[] = [];
  const handler = async (method: string, params: Record<string, unknown>): Promise<TransportInvoke<unknown>> => {
    invoked.push(method);
    switch (method) {
      case "initialize":
        return {
          result: {
            protocolVersion: "1",
            serverInfo: { name: "harness-sdk-conformance", version: "0.1.0" },
            capabilities: { streamingItems: true, approvalForms: true },
          },
        };
      case "thread/start":
        // MUST match the fixture's threadId ("thr-c") — EventChannel filters
        // on this.threadId, so a mismatch silently drops every event and the
        // done() promise never settles (the classic SDK hang).
        return { result: { id: "thr-c" } };
      case "turn/start":
        return { result: { turnId: "turn-c" } };
      case "turn/run":
        // Deliver the stream asynchronously — exactly like a real server push.
        queueMicrotask(() => {
          for (const e of events) t.emit(e);
        });
        await new Promise((r) => setTimeout(r, 0));
        return { result: {} };
      case "turn/interrupt":
        return { result: {} };
      case "thread/read":
        return { result: { threadId: "thr-1", items: [], nextSequence: 0 } };
      default:
        return { error: { code: "METHOD_NOT_FOUND", message: `unknown ${method}`, retryable: false } };
    }
  };
  t = new MemoryHarnessTransport(handler);
  return { transport: t, invoked };
}

// ---------------------------------------------------------------------------
// 1. The RAW client path — no SDK sugar.
// ---------------------------------------------------------------------------

async function rawClientRun(events: TurnEvent[]): Promise<RunResult> {
  const { transport, invoked } = transportFor(events);
  const init = await transport.initializeResult();

  const start = await transport.invoke("thread/start", { agentName: "a", cwd: "/tmp" });
  const threadId = (start.result as { id: string }).id;
  const started = await transport.invoke("turn/start", { threadId, prompt: "do it" });
  const turnId = (started.result as { turnId: string }).turnId;

  // raw subscription: collect events that belong to our turn
  const received: TurnEvent[] = [];
  const unsubscribe = transport.subscribe("turn", (e) => {
    if (e.threadId === threadId && e.turnId === turnId) received.push(e);
  });

  await transport.invoke("turn/run", { threadId, turnId });
  // give the async stream a beat to fully drip
  await new Promise((r) => setTimeout(r, 5));
  unsubscribe();

  expect(invoked).toContain("thread/start");
  expect(invoked).toContain("turn/run");
  void init;
  return reduceTurnEvents(received);
}

// ---------------------------------------------------------------------------
// 2 & 3. SDK paths.
// ---------------------------------------------------------------------------

async function sdkStreamed(events: TurnEvent[]): Promise<{ result: RunResult; consumed: TurnEvent[] }> {
  const { transport } = transportFor(events);
  const client = await HarnessClient.connect(transport);
  const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
  const { events: stream } = await thread.runStreamed("do it");
  // EventChannel is SINGLE-consumer: `done` shares the same channel as the
  // stream, so a test must consume exactly one of them. We consume the raw
  // stream (the streaming-first surface) and reduce it by hand — the `done`
  // promise is left to settle on its own (empty reduce, harmless).
  const consumed: TurnEvent[] = [];
  for await (const e of stream) consumed.push(e);
  return { result: await reduceTurnEvents(consumed), consumed };
}

async function sdkRun(events: TurnEvent[]): Promise<RunResult> {
  const { transport } = transportFor(events);
  const client = await HarnessClient.connect(transport);
  const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
  return thread.run("do it");
}

// ---------------------------------------------------------------------------
// Conformance assertions
// ---------------------------------------------------------------------------

describe("P34-6 SDK conformance — raw client / runStreamed / run over one fixture", () => {
  it("all three paths settle to the IDENTICAL final state", { timeout: 15000 }, async () => {
    const fixture = sharedFixture();

    const raw = await rawClientRun(fixture);
    const streamed = await sdkStreamed(fixture);
    const run = await sdkRun(fixture);

    // same item sequence (identity = sequence order, protocol DTOs)
    expect(raw.items.map((i) => i.sequence)).toEqual([1, 2, 3, 4]);
    expect(streamed.result.items.map((i) => i.sequence)).toEqual([1, 2, 3, 4]);
    expect(run.items.map((i) => i.sequence)).toEqual([1, 2, 3, 4]);

    // deep equality of the reduced state across all three
    expect(streamed.result.items).toEqual(raw.items);
    expect(run.items).toEqual(raw.items);
    expect(streamed.result.finalResponse).toBe("done");
    expect(run.finalResponse).toBe("done");
    expect(run.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(streamed.result.usage).toEqual(run.usage);
    expect(run.status).toBe("completed");
    expect(streamed.result.status).toBe("completed");
  });

  it("runStreamed delivers the same events a raw subscription sees", async () => {
    const fixture = sharedFixture();
    const streamed = await sdkStreamed(fixture);
    // every "settled" item in the shared fixture appears on both paths;
    // streams are ordered — the SDK stream consumed the full fixture.
    expect(streamed.consumed.length).toBe(fixture.length);
    expect(streamed.consumed.map((e) => e.type)).toEqual(fixture.map((e) => e.type));
  });

  it("the raw path produces an identical reducer output to thread.run()", async () => {
    const fixture = sharedFixture();
    const raw = await rawClientRun(fixture);
    const run = await sdkRun(fixture);
    // `run` carries turnId (the SDK's done() attaches it); the hand-rolled
    // raw reducer doesn't know which turn it reduced. The reducer truth is
    // everything else.
    const { turnId, ...runEssence } = run;
    expect(turnId).toBe("turn-c");
    expect(runEssence).toEqual(raw);
  });
});