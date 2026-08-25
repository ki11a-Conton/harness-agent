# Release Integrity Model

> P36-13 — the release gate state model, execution-backed evidence, and
> why "pre-existing failure" is still release red.

## Release gate state model (P36-1)

A release candidate is READY only when every required gate has state `"passed"`
at the exact release HEAD. The gate states are:

| state | meaning |
| --- | --- |
| `passed` | gate ran and exited 0 |
| `failed` | gate ran and exited non-zero |
| `not_run` | gate was never attempted |
| `blocked` | a dependency prevented the gate from running |

No state is convertible:
- `failed` + reason "pre-existing" → still `failed`
- `failed` + reason "known noise" → still `failed`
- `blocked` → not `passed`

## Rule — "Red means red" (P36 Rule 1)

A failed gate may not be reclassified as "expected noise" to produce
`releaseReady = true`. If a test is genuinely invalid, repair the test so it
tests the intended invariant. If the invariant is wrong, correct the invariant.

## Execution-backed evidence (P36-7)

A capability is `integrationTested` only when:
1. a test file exists (static declaration, `testDeclared`);
2. a passing, current-HEAD run of that test exists (execution evidence,
   `integrationTested`).

File existence alone is never "tested". Execution evidence is stored in
`.ci/evidence/*.json` and validated by HEAD SHA.

## SessionActor linearizability (P36-2)

`SessionActor.startTurn` reserves ownership synchronously before the first
`await` that can yield to another caller. This makes same-session turn
admission linearizable: two concurrent `startTurn` calls cannot both succeed.

## SDK stream truth (P36-4)

`RunEventHub` broadcasts transport events to both the public event queue and
an internal incremental reducer. `events` and `done` are independent
consumers — they may be used concurrently without deadlock or event stealing.

## Security shell-composition policy (P36-5)

A plain-command allowlist rule (`git *`, `**/*`) cannot authorize shell
composition (`git status; echo pwned`). Composed commands require an explicit
shell rule. Decision order: parse target → detect composition → apply
denied surface → if composed: require explicit shell authorization → if plain:
evaluate argv/glob allowlist → apply network intent.

## Capability durability semantics (P36-8)

Durability is modeled as three separate attributes:
- `durabilityActual`: the backing store's durability level (none/memory/process/durable)
- `durabilityRequired`: what the profile requires
- `durabilitySatisfied`: whether the actual meets the requirement

An in-memory store is never `durable=true` merely because the profile does not
require durability.