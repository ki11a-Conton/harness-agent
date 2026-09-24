# MCP Runtime: Catalog ≠ Connection ≠ Binding

> P24 + P35-3 architecture doc. Documents lazy MCP composition and the
> generation-pinned bindings that keep the step world authoritative.

## The core statement

Harness creation never connects MCP servers eagerly. The composition root
builds an `McpServerCatalog` (descriptors only), connects on **need**, and
freezes each step's MCP world into an immutable `McpBindingSnapshot` whose
tools are generation-pinned.

## Components

- `McpServerDescriptor` — id, config, trust, networkBoundary, enabled,
  requiredByDefault; declaration only, never connects.
- `McpConnectionManager` — `getOrConnect(serverId)`: shared connect promise
  (100 concurrent → 1 connect), connection generation, health state, refresh,
  idle close, closeAll.
- `McpDependencyResolver` — need-driven: `mcp:<id>` mentions, known-tool
  matching, skill/plugin declared deps, `requiredByDefault`. Config existence
  alone is never a reason to connect.
- `McpBindingSnapshot` — immutable: id, fingerprint, generations map, tools
  (`McpFrozenToolBinding`: serverId, generation, schemaHash, definition ref,
  trust), createdAt.
- Refresh: `G1 active → tools/list changes → construct G2 → future steps may
  bind G2 → already-created steps retain G1`. Never mutate `G1.tools` in place.

## Invariants

- **INV-V5-003 — MCP generation identity**: a model call advertised using MCP
  generation G executes using G or fails explicitly; never silently upgrades to
  G+1.
- **INV-MCP-001 — lazy composition**: `composeMcp` is mostly catalog
  composition; no stdio/HTTP initialize at startup unless explicitly
  eager/required. Configure 10 servers, create Harness → connect count == 0.
- **INV-MCP-002 — single-flight connect**: two simultaneous steps needing the
  same disconnected server share one connect promise.
- **INV-MCP-003 — unused broken server never kills startup**: a misconfigured
  non-needed server cannot abort Harness creation; a step that actually needs
  it gets a typed `MCP_CONNECT_FAILED` with the server id, and unrelated
  built-ins stay available.
- **INV-MCP-004 — lifecycle closure**: `harness.close()` closes every connected
  generation; no orphan stdio processes.
- **INV-MCP-005 — bounded idle**: `McpRuntimePolicy` (idleTtlMs /
  maxConnectedServers / connectTimeoutMs) bounds lifecycle; tests use injected
  timers.

## Enforcement points

- `packages/mcp/src/mcp-runtime-v2.test.ts` (or equivalent MCP v2 suite) —
  P24-2 single-flight, P24-6 generation refresh, P24-7 unused-broken server.
- `packages/harness/src/mcp-wiring.integration.test.ts` — step-level MCP world
  freeze into `StepToolRouter`.
- Audit: `mcp_connected.snapshotAuthoritative` requires
  `features.stepSnapshot` + P34-7/P34-8 matrix coverage (see
  `CAPABILITY_MATRIX.md`).
