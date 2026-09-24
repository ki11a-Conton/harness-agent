# Symphony-Style Orchestration (External Work)

> P33 + P35-3 architecture doc. Documents the layer ABOVE the harness that
> schedules many independent work items using only the public App Server/SDK
> boundary.

## The core statement

The orchestrator is a separate package (`packages/orchestration`), above the
Harness, not inside `AgentRuntime`. It reconciles external work items
(polling, claims, state reconciliation, retries, workspace lifecycle) and
drives each worker through the App Server — never through Core internals.

## Components

- `WorkTracker` — `listCandidates()` / `read(ids)`; generic, provider-native
  opaque refs preserved without core interpretation (fake tracker first, no
  GitHub/Linear-specific core logic).
- `WorkItem` — normalized: id, identifier, title, description?, state,
  priority?, labels, dispatchable, updatedAt?.
- `OrchestratorState` — authoritative scheduler state: `running`, `claimed`,
  `blocked`, `retries`.
- Reconcile-before-dispatch tick: reload dynamic workflow config → reconcile
  running/blocked/retry eligibility → compute capacity → list candidates →
  revalidate immediately before claim → claim → prepare workspace → start
  Harness thread through App Server → schedule next tick.
- `WORKFLOW.md` — repository-owned contract (optional YAML front matter +
  prompt body; unknown keys ignored, invalid known fields fail typed).

## Invariants

- **INV-ORCH-001 — state consistency**: `running ⊆ claimed`,
  `retrying ⊆ claimed`, `running ∩ blocked = ∅`, terminal eventually
  `∩ running = ∅`.
- **INV-ORCH-002 — reconcile before dispatch**: never only consume a queue and
  hope state remains valid; every claim is revalidated immediately before
  dispatch.
- **INV-V5-012 — reconciliation convergence**: a work item that becomes
  ineligible eventually has no active worker (stop via `turn/interrupt`, then
  workspace cleanup policy).
- **INV-ORCH-003 — boundary isolation**: `orchestration → SDK/AppServer client`;
  `orchestration → AgentRuntime internals` is forbidden. No dependency from
  `core → orchestration`.
- **INV-ORCH-004 — workspace isolation**: per-item deterministic sanitized key
  + collision-resistant hash suffix; no two distinct identifiers share a
  workspace.
- **INV-ORCH-005 — bounded retry**: exponential backoff + jitter on transient
  failures; injected monotonic timer in tests; no retry storm after restart;
  state change may cancel pending retry.

## Worker lifecycle

worker: workspace → `appServer thread/start` → `turn/start` → consume events →
react to tracker reconcile interruption.

## Enforcement points

- `packages/orchestration/` — tracker/reconciler/scheduler/workspace-manager
  unit suites.
- P34 conformance + P35-5 `pnpm test` regression gates.
