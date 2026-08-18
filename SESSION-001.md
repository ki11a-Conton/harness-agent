# TASK: SESSION-001

## Status

In Progress（主会话待验收）

## Goal

Implement persistent session storage in `packages/session` (`@ar/session`): a JSONL-backed `SessionStore` (sessions, turns, messages, state snapshots) plus a `SessionService` lifecycle (create / resume / fork / cancel / complete / archive / create) per AGENT_ARCHITECTURE_PLAN v2.0 §99, §108, §184 (build order `10 session`).

## Why

A session must survive process restart ("kill process → restart → resume → continue", §108). Sessions are the unit of continuity for the whole runtime; without durable storage no later phase (context, loop, recovery, multi-agent) can work.

## Dependencies

- CONTRACT-001 — `Session` / `Turn` / `Message` / `SessionStore` interfaces in `packages/contracts/src/session.ts` (§26–§27), branded IDs in `ids.ts`.
- EVENT-001 (sibling, NOT a hard dependency) — per §108 the session store also "stores" events; the durable event stream is implemented by EVENT-001 in `@ar/events` per build order (`10 session` → `11 events`). SESSION-001 must not block on it; persistence of `session.created/resumed/forked` etc. as events is EVENT-001's concern.
- REPLAY-001 (downstream) — reads this package's snapshot interface (`saveStateSnapshot`/`loadStateSnapshot`) and the `SessionStore` for consistency checks.

## Scope

### Create

- `packages/session/src/session-store.ts` — `JsonlSessionStore` implementing contracts `SessionStore`:
  - JSONL files per session: `<dataDir>/sessions/<sessionId>.jsonl` (turns+messages+snapshots in one append-only line stream), `<dataDir>/sessions/<sessionId>.meta.json` (schemaVersion wrapper for session row)
  - `createSession` / `getSession` / `updateSession` / `listSessions`
  - `createTurn` / `getTurn` / `updateTurn` / `listTurns`
  - `appendMessage` / `listMessages` / `listMessagesByTurn`
  - `saveStateSnapshot` / `loadStateSnapshot`
- `packages/session/src/service.ts` — `SessionService` lifecycle:
  - `create` (active session + first turn), `resume` (re-open a persisted session), `fork` (new session with `parentId`, §27 `parentId`), `cancel`, `complete`, `archive` (status transitions to `cancelled` / `completed` / archived marker), duplicate `create` guarded
- `packages/session/src/session-store.test.ts` — store persistence tests
- `packages/session/src/service.test.ts` — lifecycle tests

### Modify

- `packages/session/src/index.ts` — re-export store + service (package skeleton exists; src is filled by this task)

### Forbidden

- No symlink-following reads/writes; no reads outside `dataDir`
- No cross-package imports beyond `@ar/contracts`
- No in-memory-only fallback that hides persistence failures

## Key Design Decisions

- **JSONL append-only + schemaVersion wrapper** — each session's life is an append-only line stream (immutable history, crash-safe partial-file tolerance); the session header row and snapshot rows are wrapped in a `{ schemaVersion, payload }` envelope so future migrations are detectable (§154–§155 serialization/migration). Only snapshots and status updates are written as additional lines, never rewritten in place.
- **dataDir injectable** — constructor takes `dataDir: string` (resolved to absolute path); tests inject `fs.mkdtemp` dirs; app injects the configured store root. No hardcoded paths.
- **id path safety** — `SessionId`/`TurnId` are branded `session_<uuid>` / `turn_<uuid>` (contracts `ids.ts`). Store must reject any id that fails `isId("session"|"turn", …)` plus UUID-shape check, and must reject ids containing path separators or `.`/`..` before using them to derive filenames — ids are never treated as raw path components.
- **Snapshots are versioned state rows** — `saveStateSnapshot` appends a snapshot line; `loadStateSnapshot` returns the last one; snapshot existence is what REPLAY-001 compares against (§110).
- **archive is a status, export is out of scope** — §28 lists `archive`/`export`; `archive` is implemented as status marking here; `export` (trace packaging, §77) is deferred to TRACE-001; `replay` is REPLAY-001. `branch` is realized as `fork` with `parentId` (distinct future id in §27).

## Tests

- Store: create/get/update/list round-trip through a real temp-dir JSONL file; restart simulation (new store instance on same dir) restores sessions/turns/messages/snapshots — the "kill process → restart → resume → continue" flow (§108 acceptance)
- Store: corrupted/truncated final line tolerated, earlier lines intact
- Store: id path-safety rejections (path separator, `..`, wrong prefix, non-UUID)
- Store: `schemaVersion` envelope present and `loadStateSnapshot` returns latest snapshot
- Service: create → complete → resume → continue; fork sets `parentId`; cancel transitions; duplicate create rejected; unknown id rejected

## Acceptance Criteria

From plan §108 (verbatim): persistent sessions; Store: `session, turn, messages, events, state snapshots`; Acceptance: `kill process → restart → resume → continue`.

From plan §28 (verbatim): a session must survive process restart, and must support `create, resume, fork, branch, cancel, archive, export, replay` — mapped within this task as: create ✓ (this task), resume ✓, fork ✓ / branch = fork-with-parentId ✓, cancel ✓, complete ✓ (status), archive ✓ (status marking), export → TRACE-001 (out of scope), replay → REPLAY-001 (this task's snapshot + store interfaces are its input).

## Residual Risks

- Event rows listed in §108's store list are actually persisted by EVENT-001; any divergence between snapshot rows and event log must be resolved in REPLAY-001, not here.
- Partial writes (crash mid-line) can leave a torn final line; mitigation is tolerance + schemaVersion check, not repair.
- No concurrency across processes for the same session file (single-writer assumption) — document in code; multi-process append locking is out of scope.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **174/174 passed (exit 0)** — 2026-08-11, main session（含 P2 集成套件 3/3：重启恢复、事件序列续接、replay 与快照一致性）
- Main-agent review: **done** — 逐文件审查 event-store.ts / session-store.ts / service.ts / replay.ts / p2-integration.test.ts。修复：replay ReplayMessage 提取与 ToolOrchestrator 实际 payload 形状不一致（orchestrator 注入 {toolCallId, tool} 且 onOutput 透传 {stream, text}，原实现只认 {name, output}）→ 兼容两种形状并补 orchestrator 形状测试；修正文档类名（JsonlEventStore → JSONLEventStore）
- Cross-package integration verified: JSONLEventStore + SessionService/SessionReplayer 同一 dataDir 端到端（p2-integration.test.ts）
