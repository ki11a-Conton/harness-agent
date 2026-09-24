# E4-R05 Report — champion mechanism actually installed + CAS-failure instance closed

## Defects fixed

| id | defect | fix |
|---|---|---|
| F12 | `createHarnessWithChampion` projected only `featureFlags` + `memory.enabled` from the champion config and wrote `applied/PROVEN` on a flags match — the evaluated mechanism (e.g. budget-aware completion) was never actually installed in the running harness | the champion's required mechanisms are now 1) resolved via the ArmFactory, 2) INSTALLED in the harness config, and 3) verified against the REAL resolved config in the AppliedProof check surface. `budget_aware_completion_v1` installs `completionGuidance` → the harness's main agent appends it to the system prompt (same behavior text the benchmark uses). Mechanisms with NO production install point (`toolSelector` deferred-schema, `contextBudget` adaptive, `recoveryPlanner`) explicitly REJECT the candidate startup — flags-only PROVEN is never written |
| F13 | on CAS failure the code returned the CHAMPION-configured harness built from stale generation A — the old champion instance kept serving after a lost race | on CAS rejection the stale harness is CLOSED (timers/stores stop) and the process runs the frozen baseline harness |

## Mechanism installation matrix (real startup path, per ArmFactory)

| mechanism | install point in production startup | proof surface in AppliedProof | unsupported → rejected? |
|---|---|---|---|
| memory retrieval | `memory.enabled` + dbPath in the config | `memory.enabled` check (origin runtime) | — |
| budget-aware completion | `completionGuidance` → main agent system-prompt suffix | `completionGuidance` check (origin runtime) | — |
| tool selector (deferred-schema) | none today | — | yes — startup refused with explicit reason |
| adaptive context | none today | — | yes — startup refused |
| recovery planner | none today | — | yes — startup refused |

## Evidence (both halves, per the deliverable)

**Config installation** (real `createHarness`, scripted/capturing provider, temp dirs):

```text
F12: budget-aware + pending claim
  createHarnessWithChampion -> status "applied"
  main agent systemPrompt    contains "prioritize running the verification command"
C0 baseline:
  main agent systemPrompt    does NOT contain the guidance

F12 real turn:
  sessionService.create -> runtime.startTurn -> runtime.runTurn
  provider REQUEST system prompt contains the guidance
  (mechanism observable in the actual request, not inferred from a flag)

F13 CAS race (real timing simulation):
  createHarnessFn advances the state file DURING harness creation
  -> status "applicationFailed", reason contains "CAS"
  -> stale harness .close() observed (racerClosed === true)
  -> returned harness = BASELINE (no budget guidance in its main agent)
```

The negative side is asserted too: the baseline never exhibits the mechanism, and
the race never returns the old champion instance.

## What this does NOT claim

- This proves **configuration/mechanism installation** + a real-turn observable
  for the installed mechanism. It is not a claim that the whole candidate
  behavior is correct in production — the benchmark's paired eval remains the
  behavioral evidence (per the task: startup proof ≠ behavior proof).
- The F13 test simulates the race in one process via an injected `createHarnessFn`
  (a cross-process two-writer race is equivalent in the CAS contract); all state
  files and data dirs are temp-only.
- Mechanisms with no safe install point are REJECTED here, not silently mapped —
  their promotion claims stay pending until a real install point exists.

## Verification

```text
pnpm typecheck (tsc -b)               clean
E4-R05 file                           4/4 (new)
affected suites (champion-application,
  champion-state-file, create-harness,
  config-wiring, champion-harness-config)  47 passed / 5 files
```

Commits: `41406c4` (R04) → R05 changes committed separately.