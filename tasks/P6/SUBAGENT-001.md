# TASK: SUBAGENT-001

## Goal

Create the `packages/agents` package: a `Delegator` that spawns isolated child
sessions (INV-005) under bounded recursion (INV-009), per plan §53–§57.

## Why

Parents must be able to delegate work to subagents without exposing their own
conversation (INV-005), without unbounded recursion (INV-009), and with only a
structured result returning to the caller (§57), not raw conversation.

## Dependencies

- `@ar/contracts` — DelegationLimits/DEFAULT_DELEGATION_LIMITS, ContextBlock,
  ToolPolicy, Evidence, SessionStore/EventStore (already present)
- `@ar/core` — AgentRuntime (createSession/startTurn/runTurn, TurnOutcome)
- `@ar/model` (dev) — ScriptedModelProvider for tests
- `tasks/P0/CONTRACT-001.md` — task file template

## Preconditions

Root workspace typechecks (`pnpm typecheck` PASS, per mem.md). AgentRuntime
does NOT expose its EventStore, so delegation events are emitted through an
injected EventStore dependency instead.

## Scope

### Create

- `tasks/P6/SUBAGENT-001.md` (this file)
- `packages/agents/package.json` — deps: `@ar/contracts`, `@ar/core`;
  devDeps: `@ar/model`. No third-party dependencies.
- `packages/agents/tsconfig.json` — mirrors `packages/skills`
- `packages/agents/src/delegation.ts` — `DelegationRequest`,
  `DelegationResult` (§57 structured result, not raw conversation)
- `packages/agents/src/delegator.ts` — `Delegator` class + exported
  `restrictToolPolicy` (allow intersect, deny union)
- `packages/agents/src/index.ts`
- `packages/agents/src/delegator.test.ts` — 12+ cases, local in-memory
  SessionStore/EventStore + FakeOrchestrator + ScriptedModelProvider

### Modify

- `tsconfig.json` (root references: add `./packages/agents`)
- `pnpm-lock.yaml` (via `pnpm install`)

### Forbidden

- No changes to `@ar/core`, `@ar/session`, `@ar/contracts`, or any other
  existing package
- No third-party dependencies
- No UI, no `node:fs` side effects in `src/` (only tests may use timers)

## Contracts

- `delegate(req, signal)` returns `DelegationResult`; pre-flight rejections
  (unknown parent/agent, INV-009 bounds breached) throw `AgentError` because
  no child session exists yet — a result always carries a real
  `childSessionId`
- Child session: `parentId = parentSessionId`, `agentId = req.agentId ??
  default`, same cwd as parent, only `req.context` seeded as system messages
  (INV-005) — never parent history
- Timeout: `limits.timeoutMs` races the turn; caller `AbortSignal` cancels;
  cancelled is never masked as timeout
- Events: `subagent.started` → `subagent.completed` (success) or
  `subagent.failed` (failed/timeout/cancelled, exact status in payload), on
  the parent session stream; skipped when no EventStore is injected
- `summary` from final assistant message (2000 char cap); `evidence` from
  verification-gate events + persisted tool results; `artifacts` = path-like
  tokens in tool outputs
- `toolPolicy` restricts the child agent's tools (allow intersect, deny
  union). Known limitation: `AgentRuntime.runTurn` re-resolves the agent by
  id from its own registry, so the restriction is advisory until a runtime
  change supplies per-session policy

## Security Invariants

- INV-005: child store contains only its own goal/context/turn messages
- INV-009: maxDepth=0 (leaf) and maxChildren=0 reject delegation; children
  counted via `store.listSessions({ parentId })`; depth walked via the
  `parentId` chain

## Tests

- parentId + agentId (default and override) on the child session
- isolation: child store has no parent messages (core acceptance)
- only `req.context` seeded into the child
- structured result fields (summary/status/childSessionId/toolCalls/duration)
- tool-call counting through the orchestrator
- parent event stream: started → completed / started → failed
- failed model → `status=failed` + `subagent.failed`
- timeout → `status=timeout`; cancel (mid-run and pre-aborted) → `cancelled`
- maxChildren=0 / maxDepth=0 rejection (AgentError RESOURCE_LIMIT)
- maxChildren=1 second-child rejection; maxDepth=1 child-of-child rejection
- evidence from verification gate; artifacts from tool output
- injectable clock; `restrictToolPolicy` unit cases

## Acceptance Criteria

- `pnpm typecheck` passes (root, with `packages/agents` in references)
- `pnpm vitest run packages/agents` — 12+ tests pass
- Isolation test asserts the child message list contains no parent texts

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (INV-005, INV-009)
- [ ] Evidence: typecheck + test output
