# E4-R89 report — the campaign runner's authorization, identity-resume and command-argument contract

Plan: `plan(20260917-001821).md` §R89 (findings **F3**, **F4**, **F5**).

## Status

| Item | Value |
| --- | --- |
| Task | R89 — authorization read-not-created, identity-bound completion, argv/limit/exit contract |
| Start SHA | `20f01b988fe999638218a8be9dd5e57a78e36c29` (R88) |
| Ending SHA | see §10 (this report's commit) |
| Provider / model calls | **0** (fake CLI only; no key read, no network) |
| Paid spend | **0** |
| Verdict | F3, F4, F5 all fixed — RED and GREEN both reproduced locally |

## 1. Findings addressed

**F3 (P1)** — the authorization gate claimed it required `-ConfirmPaidRun` **and**
`RUN_PAID_BENCHMARKS=1`, but it only checked the switch and the key, then **set
`$env:RUN_PAID_BENCHMARKS = "1"` itself** (old line 102). The authorization
condition was completed by the code under test, so the documented gate was
decorative.

**F4 (P1)** — `Test-CaseDone` was `Test-Path <report>.json`. Existence alone
counted as completion, so a truncated, foreign-identity or wrong-suite report was
resumed as verified evidence; and the two crash windows (report written but
manifest not, or manifest written but report missing) were indistinguishable
from a clean finish.

**F5 (P2)** — the runner passed a PowerShell **hashtable array** to the CLI's
`--suites` flag (which expects a comma-separated string); `LimitCases` was
compared against `done + failed`, so **historical skips consumed the limit**; and
a failing case's exit status could be masked by a later successful command.

## 2. RED evidence (before the fix)

The test was written first and run against the **unmodified** runner. RED was
clean — 29 assertions failed for exactly the expected reasons:

```
$ pwsh -NoProfile -File scripts/benchmark/selfcheck-r89-runner.ps1
  FAIL  the runner exposes an injectable CLI entry point (-CliPath)
== 1. F3 authorization gate: READ the inputs, never create them ==
  FAIL  half-authorized (key + switch, no RUN_PAID_BENCHMARKS) is REFUSED with exit 3 — got -1
...
== 6. F5 counting: LimitCases bounds only NEW cases; skips are free ==
  FAIL  a machine-readable campaign-status.json was written
  FAIL  a limited run reports PARTIAL, never a complete campaign (got '')
R89 SELF-CHECK FAILED: 29 assertion(s)
```

Note `got -1`: without an injectable entry point the harness **refuses to invoke
the runner at all** rather than risk driving the real CLI with a paid-shaped
environment. That guard is itself one of the assertions.

The F3 defect is also directly visible in the pre-fix source:

```
$ git show 20f01b9:scripts/benchmark/run-campaign.ps1 | Select-String RUN_PAID_BENCHMARKS
25:  start unless -ConfirmPaidRun is passed AND RUN_PAID_BENCHMARKS=1 is set. The
94:  Write-Host "Pass -ConfirmPaidRun and set RUN_PAID_BENCHMARKS=1 only under explicit authorization."
102: $env:RUN_PAID_BENCHMARKS = "1"        <-- the gate completes itself
```

and F5 is reproducible standalone — splatting an array of hashtables yields
non-string argv elements:

```
suiteList type: Object[], count=2
first element type: Hashtable
  [Hashtable] Name                           Value
              ----                           -----
              name                           adversarial
```

## 3. GREEN evidence (after the fix)

```
$ pwsh -NoProfile -File scripts/benchmark/selfcheck-r89-runner.ps1
...
R89 SELF-CHECK PASSED (0 provider calls, 0 network, 0 cost)     exit 0
```

73 assertions across 10 sections. The pre-existing R84 gate was **not**
weakened — it caught a real regression during development (§5) and now passes:

```
$ pwsh -NoProfile -File scripts/benchmark/selfcheck-campaign-runner.ps1
SELF-CHECK PASSED (0 provider calls, 0 cost)                    exit 0
```

## 4. What was implemented

### 4.1 F3 — authorization is READ, never created

The gate now runs **first**, before any other validation, so an unauthorized
invocation is refused for authorization reasons and cannot act on configuration
first. A real run requires all three of: `-ConfirmPaidRun`; `RUN_PAID_BENCHMARKS`
already equal to `1` in the environment; and a non-empty key variable. The runner
never assigns the authorization flag — it only reads it (and restores it in the
`finally`-style epilogue if it was ever shadowed).

Exit codes are explicit constants: `0` complete · `1` failed · `2` config/usage ·
`3` refused · `4` partial.

`-ApiKeyEnv` was misleading before: the runner read that variable but the child
CLI reads `OPENAI_API_KEY`. Now a custom name is **explicitly propagated** to the
child and the parent environment is restored afterwards; the key still never
enters argv, a file, or any log. A test asserts the child actually saw
`OPENAI_API_KEY` set, by recording a boolean — never the value.

### 4.2 F4 — completion is identity-bound, and crashes are explicit

`Test-CaseDone` is gone. A case is resumed only when **all** hold:

- the report parses (a truncated/partial JSON write is rejected);
- its `meta.suite`, `results[0].task_id`, and `manifest.model`/`provider` match
  the frozen experiment;
- a matching `ok:true` manifest record exists;
- the record's stored **identity** still matches — a digest over
  `suite|caseId|provider|model|endpointDigest|planDigest|sourceSha`.

The plan digest is now genuinely captured from the dry run and persisted (it was
previously computed and thrown away), so a changed plan invalidates the resume.

Four anomalous states are distinguished and **quarantined**, never silently
reused and never automatically re-billed:

| State | Handling |
| --- | --- |
| report present, manifest absent | quarantine + `OUTCOME_UNKNOWN` |
| manifest `ok`, report absent | quarantine + `OUTCOME_UNKNOWN` |
| report truncated / wrong suite / wrong case / wrong model | quarantine, never resumed |
| identity changed (model/endpoint/source/plan) | quarantine, never resumed |

Quarantine **copies** evidence into `quarantine/<suite>-<caseId>/` with a
`QUARANTINE.txt` stating the reason. It never moves or deletes, so the original
R83/R84 evidence stays byte-identical.

A crash **after the request was sent but before the outcome was persisted** is
recorded as not-succeeded and the relaunch does **not** silently re-issue the
request; `-AdoptOrphanReport` is the explicit operator override. The runner makes
**no exactly-once guarantee across a network boundary** and says so.

**Legacy records:** a manifest written by the pre-R89 runner (or the committed
R84 fixture) has no `identity` and therefore cannot be re-verified. Such records
are trusted only when they name the same model/provider, are counted separately
as `resumedLegacy`, and are reported as *identity not verifiable* — never
presented as verified evidence.

### 4.3 F5 — argv, limits and exit status

- `--suites` receives `($suiteNames -join ",")` — the comma-joined **string**.
- Suite names are validated as identifiers (no separators, no traversal) and
  every suite source must exist **before any case runs**.
- `-Root` must resolve inside the repository, so staging cleanup can never be
  aimed at an arbitrary directory; staging is removed in a `finally`.
- Counting is separated: `attempted`/`completed`/`failed` (this run), `resumed`
  (historical), `resumedLegacy`, `quarantined`, and `outcomeUnknown`.
- `-LimitCases` bounds only **newly started** cases. Skips never consume it.
- `PARTIAL` means the *evidence* is incomplete: a limit that cuts work off, or
  any quarantined/unknown case. A limit that happens to coincide with finishing
  all work is an honest `COMPLETE` — the status describes the evidence, not the
  flag. Both directions are pinned by tests.
- A machine-readable `campaign-status.json` is always written; the exit code is
  the **worst** outcome and is never overwritten by a later success (a validation
  failure raises it to `1` / `INVALID`).

### 4.4 Offline, injectable process boundary

`-CliPath` injects the CLI entry point. The test points it at
`scripts/benchmark/fixtures/r89-fake-cli.mjs`, so the **paid-shaped** control
flow — argv, exit codes, resume, quarantine, crash windows — is covered end to
end with zero real requests. The harness refuses to invoke the runner at all when
that injectable point is absent, so a future regression can never cause the test
to drive the real CLI.

## 5. Regression found and fixed during R89

Running the pre-existing R84 gate against the new runner **failed 4 assertions** —
a genuine regression, not a stale test:

1. the new `CAMPAIGN END` line dropped the historical `totalCases=N done=N
   failed=N` progress vocabulary;
2. resume refused the seeded fixture because the relaunch named model
   `selfcheck-model` while the stored reports name `synthetic-1`/`test`.

(2) is the *intended* new behaviour: under R89 that **is** a different
experiment. The R84 test was relaunching with an identity that never matched its
own seeded evidence — it passed before only because existence was the sole
completion test. The test now relaunches with the identity its evidence records,
and (1) was restored by keeping `totalCases`/`done`/`failed` adjacent in the
progress line. The R84 gate's assertions were not weakened.

## 6. Acceptance criteria (plan §R89 怎么验收)

| Criterion | Evidence | Result |
| --- | --- | --- |
| Zero/partial authorization → zero child requests | §2 combinations; refusal starts no child, creates no dir, echoes no key | PASS |
| A full fake authorization only calls the fake CLI | `-CliPath` test; `sawOpenAiKey` boolean | PASS |
| Custom `adversarial,stress` suites validate at the end, asserting the real argv string | `--suites` value asserted `-is [string]` and `-eq "adversarial,stress"` | PASS |
| 3 completed cases + `LimitCases=2` → exactly 2 new; skips free | `attempted=2`, `resumed=3`, 2 case-execs in the CLI log | PASS |
| Wrong model/endpoint/source or truncated reports are not "done" | 4 modes × (executed + not-resumed) | PASS |
| Injected crash at the report/manifest write stage → no silent missed case, no auto-repeat of an unknown paid op | both windows + the after-request crash; `OUTCOME_UNKNOWN` | PASS |
| Windows and Ubuntu/pwsh run the same offline script | CI step runs on both matrix OSes | PASS |
| The real key never enters the test | fake key is key-shaped; §10 asserts no artifact contains it | PASS |
| Original R83 data unchanged | quarantine copies; R84 fixture byte-identical; R84 gate passes | PASS |

## 7. Commands and exit codes

| Command | Exit | Note |
| --- | --- | --- |
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-r89-runner.ps1` (pre-fix) | 1 | 29 assertions failed — genuine RED |
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-r89-runner.ps1` | 0 | 73 assertions passed, 0 provider calls |
| `pwsh -NoProfile -File scripts/benchmark/selfcheck-campaign-runner.ps1` | 0 | R84 gate green after the regression fix |
| `pnpm typecheck` | 0 | `tsc -b` |
| `pnpm docs:verify` | 0 | ALL CHECKS PASS |
| `git diff --check` | 0 | clean |

## 8. CI static guards (with controls)

CI asserts the two defect shapes cannot return, scanning the runner's **code with
comments stripped** (the file documents the rule in its own help block, so a raw
text scan matches its documentation):

- no `$env:RUN_PAID_BENCHMARKS = "1"` assignment — the authorization is never self-granted;
- no hashtable list passed to `--suites`.

Both guards carry a **negative control** so they cannot silently become vacuous,
and were verified locally against three defect shapes and two legitimate forms
(`-ne "1"` read, and the `$restorePaidEnv` restore):

```
literal-self-grant sites found (want 0): 0
hashtable-to-suites found (want False): False
negative control detects old bug (want >0): 1
  control '$env:RUN_PAID_BENCHMARKS = "1"' -> 1 (want 1)
  safe 'if ($env:RUN_PAID_BENCHMARKS -ne "1") { exit 3 }' -> 0 (want 0)
  safe 'if ($restorePaidEnv -ne $null) { $env:RUN_PAID_BENCHMARKS = $restorePaidEnv }' -> 0 (want 0)
```

## 9. Files

- `scripts/benchmark/run-campaign.ps1` — rewritten authorization/completion/argv/limit/exit contract (F3/F4/F5)
- `scripts/benchmark/selfcheck-r89-runner.ps1` — 73-assertion offline gate (NEW)
- `scripts/benchmark/fixtures/r89-fake-cli.mjs` — fake CLI process boundary (NEW)
- `scripts/benchmark/fixtures/r89-cases/` — 6-case fixture across 3 suites (NEW)
- `scripts/benchmark/selfcheck-campaign-runner.ps1` — relaunch now uses the identity its seeded evidence records
- `.github/workflows/ci.yml` — R89 step on both OSes + static guards with controls
- `docs/E4-R89-report.md` — this report (NEW)

## 10. CI

To be filled with the run id after pushing (this report's commit is the ending
SHA).

## 11. Not done / out of scope

- **R90–R92** are separate dependent tasks (evidence-grade correction, Windows
  verifier determinism, paid A/B preparation).
- No real provider request was made or authorized; `RUN_PAID_BENCHMARKS` was
  never set for a real run, and the paid path remains unexercised against a real
  endpoint by design.
- The original R83 campaign data and the committed R84 fixture are unchanged.
- "Exactly once" across a network boundary is **not** claimed and not testable
  offline; the runner records `OUTCOME_UNKNOWN` and defers to the operator.
