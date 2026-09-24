# E4-R06 Report — corrupt-state durability + lease fencing

## Defects fixed

| id | defect | fix |
|---|---|---|
| F14 | a corrupt record was quarantined by RENAME, so a second `getRecord` (or a post-restart read) saw ENOENT → `undefined` → the actor created a fresh `attempt=0` record — recovery attempts were reset by damage | the quarantine now leaves a **persistent `.corrupt-*` marker**; every subsequent read (second read AND restart) re-raises `CORRUPT_RECORD` instead of `undefined`; a fresh `putRecord` (versionless) is **refused** while the marker exists; only an explicit `deleteRecord` (the maintenance action) clears the marker |
| F15 | the file lock was released by unconditional `unlink` (an old owner's `finally` could delete a NEW owner's lock) and stale locks were stolen on mtime alone — a live writer running >10s could be robbed, admitting two writers | locks now carry an **owner token** (`pid + per-store nonce`); release only unlinks when the file still carries THIS token; a lock is stolen only when it is older than the stale floor AND its recorded owner PID is **no longer alive** (`process.kill(pid, 0)` liveness probe) |

## Durability / idempotency semantics — explicitly committed

Checked against the existing actor design (E4-08) and verified unchanged:

- **intent/lease writes are STRICT** (`persistRecoveryIntent` throws): an intent write failure means the recovery action is NOT run (0 action calls).
- **queue advancement is gated on DURABLE terminal state**: `recoverHead` re-reads the durable record; the head shifts only when the stored record is `RECOVERED` / `EXHAUSTED+proceed`. A failed terminal write leaves the record non-terminal on disk, so the item is never dropped and a restart re-drives it (reconciliation path, `lastError` recorded).
- **lease release is owner-checked**: `releaseLease` re-reads and only clears its own owner's lease.
- Attempts/backoff/max attempts cross-process preserve (versioned CAS, verified by existing restart test).

**Not provable from a local ACK alone**: exactly-once for an EXTERNAL side effect. A recovery action that ran before a terminal-write failure will be re-attempted after restart (the durable record is `RECOVERY_IN_PROGRESS` with `lastError`). This repo does not claim external exactly-once for non-idempotent effects; those remain marked for reconcile/human handling — stated here, not concealed.

## Evidence

Store regressions (`durable-recovery-store.test.ts`, +4):

```text
F14: corrupt JSON → getRecord CORRUPT_RECORD (1st read)
                      CORRUPT_RECORD (2nd read — NOT undefined)
     new client (restart) → CORRUPT_RECORD
     fresh putRecord(attempt 0) → CORRUPT_RECORD (refused; attempts NOT reset)
     deleteRecord (maintenance) → getRecord undefined (marker cleared)
F15: release of own token   → lock removed
     old owner's finally after token rewrite → new owner's lock SURVIVES
     live owner + 60s-old lock (this pid) → acquire fails fast (IO_ERROR), not stolen
     dead owner (pid 99999999) + old lock → reclaimed
```

Cross-process test (`durable-recovery-store-xproc.test.ts`, +1, real child process):

```text
child node process creates the wx lock with ITS live pid + old mtime
parent acquire  → RecoveryStoreError (no second writer in the critical section)
child exits     → parent reclaims the dead owner's lock
```

## Verification

```text
pnpm typecheck (tsc -b)          clean
durable-recovery-store (+ xproc) 16/16
recovery-durable / state-machine /
  create-harness                  44 passed / 5 files (no regressions)
```

## Explicit non-claims

- The lock is an ADVISORY, crash-tolerant mutex (wx + owner token + pid
  liveness); it is not a mandatory OS-level file lock and does not protect
  against a malicious writer that ignores the protocol.
- `listDue` scheduling and the actor retry-scheduler integration were reviewed
  (they exist and are wired via `scheduleRecoveryRetry` / the injected
  scheduler); no new scan API was added, and no external system is claimed
  exactly-once.