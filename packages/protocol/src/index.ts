/**
 * @ar/protocol — App Server Protocol v1 (P29).
 *
 * Pure boundary: DTOs, handshake state machine, bounded queues, idempotency,
 * and the deterministic event→wire mapper. This package imports ONLY
 * `@ar/contracts` types (identity primitives) — never `AgentRuntime` nor any
 * runtime/store — so any client (CLI, SDK, web, another process) can speak the
 * protocol without pulling in the runtime.
 */
export * from "./ids.js";
export * from "./items.js";
export * from "./errors.js";
export * from "./handshake.js";
export * from "./bounded.js";
export * from "./idempotency.js";
export * from "./mapper.js";
export * from "./types.js";
export * from "./schema.js";