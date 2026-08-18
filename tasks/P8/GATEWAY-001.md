# TASK: GATEWAY-001

## Goal

Add the chat-channel gateway to `packages/gateway` per AGENT_ARCHITECTURE_PLAN v2.0 §83 (Remote Gateway), §84 (RPC), §161 (Remote Security), §162 (UI Security), §175 (Human Intervention).

## Why

Channels (Telegram/Discord/Slack/Web/…) must be able to talk to the agent loop without channel-specific logic ever leaking into Core (§83). The gateway is the adapter layer: it routes channel messages into sessions through the §84 RPC surface only, forwards approval decisions, pushes session events back to the channel, and records human interventions (§175) as `human.*` events.

## Dependencies

- `@ar/contracts`, `@ar/core`, `@ar/session`, `@ar/security` (already in `packages/gateway/package.json` — no manifest change needed)
- `@ar/model` (dev only, test fakes)
- Root `tsconfig.json` already references `./packages/gateway` (no change needed)

## Preconditions

RPC-001 delivered `RpcMethodRegistry` + `createRuntimeRpc` (`session.create/send/run/cancel/approve/subscribe`), `InMemoryApprovalStore` (one-shot, session-bound), `EventStore` (append/list/stream/nextSequence).

## Scope

### Create

- `packages/gateway/src/channel.ts` — `ChannelAdapter` + `ChannelMessage` (§83)
- `packages/gateway/src/gateway.ts` — `Gateway` class
- `packages/gateway/src/fakes/fake-channel.ts` — programmable in-memory channel for tests
- `packages/gateway/src/gateway.test.ts` — 12+ cases
- `tasks/P8/GATEWAY-001.md` (this file)

### Modify

- `packages/gateway/src/index.ts` — export the new surface

### Forbidden

- No third-party dependencies
- No changes to core/session/security/contracts
- No channel-specific logic in Core (§83): the gateway calls the runtime only through `RpcMethodRegistry`
- No raw shell execution through the gateway (§161)

## Contracts

### ChannelAdapter (§83)

- `id: string`
- `connect(): Promise<void>` / `disconnect(): Promise<void>`
- `send(recipient: string, payload: unknown): Promise<void>`
- `onMessage(handler: (msg: ChannelMessage) => void | Promise<void>): void`

### ChannelMessage

`{ channelId, from, text, messageId, ts }`

### Gateway

Constructor `{ rpc: RpcMethodRegistry; channels: ChannelAdapter[]; sessionService: SessionService; approvalStore: InMemoryApprovalStore; events: EventStore; route?: (from) => SessionId | undefined; sessionDefaults?: { agentId, cwd }; pollDelayMs?; now? }`.

- `start()` connects all channels and registers the message handler (double start throws); `stop()` clears event pollers and disconnects all channels (idempotent).
- Message routing: `approve:<id>:allow|deny` → `session.approve` (decidedBy = `channelId:from`), §175 `human.approval` event; `cancel` → `session.cancel` of the gateway-started turn, §175 `human.cancel` event; anything else → find-or-create the session (internal binding → `route` → `session.create` with defaults) → `session.send` → `session.run` → result text back to the channel.
- Event push: per bound session, poll `events.list(sessionId, { afterSequence })`; forward `approval.created` (enriched via `approvalStore.listPending()` to carry full §162 fields: action/target/reason/sessionId/agent/policy/expiry + reply instructions), `tool.permission_requested`, `run.limit_reached`.
- Error replies are `[error] …` texts; approval errors are `[approve] error: …`.

## Security Invariants

- Approval push messages carry action/target/reason/sessionId — never just "Allow tool?" (§162)
- `sessionDefaults` is optional: without route/defaults the gateway refuses to create sessions instead of inventing one
- All session mutations go through the RPC surface (permission/sandbox logic stays behind the runtime, §161)
- Errors crossing the channel boundary are short texts derived from structured `{ code, message }` — no stacks

## Tests

- end-to-end: channel message → new session → run → reply; same sender reuses the session
- `route` reuses an existing session; stale route falls back to creation
- `approve:<id>:allow` / `deny` resolve through the store and record `human.approval`
- approval request push contains full fields (action/target/reason/sessionId/expiry + reply syntax)
- unknown approval id → error message
- `tool.permission_requested` and `run.limit_reached` pushed; non-forwarded event types ignored
- `cancel` message aborts a blocked run (store status, `human.cancel` event)
- connect/disconnect lifecycle (double start throws, stop idempotent)
- multi-channel isolation: separate sessions, replies and approvals per channel
- no sessionDefaults/route → error reply, no session created

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/gateway` passes (12+ tests, including the pre-existing rpc.test.ts suite)
- `pnpm test` passes (no regression)

## Definition of Done

- [x] Implementation exists
- [x] Tests exist and pass
- [x] Security implications checked (full-field approvals, no Core bypass, no session invention)
- [x] Evidence: typecheck + test output
