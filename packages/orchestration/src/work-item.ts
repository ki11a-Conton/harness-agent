/**
 * P33-3 — Normalized WorkItem.
 *
 * A tracker-agnostic work item. The orchestrator NEVER interprets provider-
 * native opaque references; it only consumes the normalized fields below. The
 * provider-native reference (`opaque`) may be preserved without core
 * interpretation so the tracker can round-trip it back to the source.
 */

/** Opaque provider-native reference. Never interpreted by the orchestrator. */
export interface OpaqueRef {
  /** e.g. tracker-specific id, URL, cursor... */
  readonly kind: string;
  readonly value: string;
  readonly [k: string]: unknown;
}

export interface WorkItem {
  /** Stable id used by the orchestrator (per-tracker unique). */
  readonly id: string;
  /** Human/consumer-facing identifier (e.g. "ABC-123"). */
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  /** Tracker-native state string (e.g. "todo" | "in_progress" | "done"). */
  readonly state: string;
  readonly priority?: number;
  readonly labels: readonly string[];
  /** True when the orchestrator may claim this item for a worker. */
  readonly dispatchable: boolean;
  readonly updatedAt?: number;
  /** Provider-native opaque reference, preserved, never interpreted. */
  readonly opaque?: OpaqueRef;
}

/** Opaque brand so callers can't accidentally pass a bare string. */
declare const workIdBrand: unique symbol;
export type WorkId = string & { readonly [workIdBrand]: "WorkId" };

export function workId(id: string): WorkId {
  return id as WorkId;
}