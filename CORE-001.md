# TASK: CORE-001

## Goal

Implement the Runtime lifecycle in `packages/core` per AGENT_ARCHITECTURE_PLAN §25, §51, §102.

## Why

Core is the smallest deterministic runtime: session/turn lifecycle, agent phase state machine, hook interception, bounded single-turn execution through a ModelProvider + ToolOrchestrator (both injected as contracts).

## Dependencies

CONTRACT-001.

## Scope

### Create

- `packages/core/package.json`, `tsconfig.json`
- `packages/core/src/errors.ts` — AgentError class
- `packages/core/src/state/agent-state.ts` — phase machine (§25)
- `packages/core/src/lifecycle/hooks.ts` — HookRegistry (§51)
- `packages/core/src/runtime/runtime.ts` — AgentRuntime (createSession/startTurn/runTurn/finish, bounded iterations, cancel via AbortSignal, run.limit_reached)
- `packages/core/src/test/fakes.ts` — in-memory SessionStore/EventStore (§97)
- tests: state machine, hooks, runtime with fake model/orchestrator

### Forbidden

- Direct model provider import in Core (injected via contracts)
- Direct tool implementation in Core
- Direct filesystem access

## Acceptance Criteria

- FakeModel executes one turn through Core (text, tool call, error, cancel)
- Illegal phase transitions rejected
- Bounded iterations: maxIterationsPerTurn / agent.limits.maxToolCalls → safe stop with RESOURCE_LIMIT
- Contract change (reported): EVENT_TYPES extended with `turn.cancelled`

## Definition of Done

- [ ] Implementation + unit/integration/failure tests pass
- [ ] `pnpm typecheck` + `pnpm test` green
