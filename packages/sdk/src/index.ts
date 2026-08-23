/**
 * @ar/sdk — TypeScript SDK (P30).
 *
 * Client-only path: drives an App Server over the protocol. Depends ONLY on
 * `@ar/protocol` (DTOs) + a transport; never imports the runtime.
 */
export * from "./client.js";
export * from "./transport.js";