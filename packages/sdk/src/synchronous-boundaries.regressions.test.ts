import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@ar/protocol";
import { Thread } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";

function fixture() {
  let runs = 0;
  const transport = new MemoryHarnessTransport(async method => {
    if (method === "turn/start") return { result: { turnId: "turn-1" } };
    if (method === "turn/run") {
      runs++;
      transport.emit({ type: "turn/completed", threadId: "thread-1", turnId: "turn-1", sequence: 1 });
    }
    return { result: {} };
  });
  return { transport, thread: new Thread("thread-1", transport), runs: () => runs };
}

describe("SDK synchronous transport boundaries", () => {
  it.each([false, true])("settles synchronous turn/run rejection and releases listeners (streamed: %s)", async streamed => {
    const { transport, thread } = fixture();
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (method, params) => {
      if (method === "turn/run") throw new Error("controlled synchronous dispatch rejection");
      return invoke(method, params);
    };
    try {
      const result = streamed ? await (await thread.runStreamed("code")).done : await thread.run("code");
      expect(result).toMatchObject({ status: "failed", error: { code: "protocol_error" } });
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await transport.close(); }
  });

  it.each(["turn/completed", "turn/failed", "turn/interrupted"] as const)("accepts a synchronously replayed %s without re-running the turn", async type => {
    const { transport, thread, runs } = fixture();
    const subscribe = transport.subscribe.bind(transport);
    let released = 0;
    transport.subscribe = (topic, listener) => {
      const off = subscribe(topic, listener);
      listener({ type, threadId: "thread-1", turnId: "turn-1", sequence: 1,
        ...(type === "turn/failed" ? { error: { code: "MODEL_ERROR", message: "recorded failure", retryable: false } } : {}),
      } as TurnEvent);
      return () => { released++; off(); };
    };
    try {
      const result = await (await thread.runStreamed("code")).done;
      expect(result.status).toBe(type === "turn/completed" ? "completed" : type === "turn/failed" ? "failed" : "interrupted");
      expect(runs()).toBe(0);
      expect(released).toBe(1);
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await transport.close(); }
  });

  it("handles close delivered during onClose registration and does not dispatch", async () => {
    const { transport, thread, runs } = fixture();
    let released = 0;
    transport.onClose = listener => { listener(); return () => { released++; }; };
    try {
      expect(await (await thread.runStreamed("code")).done).toMatchObject({ status: "failed", error: { code: "STREAM_TERMINATED_BEFORE_TURN_END" } });
      expect(runs()).toBe(0);
      expect(released).toBe(1);
      expect(transport.subscriberCount()).toBe(0);
    } finally { await transport.close(); }
  });

  it("keeps non-terminal subscription replay and the subsequent live turn", async () => {
    const { transport, thread, runs } = fixture();
    const subscribe = transport.subscribe.bind(transport);
    transport.subscribe = (topic, listener) => {
      const off = subscribe(topic, listener);
      listener({ type: "item/delta", threadId: "thread-1", turnId: "turn-1", sequence: 1, delta: { text: "cached progress" } });
      return off;
    };
    try {
      expect((await thread.run("code")).status).toBe("completed");
      expect(runs()).toBe(1);
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
    } finally { await transport.close(); }
  });
});
