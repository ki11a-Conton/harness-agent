/**
 * P36-4 — SDK event stream / done semantic closure (INV-P36-003/004).
 *
 * Verifies that `events` and `done` are independent broadcast channels and
 * that terminal semantics are correct across all failure modes.
 */
import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@ar/protocol";
import { HarnessClient, type RunResult } from "./client.js";
import { MemoryHarnessTransport, type TransportInvoke } from "./transport.js";

let seq = 0;
function ev(type: TurnEvent["type"], overrides: Record<string, unknown> = {}): TurnEvent {
  const base = { sequence: ++seq, threadId: "thr-1", turnId: "turn-1", type } as TurnEvent;
  return { ...base, ...overrides } as TurnEvent;
}
function completedItem(kind: string, text?: string): TurnEvent {
  return ev("item/completed", { item: { kind, sequence: seq, ...(text ? { text } : {}) } });
}

function makeTransport(
  events: TurnEvent[],
  opts: { turnRunDelay?: number; failOnStart?: boolean } = {},
): { transport: MemoryHarnessTransport; emit: (e: TurnEvent) => void } {
  let t!: MemoryHarnessTransport;
  const handler = async (method: string, _params: Record<string, unknown>): Promise<TransportInvoke<unknown>> => {
    switch (method) {
      case "initialize": return { result: { protocolVersion: "1", serverInfo: { name: "t", version: "1" }, capabilities: {} } };
      case "thread/start": return { result: { id: "thr-1" } };
      case "turn/start": return opts.failOnStart ? { error: { code: "TURN_FAILED", message: "start failed", retryable: false } } : { result: { turnId: "turn-1" } };
      case "turn/run":
        if (opts.turnRunDelay !== undefined) await new Promise((r) => setTimeout(r, opts.turnRunDelay));
        for (const e of events) queueMicrotask(() => t.emit(e));
        return { result: {} };
      case "turn/interrupt": return { result: {} };
      default: return { error: { code: "UNKNOWN", message: "unknown", retryable: false } };
    }
  };
  t = new MemoryHarnessTransport(handler);
  return { transport: t, emit: (e) => t.emit(e) };
}

async function runStreamed(events: TurnEvent[], abort?: AbortSignal): Promise<{
  result: RunResult; consumed: TurnEvent[]; done: RunResult;
}> {
  const { transport } = makeTransport(events);
  const client = await HarnessClient.connect(transport);
  const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
  const { events: stream, done } = await thread.runStreamed("do it", { signal: abort });
  const consumed: TurnEvent[] = [];
  const consume = (async () => {
    for await (const e of stream) consumed.push(e);
  })();
  const [result] = await Promise.all([done, consume]);
  return { result, consumed, done: result };
}

