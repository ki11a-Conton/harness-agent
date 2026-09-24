import { describe, expect, it } from "vitest";
import { IdempotencyTable, idempotencyKeyOf } from "./idempotency.js";

describe("P29-9 request idempotency", () => {
  it("derives a stable key from method + params", () => {
    const a = idempotencyKeyOf("turn/start", { threadId: "t1", prompt: "hi" });
    const b = idempotencyKeyOf("turn/start", { threadId: "t1", prompt: "hi" });
    expect(a).toBe(b);
    expect(a).toContain("turn/start");
  });

  it("key order is stable (same params, different insertion order)", () => {
    const a = idempotencyKeyOf("turn/start", { prompt: "hi", threadId: "t1" });
    const b = idempotencyKeyOf("turn/start", { threadId: "t1", prompt: "hi" });
    expect(a).toBe(b);
  });

  it("different params → different key", () => {
    const a = idempotencyKeyOf("turn/start", { threadId: "t1", prompt: "hi" });
    const b = idempotencyKeyOf("turn/start", { threadId: "t1", prompt: "bye" });
    expect(a).not.toBe(b);
  });

  it("table returns the recorded result for a repeated key", () => {
    const t = new IdempotencyTable();
    expect(t.lookup("k1")).toBeUndefined();
    t.record("k1", { ok: true, turnId: "turn-1" });
    expect(t.lookup("k1")).toEqual({ ok: true, turnId: "turn-1" });
  });

  it("table ignores unknown keys", () => {
    const t = new IdempotencyTable();
    t.record("k1", { ok: true });
    expect(t.lookup("k2")).toBeUndefined();
  });
});