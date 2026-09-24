# Runtime Scopes & Config Lifecycle

> P27 + P35-3 architecture doc. Describes the config lifecycle classes and the
> drift rules that keep the **world snapshot** authoritative.

## The core statement

The runtime executes one **step** (one model round-trip plus its tool batch) at
a time against an immutable `StepExecutionSnapshot`. Config, tools, MCP, policy
and context are all frozen **before** the model call and must not change for the
duration of that step.

## Config lifecycle classes (P27-3)

Every resolved config key belongs to exactly one lifecycle class:

| class | meaning | example keys |
| --- | --- | --- |
| `process_static` | fixed for the whole process; changing requires restart | data store backend, data directory |
| `session_frozen` | frozen when the session is created | base agent identity, default authority ceiling |
| `turn_dynamic` | may change per turn | task-specific verification plan inputs |
| `step_dynamic` | may change per step, never mid-step | model selection, MCP binding selection, tool exposure |

## Drift rules per lifecycle × change direction (P27-4)

| lifecycle | widening change | narrowing change | allowed mid-step? |
| --- | --- | --- | --- |
| `process_static` | restart required | restart required | never |
| `session_frozen` | reject or require a new session | emergency revocation policy | never |
| `turn_dynamic` | next turn only | next turn only | never |
| `step_dynamic` | next step only | next step only | never |

## Invariants

- **INV-CFG-001 — no silent mutation**: a current `StepExecutionSnapshot` is
  never silently mutated. A config change after snapshot creation only affects
  the **next** step.
- **INV-CFG-002 — fail closed on ambiguity**: if the runtime cannot prove which
  config/policy profile applies to a step, it returns a typed failure
  (`CONFIG_DRIFT_REJECTED` for reject/restart_required severities) rather than
  guessing.
- **INV-CFG-003 — origin traceability**: `ResolvedConfig` can answer "which
  layer supplied this key" and reports a deterministic fingerprint.
- **INV-CFG-004 — frozen fingerprint**: the session-freeze fingerprint is
  persisted with the session; drift detection compares against it and never
  compares against a mutable live view.

## Enforcement points

- `packages/harness/src/create-harness.ts` — `checkSessionConfigDrift`
  (severity `reject`/`restart_required` → throw `CONFIG_DRIFT_REJECTED`;
  otherwise re-freeze and continue).
- `packages/harness/src/config-drift-matrix.test.ts` — P34-7 matrix covering
  all 4 lifecycle classes × change directions.
