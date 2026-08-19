import { describe, expect, it } from "vitest";
import { ManualTimer, RealTimer, sleep, type Timer } from "./timer.js";

/**
 * Q-7 — testable timer / sleeper abstraction.
 *
 * These tests pin the deterministic-clock semantics that let a test drive a
 * timeout/backoff without any real waiting, plus the abort/cancellation
 * behavior of the `sleep` primitive.
 */

function collect(timer: Timer, msValues: number[]): { fired: number[] } {
  const fired: number[] = [];
  for (const ms of msValues) timer.schedule(() => fired.push(ms), ms);
  return { fired };
}

describe("Q-7 ManualTimer deterministic clock", () => {
  it("does nothing until the clock advances", () => {
    const t = new ManualTimer();
    const { fired } = collect(t, [5, 10, 5]);
    expect(fired).toEqual([]);
    t.advance(4);
    expect(fired).toEqual([]); // nothing due yet
  });

  it("fires due callbacks deterministically by (deadline, schedule id)", () => {
    const t = new ManualTimer();
    const { fired } = collect(t, [5, 1, 5, 1]);
    t.advance(10);
    // deadline 1 first (ids 2,4), then deadline 5 (ids 1,3) — schedule order.
    expect(fired).toEqual([1, 1, 5, 5]);
  });

  it("advance(0)/tick fires callbacks due at the current instant", () => {
    const t = new ManualTimer();
    const { fired } = collect(t, [0, 0]);
    expect(fired).toEqual([]);
    t.tick();
    expect(fired).toEqual([0, 0]);
    expect(t.pendingCount()).toBe(0);
  });

  it("cancelled callbacks never fire and leave no pending", () => {
    const t = new ManualTimer();
    const fired: string[] = [];
    const a = t.schedule(() => fired.push("a"), 5);
    const b = t.schedule(() => fired.push("b"), 5);
    a.cancel();
    t.advance(10);
    expect(fired).toEqual(["b"]);
    expect(t.pendingCount()).toBe(0);
  });

  it("a callback scheduled by a firing callback inside the window also runs", () => {
    const t = new ManualTimer();
    const fired: string[] = [];
    t.schedule(() => {
      fired.push("outer");
      t.schedule(() => fired.push("inner"), 2);
    }, 3);
    t.advance(10);
    expect(fired).toEqual(["outer", "inner"]);
  });

  it("pendingCount exposes true residual backlog for leak assertions", () => {
    const t = new ManualTimer();
    collect(t, [100, 100]);
    expect(t.pendingCount()).toBe(2);
    t.advance(100);
    expect(t.pendingCount()).toBe(0);
  });
});

describe("Q-7 sleep primitive", () => {
  it("resolves only when the ManualTimer advances past the delay", async () => {
    const t = new ManualTimer();
    let resolved = false;
    const p = sleep(t, 500).then(() => {
      resolved = true;
    });
    t.advance(100);
    await Promise.resolve();
    expect(resolved).toBe(false);
    t.advance(400); // reaches 500 -> fires
    await p;
    expect(resolved).toBe(true);
    expect(t.pendingCount()).toBe(0);
  });

  it("no-ops for zero/negative delays", async () => {
    const t = new RealTimer();
    await expect(sleep(t, 0)).resolves.toBeUndefined();
    await expect(sleep(t, -1)).resolves.toBeUndefined();
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const t = new RealTimer();
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(t, 10_000, ac.signal)).resolves.toBeUndefined();
  });

  it("resolves promptly on abort and cancels the pending timer", async () => {
    const t = new ManualTimer();
    const ac = new AbortController();
    let resolved = false;
    const p = sleep(t, 10_000, ac.signal).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    ac.abort();
    await p;
    expect(resolved).toBe(true);
    expect(t.pendingCount()).toBe(0); // timer cancelled, no leak
  });

  it("detaches the abort listener when the timer wins the race", async () => {
    const t = new ManualTimer();
    const ac = new AbortController();
    let resolved = false;
    const p = sleep(t, 5, ac.signal).then(() => {
      resolved = true;
    });
    t.advance(10); // fire the timer, not the abort
    await p;
    expect(resolved).toBe(true);
    // Aborting afterward must not throw / double-resolve.
    ac.abort();
    expect(t.pendingCount()).toBe(0);
  });
});

describe("Q-7 RealTimer adapter", () => {
  it("now() reflects the injected clock", () => {
    let now = 1000;
    const t = new RealTimer(() => now);
    expect(t.now()).toBe(1000);
    now = 2000;
    expect(t.now()).toBe(2000);
  });

  it("still runs against the real loop", async () => {
    const t = new RealTimer();
    const started = t.now();
    const done = await new Promise<void>((resolve) => {
      const h = t.schedule(resolve, 5);
      void h;
    });
    void done;
    expect(t.now() - started).toBeGreaterThanOrEqual(0);
  });
});