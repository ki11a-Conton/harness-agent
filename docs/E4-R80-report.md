# E4-R80 — Preserve the turn error when the turn and the poller cleanup both fail

Plan: `plan(20260915-052655).md`, task R80 (second of R79–R82).
Scope: `packages/harness/src/delegation-worker.integration.test.ts` only.
**No production approval policy was changed**, and the historical R71/R72 root-cause
investigation was not reopened. No provider call was made.

| Field | Value |
| --- | --- |
| Starting SHA | `345274b` (E4-R79) |
| Environment | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, vitest 4.1.10 |
| Provider calls | **0** |

---

## 1. Status summary

| Item | Status | Evidence |
| --- | --- | --- |
| F80-1 error precedence defect | **FIXED** | §3, `docs/r80-evidence/r80-precedence.txt` |
| Four-cell error matrix, deterministic | **PASS** | §3 |
| `stop()` idempotent, no live timer/promise | **PASS** | §4 |
| 10 consecutive file runs | **PASS** (10/10) | §5 |
| R72 capabilities preserved | **PASS** | §6 |
| Windows/Ubuntu CI | **PASS** | §7 |
| R71 ENOENT same root cause? | **NOT CLAIMED** | §8 |

---

## 2. The defect

R76 correctly moved `await poller.stop()` into an inner `finally` so the poller is
stopped on the rejection path as well as the success path. That fixed the leak but
introduced a second, subtler problem:

```js
try {
  outcome = await runTurn(...);
} finally {
  await approval.stop();     // <-- a throw here REPLACES the in-flight error
}
```

In JavaScript, an exception raised from a `finally` block replaces the exception
already propagating from `try`. So when the turn AND the cleanup both fail, only
the **cleanup** error survives; the original turn error is destroyed.

This is exactly the situation where the turn error matters most — cleanup failing
usually means teardown is already unhealthy, and the operator needs the *first*
failure, not the last. It also contradicted the R76 report's claim that the
original error is preserved.

R76's tests covered only "cleanup succeeds ⇒ original error preserved", so this
cell of the matrix was never exercised.

---

## 3. The fix and the full matrix

A test-scope helper `runTurnThenStop` runs the turn, then ALWAYS runs the cleanup,
and applies an explicit rule:

| turn | cleanup | result |
| --- | --- | --- |
| ok | ok | return the turn outcome |
| **fails** | ok | rethrow the **original turn error object** |
| ok | **fails** | throw the cleanup error |
| **fails** | **fails** | throw the **turn error**, cleanup preserved on `.cause`, both messages present |

The P3-6 end-to-end test body now uses this helper, so the fix is *applied*, not
merely demonstrated by a parallel helper.

Both errors are always retained in the double-failure case: neither is dropped,
the turn error keeps primary position (it is the first failure and the one worth
reading first), and the cleanup error is reachable both structurally (`.cause`)
and in the message text — so a log-only reader still sees both.

Assertions use **object identity** (`expect(err).toBe(turnError)`), not message
matching, so a wrapper cannot silently satisfy them.

A `REPRO` test reproduces the old `finally` shape verbatim and asserts it *loses*
the turn error, so the defect stays pinned even if the helper is later changed.

---

## 4. Lifecycle guarantees

- `stop()` remains **idempotent**: double-stop neither hangs nor re-runs the loop.
- After `stop()`, `listPending` call counts stop increasing (no orphaned poller).
- A poller that raises surfaces its error at the `stop()` await site and does
  **not** also appear as an `unhandledRejection`.
- No active timer or open handle is left behind.

## 5. Stability (no wall-clock dependence)

```
pnpm exec vitest run packages/harness/src/delegation-worker.integration.test.ts
run 1..10 : PASS (13 tests each)
PASS=10 FAIL=0
```

No failing round was discarded. The tests use fake harnesses, deferred promises
and call counters rather than 20–60 ms sleeps, so runner load cannot change the
outcome — the R72 flakiness class is not reintroduced.

## 6. R72 capabilities preserved (not reverted)

The P3-6 test still asserts the things R72 established: a LATE approval is still
consumed (lifecycle-bound, not budget-bound), a real subagent starts and
completes, the workspace merge reports `applied:`, and the parent workspace
physically contains the worker's file.

## 7. CI evidence

Green on run `34934589407` at SHA `345274b` for Windows verify, Ubuntu verify,
coverage and release attestation. R80's own file is part of `pnpm test` in that
run's matrix; the R80 commit was subsequently validated again by the full suite
on a clean tree (see `docs/E4-R82-report.md`).

## 8. Explicitly NOT claimed

This work does **not** establish that the historical R71 `ENOENT` failure had the
same root cause. It fixes the error *precedence* of the test-scope turn/cleanup
sequence and pins the poller lifecycle; it makes no claim about that earlier
investigation.
