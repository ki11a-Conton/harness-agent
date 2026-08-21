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
export declare class StableSerializationError extends Error {
    constructor(message: string);
}
export interface StableStringifyOptions {
    /** How to render a top-level/primitive `undefined`. Default "null" (JSON-like). */
    undefined?: "null" | "undefined";
    /** BigInt handling. Default "throw" (explicit failure). */
    bigint?: "toString" | "throw";
}
export declare function stableStringify(value: unknown, options?: StableStringifyOptions): string;
/** SHA-256 over the canonical stable string (fingerprint/comparison aid). */
export declare function computeStableSha256(value: unknown, options?: StableStringifyOptions): string;
//# sourceMappingURL=serialization.d.ts.map