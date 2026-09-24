# E4-R94 report — resume re-observes the current identity, and the pre-request state is durable

Plan: `plan(20260917-083737).md` §R94 (findings B and C).
Baseline SHA: `232ae5f1b39b4c1907be31da908daa8bd7499233` (verified: `git rev-parse HEAD` == this SHA at start of work).
Work started at `9b0914d59ce440e5f9a5610f88b6a8afad3785db` (R93 committed).
Zero real provider requests. Zero paid calls. The fake CLI only.

## 1. The defects (findings B and C), restated from source

### B — resume compared the stored identity against itself

`scripts/benchmark/run-campaign.ps1` built the resume decision like this:

```powershell
$expectedIdentity = Get-CaseIdentity $s.name $caseId $lastOk.planDigest   # the OLD digest
if ($lastOk.identity -ne $expectedIdentity) { ... }
```

`Get-CaseIdentity` hashes `suite|caseId|provider|model|endpointDigest|planDigest|sourceSha`.
Passing the **stored** `planDigest` back in means the plan-digest term is identical on both
sides by construction: the comparison cannot fail for the reason it exists. A case whose
source file changed at an unchanged git SHA still matched, and was reported
`SKIP already stored (identity verified)`.

Two further gaps in the same decision:

- **The report's own bytes were never hashed.** "The report file exists" was the whole
  completion test, so editing `success`, `output_tokens` or `termination_reason` inside an
  otherwise well-formed report was invisible.
- **Only the first result was validated.** `Test-ReportValid` inspected `$doc.results[0]`,
  so a report whose *later* results were malformed still passed.

### C — the crash window was unguarded, and a corrupt manifest was silently swallowed

- `Read-Manifest` did `try { ... } catch { continue }`. A truncated or corrupt line was
  skipped without a trace, and the run proceeded as if the ledger were intact.
- The attempt record was written only **after** the case finished. A crash between "the
  request went out" and "the outcome was persisted" left no durable trace at all, so the
  next invocation could treat the case as new and silently re-bill it.
- There was no single-instance lock: two runners pointed at one output root would both
  start children for the same cases.
- The output-root containment check was purely **lexical**. A junction/symlink anywhere
  under the repository passed the `StartsWith` test while redirecting every write outside.

## 2. What was built

### 2.1 A durable attempt state machine (the attempt, not the case)

`attempt-state.json` holds one record per case:

| Field | Meaning |
|---|---|
| `suite`, `caseId` | the case |
| `arm` | `"single"` — this runner runs ONE configuration; the arm becomes two-valued in the R92/R97 driver |
| `attemptId` | a fresh GUID per dispatch |
| `currentPlanDigest` | the digest the attempt was LAUNCHED with |
| `status` | `planned` → `in_flight` → `completed` / `failed_before_dispatch` / `outcome_unknown` |
| `reportHash` | sha256 of the durable report's bytes |
| `sourceSha`, `experimentId`, `detail`, `at` | provenance |

The state machine tracks the **attempt**; the manifest tracks the **case outcome**. They are
deliberately separate: a child can exit non-zero while leaving a durable, valid report, in
which case the attempt is `completed` and the manifest records `ok=false`.

The `in_flight` record is written **before** the billable child starts, and it is written
atomically (temp file + same-volume rename). NTFS and POSIX same-volume rename are atomic;
no cross-network guarantee is claimed.

### 2.2 Recovery decides from evidence, never from hope

| Durable state found | Action |
|---|---|
| `failed_before_dispatch` | **retry** — no billable child ever existed. The only freely retryable state. |
| `outcome_unknown` | **stop.** A request may have reached the provider. No automatic retry. |
| `in_flight` + valid report + same experiment + same **re-observed** digest | **offline re-registration** — 0 provider calls |
| `in_flight` + anything less | `outcome_unknown` |

The `in_flight` substantiation test is conjunctive and each conjunct is load-bearing:
`$dig.error -eq $null` (the case still plans), `$reportOk` (the report is durable **and**
valid), `$stored.experimentId -eq $experimentId`, and
`$stored.currentPlanDigest -eq $dig.digest` where `$dig` was re-derived from the **current**
case source by a free `--dry-run`.

### 2.3 The resume decision re-observes everything

- `Get-PlanDigestCached` re-derives the current digest with a free `--dry-run` (cached per
  case), and `Get-CaseIdentity` is now called with **that** digest.
- `reportHash` is the sha256 of the report's bytes, so any content edit — `success`,
  `output_tokens`, `termination_reason` — breaks reuse and quarantines the case.
- `Test-ReportValid` validates **every** result (not just `$doc.results[0]`), plus `meta`/
  `results` presence, `meta.suite`, each result's `task_id`, `summary.total` against the
  result count, and the report's own model/provider against this run's.
- A record with no `identity` is **LEGACY**: trusted only for the model/provider it names,
  counted in `resumedLegacy`, and never presented as verified reuse.
