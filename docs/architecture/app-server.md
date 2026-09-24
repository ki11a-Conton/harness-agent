# App Server Protocol v1

> P29 + P35-3 architecture doc. Documents the versioned wire boundary that lets
> any client drive the full Agent lifecycle without importing Core.

## The core statement

`Gateway → RpcMethodRegistry → AgentRuntime` is replaced by a versioned App
Server protocol with an `initialize` handshake, Thread/Turn/Item DTOs, bounded
queues/backpressure, replay-from-sequence, and idempotency for mutating calls.
The protocol package never imports `AgentRuntime`; it defines DTOs only.

## External primitive names

| external | internal |
| --- | --- |
| Thread | Session |
| Turn | Turn |
| Item | user/model/tool/approval/verification visible item |

Internal packages are NOT renamed to match wire names.

## Minimum v1 methods

- Thread: `thread/start`, `thread/read`, `thread/resume`, `thread/fork`,
  `thread/list`, `thread/loaded/list`
- Turn: `turn/start`, `turn/interrupt`, `turn/steer`
- Approval: `approval/respond` · Ask: `ask/respond`
- Introspection: `agent/list`, `tool/list`, `skill/list`, `trace/read`

## Invariants

- **INV-PROT-001 — initialize gate**: before `initialize`, other mutating
  requests → `NOT_INITIALIZED`; repeated initialize → `ALREADY_INITIALIZED`.
- **INV-PROT-002 — item model closure**: wire items are a closed union
  (`UserMessageItem | AgentMessageItem | ToolCallItem | ToolResultItem |
  FileChangeItem | ApprovalItem | AskUserItem | VerificationItem |
  RuntimeWarningItem`); chain-of-thought is never exposed.
- **INV-PROT-003 — deterministic mapping**: `AgentEvent → ProtocolEventMapper`
  is deterministic; golden tests pin the mapping.
- **INV-PROT-004 — bounded queues**: transport ingress, request processing and
  outbound notification queues are bounded; saturation returns retryable typed
  `SERVER_OVERLOADED` — arrays never grow forever.
- **INV-PROT-005 — replay from authoritative sequence**: subscribe
  `afterSequence=N` returns only events > N; sequence is authoritative; no
  duplicates after reducer dedupe.
- **INV-PROT-006 — idempotent mutating calls**: `thread/start`, `turn/start`,
  `approval/respond`, `ask/respond` support an idempotency key; a retried
  transport request never starts a duplicate turn.
- **INV-PROT-007 — error code passthrough**: `AgentError` codes/messages are
  passed through to the client (never swallowed into `INTERNAL_ERROR`);
  `thread/read` is a real read (pulled from events + mapped via
  `ProtocolEventMapper`), not a mis-mapped `session.status`.
- **INV-V5-010 — protocol isolation**: client/SDK packages never import
  AgentRuntime internals.

## Conformance

- `packages/gateway/src/transport-conformance.test.ts` — P34-5, same fixtures
  over `InMemoryTransport` and `StdioTransport` (initialize gate, method
  mapping, SESSION_BUSY, SERVER_OVERLOADED, interrupt/steer/cancel, reconnect
  replay).
- `packages/sdk/src/conformance.test.ts` — P34-6, three-path equivalence
  (raw client / SDK runStreamed / SDK run).

## Known pitfall

`EventChannel` is a **single-consumer** AsyncIterable: `runStreamed()`'s
`events` and `done` share one iterable — never double-consume (deadlock).
