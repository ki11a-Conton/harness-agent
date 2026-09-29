# MEASURED DEFECT — `budget-ledger.lock` acquisition fails with EPERM on Windows

**Status:** REAL, deterministic, reproducible. Found while running the clean-tree positive
phase of `prereg-production-e2e.mjs` (S3 Phase G).
**Introduced by:** the ledger lock itself (`packages/evaluation/src/r97-budget-ledger.ts`),
not by the R0/R7 round. This is a **pre-existing** defect that only a real concurrent
campaign run can expose.
**Severity:** blocks the positive arm campaign on Windows. CI runs this job on **both**
`windows-latest` and `ubuntu-latest`, so the Windows leg is at risk of a flaky red that
is not caused by the change under test.

## Symptom

```
Error: EPERM: operation not permitted, open
  'C:\...\.ci\prereg-production-e2e\pos-exec-budget\budget-ledger.lock'
    errno: -4048, code: 'EPERM', syscall: 'open',
    at async Object.reserve (tool-call-efficiency-formal-run.js:1045)
    at async launchArmWorker (prereg-arm-executor.js:999)
    at async runPreregisteredCampaign (.../tool-call-efficiency-paired-campaign.js:268)
    at async runPositiveExecution (prereg-production-e2e.mjs:1106)
```

Reproduced **twice in a row** on a freshly-cleaned directory, so it is not a stale lock
and not a leftover from an aborted run.

## Exact code path

`packages/evaluation/src/r97-budget-ledger.ts`:

- L1198 `const lockPath = join(dir, R97_LEDGER_LOCK_FILENAME)`
- L1203 `const fh = await open(lockPath, "wx")`
- L1216-1218
  ```ts
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
  ```
  **Only `EEXIST` is classified as contention.** Any other code is rethrown
  immediately, bypassing the whole dead-owner / retry / deadline machinery below it.

Release (elsewhere in the same module) uses `rm(lockPath, { force: true })`, and the
dead-owner path does too (L1238).

## Minimal reproduction (measured, not theorised)

Scripts left in `.ci/` (gitignored):

### 1. `open("wx")` racing a concurrent unlink → EPERM
16 workers × 200 attempts, each acquiring then `rm`-ing the same path
(`.ci/lock-rm-race-probe.mjs`):
```
codes observed: { "EEXIST": 2963, "ACQUIRED": 174, "EPERM": 63 }
```

### 2. Isolation — EPERM needs the concurrent unlink
`.ci/lock-mechanism-probe.mjs`, two scenarios:
```
A (open vs concurrent unlink): {"ACQUIRED":2195,"EEXIST":2651,"EPERM":154}
B (sequential open/rm):        {"ACQUIRED":1,   "EEXIST":4999,"EPERM":0}
```
**Scenario B produces ZERO EPERM over 5000 attempts.** So the trigger is precisely the
race between `open(path, "wx")` and a concurrent `rm` of the same path — the lock's own
release step racing another acquirer's open. It is not ordinary contention, and it is not
a Windows quirk of `open("wx")` by itself.

### 3. Disproven hypotheses (recorded so they are not re-tried)
- **Delete-pending from a still-open handle:** disproven. Holding the handle open while
  `rm`-ing, then opening `"wx"`, gave `ACQUIRED` — no EPERM
  (`.ci/lock-eperm-probe.mjs`). The handle must be *closed* for the race to bite.
- **Plain concurrency without rm:** disproven. 24 concurrent openers × 40 rounds on a
  never-deleted path gave `{EEXIST: 920, ACQUIRED: 40}` — zero EPERM
  (`.ci/lock-race-probe.mjs`).

## Why `EEXIST`-only classification is wrong

On Windows, `open(path, "wx")` can fail with `EPERM` when the target name is in a
transient delete/rename state, and that state is created by the lock's OWN release
`rm`. `EPERM` here means "the name is momentarily unavailable", which is exactly the
condition the retry loop exists to absorb — but because it is rethrown at L1217 it
escapes the entire retry/timeout design.

Consequence: a transient, milliseconds-long Windows filesystem state is reported as a
**hard campaign failure**, and it aborts the run (`runPositiveExecution`) rather than
retrying. On a machine with 124 arm runs and a shared lock, this is likely, not exotic.

## Why this is in scope for the round

It is a **deterministic correctness bug with a reproducer** (Runtime Freeze condition 1)
and a **release-integrity defect** (condition 3): it makes the very gate this round adds
red on one of the two platforms, for a reason unrelated to what the gate measures. If
left alone, the honest reading of a Windows CI red would be "the round broke something",
which is false, and the temptation would be to waive the leg — the "silently narrower
claim" this round exists to prevent.

## Proposed fix (NOT yet applied — needs its own counter-example)

Treat `EPERM` as **contention to retry**, not as fatal, at the same place `EEXIST` is
absorbed — but keep it *bounded* by the existing deadline so a permanently unavailable
path still fails closed rather than spinning:

```ts
} catch (err) {
  const code = (err as { code?: string }).code;
  // EEXIST  = genuinely held (the designed contention signal).
  // EPERM/EBUSY = the name is transiently unavailable (Windows delete-pending); the
  //   lock's own `rm` on release creates this window, so it is contention too.
  // Anything else is a real error and must still propagate.
  if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw err;
}
```

Requirements for the change to be acceptable:
1. A **regression that fails on the old code**: drive concurrent acquire/release of the
   same lock path and assert zero unhandled `EPERM` escapes, with the loop bounded.
2. It must still **fail closed** on a genuinely wedged lock (a live holder past the
   deadline must still throw `R97_LOCK_HELD`), so this cannot become an infinite retry.
3. The retry must be **bounded by the existing `deadline`**, using the existing
   `now()`/`timeoutMs` parameters rather than a new ad-hoc counter.
4. `EBUSY` should be included only if a reproducer shows Windows can emit it here;
   otherwise leave it out rather than defensively widening the classification.
5. It must NOT weaken the token/pid/host ownership logic, and must not steal a live lock.

## Honest limits of this report

- Verified on **Windows only** (`win32`/x64, Node v24.18.1). No Linux host is available in
  this session, so whether Linux can produce `EPERM` here is **NOT_PROVEN**. The proposed
  fix is intentionally additive (it only widens *retryable* codes) and does not change
  Linux behaviour, where the code does not arise.
- The frequency in a real campaign is **NOT MEASURED**; the probes give per-attempt rates
  (154/5000 ≈ 3% in the tight-race scenario) and the real run failed twice, but the
  campaign's actual contention profile was not instrumented.
- Whether this alone explains any *earlier* unrelated CI flake is **NOT_PROVEN**; no
  earlier run was tagged with this signature.
