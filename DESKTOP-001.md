# TASK: DESKTOP-001

## Goal

Create the desktop client library `packages/gateway/src/desktop-client.ts` per AGENT_ARCHITECTURE_PLAN v2.0 §85 (Desktop) and §162 (UI Security). The desktop is a pure client: it owns rendering, interaction, approval UI, session browsing and event display — never the agent loop, tool execution, permission logic, or session persistence. This task delivers the client library (the UI rendering layer is future work); the API surface goes through the public §84 RPC only.

## Why

The runtime needs a host-facing client for the desktop that binds to the §84 method surface without owning the loop, tool execution, permission logic, or session persistence (§85). Event display and approval UI need event streaming and pending-approval access (§162) from a client that holds no runtime references.

## Dependencies

- RPC-001 (`packages/gateway`: `createRuntimeRpc`, `RpcMethodRegistry`, `InMemoryTransport`) — already inside `@ar/gateway`
- `@ar/contracts` (AgentEvent, AgentError), `@ar/security` (`InMemoryApprovalStore`, §162 read-only pending lookup) — already runtime deps of `@ar/gateway`
- `@ar/model` (dev only, `ScriptedModelProvider` test fakes) — already a devDep of `@ar/gateway`
- No third-party dependencies

## Preconditions

`@ar/gateway` exists with the §84 RPC surface (`createRuntimeRpc`) and `InMemoryTransport` (RPC-001), and depends on contracts/core/session/security already.

## Scope

### Create

- `tasks/P8/DESKTOP-001.md` (this file)
- `packages/gateway/src/desktop-client.ts` — `DesktopClient` + `DesktopClientOptions`
- `packages/gateway/src/desktop-client.test.ts` — 17 cases, end-to-end: FakeModel + in-memory stores → `AgentRuntime` → `createRuntimeRpc` → `InMemoryTransport` → `DesktopClient`

### Modify

- `packages/gateway/src/index.ts` — export `DesktopClient` (and `DesktopClientOptions` type)

### Forbidden

- No agent loop / tool execution / permission logic / session persistence in the client (§85)
- No direct access to the runtime, RpcMethodRegistry, SessionStore, or EventStore from the client — the only injected state is the read-only `approvalStore` (sanctioned §162 exception, never mutated; decisions go through `session.approve` RPC)
- No third-party dependencies
- No changes to core/session/security/contracts packages

## Contracts

### DesktopClientOptions

- `transport: InMemoryTransport` — client endpoint of a pair whose server side is bound to the runtime RPC registry; the client's ONLY runtime-facing dependency
- `sessionDefaults?: { agentId: string; cwd: string }` — used by `createSession` when its arguments are omitted
- `approvalStore?: InMemoryApprovalStore` — read-only pending lookup for §162; the RPC surface has no pending-approval listing method (comment documents the exception)
- `pollDelayMs?: number` — event-poll interval for `run`/`subscribe` (tests use small values)

### DesktopClient methods (all forward through the transport)

- `createSession(agentId?, cwd?) → { sessionId }` — missing args fall back to `sessionDefaults`; neither → structured error
- `send(sessionId, text) → { turnId }`
- `run(sessionId, turnId, onEvent?) → { status, toolCalls, iterations }` — while running, the session's event stream is exposed to the UI layer via incremental polling of `session.subscribe`; the callback receives the session stream from its start (a run covers turn.started → tool.* → turn.completed; UI filters by turnId/sessionId). Final drain after the run settles so terminal events are always delivered
- `cancel(sessionId, turnId) → { status }`
- `resume(sessionId) → { session }`
- `approve(approvalId, allow: boolean, decidedBy?) → { value }` — maps to `session.approve` value "allow"|"deny"
- `listPendingApprovals() → unknown[]` — `approvalStore.listPending()` (read-only; structured error when no store injected)
- `subscribe(sessionId, afterSequence?, onEvent?, signal?) → Promise<void>` — §85 event display. The RPC surface provides snapshots only, so delivery is snapshot + incremental polling (the portable choice; a future streaming RPC wrapping `EventStore.stream` can replace the loop — comment documents this). Resolves when `signal` aborts; without a signal it keeps polling

## Security Invariants

- The client holds no reference to the runtime/registry/stores (only the transport endpoint; the approvalStore injection is read-only) — §85 enforced at the type level (options type + `@ts-expect-error` guard test)
- Errors crossing the RPC boundary surface only `{ code, message }`; the client rethrows structured `AgentError`s
- Approval decisions always go through `session.approve` (one-shot, store-backed, §161); `listPendingApprovals` never mutates the store

## Tests

- createSession success / defaults fallback / explicit args override / no-defaults structured error
- send returns the turn id
- run full chain: onEvent receives turn.started → tool.requested → turn.completed (in order), outcome { status, toolCalls, iterations }
- cancel aborts a blocked run (status cancelled, turn.cancelled delivered)
- resume returns the session
- approve allow / deny / unknown-id structured error
- listPendingApprovals non-empty after creation, empty after resolution (one-shot)
- listPendingApprovals without injected store → structured error
- subscribe delivers session events to the callback and resolves on abort
- type-level §85 guard: options reject runtime internals
- multi-session isolation: per-session subscriptions and runs do not interfere

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/gateway` passes (10+ tests)
- `pnpm test` (full suite) passes — no regressions

## Definition of Done

- [ ] Implementation exists (task file, desktop-client.ts, exports, tests)
- [ ] Tests exist and pass (17 cases)
- [ ] Security implications checked (§85 client purity, §162 approval surface, error surface)
- [ ] Evidence: typecheck + test output reported