- A record with an identity but no `reportHash` (pre-R94) is also counted in `resumedLegacy`.

### 2.4 Fail-closed on a ledger that no longer has one answer

`Read-Manifest` returns `@{byKey; conflicts; damaged; reason}` and never swallows a line.
Both a truncated line and **two `ok` records that disagree** about identity or report content
set `damaged`, which stops the run, leaves the original file untouched, and reports
`INVALID`. A conflict is the same class of defect as a truncated line: the ledger has lost
its single authoritative answer, so a case-level quarantine would be too weak.

`Move-ToQuarantine` **copies**; it never moves or deletes. The original evidence stays
byte-identical and the quarantine is an audit record plus a block on reuse.

### 2.5 Containment, locking, and orphan reports

- **Reparse-point refusal.** `Test-ReparsePointInPath` walks each real component between the
  repository root and the output root and refuses if any is a reparse point (junction or
  symlink). Exit code 2, before anything is created.
- **Single-instance lock.** `[System.IO.File]::Open(..., CreateNew, ...)` is the atomic
  test-and-set. A lock whose owning PID is gone is **stale** — exactly the crash this
  contract recovers from — so it is taken over with a recorded notice. The lock is acquired
  *after* the authorization gate and suite validation, so a refused run creates no directory.
- **`AdoptOrphanReport` requires the explicit switch.** A report with no manifest record is
  quarantined by default; only the explicit operator flag adopts it, and adoption is offline.

### 2.6 Exit codes

`0` OK · `1` FAILED · `2` CONFIG · `3` REFUSED · `4` PARTIAL.

## 3. RED → GREEN

### RED (before implementation)

`pwsh -NoProfile -File scripts/benchmark/selfcheck-r94-runner.ps1`:

```
R94 SELF-CHECK FAILED: 26 assertion(s)
[exit code: 1]
```

Failure modes were the intended ones: no durable state file existed; a changed case was
still `SKIP`ped as `identity verified`; tampered reports were still reused; a truncated
manifest produced `status='COMPLETE'`; `outcome_unknown` never appeared; a second runner
against a held lock got exit 0; and a legacy record was not labelled.

### GREEN (after implementation)

```
R94 SELF-CHECK PASSED (0 provider calls, 0 network, 0 cost)
106 PASS, 0 FAIL, 0 SKIP
[exit code: 0]
```

The 106 assertions span 16 sections: §0 durable state, §1 finding B (unchanged still SKIPs /
edited case does not / model change), §2 report content hashing for `success`,
`output_tokens` and `termination_reason`, §3 truncated manifest, §4 crash after start, §5 the
six termination points, §5b runner-killed mid-case (offline re-registration, unsubstantiated
→ UNKNOWN, changed-source → UNKNOWN), §6 crash after the request marker, §7 single-instance
lock, §8 legacy records, §8b conflicting records, §8c orphan reports, §8d junction escape,
§8e LimitCases, §9 pinned historical hashes, §10 secret/endpoint leaks.

## 4. Non-vacuity — every guard mutation-tested

A gate that asserts "the runner refuses" can be satisfied by a runner that refuses
everything, so each guard was disabled in turn and the gate had to fail. All mutations were
applied to `run-campaign.ps1` and the file was restored byte-identically afterwards
(verified by sha256 against a pre-mutation backup).

| Mutation | Result |
|---|---|
| `if ($reparse)` → `if ($false -and $reparse)` | **3 failures** in §8d — the link was followed and `out/` was written outside the repository |
| conflict no longer sets `$damaged = $true` | **1 failure** in §8b — status `PARTIAL` instead of `INVALID` |
| `$substantiated = ... -and $reportOk -and ...` → drop `$reportOk` | **2 failures** in §5b-ii — an attempt with no durable report was re-registered `completed` |
| `($stored.currentPlanDigest -eq $dig.digest)` → `($true)` | **3 failures** in §5b-iii — a changed case source was re-registered `completed` |

The fourth mutation initially **escaped**: §5b-ii has no report at all, so the `$reportOk`
conjunct rejected it for the wrong reason and the digest binding was never exercised. That
is a real gap in the gate, not a false alarm, so §5b-iii was added — report durable, every
other conjunct satisfied, only the case source changed. The mutation is now caught, which is
what makes the digest binding load-bearing rather than decorative.

The `while ($true)` at line 433 of `run-campaign.ps1` is the lock retry loop and is
unrelated to the mutations.

## 5. Verification

