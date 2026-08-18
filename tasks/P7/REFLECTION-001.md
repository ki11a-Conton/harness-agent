# TASK: REFLECTION-001

## Goal

Add rule-based runtime reflection to `packages/memory`: a `Reflector` class that reads an event stream, extracts per-turn failure/recovery, attributes each failure to a §164 root cause, and produces `ReflectionOutput[]` with procedural memory candidates, per AGENT_ARCHITECTURE_PLAN v2.0 §68, §69, §181.

## Why

The learning pipeline (§69: trace → outcome → reflection → candidate → evaluation → promotion) starts at reflection. Reflection must be deterministic at runtime (no LLM dependency): the existing `ReflectionOutput` contract (outcome/rootCause/evidence/lesson/generalizable/candidate) already exists in `packages/contracts` and must be reused. Reflection must never directly mutate production policy (§181 — it produces candidates that only the §67 write gate can later evaluate).

## Dependencies

- `@ar/contracts` (provides `AgentEvent`/`EventType`, `MemoryCandidate`, `ReflectionOutput`, `ErrorCode`/`ERROR_CODES`, `SessionId`/`TurnId`)

## Preconditions

- `packages/memory` exists (MEMORY-001): `JsonlMemoryStore` + §67 write gate, deps only `@ar/contracts`.
- TRACE-001 (`packages/observability`) established the event payload conventions this module reads (see Contracts).

## Scope

### Create

- `tasks/P7/REFLECTION-001.md` (this file)
- `packages/memory/src/reflection.ts` — `Reflector` class, deterministic rule engine (no LLM):
  - `reflect(deps: { events: AgentEvent[]; taskGoal?: string }): ReflectionOutput[]`
  - Failure events scanned in sequence order: `turn.failed`, `tool.failed`, `verification.failed`, `model.failed`
  - §164 attribution: error code from the contracts taxonomy (`payload.error` object/`info.code`, `payload.code`, or `"CODE: message"` string prefix) wins; then event-type default (`tool.failed`→tool, `model.failed`→model, `verification.failed`→verification, `turn.failed`→model). `INTERNAL_ERROR` → tool on `tool.failed`, else environment. `USER_CANCELLED` is skipped (not an agent failure, nothing learnable)
  - Per-failure outcome: `turn.failed` event → `failure`; other failures are `partial` only when a recovery is evidenced later in the stream (same `toolCallId` completed, or the same turn completed); otherwise `failure`
  - Evidence references the failure event and related events (preceding `tool.requested` by `toolCallId`, following same-turn terminal event, same-turn preceding failures) as `type id@timestamp`, plus `task: <taskGoal>` when provided
  - Lessons are rule-based templates per root cause (e.g. `tool X failed with Y; verify inputs and environment before retry`)
  - `generalizable`: false for permission/sandbox denials (§45: no automatic retry, session-specific decision); true otherwise
  - Candidate per failure: `type: "procedural"`, `sourceSession` from the failure event, `importance` by severity 0.5–0.9 (turn.failed 0.9, verification 0.8, context 0.7, tool/model 0.6, environment/permission/sandbox 0.5), rule-estimate confidence 0.6 / novelty 0.5 / stability 0.5
  - Aggregation: no failures → `[]`; dedupe by root cause (for tool failures: root cause + tool name) so repeated failures of the same tool collapse into one lesson while distinct tools stay separate; merged output keeps the worst outcome, the max importance, and all contributing evidence
- `packages/memory/src/index.ts` — export `Reflector` (+ `FAILURE_EVENT_TYPES`), type `FailureRootCause`/`ReflectDeps`
- `packages/memory/src/reflection.test.ts` — 10+ cases (see Tests)

### Forbidden

- No LLM/model dependency (runtime reflection is rule-based)
- No side effects, no `node:fs`, no writes to any store (reflection only produces candidates; persistence goes through the §67 gate)
- No third-party dependencies
- No modification of contracts types (`ReflectionOutput` is reused as-is)

## Contracts

`ReflectionOutput` from `packages/contracts/src/memory.ts` (§68). Failure attribution categories from §164: model / context / tool / permission / sandbox / environment / verification. Error codes read from the runtime payload convention (TRACE-001): `payload.error` is an `AgentErrorInfo`-shaped object (`{ code, message, ... }`), `verification.failed` carries a plain string reason, `tool.failed` carries `toolCallId` (tool name correlated from `tool.requested`).

## Security Invariants

- Permission/sandbox denials never produce a generalizable lesson (§45 — do not retry automatically, do not bypass the sandbox).
- Reflection never bypasses the write gate: it emits candidates only; persistence is the gate's job (§67, §181).

## Tests

- turn.failed + tool.failed → attributed to the tool, one output, candidate produced
- verification.failed → attributed to verification
- two consecutive tool.failed with the same tool → deduped into one lesson
- no failure events → empty array
- model.failed → attributed to model
- mixed failures (model/tool/verification across turns) → each attribution correct
- candidate fields: type procedural, sourceSession, importance in 0.5–0.9
- permission-denied failure → generalizable false (§45)
- sandbox-denied failure → generalizable false
- recovered tool failure → outcome partial
- context overflow → attributed to context
- evidence references related event ids + timestamps (and taskGoal when given)
- distinct failing tools → separate outputs
- user-cancelled failure → skipped

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/memory` passes
- `pnpm test` passes (full suite, no regression)

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (no auto-retry lesson for denials, no write-path bypass)
- [ ] Evidence: typecheck + test output
