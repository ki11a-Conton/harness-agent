# Tool Snapshot & Step World Authority

> P23 + P35-3 architecture doc. Documents the Frozen StepToolRouter and why
> "the tool the model saw" and "the tool that executes" are the same object.

## The core statement

For every model-originated tool call:

```
MODEL_VISIBLE_WORLD(step N) == TOOL_EXECUTION_WORLD(step N)
```

The exact tool set advertised to the model is frozen into a `StepToolRouter`
before sampling, and every call produced by that model request resolves against
that same frozen router — never against a later, mutated global registry.

## Components

- `StepRecord` — durable serializable identity: stepId, fingerprints
  (toolRouter/policy/environment/context/instruction/mcpBinding), createdAt.
  Never stores closures/executors.
- `StepExecutionSnapshot` — runtime object: `record` + agent, environment,
  permissions, `tools: StepToolRouter`, model, context, instructions, mcp,
  skills.
- `StepToolRouter` (`FrozenStepToolRouter`) — immutable map from model-visible
  name → `FrozenToolBinding { name, spec, definition, semantics, provenance }`.
  No mutation API; execution holds the binding reference.
- Build path: mutable `ToolRegistry` → candidate bindings → policy filter →
  deferred exposure/selector → collision check → freeze → router.

## Invariants

- **INV-V5-001 — router identity**: `executedRouterFingerprint ==
  advertisedRouterFingerprint` for every model-originated call.
- **INV-V5-002 — binding identity**: a call from Step S resolves the binding
  captured by S, never a later global catalog binding. A tool absent from S but
  present globally fails with `TOOL_NOT_IN_STEP` — it never executes globally.
- **INV-V5-003 — MCP generation identity**: a call advertised with MCP
  generation G executes using G or fails explicitly; never silently upgrades to
  G+1. (See `mcp-runtime.md`.)
- **INV-V5-004 — policy non-widening**: global config changes after Step
  creation must not silently widen that step's authority.
- **INV-SNAP-001 — collision fail-closed**: two sources producing the same
  model-visible name (`builtin:read_file` vs `mcp-X:read_file`) fail with
  typed `TOOL_COLLISION`; never last-write-wins.
- **INV-SNAP-002 — fingerprint determinism**: fingerprints canonicalize object
  key order; never depend on function `.toString()`, object identity, random
  iteration order, memory address, or `Date.now()` (except explicit
  `createdAt` outside the hash).
- **INV-SNAP-003 — retry taxonomy**: `transport_retry`/`model_retry` reuse the
  same snapshot; `reactive_compaction`/`context_rebuild`/`tool_world_changed`/
  `model_switch` require a **new** snapshot.

## Enforcement points

- `packages/core/src/runtime/step-snapshot-factory.ts` —
  `buildStepExecutionSnapshot` before every model call.
- `packages/core/src/runtime/tool-call-controller.ts` — resolves
  `step.tools.resolve(call.name)`; fails `TOOL_NOT_IN_STEP`.
- `packages/core/src/runtime/step-snapshot.invariant.test.ts` — P23-8 ten-case
  invariant suite through the real runtime loop.
- `packages/core/src/runtime/world-snapshot.conformance.test.ts` — P34-1
  drift/conformance suite.