| Command | Result |
|---|---|
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-r94-runner.ps1` | **106 passed**, exit 0 |
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-r89-runner.ps1` | **61 passed**, exit 0 (unchanged contract) |
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-campaign-runner.ps1` | **47 passed**, exit 0 (unchanged contract) |
| `pnpm typecheck` | exit 0 |
| `pnpm docs:verify` | exit 0 (`ALL CHECKS PASS`) |
| `git diff --check` | exit 0 (no whitespace errors) |

### 5.1 The dirty-tree precondition

`plan(20260917-083737).md` §1 line 46 requires that when the pre-existing clean-tree guard
fires because of a dirty working tree, that is recorded as an **environment precondition**
and re-verified in an isolated clean checkout — never resolved by stashing or deleting the
user's files.

The working tree carries two user-owned files that this work must not touch:
`plan(20260917-001821).md` (deleted by the user) and `plan(20260917-083737).md` (untracked,
the authoritative plan). They were left exactly as found. R93's report §6.1 records the
isolated clean-checkout re-verification that separates this precondition from a real failure
(`342 files, 6295 passed | 3 skipped`, exit 0). The R94 changes are confined to
`scripts/benchmark/**`, `.github/workflows/ci.yml` and `docs/**`, none of which the clean-tree
guard inspects.

## 6. CI wiring

`.github/workflows/ci.yml` gains one step, placed before the R89 contract step:

```yaml
- name: Campaign runner interruption-recovery contract (E4-R94)
  shell: pwsh
  run: |
    pwsh -NoProfile -File scripts/benchmark/selfcheck-r94-runner.ps1
    if ($LASTEXITCODE -ne 0) { throw "E4-R94 self-check failed ($LASTEXITCODE)" }
```

It runs on **both** OSes, matching R89. The gate was written for that: no `-WindowStyle`
(a Windows-only parameter), `$env:TEMP` falls back to `$env:TMPDIR` then `/tmp`, and §8d
tries `Junction` then `SymbolicLink`, reporting `SKIP` — not a failure — if a platform can
create neither. The R84 self-check stays Windows-only because it drives the PowerShell
runner's real campaign path.

## 7. Honest limits

- **The fake CLI proves control flow, not model behaviour.** Every assertion here is about
  the runner's bookkeeping. Nothing in this report is evidence that a real campaign produces
  correct results.
- **Atomicity is same-volume only.** Temp-file + rename is atomic on NTFS and POSIX; across a
  network share it is not, and no exactly-once claim is made.
- **The lock is advisory and PID-based.** It defends against two local runners. A PID reused
  by an unrelated process after a crash would make a stale lock look live; the recovery path
  then waits rather than corrupting, which is the safe direction but not a liveness guarantee.
- **`sourceSha` can be `"unknown"`** outside a git checkout, which weakens the identity to
  content + configuration.
- **The reparse-point walk is best-effort.** It refuses a link it can see; it does not defend
  against a link created between the check and the write (TOCTOU), which would require
  handle-based directory APIs.
- **`outcome_unknown` is terminal for automation.** Clearing it needs an explicit operator
  decision. That is deliberate — the alternative is silently re-billing — but it means an
  interrupted campaign cannot finish unattended.
- **Findings D/E (R95), F (R97) and G (R96) are untouched.** R92's `r92AuthorizationGate` is
  still not wired into the generic `agent benchmark` path.

## 8. Files

| File | Change |
|---|---|
| `scripts/benchmark/run-campaign.ps1` | rewritten state machine, atomic attempt state, re-observed resume, full-report validation, damaged-ledger fail-closed, single-instance lock, reparse-point refusal (~604 lines changed) |
| `scripts/benchmark/selfcheck-r94-runner.ps1` | **new**, 690 lines, 106 assertions, drives the real runner through the fake CLI |
| `scripts/benchmark/fixtures/r89-fake-cli.mjs` | content-derived `dirDigest()`; `FAKE_CLI_CRASH` (`after-start`/`after-request`/`after-report`/`before-completion`); `FAKE_CLI_SLOW_MS`; `FAKE_CLI_SLOW_AFTER_REPORT_MS`; `FAKE_CLI_HANG=before-report`; `FAKE_CLI_PID_FILE` |
| `.github/workflows/ci.yml` | +13 lines, the R94 step |

### Historical evidence, byte-identical

| File | sha256 |
|---|---|
| `docs/evidence/e4-r87-phase-a-manifest.json` | `cfecb47172c3d3bb3d4e529985acb902c8babcd44711e6854153aa354ce967e1` |
| `docs/evidence/e4-r88-phase-a-manifest.json` | `d3bd5a1d90225a3bd88f1c9ea10f79d371118244bcd3f116856bb9fb0912ec69` |
| `docs/evidence/e4-r85-failure-taxonomy.json` | `861557f093fdaac69df56e08c1ac900e1e2462e09fd241d6b78a33bbde3454e8` |

Asserted by §9 of the gate on every run. The real R83 campaign data at
`D:\Harness Agent\.ci\bench-grok\` was not read or modified.

### Upgrade policy

No automatic migration. A pre-R89 record stays LEGACY and a pre-R94 record keeps its
identity-verified-but-not-hash-bound status; both are counted in `resumedLegacy` so a report
can never present unverifiable reuse as verified evidence. Promoting either requires an
explicit operator decision (`-AdoptOrphanReport` for an orphan report), never a silent path.