describe("P36-4 event stream / done semantic closure", () => {
  it("1. consume events + await done concurrently — no deadlock, no event loss", async () => {
    const fixture = [ev("item/delta", { delta: { text: "a" } }), completedItem("agent_message", "hello"), ev("turn/completed", {})];
    const { result, consumed } = await runStreamed(fixture);
    expect(consumed.length).toBe(fixture.length);
    expect(result.status).toBe("completed");
    expect(result.items.length).toBe(1);
  });

  it("2. await done without consuming events — done settles with correct result", async () => {
    const fixture = [completedItem("agent_message", "hi"), ev("turn/completed", {})];
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { done } = await thread.runStreamed("do it");
    const result = await done;
    expect(result.status).toBe("completed");
    expect(result.items.length).toBe(1);
  });

  it("3. consume events without awaiting done — events stream completes", async () => {
    const fixture = [ev("item/delta", { delta: { text: "b" } }), completedItem("agent_message", "bye"), ev("turn/completed", {})];
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { events: stream } = await thread.runStreamed("do it");
    const consumed: TurnEvent[] = [];
    for await (const e of stream) consumed.push(e);
    expect(consumed.length).toBe(fixture.length);
  });

  it("4. slow public consumer — events still delivered, done still settles", async () => {
    const fixture = [ev("item/delta", { delta: { text: "s" } }), completedItem("agent_message", "slow"), ev("turn/completed", {})];
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { events: stream, done } = await thread.runStreamed("do it");
    // Slow consumer: await between each event
    const consumed: TurnEvent[] = [];
    for await (const e of stream) {
      consumed.push(e);
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await done;
    expect(consumed.length).toBe(fixture.length);
    expect(result.status).toBe("completed");
  });

  it("5. terminal failure — done resolves with failed status", async () => {
    const fixture = [ev("turn/failed", { error: { code: "MODEL_ERROR", message: "model failed", retryable: false } })];
    const { result } = await runStreamed(fixture);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("MODEL_ERROR");
  });

  it("6. interrupt — done resolves with interrupted status", async () => {
    const fixture = [ev("turn/interrupted", {})];
    const { result } = await runStreamed(fixture);
    expect(result.status).toBe("interrupted");
  });

  it("7. immediate abort — done resolves with interrupted status (no events)", async () => {
    const ac = new AbortController();
    ac.abort();
    // No events emitted — the hub should see the abort and resolve immediately.
    const { transport } = makeTransport([]);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { done } = await thread.runStreamed("do it", { signal: ac.signal });
    const result = await done;
    expect(result.status).toBe("interrupted");
  });

  it("8. iterator early return — events stream ends cleanly, done still settles", async () => {
    const fixture = [ev("item/delta", { delta: { text: "a" } }), completedItem("agent_message", "x"), ev("turn/completed", {})];
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { events: stream, done } = await thread.runStreamed("do it");
    // Consume only the first event, then break
    for await (const e of stream) {
      void e;
      break;
    }
    // done should still settle (RunEventHub is independent)
    const result = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    expect(result).not.toBeNull();
    if (result) expect((result as RunResult).status).toBe("completed");
  });

  it("9. transport closes before terminal — done FAILS (P37-4)", async () => {
    // Emit a non-terminal event, then close the transport without a terminal.
    const { transport, emit } = makeTransport([]);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { events: stream, done } = await thread.runStreamed("do it");
    // Emit a non-terminal delta (simulate transport dropping before terminal)
    emit(ev("item/delta", { delta: { text: "orphan" } }));
    // Close the transport — P37-4: this triggers onClose, which terminally
    // FAILS the run (STREAM_TERMINATED_BEFORE_TURN_END).
    await transport.close();
    const result = await done;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("STREAM_TERMINATED_BEFORE_TURN_END");
  });

  it("11. event order identical raw client vs SDK", async () => {
    const fixture = [ev("item/delta", { delta: { text: "a" } }), ev("item/delta", { delta: { text: "b" } }), completedItem("agent_message", "ab"), ev("turn/completed", {})];
    const { result, consumed } = await runStreamed(fixture);
    // All events consumed, in order
    expect(consumed.map((e) => e.type)).toEqual(fixture.map((e) => e.type));
    // Same reduced items
    const rawResult = await import("./client.js").then((m) => m.reduceTurnEvents(fixture));
    expect(result.items.map((i) => i.sequence)).toEqual(rawResult.items.map((i) => i.sequence));
  });

  // ---------------------------------------------------------------------------
  // P37-5 — bounded event buffer (INV-P37-006)
  // ---------------------------------------------------------------------------

  it("P37-5: slow consumer under limit — all events delivered", async () => {
    const fixture = Array.from({ length: 50 }, (_, i) => ev("item/delta", { delta: { text: `e${i}` } }));
    fixture.push(ev("turn/completed", {}));
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    const { events: stream, done } = await thread.runStreamed("do it");
    const consumed: TurnEvent[] = [];
    for await (const e of stream) {
      consumed.push(e);
      await new Promise((r) => setTimeout(r, 2)); // slow consumer
    }
    const result = await done;
    expect(consumed.length).toBe(fixture.length);
    expect(result.status).toBe("completed");
  });

  it("P37-5: absent consumer + over-limit burst → overflow failure", async () => {
    const { PushChannel, OverflowError } = await import("./client.js");
    const pc = new PushChannel(1); // buffer of 1
    // Push 2 events — the second should overflow.
    pc.push(ev("item/delta", { delta: { text: "e1" } }));
    pc.push(ev("item/delta", { delta: { text: "e2" } }));
    // Consuming should throw OverflowError.
    let threw = false;
    try {
      for await (const _ of pc) { void _; }
    } catch (err) {
      if (err instanceof OverflowError) threw = true;
    }
    expect(threw).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // P38-7 — exactly-once settlement + listener cleanup (INV-P38-009)
  // ---------------------------------------------------------------------------

  it("P38-7: 1,000 short runs — no listener growth", async () => {
    const fixture = [ev("item/delta", { delta: { text: "x" } }), ev("turn/completed", {})];
    const { transport } = makeTransport(fixture);
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "a", cwd: "/tmp" });
    // baseline: 0 listeners before any run
    expect(transport.subscriberCount()).toBe(0);
    expect(transport.closeHandlerCount()).toBe(0);
    for (let i = 0; i < 1_000; i++) {
      const { done } = await thread.runStreamed(`run-${i}`);
      const result = await done;
      expect(result.status).toBe("completed");
    }
    // After 1,000 terminal runs, every run-scoped listener is released.
    expect(transport.subscriberCount()).toBe(0);
    expect(transport.closeHandlerCount()).toBe(0);
  });
});