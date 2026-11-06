import { describe, expect, it } from "vitest";
import { AgentError } from "@ar/contracts";
import { StdioTransport } from "./stdio-transport.js";
const observe = <T>(p: Promise<T>) => p.then(value => ({ kind: "resolved" as const, value }), error => ({ kind: "rejected" as const, error }));
async function bounded<T>(p: Promise<T>): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<"pending">(resolve => { timer = setTimeout(() => resolve("pending"), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function pair(invoke: (method: string, args: unknown) => Promise<unknown> = () => new Promise(() => {})) {
  const client = new StdioTransport({ role: "client" });
  const server = new StdioTransport({ role: "server", server: { invoke } });
  client.pair(server);
  return { client, server };
}

describe("stdio lifecycle and frame integrity", () => {
  it("rejects all client waiters when the server closes, and rejects later requests", async () => {
    const { client, server } = pair();
    const calls = [observe(client.request("one")), observe(client.request("two"))];
    try {
      await server.close();
      for (const call of calls) expect(await bounded(call)).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
      expect(await bounded(observe(client.request("after-close")))).toMatchObject({ kind: "rejected" });
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("never dispatches a buffered request delivered after local close", async () => {
    let calls = 0;
    const { client, server } = pair(async () => { calls++; return "must not run"; });
    await server.close();
    server.readLine(JSON.stringify({ id: 9, method: "run", params: {} }));
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(0);
    await client.close();
  });

  it.each([null, [], false, 23, "frame"])("ignores an invalid top-level JSON value %j without crashing", async value => {
    const { client, server } = pair(async () => "healthy");
    try {
      expect(() => server.readLine(JSON.stringify(value))).not.toThrow();
      expect(() => client.readLine(JSON.stringify(value))).not.toThrow();
      await expect(client.request("health")).resolves.toBe("healthy");
    } finally { await client.close(); }
  });

  it.each([
    { id: 0 }, { id: 0, error: null }, { id: 0, error: {} },
    { id: 0, error: { code: 4, message: "invalid code" } },
    { id: 0, error: { code: "INTERNAL_ERROR", message: null } },
    { id: 0, result: 1, error: { code: "INTERNAL_ERROR", message: "ambiguous" } },
  ])("rejects a malformed correlated response %j without orphaning its waiter", async frame => {
    const { client } = pair();
    const call = observe(client.request("wait"));
    try {
      expect(() => client.readLine(JSON.stringify(frame))).not.toThrow();
      const result = await bounded(call);
      expect(result).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
      if (result !== "pending" && result.kind === "rejected") expect(result.error.message).toMatch(/frame|response|protocol/i);
    } finally { await client.close(); }
  });

  it("rejects cyclic request encoding without retaining its correlation", async () => {
    const { client } = pair();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    try {
      await expect(client.request("encode", cyclic)).rejects.toThrow();
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("rejects a request beyond the original 64KiB wire cap before dispatch", async () => {
    let calls = 0;
    const { client } = pair(async () => { calls++; return "never"; });
    try {
      expect(await bounded(observe(client.request("oversized", { text: "字".repeat(25_000) })))).toMatchObject({ kind: "rejected" });
      expect(calls).toBe(0);
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("returns a bounded error instead of silently losing an oversized response", async () => {
    const { client } = pair(async () => "x".repeat(70_000));
    try {
      const result = await bounded(observe(client.request("large-result")));
      expect(result).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("normalizes a synchronous server exception through the same RPC error path", async () => {
    const { client } = pair(() => { throw new Error("controlled synchronous server exception"); });
    try {
      const result = await bounded(observe(client.request("throw")));
      expect(result).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("turns a cyclic server result into a terminal RPC error", async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const { client } = pair(async () => cyclic);
    try {
      expect(await bounded(observe(client.request("cyclic-result")))).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("bounds an oversized error response and still settles the client", async () => {
    const { client } = pair(async () => { throw new Error("sensitive-detail-".repeat(8000)); });
    try {
      const result = await bounded(observe(client.request("large-error")));
      expect(result).toMatchObject({ kind: "rejected", error: expect.any(AgentError) });
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });

  it("does not overwrite a live peer with a different connection", async () => {
    const { client, server } = pair(async () => "original");
    const other = new StdioTransport({ role: "client" });
    try {
      expect(() => other.pair(server)).toThrow(/paired|connected|bound/i);
      await expect(client.request("health")).resolves.toBe("original");
    } finally { await client.close(); await other.close(); }
  });

  it("accepts null results and keeps notifications separate from the first call id", async () => {
    const { client, server } = pair(async () => null);
    const pushes: unknown[] = []; client.onPush((topic, payload) => pushes.push({ topic, payload }));
    try {
      server.notify("turn", { text: "observed" });
      await expect(client.request("null-result")).resolves.toBeNull();
      expect(pushes).toEqual([{ topic: "turn", payload: { text: "observed" } }]);
      expect(client.inFlight).toBe(0);
    } finally { await client.close(); }
  });
});
