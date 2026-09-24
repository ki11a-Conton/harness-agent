# E4-08 Report: Durable, Restart-Safe RecoveryStore

## Objective

Make session recovery survive a real process restart — preserving attempts,
`nextAttemptAt`, lease, and terminal decision — with production persistence and
fail-closed write semantics. The existing actor algorithm is left intact.

## Completion status

Implemented in commit `e4c4fca`.

## Contract change (minimal, backward-compatible)

- `RecoveryRecord` gains an optional `version` (optimistic-concurrency token).
- `RecoveryStore.putRecord` is now a **compare-and-set**: it returns the stored
  record with a bumped `version` and throws when the incoming `version` does not
  match the stored one. `MemoryRecoveryStore` enforces the same CAS (tests /
  explicit ephemeral mode only).

## Headline fix — a store write failure can no longer run the action

Previously `persistRecoveryRecord` logged a write failure on the degraded channel
and returned the record unchanged, so `recoverHead` proceeded to `runTurn` even
though the lease/attempt-intent was never durably recorded — an unrecoverable
external side effect with no owner record.

Now:

- `persistRecoveryIntent` (strict, throws) is used for the **lease acquisition**
  and the **attempt-intent** write;
- `recoverHead` catches a lease or intent-persist failure and returns
  `wait-lease` **without** calling `runTurn`;
- terminal (success/failure) writes stay best-effort (the action already
  happened; a crash before the terminal write is reconciled on restart via the
  `RECOVERY_IN_PROGRESS → interrupted` path).

## DurableRecoveryStore (production backend)

`packages/harness/src/durable-recovery-store.ts`:

- one atomic JSON file per task (temp + fsync + rename via `@ar/store-integrity`);
- version CAS + a cross-process advisory lock (`open "wx"` + PID + stale
  recovery) around each read-check-write, so two processes cannot both win a
  lease;
- verify-by-read before acknowledging a write;
- unknown schema fails closed; a corrupt record is **quarantined** (moved aside,
  never silently treated as absent, so attempts are never reset by damage);
- `listDue(now, limit)` for an external scheduler to re-drive backoff after a
  restart with no live actor.

## Production injection

`createHarness` constructs a `DurableRecoveryStore` whenever a `dataDir` is set
and passes it to `DefaultLoadedSessionManager` → every loaded actor. Both CLI and
Web go through `createHarness`, so both get durable recovery automatically;
without a `dataDir` the actor keeps its in-memory fallback (never the production
path).

## Tests

- `durable-recovery-store.test.ts` (11): fresh/version-1; restart continuity
  (a new client sees the prior attempt budget); CAS race — exactly one write
  wins; fresh-over-existing rejected; expired-lease re-acquisition; delete
  idempotent; corrupt JSON quarantined (not absent); unknown schema fail-closed;
  `listDue` ordering/cap/filters; unsafe-id traversal rejected; on-disk envelope
  valid.
- `recovery-durable.test.ts` (3): store write failure → `runTurn` never called
  (0 external side effects); attempt budget survives across actor instances
  (1 → 2, RECOVERED); two actors contending for one lease → at most one runs.

## Acceptance

- `tsc -b` clean.
- Full suite green at commit time (5479 passed / 1 skipped, 297 files).

## Deliverables

- durable store adapter: complete.
- CLI/Web injection: complete.
- crash/restart/concurrency tests: complete.
- E4-08 report: complete.
