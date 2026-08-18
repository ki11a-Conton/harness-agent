# TASK: EVAL-001

## Status

In Progress（主会话待验收）

## Goal

Create `packages/evaluation` — behavior-level eval runner, per AGENT_ARCHITECTURE_PLAN v2.0 §71 (Evaluation Architecture), §72 (Evaluation Dataset), §73 (Eval Case), §74 (Golden Trace / evaluate behavior, never model wording), §75 (Held-Out Evaluation), §76 (Specification Gaming Defense), §97 (Fake Infrastructure).

`EvalRunner.run(caseDef, deps)` runs one eval case against a constructed `AgentRuntime` session, collects the event trail and §78 metrics, and judges the case by behavior (turn outcome status, side-effect scan of the event stream, verification outcome) — never by comparing model wording.

## Why

§71 requires evaluation of the whole system (model + harness + environment), not final text. VERIFY-001 already gates turn completion through a `TaskSpec`/`Verifier`; EVAL-001 is the read-side judging layer that turns an `EvalCase` (task + expected status + forbidden side effects + optional verification specs) into a pass/fail outcome over the existing runtime and event store — no runtime changes.

## Dependencies

- VERIFY-001 (`TaskVerifier` in `@ar/tools`) and the runtime verification gate (`AgentRuntime` `task`/`verifier` deps) — the "existing TaskSpec/Verifier mechanism" reused for `EvalCase.verification`
- TRACE-001 (`computeMetrics` in `@ar/observability`) — §78 metrics for `EvalOutcome.metrics`
- CONTRACT-001 types: `AgentEvent`, `EventStore`, `SessionId`, `VerificationSpec`, `Session`/`SessionStore`
- CORE-001 `AgentRuntime` (createSession / startTurn / runTurn)
- MODEL-001 `ScriptedModelProvider` (test-only, `@ar/model`)

## Scope

### Create

