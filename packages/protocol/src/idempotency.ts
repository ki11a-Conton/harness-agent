/**
 * P29-9 — request idempotency for mutating protocol methods.
 *
 * A retried transport request (duplicate network frame, client retry after a
 * timeout) must not produce a duplicate side effect: thread/start must not
 * create two threads, turn/start must not start two turns, approval/respond
 * and ask/respond must not be applied twice.
 *
 * The idempotency key is scoped to the connection+method: the first request
 * with a given key records its result; a retry with the same key returns the
 * recorded result instead of re-executing. Storage is provided by the caller
 * (per-connection Map, or a shared table) — this type only defines the
 * coverage decision.
 */
export interface IdempotencyRecord {
  key: string;
  result: unknown;
}

/** Deterministic extracted result for a successful mutating call. */
export function idempotentResult(method: string, params: unknown): IdempotencyRecord {
  return {
    key: idempotencyKeyOf(method, params),
    result: { method, ok: true },
  };
}

/** Stable key derivation from method + params (never includes the raw secret —
 *  params here are already DTO shapes without secrets). */
export function idempotencyKeyOf(method: string, params: unknown): string {
  const stable = stableSerialize(params);
  return `${method}:${stable}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * In-memory idempotency table for a single connection. Satisfies P29-9's
 * acceptance: a retried mutating request with the same key returns the
 * previously-returned result instead of re-executing.
 */
export class IdempotencyTable {
  private readonly seen = new Map<string, { key: string; result: unknown }>();

  /** Look up a previous result by explicit idempotency key. */
  lookup(explicitKey: string): unknown | undefined {
    return this.seen.get(explicitKey)?.result;
  }

  /** Record the result for an explicit idempotency key. */
  record(explicitKey: string, result: unknown): void {
    if (!this.seen.has(explicitKey)) this.seen.set(explicitKey, { key: explicitKey, result });
  }
}