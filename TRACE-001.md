# TASK: TRACE-001

## Status

In Progress（主会话待验收）

## Goal

Create `packages/observability` — episode trace export, per AGENT_ARCHITECTURE_PLAN v2.0 §77 (Trace Package), §78 (Observability metrics), §79 (structured log fields), §168 (repository snapshot).

Every completed run produces a self-contained `episode/` directory with the §77 file set; `metrics.json` carries the §78 metric set computed purely from the event stream; `summary.json` adds a structured rollup including the §168 repository snapshot.

## Why

Evaluation (plan §71–§76) and trace-based debugging (§165) need a deterministic, replayable export of a run: raw events + extracted tool/permission trails + metrics + verification outcome. The event store and session store already persist everything; TRACE-001 is the read-side packaging layer that turns them into a golden-trace-compatible package without touching the runtime.

## Dependencies

- EVENT-001 / SESSION-001 (interfaces `EventStore` / `SessionStore` already in `@ar/contracts`; this package reads them via those interfaces only)
- CONTRACT-001 types: `AgentEvent`, `TaskSpec`, `Verifier`, `VerificationContext`, `VerificationResult`, `Session`

## Scope

### Create

- `tasks/P9/TRACE-001.md` (this file)
- `packages/observability/package.json` — name `@ar/observability`, ESM, exports `./src/index.ts`, scripts `typecheck: tsc -b` / `test: vitest run`. Dependency: only `@ar/contracts` (the `@ar/events` / `@ar/session` packages are NOT needed: `exportEpisode` consumes the `EventStore`/`SessionStore` interfaces, never the JSONL implementations).
- `packages/observability/tsconfig.json` — extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: ../../node_modules/.cache/tsbuildinfo/observability.tsbuildinfo`, `include: ["src"]`, references `../contracts`.
- `packages/observability/src/metrics.ts` — `computeMetrics(events: AgentEvent[]): RunMetrics` implementing §78; metric derivation conventions documented in JSDoc:
  - `turn_count` = `turn.started` count
  - `tool_call_count` = `tool.requested` count
  - `tokens_input` / `tokens_output` / `context_tokens` = sums of `payload.usage.{inputTokens,outputTokens,contextTokens}` across `model.*` events (flat fallbacks `inputTokens` / `outputTokens` / `contextTokens`); `context_tokens` additionally sums numeric `payload.tokens` from `context.built` events
  - `compaction_count` = `context.compacted` count
  - `duration_ms` = last − first event timestamp (0 when < 2 events)
  - `retry_count` = `run.limit_reached` with `payload.limit === "maxRetries"` + `tool.failed` with `payload.retried === true` (runtime has no dedicated retry event today; documented convention)
  - `verification_failures` = `verification.failed` count + `verification.completed` with `payload.passed === false`
  - `human_interventions` = `human.*` event count
  - `estimated_cost` = sum of explicit `payload.usage.cost` / `payload.cost` on `model.*` events when present; otherwise default-rate estimate (`DEFAULT_COST_PER_INPUT_TOKEN = 2e-6` USD, `DEFAULT_COST_PER_OUTPUT_TOKEN = 8e-6` USD), rounded to 10 decimals
- `packages/observability/src/trace-exporter.ts` — `exportEpisode(deps: { events: EventStore; sessions: SessionStore; task?: TaskSpec; verifier?: Verifier; outputDir: string }): Promise<EpisodePackage>` writing the 10 §77 files:
  - `task.json` (`task ?? {}`), `session.json`, `events.jsonl` (raw `AgentEvent`, one JSON per line, sequence order)
  - `context.json` = `{ builds: [...context.built events], compactions: [...context.compacted events] }`
  - `tool-calls.jsonl` — one line per `tool.requested` / `tool.completed` / `tool.failed` event; `toolCallId`/`tool`/`args`/`status`/`durationMs`/`evidence`/`outputPreview`/`error` extracted from payload (`tool = payload.tool ?? payload.name` — runtime uses `name`, orchestrator uses `tool`)
  - `permissions.jsonl` — one line per `tool.permission_requested` / `tool.permission_resolved` / `human.*` event
  - `artifacts.json` = `{ artifacts: [{ path, kind?, description?, at }] }` from `tool.completed` evidence entries with a string `source` + `payload.artifacts` string arrays
  - `verification.json` — verifier result (`{ source: "verifier", ...result }`) when both `task` and `verifier` are given; else the last `verification.completed`/`verification.failed` payload (`{ source: "events", ... }`); else `{ source: "none" }`
  - `metrics.json` = `computeMetrics` output; `summary.json` — `{ sessionId, status, taskId?, startedAt, endedAt, turnCount, toolCallCount, artifactCount, artifacts[], verification, metrics, repoSnapshot, files }` where `repoSnapshot` is the §168 capture (node version; git branch/commit/dirty/changed-files via `spawnSync` in `session.cwd`, `available: false` on failure)
  - `exportEpisode` requires exactly one session in the store (0 → throw, >1 → throw); empty event stream exports an empty package without throwing
- `packages/observability/src/index.ts` — exports both modules
- `packages/observability/src/trace-exporter.test.ts` — in-memory `EventStore`/`SessionStore` fakes (mirroring the `@ar/contracts` interfaces), ≥ 10 cases

### Modify

- `tsconfig.json` (root references: add `./packages/observability`)

### Forbidden

- No third-party dependencies
- No changes to contracts, events, session, core, or any other package
- No runtime changes (export is read-only; the runtime's current event payload shapes are documented as conventions, not patched)
- No secrets in exported files (payloads are written as-is; export does not add any credential material)

## Key Design Decisions

- **Interfaces only**: `exportEpisode` depends on `EventStore`/`SessionStore` interfaces from `@ar/contracts`, so `@ar/events`/`@ar/session` are not dependencies and the exporter works with any store implementation.
- **Events are the source of truth** for metrics (§78 "从事件统计得出"): metrics are derived purely from the event stream, never from the session record. Missing usage payloads yield 0 (honest "not recorded"), not fabricated values.
- **Fail-closed discovery**: the export target is identified by store inspection (exactly one session). Ambiguity or absence throws instead of guessing.
- **Empty stream is valid**: a session with zero events still exports a complete, parseable package (zeroed metrics, empty trails) — required by the tests.
- **§168 in summary.json**: the repository snapshot (git branch/commit/dirty/changed files, node version) has no dedicated §77 file, so it lives in `summary.json`; git capture failure degrades to `available: false` rather than failing the export.

## Tests

In-memory fakes for `EventStore` (append assigns monotonic sequence; list/stream/nextSequence) and `SessionStore` (session/turn/message maps). Cases:

1. 10-file package layout matches §77 exactly
2. `events.jsonl` parses line-by-line; line count == event count; sequence order preserved
3. `metrics.json` counts turns and tool calls
4. token sums (input/output/context) from usage payloads
5. compaction / verification failures / human interventions / duration
6. retry counting (maxRetries limit event + `retried: true` tool failures)
7. estimated cost (default-rate fallback + explicit cost honored)
8. `tool-calls.jsonl` contains only requested/completed/failed entries with correlation keys
9. `permissions.jsonl` contains only permission and human entries
10. `summary.json` carries sessionId/status/artifact list/metrics
11. empty event stream → empty package, no throw, zeroed metrics
12. `task.json` mirrors the TaskSpec
13. verifier result embedded; verifier receives changedPaths/cwd
14. `artifacts.json` collects file evidence from `tool.completed`
15. `computeMetrics` unit behavior on a synthetic stream
16. `session.json` round-trips the stored session

## Acceptance Criteria

- `pnpm typecheck` passes (root, after adding the reference and installing)
- `pnpm vitest run packages/observability` passes (≥ 10 tests)
- No third-party dependencies added
- Exported files for a realistic session: events.jsonl parseable line-by-line; metrics reflect event statistics; empty-session export does not throw

## Residual Risks

- Metrics rely on documented payload conventions (`usage.{input,output,context}Tokens`, `limit: "maxRetries"`, `retried: true`) that the current runtime does not fully emit yet — e.g. model usage is not written into `model.*` event payloads today, so `tokens_*` will be 0 for real runs until the runtime forwards usage. Honest zeros by design.
- `retry_count` has no dedicated runtime event; the convention counts explicit markers. Recovery retries that are re-executions without events remain invisible.
- Repo snapshot depends on `git` being on PATH and the session cwd being inside a git worktree; otherwise `available: false`.

## Verification

- `pnpm typecheck` — **green (exit 0)** — 2026-08-12, root (after adding packages/observability reference + `pnpm install`)
- `pnpm vitest run packages/observability` — **19/19 PASS (exit 0)** — 2026-08-12, root
- Full suite `pnpm vitest run` — 354 passed / 1 skipped / 0 failed at 08:53 (the single transient delegator failure during the run belonged to a concurrently working agent session on packages/agents, since resolved; delegator.test.ts re-verified 20/20)
- Main-agent review: **done** — 逐文件审查 metrics.ts 抽取约定（usage/retry/cost）、trace-exporter.ts 10 文件写入与事件提取、测试 fake 与断言。修复：summary 与 verification.json 共用同一 buildVerification 结果（避免 source/passed 不一致）；测试中 tool_call_count 计数约定（tool.requested）与 fixture 对齐

## Definition of Done

- [ ] `tasks/P9/TRACE-001.md` exists
- [ ] `packages/observability` implements §77/§78/§79/§168 deliverables
- [ ] ≥ 10 tests pass
- [ ] Root `pnpm typecheck` passes
- [ ] No third-party dependencies
- [ ] Evidence: typecheck + test output reported
