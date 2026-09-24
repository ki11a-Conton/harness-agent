# Durability: Canonical Journal & Fences

> P26 + P35-3 architecture doc. Documents the durability boundary — what is
> durable, through which fence, and how resume classifies crashes.

## The core statement

The event trail **is** the canonical semantic journal. There is no second
competing log. A subset of event kinds are semantic durability records; the
rest are observability deltas. `DurabilityFenceStore.flushThrough(sequence)`
is the explicit "everything through sequence N is durable" boundary.

## Durability levels

| level | meaning | backends |
| --- | --- | --- |
| `memory` | lost on process exit | mem stores |
| `process` | survives normal process exit, may lose on crash | SQLite (WAL + NORMAL) — **honest, never over-claimed** |
| `crash_safe` | fsync-backed | JSONL (`appendDurable`) |

## Side-effect lifecycle journal states (P26-4)

```
INTENT_PERSISTED → EXECUTION_STARTED → OUTCOME_COMMITTED → CHECKPOINT_COMMITTED (policy)
```

- `ToolIntentJournalPayload`: toolCallId, stepId, routerFingerprint,
  toolBindingFingerprint, argsHash, sideEffectScope, idempotent.
- `ToolOutcomeJournalPayload`: toolCallId, status, resultHash?, evidenceHashes?.

## Invariants

- **INV-V5-009 — semantic journal sequence**: per session, committed journal
  sequence is unique and monotonic; allocation is store-owned and atomic
  (`EventStore.appendNew`), never caller-allocated via
  `nextSequence + append` in production writers.
- **INV-DUR-001 — fence before ack**: the runtime flushes the durability fence
  BEFORE acknowledging turn completion (fail-closed).
- **INV-V5-007 — no blind retry of unsafe side effects**: a crash/timeout/
  unknown outcome of a non-safe tool never triggers automatic re-execution.
- **INV-DUR-002 — resume classification**: crash states classify as
  `not_started` / `likely_not_started` / `unknown_effect → reconcile` /
  `do_not_reexecute → reconstruct_forward` / `resume_from_checkpoint`; an
  unknown effect is never blind-retried.
- **INV-DUR-003 — projection rebuild**: projections (Session/Turn/Transcript/
  ToolLedger/Trace) are rebuilt from journal + durable docs; a projection is
  never an independent authority; rebuild is idempotent.
- **INV-DUR-004 — atomic where feasible**: `commitToolOutcome` (message +
  outcome event + checkpoint) commits in ONE transaction on SQLite; fallback
  stores use ordered writes + fences and advertise weaker atomicity.

## Crash matrix

Inject kill at: before intent / after intent / after execution start / after
effect committed before outcome write / after outcome write / before checkpoint
/ after checkpoint / before turn completion / after completion event before
client ack. For a non-idempotent fake write tool, **no crash path performs an
automatic duplicate side effect** (P26-8 / P34-3).

## Enforcement points

- `packages/core/src/runtime/crash-matrix.test.ts`,
  `packages/core/src/runtime/crash-sideeffect.test.ts` — P26-8 / P34-3.
- `packages/core/src/runtime/resume.test.ts` — P26-5 classification.
- `packages/core/src/state/projections.test.ts` — P26-7 rebuild idempotence.