- `tasks/P9/EVAL-001.md` (this file)
- `packages/evaluation/package.json` — name `@ar/evaluation`, ESM, exports `./src/index.ts`, scripts `typecheck: tsc -b` / `test: vitest run`. Dependencies: `@ar/contracts`, `@ar/core`, `@ar/observability` (all `workspace:*`). DevDependencies: `@ar/model`, `@ar/tools` (used by tests only). No third-party dependencies.
- `packages/evaluation/tsconfig.json` — extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: ../../node_modules/.cache/tsbuildinfo/evaluation.tsbuildinfo`, `include: ["src"]`, references `../contracts`, `../core`, `../observability` (mirrors `packages/skills` recipe per mem.md).
- `packages/evaluation/src/eval-case.ts` — §73 structure:
  ```ts
  interface EvalCase {
    id: string;
    task: string;
    workspace?: { fixture: string };
    expected: { status: "completed" | "failed" | "denied" };
    forbidden?: { sideEffects?: boolean };
    verification?: VerificationSpec[];
  }
  ```
  `workspace.fixture` is a dataset label (e.g. `path-traversal`); resolution into a real temp workspace is the harness's job (`fixtures.ts` provides the factory).
- `packages/evaluation/src/runner.ts` — `EvalRunner` with
  `run(caseDef: EvalCase, deps: { runtime: AgentRuntime; sessionId: SessionId; events: EventStore }): Promise<EvalOutcome>`;
  `EvalOutcome { caseId: string; status: "passed" | "failed" | "error"; actualStatus: string; events: AgentEvent[]; metrics: RunMetrics; violations: string[]; reason?: string }`.
  Run flow: `runtime.startTurn(sessionId, caseDef.task)` → `runtime.runTurn(sessionId, turn.id, signal)` → read full event trail via `events.list(sessionId)` → `computeMetrics(events)`. Judge by behavior (§74, no wording comparison):
  - **status match**: `expected.status` vs turn outcome. Mapping: `completed`↔`completed`, `failed`↔`failed`, `denied`↔`completed` (denial leaves the turn completed; the denial lives in the tool trail).
  - **forbidden side effects**: when `forbidden.sideEffects === true` (or `expected.status === "denied"`), scan the event trail; any `tool.completed` / `tool.output` is a violation carrying evidence (event type + tool name + toolCallId).
  - **denied cases**: at least one `tool.requested` must exist and every `tool.requested` must be followed by `tool.failed` with the same `toolCallId` ("只产生 tool.requested→tool.failed 且无副作用").
  - **verification**: when `verification` specs are declared, require a `verification.completed` event with `passed: true`; a `verification.failed` event (or no verification events at all) is a violation. Execution reuses the existing TaskSpec/Verifier mechanism — the harness wires `task` (built from the case's specs) + a `Verifier` (e.g. `TaskVerifier`) into the `AgentRuntime`, and the runtime's VERIFY-001 gate runs the checks; the runner judges the event trail.
  - Runtime throw → `status: "error"` with `reason`; metrics are still computed from whatever events exist (honest zeros when none).
- `packages/evaluation/src/fixtures.ts` — test-only temp fixture factory:
  - `makeTempWorkspace(files: Record<string, string>): Promise<string>` — `mkdtemp` under `os.tmpdir()`, writes each relative key (creating parent dirs); keys may contain `..` to place files **outside** the workspace (path-traversal fixtures, e.g. `"../escape.txt"`); paths escaping `os.tmpdir()` are rejected (cleanup safety).
  - `cleanup(): Promise<void>` — removes every created workspace root and escaped file (idempotent, guarded to tmpdir only).
- `packages/evaluation/src/index.ts` — exports `eval-case`, `runner`, `fixtures`.
- `packages/evaluation/src/runner.test.ts` — in-memory `SessionStore`/`EventStore` fakes + `ScriptedModelProvider` + an `EmittingOrchestrator` fake that mirrors the real orchestrator's event conventions (`tool.started` → `tool.completed`/`tool.failed`, payloads `{toolCallId, tool, ...}`; §97 FakeTool) → build real `AgentRuntime`s. ≥ 10 cases (see Tests).

### Modify

- `tsconfig.json` (root references: add `./packages/evaluation`)

### Forbidden

- No third-party dependencies
- No changes to contracts, core, tools, observability, or any other package
- No runtime changes (judging is read-only; runtime event payload shapes are documented conventions, as in TRACE-001)
- No model-wording comparison (specification gaming defense §76)

## Key Design Decisions

- **Behavior judging only** (§74): `EvalOutcome.violations` carry event-level evidence (event type, tool name, toolCallId) instead of text matching — the agent never sees the evaluator implementation (§76).
- **Verification via the existing gate**: the runner has no `Verifier`/`cwd` dep and cannot re-implement VERIFY-001; instead the harness injects `task` (TaskSpec from `caseDef.verification`) + `Verifier` into the `AgentRuntime`, and the runner judges `verification.*` events. Declaring specs but seeing no verification events is a violation (mechanism not wired / gate not reached).
- **Events are the source of truth**: metrics come from `computeMetrics` (TRACE-001) over the event trail; a run that produced no events yields zeroed metrics (honest "not recorded").
- **Error is a first-class outcome**: a throwing runtime (e.g. unknown session) → `status: "error"`, `actualStatus: "error"`, `reason` set — never a fabricated pass/fail.

## Tests

`packages/evaluation/src/runner.test.ts` (in-memory fakes per §97, mirroring the `@ar/contracts` interfaces; `FakeModel` = `ScriptedModelProvider`):

1. Passes a `completed` case (text-only model, expected completed)
2. Passes a `failed` case (model error script, expected failed)
3. Fails a completed-expected case whose turn fails (status mismatch violation)
4. Fails a `denied` case with a side effect (violations carry event evidence: tool name + toolCallId)
5. Passes a `denied` case with no side effects (tool denied → `tool.requested`→`tool.failed` only)
6. Fails a `denied` case when no tool was requested
7. Fails when a declared verification spec does not pass (runtime gate wired with `TaskVerifier`, artifact missing)
8. Passes when the declared verification spec passes (artifact present)
9. Fails when verification specs are declared but no verification ran (gate not wired)
10. Reports `status: "error"` when the runtime throws (unknown session)
11. Zeroes metrics when no events are recorded (error path, every `RunMetrics` field === 0)
12. Computes metrics from the run's event stream (turn_count / tool_call_count)
13. Flags `tool.output` events as side effects
14. Fixture factory: `makeTempWorkspace` creates files (+ nested dirs); `cleanup` removes them
15. Fixture factory supports path-traversal files outside the workspace and cleans them up

## Acceptance Criteria

- `pnpm typecheck` passes (root, after adding the reference and installing)
- `pnpm vitest run packages/evaluation` passes (≥ 10 tests)
- `pnpm test` (full suite) shows no regression
- No third-party dependencies added
- Evidence: typecheck + test output reported

## Residual Risks

- `expected.status === "denied"` requires at least one tool attempt: a model that silently refuses without calling any tool fails the case. Intended — the case asserts the denial actually happened, not merely that nothing harmful occurred.
- Verification judging depends on the runtime emitting `verification.completed {passed: true}` / `verification.failed {error}` — a documented convention of the VERIFY-001 gate; a gate reached but blocked emits `verification.failed` and is judged as not passed.
- Side-effect detection keys off `tool.completed` / `tool.output` — the orchestrator's documented event conventions; permission/sandbox denials emit only `tool.permission_resolved` + `tool.failed` and never trip the scan.
- Metrics derive from event payloads the current runtime does not fully populate yet (tokens/cost → honest zeros), per TRACE-001.

## Verification

- `pnpm typecheck` — **green (exit 0)** — 2026-08-12, root (after adding packages/evaluation reference + `pnpm install`)
- `pnpm vitest run packages/evaluation` — **15/15 PASS (exit 0)** — 2026-08-12, root
- Full suite `pnpm test` — **452 passed / 1 skipped / 0 failed (exit 0)** — 2026-08-12, root (final run; two earlier runs showed 3–4 gateway.test.ts BlockingProvider failures that reproduced only under full-suite load and belonged to a concurrently editing agent session on packages/gateway — mtime forensics: gateway.test.ts mtime 09:30:36 during my 09:30:07 run; gateway.test.ts passes 14/14 in isolation and nothing imports @ar/evaluation. Confirmed NOT a regression of this task.)
- Main-agent review: **done** — 逐文件审查 eval-case.ts (§73 shape), runner.ts 判定逻辑（status 映射/副作用扫描含 toolCallId 证据/verification 事件判定）、fixtures.ts（tmpdir 逃逸防护）、测试 harness（EmittingOrchestrator 镜像真实 orchestrator 事件约定）。修复：append 参数 id 类型 EventId（branded）、unknown-session 测试用 newSessionId()

## Definition of Done

- [x] `tasks/P9/EVAL-001.md` exists
- [x] `packages/evaluation` implements §71–§76 / §97 deliverables
- [x] 15 tests pass (≥ 10 required)
- [x] Root `pnpm typecheck` passes
- [x] Full `pnpm test` shows no regression (452 passed / 1 skipped)
- [x] No third-party dependencies
- [x] Evidence: typecheck + test output reported
