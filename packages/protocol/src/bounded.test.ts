import { describe, expect, it } from "vitest";
import { BoundedQueue, BoundedNotifier } from "./bounded.js";
import { ProtocolError } from "./errors.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("P29-7 bounded queue + server overloaded backpressure", () => {
  it("runs work and returns results in order", async () => {
    const q = new BoundedQueue<string>({ capacity: 2 });
    const out: string[] = [];
    const p1 = q.submit(async () => { out.push("a"); return "A"; });
    const p2 = q.submit(async () => { out.push("b"); return "B"; });
    await tick();
    expect(out).toEqual(["a", "b"]);
    expect(await p1).toBe("A");
    expect(await p2).toBe("B");
  });

  it("capacity=2: third submit rejects quickly with SERVER_OVERLOADED", async () => {
    const q = new BoundedQueue<number>({ capacity: 2 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const p1 = q.submit(async () => { await firstGate; return 1; });
    const p2 = q.submit(async () => 2);
    // Both slots busy (p1 running, p2 queued? No — p1 runs immediately, so
    // active=1, waiting=1 → full). A third submit must be rejected.
    const rejection = q.submit(async () => 3).catch((e) => e);
    await tick();
    const err = await rejection;
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err.info.code).toBe("SERVER_OVERLOADED");
    expect(err.info.retryable).toBe(true);
    // Processing memory did not accumulate unbounded work: queue never grew.
    expect(q.pendingCount).toBeLessThanOrEqual(2);
    releaseFirst();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  it("saturated flag true when full", async () => {
    const q = new BoundedQueue<number>({ capacity: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    void q.submit(async () => { await gate; return 1; });
    expect(q.saturated).toBe(true);
    release();
  });

  it("clears saturation after work completes (client can retry)", async () => {
    const q = new BoundedQueue<number>({ capacity: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p1 = q.submit(async () => { await gate; return 1; });
    const p2 = q.submit(async () => 2);
    const rejected = q.submit(async () => 3).catch((e) => e);
    await tick();
    expect((await rejected) instanceof ProtocolError).toBe(true);
    release();
    await p1;
    await tick();
    // Now the queue can accept work again.
    const retry = await q.submit(async () => 4);
    expect(retry).toBe(4);
  });
});

describe("P29-7 bounded notifier", () => {
  it("notifies up to capacity, then returns false", () => {
    const n = new BoundedNotifier(2);
    expect(n.notify({ x: 1 })).toBe(true);
    expect(n.notify({ x: 2 })).toBe(true);
    expect(n.saturated).toBe(true);
    expect(n.notify({ x: 3 })).toBe(false); // backpressure — never grows memory
    expect(n.bufferedCount).toBe(2);
  });

  it("drains buffered notifications", () => {
    const n = new BoundedNotifier(3);
    n.notify({ a: 1 });
    n.notify({ b: 2 });
    const batch = n.drain();
    expect(batch.length).toBe(2);
    expect(n.bufferedCount).toBe(0);
  });
});