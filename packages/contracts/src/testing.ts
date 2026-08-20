/**
 * Q-9 — Shared Test Fixture Builders.
 *
 * One home for the fixtures every package's tests reach for, so the same event
 * / session / turn shapes stop being hand-rolled (and subtly diverging) in each
 * `*.test.ts`. Everything here is DETERMINISTIC: ids are derived from a small
 * integer `n` (or an injected `makeSeed()` counter) and timestamps from an
 * injected clock, so:
 *
 *   - event snapshots are stable and re-runnable (no `Date.now()` flake);
 *   - a test can assert exact payload cross-sections without random drift;
 *   - a parent can call `makeSeed()` once and hand each child a fresh monotone
 *     id sequence that never collides.
 *
 * These builders live in `@ar/contracts` (the package every other package can
 * import) and construct only the pure data-layer shapes. Higher-level builders
 * (makeRuntime / makeTool / makeAgent) belong to the packages that own those
 * types, since `contracts` must not depend on tools/core/agents — a per-package
 * surface is documented in each owning package's `@ar/*` testing entry.
 */
import type { AgentEvent } from "./event.js";
import type { EventId, SessionId, TurnId } from "./ids.js";
import type { Session, SessionStatus, Turn, TurnStatus } from "./session.js";
import type { ModelRef } from "./model.js";
import type { UserMessage } from "./message.js";
import type { AgentId } from "./ids.js";

const DEFAULT_MODEL: ModelRef = { providerId: "test-provider", modelId: "test-model" };
const DEFAULT_AGENT: AgentId = "agent_test-fixture" as AgentId;

/** Injected, deterministic sources of ids + the clock. */
export interface FixtureSeed {
  ids: () => number;
  now: () => number;
}

/** A fresh monotone seed with a fixed clock. Give each fixture its own. */
export function makeSeed(): FixtureSeed {
  let count = 0;
  return {
    ids: () => {
      count += 1;
      return count;
    },
    now: () => 1000,
  };
}

/**
 * Module-level default counter. Each test file gets its own isolated instance
 * (vitest isolates per file), so consecutive `makeEvent()` calls in one suite
 * yield distinct ids while the run stays deterministic and reproducible.
 */
let defaultCounter = 0;

function fixed(seed?: FixtureSeed, n?: number): number {
  if (seed) return seed.ids();
  if (n !== undefined) return n;
  defaultCounter += 1;
  return defaultCounter;
}

/** Deterministic id of a given kind: `<prefix>` + zero-padded sequence. */
function seededId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export function makeSessionId(n: number): SessionId {
  return seededId("session_", n) as SessionId;
}
export function makeTurnId(n: number): TurnId {
  return seededId("turn_", n) as TurnId;
}
export function makeEventId(n: number): EventId {
  return seededId("event_", n) as EventId;
}
export function makeAgentId(n: number): AgentId {
  return seededId("agent_", n) as AgentId;
}

/** An agent-fixture id; give a small `n` to pin the value. */
export function fixtureAgentId(n = 1): AgentId {
  return makeAgentId(n);
}

export interface MakeSessionOverrides extends Partial<Omit<Session, "id">> {
  id?: SessionId;
  n?: number;
  status?: SessionStatus;
}

/** Deterministic minimal Session with sensible defaults. */
export function makeSession(over: MakeSessionOverrides = {}): Session {
  const n = over.n ?? 1;
  return {
    id: over.id ?? makeSessionId(n),
    parentId: over.parentId,
    agentId: over.agentId ?? DEFAULT_AGENT,
    model: over.model ?? DEFAULT_MODEL,
    cwd: over.cwd ?? "/workspace",
    status: over.status ?? "active",
    createdAt: over.createdAt ?? 0,
    updatedAt: over.updatedAt ?? 0,
  };
}

export interface MakeTurnOverrides extends Partial<Omit<Turn, "sessionId" | "input">> {
  sessionId?: SessionId;
  input?: UserMessage;
  n?: number;
  status?: TurnStatus;
}

/** Deterministic minimal Turn. input is a nominal message by default. */
export function makeTurn(over: MakeTurnOverrides = {}): Turn {
  const n = over.n ?? 1;
  const sid = over.sessionId ?? makeSessionId(n);
  return {
    id: over.id ?? makeTurnId(n),
    sessionId: sid,
    input: over.input ?? { sessionId: sid, text: `prompt ${n}` } satisfies UserMessage,
    status: over.status ?? "running",
    startedAt: over.startedAt ?? 0,
    completedAt: over.completedAt,
  };
}

export interface MakeEventOverrides extends Partial<Omit<AgentEvent, "type">> {
  payload?: Record<string, unknown>;
  type?: AgentEvent["type"];
  n?: number;
  seed?: FixtureSeed;
}

/**
 * Deterministic AgentEvent. Default sequence is 0 (the store under test owns
 * sequencing); pass `sequence` as needed. Id + timestamp come from `n` or the
 * injected seed clock so snapshots are stable across runs.
 */
export function makeEvent(over: MakeEventOverrides = {}): AgentEvent {
  const n = over.n;
  const seed = over.seed;
  const seqId = fixed(seed, n);
  const at = over.timestamp ?? (seed ? seed.now() : seqId);
  return {
    id: over.id ?? makeEventId(seqId),
    // A stable default session (session_0001): a loop of makeEvent() in one
    // suite lands in the same session unless the caller overrides it.
    sessionId: over.sessionId ?? makeSessionId(1),
    turnId: over.turnId ?? makeTurnId(n ?? (seqId === 1 ? 1 : seqId)),
    sequence: over.sequence ?? 0,
    timestamp: at,
    schemaVersion: over.schemaVersion,
    type: over.type ?? "turn.started",
    payload: over.payload ?? {},
  };
}