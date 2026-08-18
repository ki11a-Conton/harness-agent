# TASK: SUBAGENT-002

## Goal

Add `ParallelDelegator` to `packages/agents`: parallel delegation (§57, §55,
INV-009) that fans out many children through `Delegator.delegate` with a
bounded worker pool (`limits.maxConcurrent`, default 3).

## Why

§57: the parent must be able to run Research/Review children in parallel and
merge only the structured results (status/summary/evidence/artifacts), never
raw conversation. INV-009 adds a max-concurrency bound on top of depth and
children bounds.

## Dependencies

- `@ar/contracts` — DelegationLimits/DEFAULT_DELEGATION_LIMITS (maxConcurrent)
- `@ar/core` — AgentRuntime (via DelegatorDeps)
- `@ar/model` (dev) — ScriptedModelProvider for tests
- `packages/agents/src/delegator.ts` — `Delegator` / `DelegatorDeps` (reused;
  every child still runs through `Delegator.delegate`)
- `tasks/P0/CONTRACT-001.md` — task file template

## Preconditions

SUBAGENT-001 landed: `Delegator` exists in `packages/agents`, its 21 tests
pass, and the package is in the root typecheck references.

## Scope

### Create

- `tasks/P6/SUBAGENT-002.md` (this file)
- `packages/agents/src/parallel-delegator.ts` — `ParallelDelegator` class
- `packages/agents/src/parallel-delegator.test.ts` — 17 cases, local in-memory
  SessionStore/EventStore + FakeOrchestrator + ScriptedModelProvider (same
  fake pattern as `delegator.test.ts`)

### Modify

- `packages/agents/src/index.ts` — export `ParallelDelegator`

### Forbidden

- No changes to `Delegator`, `delegation.ts`, or any other package
- No third-party dependencies
- No UI, no `node:fs` side effects in `src/` (only tests may use timers)

## Contracts

- `delegateAll(reqs: DelegationRequest[], signal): Promise<DelegationResult[]>`
  — one result per request, in request order (results are placed by request
  index, independent of completion order)
- Concurrency: at most `limits.maxConcurrent` children in flight (default 3,
  §55); a simple worker pool starts the first N and pulls the next request as
  soon as one finishes
- `maxConcurrent <= 0` → throws `AgentError` RESOURCE_LIMIT before anything
  starts
- Pre-flight: before any child session is created, every request is validated
  with the same rules as `Delegator.delegate` (unknown parent →
  INTERNAL_ERROR; maxDepth=0 / maxChildren=0 / depth reached / children
  reached → RESOURCE_LIMIT; unknown agent → INTERNAL_ERROR). Batch members
  claim maxChildren slots, so a batch too large for the parent is rejected up
  front — never after a partial start; a pre-flight failure rejects the whole
  batch and creates no children
- Per-child limits: `req.limits` merges over the delegator limits, exactly
  like `Delegator.delegate`
- Cancellation: all children share the caller's AbortSignal; aborting cancels
  every child (started and queued alike) → all results `cancelled`
- Failure isolation: a child failing at turn level (model error) yields a
  `failed` DelegationResult while siblings complete; the array still carries
  every status
- Known boundary: an unexpected throw from `Delegator.delegate` (e.g. child
  session creation failure) rejects the whole batch, because a
  `DelegationResult` requires a real `childSessionId` (§57) that does not
  exist in that case

## Security Invariants

- INV-009: max concurrency enforced by the worker pool; batch size pre-checked
  against maxChildren (including existing children) before any session is
  created
- INV-005: per-child isolation preserved via `Delegator.delegate` — no
  parent history is ever seeded

## Tests

- 3 children all success with peak active-model count ≤ maxConcurrent (slow
  scripted models + tracker), and peak actually reaches 2 for maxConcurrent=2
- result order == request order despite different completion times (distinct
  goals matched to child sessions; slow child has the largest durationMs)
- one child fails (scripted model error) while the other two succeed
- abort mid-run → all results `cancelled`; pre-aborted signal → all
  `cancelled`
- maxConcurrent=1 → sequential execution (peak active = 1)
- maxConcurrent=0 → RESOURCE_LIMIT rejection, no children created
- pre-flight rejections create no children: maxChildren=0, maxChildren=2 with
  3 requests, maxDepth=0, unknown parent, unknown agent, per-request
  `limits.maxChildren=0`
- existing children count toward maxChildren pre-flight
- children created: one per request, all under the parent, distinct ids
- event stream: 3 × subagent.started + 3 × subagent.completed (success)
- empty request list → `[]`; injectable clock drives durationMs

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/agents` — 17 new tests pass, existing 21 still
  pass
- `pnpm test` (root) — no regressions

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (INV-009 concurrency, INV-005 isolation)
- [ ] Evidence: typecheck + test output
