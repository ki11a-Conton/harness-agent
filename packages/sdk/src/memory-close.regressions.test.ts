import { describe, expect, it } from "vitest";
import { HarnessClient, SdkError } from "./client.js";
import { MemoryHarnessTransport } from "./transport.js";
const init = { protocolVersion: "1", serverInfo: { name: "lifecycle", version: "1" }, capabilities: {} };
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ kind: "resolved" as const, value }), error => ({ kind: "rejected" as const, error }));
async function bounded<T>(promise: Promise<T>): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<"pending">(resolve => { timer = setTimeout(() => resolve("pending"), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function fixture() {
  let runs = 0;
  const transport = new MemoryHarnessTransport(async method => {
    if (method === "initialize") return { result: init };
    if (method === "thread/start") return { result: { id: "thread-1" } };
    if (method === "turn/start") return { result: { turnId: "turn-1" } };
    if (method === "turn/run") { runs++; transport.emit({ type: "turn/completed", threadId: "thread-1", turnId: "turn-1", sequence: 1 }); }
    return { result: {} };
  });
  return { transport, runs: () => runs };
}

describe("memory SDK transport close is terminal", () => {
  it("refuses a coding dispatch through a previously created thread after client.close", async () => {
    const { transport, runs } = fixture();
    const client = await HarnessClient.connect(transport);
    const thread = await client.startThread({ agentName: "coding", cwd: "/workspace" });
    await client.close();
    await expect(thread.run("must not execute")).rejects.toBeInstanceOf(SdkError);
    expect(runs()).toBe(0);
    expect(transport.subscriberCount()).toBe(0);
    expect(transport.closeHandlerCount()).toBe(0);
  });

  it("settles an in-flight ordinary invoke when the connection closes and observes a late rejection", async () => {
    let reject!: (error: Error) => void;
    const transport = new MemoryHarnessTransport(() => new Promise((_, fail) => { reject = fail; }));
    const call = transport.invoke("thread/read", {});
    await transport.close();
    try {
      const result = await bounded(call);
      expect(result).not.toBe("pending");
      expect(result).toMatchObject({ error: { code: "TRANSPORT_CLOSED" } });
    } finally { reject(new Error("controlled late response failure")); await observe(call); }
  });

  it("does not return cached initialization or register new listeners after close", async () => {
    const { transport } = fixture();
    await transport.initializeResult();
    await transport.close();
    await expect(transport.initializeResult()).rejects.toThrow(/closed/i);
    let closed = 0, delivered = 0;
    transport.onClose(() => { closed++; });
    transport.subscribe("turn", () => { delivered++; });
    transport.emit({ type: "turn/completed", threadId: "t", turnId: "r", sequence: 1 });
    expect(closed).toBe(1);
    expect(delivered).toBe(0);
    expect(transport.closeHandlerCount()).toBe(0);
    expect(transport.subscriberCount()).toBe(0);
  });

  it("cleans every run even when an earlier close observer throws; a second close is a no-op", async () => {
    const transport = new MemoryHarnessTransport(async method => method === "turn/start" ? { result: { turnId: "turn-1" } } : new Promise(() => {}));
    let badCalls = 0;
    const offBad = transport.onClose(() => { badCalls++; throw new Error("controlled observer failure"); });
    const { Thread } = await import("./client.js");
    const stream = await new Thread("thread-1", transport).runStreamed("code");
    try {
      await expect(transport.close()).rejects.toThrow(/close|observer/i);
      expect(await bounded(stream.done)).toMatchObject({ status: "failed", error: { code: "STREAM_TERMINATED_BEFORE_TURN_END" } });
      expect(transport.subscriberCount()).toBe(0);
      expect(transport.closeHandlerCount()).toBe(0);
      await expect(transport.close()).resolves.toBeUndefined();
      expect(badCalls).toBe(1);
    } finally { offBad(); await transport.close(); }
  });

  it("sets closed before observers can initiate another command", async () => {
    let dispatched = 0, attempt: ReturnType<MemoryHarnessTransport["invoke"]> | undefined;
    const transport = new MemoryHarnessTransport(async () => { dispatched++; return { result: {} }; });
    transport.onClose(() => { attempt = transport.invoke("turn/run", {}); });
    await transport.close();
    expect(await attempt).toMatchObject({ error: { code: "TRANSPORT_CLOSED" } });
    expect(dispatched).toBe(0);
  });
});
