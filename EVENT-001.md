# TASK: EVENT-001

## Status

In Progress（主会话待验收）

## Goal

Implement the durable JSONL event stream in `packages/events` (`@ar/events`): an `EventStore` (append / list / stream / nextSequence) per AGENT_ARCHITECTURE_PLAN v2.0 §99, §109, §184 (build order `11 events`).

## Why

Events are the audit trail (§31 "Event Sourcing Rule"): the runtime must be observable, and replay (REPLAY-001) depends on an unambiguous, lossless stream. Without monotonic sequences and ID de-duplication, replay cannot reconstruct state deterministically.

## Dependencies

- CONTRACT-001 — `AgentEvent` / `EventStore` / `EventSink` interfaces and `EVENT_TYPES` in `packages/contracts/src/event.ts` (§29–§30), branded `EventId` in `ids.ts`.
- SESSION-001 — interface-level only: events are scoped by `sessionId`, but `@ar/events` must not import `@ar/session`; the session package consumes this store (or a caller wires both). No hard dependency at build time (contract holds the types).

## Scope

### Create

- `packages/events/src/event-store.ts` — `JSONLEventStore` implementing contracts `EventStore`:
  - append-only JSONL per session: `<dataDir>/events/<sessionId>.jsonl`
  - `append(event)` — assigns `sequence` from store state, enforces monotonicity and `event.id` uniqueness, persists, returns stored event
  - `list(sessionId, {afterSequence, limit})`
  - `stream(sessionId, {afterSequence})` — async iterable over the log
  - `nextSequence(sessionId)` — next value the store will assign (recovery: max persisted sequence + 1)
  - corruption detection: unparseable/out-of-order/duplicate-id lines are flagged on read (tail tolerance for torn last line, hard error for mid-log corruption)
- `packages/events/src/event-store.test.ts` — stream tests

### Modify

- `packages/events/src/index.ts` — re-export store (package skeleton exists; src is filled by this task)

### Forbidden

- No in-memory sequence counter that ignores the persisted log
- No rewriting or deleting appended lines
- No cross-package imports beyond `@ar/contracts`

## Key Design Decisions

- **JSONL append-only + schemaVersion** — each line is `{ schemaVersion: 1, event: AgentEvent }`; append-only gives crash tolerance (torn last line tolerated) and an immutable audit trail (§31). A header comment line records schemaVersion.
- **sequence allocated by the store (monotonic increasing)** — callers never choose `sequence`; the store computes `maxPersisted + 1` per session (re-read tail after restart), guaranteeing §29's "monotonically increasing within a session" even across process restarts.
- **event.id de-duplication** — the store keeps an id index (rebuilt from the log on open); `append` rejects an `id` already present, and read-side corruption detection reports duplicate ids.
- **dataDir injectable** — constructor takes `dataDir` (resolved absolute); tests inject temp dirs.
- **id path safety** — `EventId`/`SessionId` are branded `event_<uuid>` / `session_<uuid>`; ids failing `isId` + UUID-shape checks, or containing path separators / `.` / `..`, are rejected before filename derivation.
- **stream is log-backed, not memory-backed** — `stream` reads lines incrementally (no full-file materialization), so large sessions stay bounded (§31 fast reads + audit).

## Tests

- Append assigns strictly increasing sequences within a session; independent per-session counters
- Restart simulation: new store instance on same dir continues sequence without gaps/duplicates
- `event.id` duplicate append rejected; duplicate ids across the persisted log detected on read
- `list` with `afterSequence` / `limit`; `stream` yields identical events in order
- Corruption: torn final line tolerated; mid-log bad line / non-monotonic sequence / duplicate id raises corruption error
- Path safety: separator, `..`, wrong-prefix, non-UUID ids rejected

## Acceptance Criteria

From plan §109 (verbatim): durable event stream; Acceptance: `monotonic sequence, no duplicate event IDs, replay reconstructs state`.

From plan §29 (verbatim): `sequence` must be monotonically increasing within a session. From plan §30: the minimum event type set (`session.created` … `approval.resolved`) must all be representable; from §31: events must enable audit and replay without becoming the only state store.

`replay reconstructs state` is verified end-to-end in REPLAY-001; EVENT-001's contribution is the lossless, ordered, de-duplicated stream that makes it possible.

## Residual Risks

- Two writers appending to the same session file concurrently can interleave sequences; single-writer-per-session assumption documented, multi-process locking out of scope.
- Duplicate-id detection requires the id index to be rebuilt on open — O(n) memory for very long logs; acceptable at this phase, revisit in TRACE-001.
- Torn final line is silently discarded (no repair); a crash mid-append loses at most one event.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **174/174 passed (exit 0)** — 2026-08-11, main session（含 P2 集成套件 3/3：重启恢复、事件序列续接、replay 与快照一致性）
- Main-agent review: **done** — 逐文件审查 event-store.ts / session-store.ts / service.ts / replay.ts / p2-integration.test.ts。修复：replay ReplayMessage 提取与 ToolOrchestrator 实际 payload 形状不一致（orchestrator 注入 {toolCallId, tool} 且 onOutput 透传 {stream, text}，原实现只认 {name, output}）→ 兼容两种形状并补 orchestrator 形状测试；修正文档类名（JsonlEventStore → JSONLEventStore）
- Cross-package integration verified: JSONLEventStore + SessionService/SessionReplayer 同一 dataDir 端到端（p2-integration.test.ts）
