# Migration Notes

> P35-4 — public-facing changes for callers of harness-agent v5. Covers the
> Step compatibility surface, RPC → App Server, the SDK package, typed approval
> capability, config layers, and MCP lazy semantics. Old callers: read the
> section for each API you touch.

---

## 1. StepContext compatibility

**What changed**: the runtime now builds an authoritative
`StepExecutionSnapshot` (record + frozen `StepToolRouter` + frozen policy/
context/environment) before **every** model call. The legacy `StepContext`
contract is retained as a **compatible surface** — do not delete it.

- `StepContext.toolSpecs` (contracts/step-context.ts) is KEPT as the
  P31-1/P23-1 intentional legacy surface. New code must read
  `StepExecutionSnapshot`/`StepRecord` for authority.
- The model-visible tool set is now `step.tools.modelVisibleSpecs`, and tool
  execution resolves `step.tools.resolve(name)` — never a global registry.

**How to migrate**:
- If you only read `stepId`/`sessionId`/`turnId`/`model`, `StepContext` still
  works unchanged.
- If you read `toolSpecs` to decide execution authority, switch to
  `StepExecutionSnapshot.tools` (frozen router).
- If you pass `toolSpecs`/`toolSelector` into `AgentRuntimeDeps`, remove them —
  they are gone (P35-1).

---

## 2. RPC → App Server

**What changed**: the internal RPC surface (`session.create`, `session.send`,
`session.run`, ...) is replaced by the versioned App Server protocol
(`initialize`, `thread/*`, `turn/*`, `approval/*`, `ask/*`).

| old RPC | new protocol |
| --- | --- |
| `session.create` | `thread/start` |
| `session.send` / `session.run` | `turn/start` (+ `thread/read` for items) |
| `session.cancel` | `turn/interrupt` |
| `session.send` while active | `turn/steer` (explicit) or follow-up queue |

**How to migrate**:
- Send `initialize` first; other mutating requests before it are rejected
  `NOT_INITIALIZED`.
- A second `turn/start` on a busy thread returns typed `SESSION_BUSY` — treat
  it as steer/queue/busy, never as a second parallel run.
- Reconnect by requesting `afterSequence=<last seen>` — sequence is
  authoritative and replay is deduped.
- Error codes are passed through (e.g. `CONFIG_DRIFT_REJECTED`,
  `TOOL_NOT_IN_STEP`, `MCP_CONNECT_FAILED`) — do not pattern-match on
  `INTERNAL_ERROR` as a catch-all.

---

## 3. SDK package (`packages/sdk`)

**What changed**: a standalone, stream-first SDK now exists.

```ts
import { HarnessClient } from "@ar/sdk";

const client = new HarnessClient({ transport });
const thread = await client.startThread({ agentId: "default" });

const { events } = await thread.runStreamed("fix bug");
for await (const e of events) { /* consume items */ }

// convenience: run() is a reducer over runStreamed()
const result = await thread.run("fix bug");
```

**How to migrate**:
- `run()` and `runStreamed()` share one event stream — never consume both on
  the same channel (single-consumer AsyncIterable; double consumption
  deadlocks).
- `AbortSignal` maps to `turn/interrupt` — aborting cancels the server-side
  turn, not just local reads.
- `@ar/sdk` never imports `@ar/core`; migrate CLI/UI callers off Core internals
  for ordinary execution.

---

## 4. Approval typed capability

**What changed**: stringly-typed `{ action, target, scope }` is replaced by a
typed `CapabilityRequest` union:

```ts
type CapabilityRequest =
  | ExecCapability      // { kind:"exec", environmentId, cwd, argv, tty, permissionDelta? }
  | FileCapability      // { kind:"file", operation:"write"|"delete"|"move", canonicalPaths }
  | NetworkCapability   // { kind:"network", protocol, origin }
  | McpCapability       // { kind:"mcp", serverId, generation, tool, argsHash }
  | PermissionEscalationCapability;
```

`approvalFingerprint(capability)` is the canonical identity (never includes raw
secrets). Legacy `action`/`target` remain as a display projection during
migration.

**How to migrate**:
- Approvers/responders: build/read the typed capability instead of
  `action`/`target` strings.
- Grant reuse is now semantic: `one_call` matches the exact request;
  `one_tool` matches equal-or-narrower capability; `session` reuses only within
  the same session and exact scope. Broader requests never reuse narrower
  grants (`INV-V5-008`).

---

## 5. Config layers

**What changed**: a direct `HarnessConfig` becomes a layered, explainable
`ResolvedConfig` with per-key origins and lifecycle classes
(`process_static` / `session_frozen` / `turn_dynamic` / `step_dynamic`).

**How to migrate**:
- Reading the effective value is unchanged (`resolvedConfig.value`).
- To explain a key: `config explain <key>` (CLI) prints its origin layer,
  fingerprint and no secrets.
- A config change after a step is created never mutates that step: if the
  change is `reject`/`restart_required`, the runtime fails closed with
  `CONFIG_DRIFT_REJECTED`.

---

## 6. MCP lazy semantics

**What changed**: Harness startup no longer connects every configured MCP
server. `McpServerCatalog` declares servers; `McpConnectionManager` connects on
**need** (goal/skill/tool resolution); each step freezes its MCP world into a
generation-pinned `McpBindingSnapshot`.

**How to migrate**:
- Do not rely on `mcp.*` tools being present at startup — a server connects
  when a step needs it.
- A call advertised with generation G always executes against G; a refresh
  creates G+1 for future steps only. Do not assume "latest tools" for an
  in-flight call.
- A broken unused server no longer aborts harness creation; a step that needs
  it gets `MCP_CONNECT_FAILED` with the server id.

---

## Summary of behavioral guarantees (what you may rely on)

1. Model-advertised tool world == executed tool world, per frozen step.
2. One active turn per session, always.
3. Side effects: at-most-once automatic retry for unsafe actions + unknown-
   effect reconciliation (never "exactly once" against arbitrary externals).
4. Versioned App Server protocol; sequence-authoritative replay.
5. Durable boundaries are explicit fences; a harness reports its durability
   honestly (`memory` / `process` / `crash_safe`).
