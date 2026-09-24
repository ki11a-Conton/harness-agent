/**
 * P22-1 — composition helper: STORES.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only — no
 * second implementation, no behavior change). Owns every store the harness
 * persists into and the composition root's ONE event writer (P16-5).
 */
import { join } from "node:path";
import {
  newEventId,
  type AgentEvent,
  type ApprovalStore,
  type ArtifactStore,
  type AskUserStore,
  type CheckpointStore,
  type EventStore,
  type InboxStore,
  type SessionId,
  type SessionStore,
} from "@ar/contracts";
import { InMemoryArtifactStore } from "@ar/core";
import { DurableCheckpointStore } from "@ar/checkpoint";
import { DurableApprovalStore, InMemoryApprovalStore } from "@ar/security";
import { JSONLAskUserStore, JSONLInboxStore, JSONLSessionStore, MemInboxStore } from "@ar/session";
import { JSONLEventStore } from "@ar/events";
import { SqliteRuntimeStore } from "@ar/store";
import { MemEventStore, MemSessionStore } from "../mem-stores.js";
import type { HarnessConfig, HarnessFeatureFlags } from "../config.js";

export interface ComposedStores {
  sqliteStore: SqliteRuntimeStore | undefined;
  store: SessionStore;
  events: EventStore;
  approvalStore: ApprovalStore;
  inbox: InboxStore;
  askUserStore: AskUserStore | undefined;
  checkpointStore: CheckpointStore | undefined;
  artifactStore: ArtifactStore | undefined;
  /** P16-5: the injected host clock (config.now, default Date.now). */
  now: () => number;
  /** The composition root's ONE event writer — every append goes through it:
   *  the injected clock stamps the timestamp, the store's sequence allocator
   *  stays authoritative (sequence: 0 placeholder, never direct Date.now). */
  appendHarnessEvent(
    sessionId: string,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    extra?: { turnId?: string; timestamp?: number },
  ): Promise<void>;
}

/** P22-1 — compose all harness stores from config + feature flags. */
export function composeStores(
  config: HarnessConfig,
  features: HarnessFeatureFlags,
): ComposedStores {
  const dataDir = config.dataDir;
  // P5-3: `dataStore: "sqlite"` replaces the five JSONL runtime stores with a
  // single SqliteRuntimeStore (WAL) — same contracts, one file, one close.
  const useSqliteStore = config.dataStore === "sqlite" && dataDir !== undefined;
  const sqliteStore: SqliteRuntimeStore | undefined = useSqliteStore
    ? new SqliteRuntimeStore({ dataDir })
    : undefined;
  const store: SessionStore =
    sqliteStore ?? (dataDir !== undefined ? new JSONLSessionStore({ dataDir }) : new MemSessionStore());
  const events: EventStore =
    sqliteStore ?? (dataDir !== undefined ? new JSONLEventStore({ dataDir }) : new MemEventStore());
  const approvalStore: ApprovalStore =
    dataDir !== undefined ? new DurableApprovalStore(join(dataDir, "approval-store.json")) : new InMemoryApprovalStore();
  const inbox: InboxStore =
    sqliteStore ?? (dataDir !== undefined ? new JSONLInboxStore({ dataDir }) : new MemInboxStore());
  // P1-5: durable ask-user store under a dataDir (crash-safe pending questions).
  const askUserStore: AskUserStore | undefined =
    sqliteStore?.askUser ??
    (dataDir !== undefined ? new JSONLAskUserStore({ dataDir }) : undefined);
  const checkpointStore: CheckpointStore | undefined =
    sqliteStore?.checkpoints ??
    (dataDir !== undefined && features.checkpoint ? new DurableCheckpointStore({ dataDir }) : undefined);
  const artifactStore: ArtifactStore | undefined = features.artifacts ? new InMemoryArtifactStore() : undefined;

  // P16-5: the composition root's ONE event writer. Every append in this file
  // goes through it: the INJECTED clock (config.now, default Date.now) stamps
  // the timestamp and the store's sequence allocator stays authoritative.
  // Direct Date.now()/sequence:0 escapes are banned below (grep-auditable).
  const now = config.now ?? Date.now;
  const appendHarnessEvent = async (
    sessionId: string,
    type: AgentEvent["type"],
    payload: Record<string, unknown>,
    extra: { turnId?: string; timestamp?: number } = {},
  ): Promise<void> => {
    await events.append({
      id: newEventId(),
      sessionId: sessionId as SessionId,
      ...(extra.turnId !== undefined ? { turnId: extra.turnId as never } : {}),
      sequence: 0, // the store's allocator is authoritative (P16-5)
      timestamp: extra.timestamp ?? now(),
      type,
      payload,
      schemaVersion: 1,
    });
  };

  return {
    sqliteStore,
    store,
    events,
    approvalStore,
    inbox,
    askUserStore,
    checkpointStore,
    artifactStore,
    now,
    appendHarnessEvent,
  };
}
