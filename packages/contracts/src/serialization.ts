import { createHash } from "node:crypto";

/**
 * Q-5 Canonical Stable Serialization.
 *
 * Single, deterministic string representation used for hashing/fingerprinting
 * (args hash, runtime-config hash, checkpoint checksum, dedup keys). Object keys
 * are sorted; output is stable across property-insertion order.
 *
 * Semantics (mirror JSON.stringify for round-trip stability):
 *   - arrays    : `[a,b]`, `undefined` slots render `null`
 *   - objects   : `{...}` with own enumerable keys sorted; keys whose value is
 *     `undefined` are omitted (so a write→parse round-trip yields equal hash);
 *     symbol keys are ignored
 *   - primitives: JSON.stringify (so NaN/±Infinity render `null`)
 *   - `undefined` top-level: renders `null` by default (overridable)
 *   - BigInt    : explicit. Default THROWS; pass `bigint: "toString"` to render
 *     the plain decimal string (deterministic, may collide with an identical string).
 *
 * Explicit failure (never silent corruption):
 *   - cyclic references throw `StableSerializationError` (avoids stack overflow).
 *   - BigInt throws unless the `bigint` option is set (avoids silent lossy Number
 *     coercion).
 */
export class StableSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StableSerializationError";
  }
}

export interface StableStringifyOptions {
  /** How to render a top-level/primitive `undefined`. Default "null" (JSON-like). */
  undefined?: "null" | "undefined";
  /** BigInt handling. Default "throw" (explicit failure). */
  bigint?: "toString" | "throw";
}

const DEFAULT_OPTIONS: Required<StableStringifyOptions> = {
  undefined: "null",
  bigint: "throw",
};

export function stableStringify(value: unknown, options?: StableStringifyOptions): string {
  const opts: Required<StableStringifyOptions> = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const seen = new WeakSet<object>();
  return serialize(value, opts, seen, "<root>");
}

function serialize(
  value: unknown,
  opts: Required<StableStringifyOptions>,
  seen: WeakSet<object>,
  path: string,
): string {
  if (value === undefined) return opts.undefined === "undefined" ? "undefined" : "null";
  if (typeof value === "bigint") {
    if (opts.bigint !== "toString") {
      throw new StableSerializationError(`BigInt at ${path} cannot be stably serialized`);
    }
    return value.toString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new StableSerializationError(`cyclic reference at ${path}`);
    seen.add(value);
    try {
      return `[${value.map((item, i) => serialize(item, opts, seen, `${path}[${i}]`)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) throw new StableSerializationError(`cyclic reference at ${path}`);
    seen.add(value);
    try {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => {
        // Omit undefined-valued keys (JSON.stringify semantics).
        if (record[key] === undefined) return false;
        return true;
      });
      keys.sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key], opts, seen, `${path}.${key}`)}`)
        .join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  // Primitives (string, number, boolean, null) — JSON.stringify matches
  // canonical JSON; NaN/Infinity → "null".
  return JSON.stringify(value);
}

/** SHA-256 over the canonical stable string (fingerprint/comparison aid). */
export function computeStableSha256(value: unknown, options?: StableStringifyOptions): string {
  return createHash("sha256").update(stableStringify(value, options)).digest("hex");
}