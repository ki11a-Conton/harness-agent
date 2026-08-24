# Session Actor: Single Owner of Live Session State

> P25 + P35-3 architecture doc. Documents why a session can never run two turns
> concurrently and how steer/follow-up/cancel are handled.

## The core statement

A logical session/thread has **at most one active executing turn**. All live
runtime state (active turn, input queue, cancellation, resource scope) is owned
by one `SessionActor`; the durable `PersistentSession` is a separate, serializable
shape that never holds AbortControllers, promises, sockets, locks or timers.

## Components

- `PersistentSession` — durable: id, parentId, agentId, model, cwd, status,
  createdAt, updatedAt.
- `LoadedSession` — runtime-only: persistent ref + `activeTurn?`, inputQueue,
  resourceScope, cancellation (AbortController).
- `SessionActor` — `startTurn` / `steer` / `enqueueFollowup` / `interrupt` /
  `status`; owns the active turn.
- `LoadedSessionManager` — `load` / `unload` / `listLoaded` / `close`;
  load is idempotent, unload/close are idempotent.

## Invariants

- **INV-V5-005 — single active turn**: `count(active executing turns) <= 1` per
  session, always. A second `turn/start` while one is active must resolve to
  exactly one of `BUSY` / `STEER` / `QUEUE` — never a silent parallel run.
- **INV-SES-001 — durable/live separation**: AbortController, promises, MCP
  sockets, locks and timers are never serialized into `PersistentSession`.
- **INV-SES-002 — steer at sampling boundary only**: steer input is injected
  before the next model sampling, never mid-tool-call, never by mutating an
  already-built Step snapshot. Steer arriving during Step S1 → S1 completes/
  cancels per policy → next sampling snapshot S2 includes the steer.
- **INV-SES-003 — follow-up is explicit**: a normal user message during a turn
  is queued as `kind=followup` (never inferred from text) and drained into a
  NEW turn after the current one settles.
- **INV-SES-004 — orderly shutdown**: `unload`/close = interrupt active turn →
  settle non-cancellable in-flight tools → flush journal/fences → close
  session-bound resources → release MCP references → remove actor; idempotent.
- **INV-SES-005 — fork semantics not overloaded**: `session.spawnChild` (empty
  child, subagent parentage) ≠ `thread.fork` (copies parent history, branch).

## Enforcement points

- `packages/core/src/runtime/session-actor.ts` — `DefaultSessionActor` with the
  hard `activeTurn ∈ {0,1}` invariant; `sessionBusy()` raises `SESSION_BUSY`.
- `packages/core/src/runtime/runtime.ts` — per-session `runTurn` guard
  (max concurrent == 1, bypass-proof); `pendingRun` closes the submit→cancel
  race.
- `packages/core/src/runtime/session-race.test.ts` / `session-race2.test.ts` —
  P34-2 same-session race suite (note: the `race-*` variants are the known
  noisy timing tests — see HANDOFF §3.1).
