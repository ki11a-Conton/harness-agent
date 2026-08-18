# TASK: REPLAY-001

## Status

In Progress（主会话待验收）

## Goal

Implement `SessionReplayer` in `packages/session` (`@ar/session`): reconstruct a session's turns and status from the durable event stream (replay), and verify consistency against the materialized `SessionStore` snapshot, per AGENT_ARCHITECTURE_PLAN v2.0 §99, §110, §184 (build order `12 replay`).

## Why

`snapshot state == replay state` (§110) is the integrity contract of the persistent observable runtime: the event log is the audit truth (§31), and replay is the only way to prove the materialized store did not drift. Without it, a corrupted store can silently diverge from history.

## Dependencies

- CONTRACT-001 — `AgentEvent` / `EventStore` / `EventSink` (`packages/contracts/src/event.ts`), `Session` / `Turn` / `SessionStore` (`packages/contracts/src/session.ts`), branded IDs.
- EVENT-001 — the `EventStore` interface the replayer consumes; tests use an in-memory fake per §97 (Fake Infrastructure) so REPLAY-001 does not hard-depend on `@ar/events` internals.
- SESSION-001 — the `SessionStore` interface + snapshot rows (`saveStateSnapshot`/`loadStateSnapshot`) the replayer compares against; store interface only.

## Scope

### Create

- `packages/session/src/replay.ts` — `SessionReplayer`:
  - `replayTurns(sessionId, eventStore)` → `TurnReplay[]`: reads the stream in `sequence` order and derives each turn's `status` as a state machine from terminal events
  - `TurnReplay` view: `{ turnId, sessionId, input?, status, startedAt, completedAt? }` derived purely from events (`turn.started` → `running`; `turn.completed` / `turn.failed` / `turn.cancelled` → corresponding terminal state; unknown/missing terminal → `running`)
  - `verifySnapshot(sessionId, eventStore, sessionStore)` → consistency report: compares replay-derived state vs `loadStateSnapshot` (+ `listTurns`), returning equality verdict or a diff of mismatches
- `packages/session/src/replay.test.ts` — replay + consistency tests

### Modify

- `packages/session/src/index.ts` — re-export replayer (package skeleton exists; src is filled by this task)

### Forbidden

- No writing to the event store or session store during replay (replay must be read-only)
- No cross-package imports beyond `@ar/contracts` (+ dev-only fakes)
- No guessing of turn status that contradicts a terminal event

## Key Design Decisions

- **turn status derived from terminal events** — the replayer is a pure fold over the ordered stream: `turn.started` opens a turn in `running`; the first of `turn.completed` / `turn.failed` / `turn.cancelled` (current contracts: no `turn.cancelled` event but `EVENT_TYPES` includes it via `turn.cancelled`) closes it; a turn with no terminal event stays `running`. No heuristic inference — the stream is the only authority.
- **sequence order is the ordering** — replay sorts/consumes strictly by `sequence` (monotonic per §109), so replay is deterministic regardless of physical line order.
- **snapshot == replay is a comparison, not a repair** — `verifySnapshot` returns the verdict and a structured diff (which turns/sessions/statuses/snapshot rows disagree); it never auto-writes, so drift is surfaced to the caller (§31: event log is audit trail, not the only store — both must agree).
- **interfaces over implementations** — replayer depends on `EventStore` / `SessionStore` contract types; tests inject in-memory fakes (§97), and the verification path is exercised against the real `JsonlEventStore`/`JsonlSessionStore` in integration-style tests only if available.
- **duplicate/lost events are reported** — non-monotonic or duplicate `event.id` encountered mid-replay raises/includes a corruption report rather than silently resolving.

## Tests

- Replay of in-memory event stream: `turn.started` alone → `running`; with `turn.completed` → `completed`; `turn.failed` → `failed`; `turn.cancelled` → `cancelled`; multiple turns in one session order correctly
- Replay ignores non-turn events (`tool.*`, `model.*`, …) without affecting turn state
- Determinism: same events, shuffled append order → same replay result (sequence ordering)
- `verifySnapshot` returns equal verdict when `saveStateSnapshot` matches replay; returns diff when snapshots/turns diverge (e.g. store turn marked `completed`, stream says `running`)
- Replay is read-only: store/session fakes record zero write calls
- Corruption: duplicate `event.id` or non-monotonic sequence in stream → reported, not silently accepted

## Acceptance Criteria

From plan §110 (verbatim): reconstruct a session from events; Acceptance: `snapshot state == replay state`.

From plan §31 (verbatim): "Events are the audit trail. Do not make the event log the only state store. Event Store + Materialized Session State … allows fast reads, replay, audit, debugging." — REPLAY-001 delivers the `replay` capability and the equality check that keeps the two stores consistent.

From plan §28 (verbatim): sessions must support `replay` — this task implements it; §184 build order `12 replay`.

## Residual Risks

- `verifySnapshot` compares what the current code defines as "session state"; version skew between snapshot `schemaVersion` and event `schemaVersion` must be surfaced by the replayer, not silently compared.
- Events missing from the log (lost append) yield a deterministically wrong replay — detection is limited to the corruption checks; gap detection between expected `session.created` and first event is reported as a warning.
- Terminal-event semantics may evolve when `turn.cancelled` emission is wired in upstream (LOOP/RECOVERY phases); the state machine must map all terminal types from `EVENT_TYPES` as they are emitted.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **174/174 passed (exit 0)** — 2026-08-11, main session（含 P2 集成套件 3/3：重启恢复、事件序列续接、replay 与快照一致性）
- Main-agent review: **done** — 逐文件审查 event-store.ts / session-store.ts / service.ts / replay.ts / p2-integration.test.ts。修复：replay ReplayMessage 提取与 ToolOrchestrator 实际 payload 形状不一致（orchestrator 注入 {toolCallId, tool} 且 onOutput 透传 {stream, text}，原实现只认 {name, output}）→ 兼容两种形状并补 orchestrator 形状测试；修正文档类名（JsonlEventStore → JSONLEventStore）
- Cross-package integration verified: JSONLEventStore + SessionService/SessionReplayer 同一 dataDir 端到端（p2-integration.test.ts）
