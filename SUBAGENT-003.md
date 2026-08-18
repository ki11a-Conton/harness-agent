# TASK: SUBAGENT-003

## Goal

Add `NestedDelegator` to `packages/agents`: recursive delegation (§56, §55,
INV-009) with role-based leaf/orchestrator semantics, chaining
`Delegator.delegate` level by level.

## Why

§56: a `leaf` role subagent must never delegate further (Hermes-style, §54),
while an `orchestrator` may delegate subject to depth/concurrency limits.
Depth bounds come from the existing INV-009 enforcement in `Delegator`
(`enforceBounds`, maxDepth default 2 per §55); the missing piece is the
role judgment and the chain orchestration on top of it.

## Dependencies

- `@ar/contracts` — DelegationLimits/DEFAULT_DELEGATION_LIMITS, AgentDefinition
- `@ar/core` — AgentRuntime (via DelegatorDeps)
- `@ar/model` (dev) — ScriptedModelProvider for tests
- `packages/agents/src/delegator.ts` — `Delegator` / `DelegatorDeps` (reused;
  every level still runs through `Delegator.delegate`, so per-level INV-009
  bounds, isolation (INV-005) and `subagent.*` events apply unchanged)
- `tasks/P0/CONTRACT-001.md` — task file template

## Preconditions

SUBAGENT-001/002 landed: `Delegator` (21 tests) and `ParallelDelegator`
(18 tests) exist and pass in `packages/agents`.

## Scope

### Create

- `tasks/P6/SUBAGENT-003.md` (this file)
- `packages/agents/src/nested-delegation.ts` — `NestedDelegator`,
  `createLeafAgent`, `resolveRole`, `DelegationRole`, `NESTED_MARKER`
- `packages/agents/src/nested-delegation.test.ts` — 12 cases, local
  in-memory SessionStore/EventStore + ScriptedModelProvider (same fake
  pattern as `delegator.test.ts`)

### Modify

- `packages/agents/src/index.ts` — export `nested-delegation.js`

### Forbidden

- No changes to `Delegator`, `delegation.ts`, `parallel-delegator.ts`,
  `@ar/contracts`, or any other package
- No third-party dependencies
- No UI, no `node:fs` side effects in `src/` (only tests may use timers)

## Contracts

- `createLeafAgent(def): AgentDefinition` — marks the definition as a §56
  leaf and forces `mode: "subagent"`. The marker is a SUBAGENT-003-added
  runtime convention: `canDelegate: false` is stored on the definition
  object (type-erased; `@ar/contracts` AgentDefinition is NOT modified —
  it has no such field). Comment in code explains the convention.
- `resolveRole(def, depth, maxDepth): "leaf" | "orchestrator"` — leaf when
  the definition carries `canDelegate: false`, or when `depth >= maxDepth`
  (at the boundary an orchestrator becomes effectively a leaf). Note: the
  task brief suggested `resolveRole(def, depth)`; the `maxDepth` argument
  was added so the boundary check honors non-default limits instead of
  hard-coding `DEFAULT_DELEGATION_LIMITS.maxDepth`.
- `NestedDelegator` constructor deps = `DelegatorDeps` + optional
  `resolveRole?: (def, depth) => DelegationRole` — injectable
  leaf/orchestrator judgment, defaulting to `resolveRole`.
- `delegateNested(req, signal, depth = 0): Promise<DelegationResult>` —
  spawns the child via `Delegator.delegate`, then chains deeper while the
  child's result summary carries a `DELEGATE: <goal>` line (convention,
  last line wins). Role check happens at EVERY level before any session is
  created: leaf (or depth boundary) → `AgentError` RESOURCE_LIMIT, no child
  session for that level. Depth is additionally enforced per level by the
  inner `Delegator.enforceBounds` (INV-009).
- Nested request inherits the parent request's `toolPolicy` and `limits`
  (per-request restrictions constrain the whole subtree) and runs the
  grandchild in the child's own agent.
- Result: the top-level `DelegationResult` (its `childSessionId` is the
  direct child) with summary annotated by `NESTED_MARKER`
  (`"[nested delegation]"`) + `chain: <sessionId>:<status> → …` listing
  every level. The deepest non-success status/error (failed/cancelled/
  timeout) propagates to the top result — never masked.
- Cancellation: every level shares the caller's AbortSignal, so aborting
  cancels the whole chain; timeout uses the per-level `limits.timeoutMs`.

## Security Invariants

- §56 / INV-009: leaf cannot spawn; orchestrator spawns only within
  maxDepth; depth overrun rejected before any session is created for the
  offending level
- INV-005: per-child isolation preserved via `Delegator.delegate` — no
  parent history is ever seeded
- Errors stay observable: a non-success deep level is propagated, not
  swallowed

## Tests

- role unit cases: `createLeafAgent` sets mode subagent + canDelegate false;
  `resolveRole` judges orchestrator / leaf / depth-boundary
- leaf agent delegation → RESOURCE_LIMIT, zero sessions created
- single-level success with no nesting (no `NESTED_MARKER` in summary)
- one-level nesting success (parent → child → grandchild): both session ids
  in the annotated chain, per-level event streams
- depth 3 rejected (default maxDepth=2): child + grandchild exist, no
  great-grandchild
- nesting beyond maxDepth=1 rejected while the first level succeeds
- per-request `limits` apply to nested levels (req.limits.maxDepth=1)
- provided starting `depth` param: beyond maxDepth rejects up front, within
  spawns
- cancellation propagates across levels (abort after grandchild started →
  top status cancelled, chain marked)
- timeout propagates across levels (hanging grandchild + timeoutMs=100 →
  top status timeout)
- failed nested turn propagates (status failed + error, chain marked)
- injected `resolveRole` override honored

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/agents` — 12 new tests pass, existing 39 still
  pass
- `pnpm test` (root) — no regressions

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (§56 roles, INV-009 depth, INV-005)
- [ ] Evidence: typecheck + test output
