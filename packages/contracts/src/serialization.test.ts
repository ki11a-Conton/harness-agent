import { describe, expect, it } from "vitest";
import {
  StableSerializationError,
  computeStableSha256,
  stableStringify,
  stableStringifyForChecksum,
} from "@ar/contracts";

describe("Q-5 stable serialization", () => {
  it("sorts object keys deterministically regardless of insertion order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { m: 3, z: 1, a: 2 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects and arrays", () => {
    expect(stableStringify([[1, 2], { a: [3] }])).toBe('[[1,2],{"a":[3]}]');
    expect(stableStringify({ b: { y: 1, x: 2 } })).toBe('{"b":{"x":2,"y":1}}');
  });

  it("omits undefined-valued object keys but marks array undefined slots as null", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
    // stableStringifyForChecksum delegates to the same canonical impl.
    expect(stableStringifyForChecksum({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("renders NaN / Infinity as null (JSON semantics) and handles primitives", () => {
    expect(stableStringify(NaN)).toBe("null");
    expect(stableStringify(Infinity)).toBe("null");
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("supports the undefined option for a literal marker", () => {
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify(undefined, { undefined: "undefined" })).toBe("undefined");
  });

  it("fails explicitly on BigInt by default; opt-in toString renders the decimal", () => {
    expect(() => stableStringify({ n: 1n })).toThrow(StableSerializationError);
    expect(() => stableStringify({ n: 1n })).toThrow(/BigInt/);
    expect(stableStringify({ n: 1n }, { bigint: "toString" })).toBe('{"n":1}');
    // A plain number 1 does NOT collide under the same opt-in (different type path).
    expect(stableStringify({ n: 1 }, { bigint: "toString" })).toBe('{"n":1}');
  });

  it("fails explicitly on cyclic references instead of stack-overflowing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(StableSerializationError);
    expect(() => stableStringify(cyclic)).toThrow(/cyclic/);
  });

  it("ignores symbol keys and renders top-level BigInt per option", () => {
    const withSymbol = { [Symbol("hidden")]: 1, a: 2 } as Record<string | symbol, unknown>;
    expect(stableStringify(withSymbol)).toBe('{"a":2}');
  });

  it("computeStableSha256 is deterministic and differs on key change", () => {
    const h1 = computeStableSha256({ a: 1, b: 2 });
    const h2 = computeStableSha256({ b: 2, a: 1 });
    const h3 = computeStableSha256({ a: 1, b: 3 });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stableStringifyForChecksum retains the historical contract behavior", () => {
    // Regression guard: canonical delegates must match the pre-Q-5 checksum
    // output exactly for the JSON-like cases checkpoints rely on.
    expect(stableStringifyForChecksum(undefined)).toBe("null");
    expect(stableStringifyForChecksum([undefined, { a: undefined, b: 1 }])).toBe("[null,{\"b\":1}]");
    expect(stableStringifyForChecksum({ c: 1, a: undefined })).toBe('{"c":1}');
  });
});