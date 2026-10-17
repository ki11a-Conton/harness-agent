/**
 * EXT-001 (audit code-audit-20261017 §3): `StdioTransport.close()` must settle
 * every in-flight request. Before the fix it only did `pending.clear()`, which
 * drops the resolve/reject handles — the awaiting caller hangs forever and the
 * host process can never exit.
 */
import { describe, expect, it } from "vitest";
import { AgentError } from "@ar/contracts";
import { StdioTransport } from "./stdio-transport.js";

/** A server surface whose requests never get a reply — models a peer that died
 *  (or a host shutting down) while an RPC is in flight. */
const neverReplies = { invoke: () => new Promise<unknown>(() => {}) };

function makePair(surface: { invoke: (method: string, params: unknown) => Promise<unknown> }) {
  const client = new StdioTransport({ role: "client" });
  const serverPeer = new StdioTransport({ role: "server", server: surface as never });
  client.pair(serverPeer);
  return { client, serverPeer };
}

/** Observe a promise without ever leaving an unhandled rejection behind. */
function observe<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ kind: "resolved" as const, value }),
    (err: unknown) => ({ kind: "rejected" as const, err }),
  );
}

describe("EXT-001 StdioTransport.close() settles in-flight requests", () => {
  it("rejects an in-flight request instead of hanging, and empties the pending map", async () => {
    const { client } = makePair(neverReplies);
    const call = observe(client.request("never/replies", { q: 1 }));
    expect(client.inFlight).toBe(1);

    await client.close();

    const settled = await Promise.race([
      call,
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1_000)),
    ]);
    // RED before the fix: the promise never settles → "timeout".
    expect(settled.kind).toBe("rejected");
    if (settled.kind !== "rejected") throw new Error("unreachable");
    // The rejection is a structured, greppable "transport closed" error.
    expect(settled.err).toBeInstanceOf(AgentError);
    expect((settled.err as Error).message).toMatch(/transport closed/i);
    expect(client.inFlight).toBe(0);
  }, 5_000);

  it("is idempotent, rejects post-close requests instead of hanging, and writes no frame after close", async () => {
    const { client, serverPeer } = makePair(neverReplies);
    const frames: string[] = [];
    const readLine = serverPeer.readLine.bind(serverPeer);
    serverPeer.readLine = (line: string) => {
      frames.push(line);
      readLine(line);
    };

    const first = observe(client.request("before/close", {}));
    expect(frames).toHaveLength(1);
    await client.close();
    expect((await first).kind).toBe("rejected");

    // Second close is a no-op, never a throw.
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.inFlight).toBe(0);

    // A request issued after close fails fast (a new request must never hang),
    // and it never reaches the (now detached) peer.
    await expect(client.request("after/close", {})).rejects.toThrow(/transport closed/i);
    expect(frames).toHaveLength(1);
    expect(client.inFlight).toBe(0);
  }, 5_000);

  it("ignores a late response that arrives after close", async () => {
    const { client } = makePair(neverReplies);
    const call = observe(client.request("slow", {}));
    await client.close();
    expect((await call).kind).toBe("rejected");
    expect(() => client.readLine(JSON.stringify({ id: 0, result: { late: true } }))).not.toThrow();
    expect(client.inFlight).toBe(0);
  }, 5_000);

  it("still resolves normally when the transport is open (no regression)", async () => {
    const { client } = makePair({ invoke: async () => ({ ok: true }) });
    await expect(client.request("echo", {})).resolves.toEqual({ ok: true });
    expect(client.inFlight).toBe(0);
    await client.close();
  });
});
