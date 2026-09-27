# E4 / N1 — two real frozen arm builds that execute the real harness

Plan: `plan(20260926-175819).md` §N1 (line 33); 怎么做 at 39–43; 验收 at line 45.
Baseline HEAD before this round: `a89f5a8183eb4bfc6ed554a065a9821c51a5a135` (N0–N7 landed).
Commit this round: `1d3f33717c501a7e86201f779a025aae3bc2ec08` (acceptance-summary identity fix),
then the documentation commit carrying this report (`git log -1 -- docs/evidence/E4-N1-report.md`).
Platform: Windows 10 / PowerShell 7, Node `v24.14.0`. Rules: no key, no paid endpoint, no promotion; unknown = `NOT_OBSERVED`/`null`, never `0`.

## 1. Labels

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N1.1 | Two **real** frozen arm builds from two **distinct existing** source SHAs | **PASS** (Windows, local) | `r97-observe-arms.mjs` created a detached worktree per SHA, installed and built each: baseline `1f3df072f6b03b9beb1e695662ba7b563dc4ff0b`, candidate `a89f5a8183eb4bfc6ed554a065a9821c51a5a135`; each worktree clean (`dirty=0`), distinct build-closure digests |
| N1.2 | Both arm entries export the worker ABI (`runOneCase` + versioned probe) | **PASS** | built `apps/cli/dist/benchmark-command.js` in **both** arms contains `runOneCase` ×7 and `R97_ARM_PROBE` ×3 |
| N1.3 | The real harness runs **from each arm's own build** | **PASS** | acceptance `executionMode=arm-worker`, `workerUnits=16`, one ledger attempt per arm per case |
| N1.4 | At least one valid offline case completes harness → tools → verifier → artifact | **PARTIAL** | 16 units measured, `verifiedPasses=6`, but `strongPasses=0` / `weakPasses=6` — the chain completed through the real verifier, **no case was strongly verified** |
| N1.5 | The repository's **configured** frozen pair is legal | **BLOCKED: NO_REAL_ARM_PAIR** | measured: `e9776ba` and `a203737` export `runOneCase` ×**0** and reference the probe ×**0** |
| N1.6 | Default SHAs re-pinned + re-preregistered as the plan directs | **NOT DONE** | the legal pair exists only as an explicit `--baseline/--candidate` argument; the defaults and the tests that hardcode them are untouched (§9.1) |
| N1.7 | Arm identity in the acceptance summary is what actually ran | **RED → GREEN** | **new defect found and fixed this round** (§5) |
| N1.8 | Duplicate/resumed campaign is refused rather than re-granted | **PASS** | re-running the acceptance into the same output dir: `[4/6] run FAILED status=REFUSED`, exit 1 |
| N1.9 | Negative control: scrambled ABI ⇒ 0 factory calls + explicit refusal | **PARTIAL** | `R100 NEGATIVE CONTROL` passed (a case missing from an arm is `NOT_READY`, never borrowed); the "swap a checkout / scramble the ABI" variant with `providerFactoryCalls=0` was **not** run |
| N1.10 | Ubuntu | **NOT_PROVEN** | Windows-only measurement |
| N1.11 | Paid run / promotion | **NOT_RUN** | `paidStatus=PAID_NOT_RUN`, `promotable=false` |

## 2. The decisive ABI measurement

The earlier claim that `e9776ba`/`a203737` "lack the ABI" was re-measured directly, and the ABI's
introduction point was located:

| Revision | `benchmark-command.ts`: `runOneCase` exports | probe references |
|---|---|---|
| `e9776ba` (configured baseline) | **0** | **0** |
| `a203737` (configured candidate) | **0** | **0** |
| `1f3df072` (`E4-N0/N1/N2 … shipped arm probe`) | present | present |
| `a89f5a81` (HEAD) | **2** | **3** |

So the repository's configured pair is **structurally incapable** of running the worker: the ABI does
not exist at either SHA. That is the measured `NO_REAL_ARM_PAIR` for the configured path, and it is why
N1.5 stays BLOCKED even though N1.1 passed.

## 3. The two real builds

| | baseline | candidate |
|---|---|---|
| source SHA | `1f3df072f6b03b9beb1e695662ba7b563dc4ff0b` | `a89f5a8183eb4bfc6ed554a065a9821c51a5a135` |
| worktree HEAD | `1f3df072…` | `a89f5a81…` |
| uncommitted entries | `0` | `0` |
| build-closure digest | `998cfba2a92e15ad6ae0be45ccb072eb0eb5f5fdbeeb2b91157f57110a2dac86` | `6bdb2ce094a70c55e4ea052941f684e8a12999282454d93c8b52d9434559e364` |
| `benchmark-command.js` sha256 | `4a11bcc1d8b76ab5…` (166182 B) | `4a11bcc1d8b76ab5…` (166182 B) |
| `runOneCase` / probe refs | 7 / 3 | 7 / 3 |

**Distinct SHAs and distinct closure digests — but the 5 declared closure entries are byte-identical
across the two arms** (including the entry bundle). The closure digest differs because the digest covers
the import closure **derived** from those entries, and the built trees do differ: `packages/evaluation/dist`
has 36 differing files and `apps/cli/dist` has 27 (e.g. `prereg-arm-executor.js`, plus test files).
**Limit:** I did not enumerate which of those differing files fall inside the derived closure, so the
*substantive* size of the mechanism difference between these two arms is not established (§9.4). What is
established is that they are two real, distinct, clean checkouts that each build and each export the ABI.

## 4. Real acceptance over the two real builds

`status=OFFLINE_ACCEPTED`, `ok=true`, all five steps OK (`observe`/`plan`/`run`/`validate`/`summarize`):

| Observable | Value |
|---|---|
| `campaign.logicalCalls` | `42` |
| `campaign.providerRequests` | **`0`** |
| `campaign.measuredUnits` / `workerUnits` | `16` / `16` |
| `campaign.executionMode` | `arm-worker` |
| `campaign.verifiedPasses` | `6` |
| `campaign.strongPasses` / `weakPasses` | **`0`** / `6` |
| `campaign.skippedUnits` | `0` |
| ledger attempts | 1 per arm per case, 8 cases × 2 arms |
| `externalProviderCalls` | **`0`** |
| `paidStatus` / `promotable` | `PAID_NOT_RUN` / `false` |
| `realTwoVersionExperimentRan` | `false` |
| `costUsdMicros` | `NOT_OBSERVED` (nothing billed) |

The offline scripted provider solved nothing strongly: every pass is a **weak** pass. The real chain
(arm worker → tools → verifier → artifact) demonstrably executes per arm, but N1's "at least one valid
offline case" is met only weakly, and that is reported as PARTIAL rather than PASS.

## 5. New defect found and fixed: the summary named revisions that never ran

`acceptance-summary.json` reported `baselineSha`/`candidateSha` from the caller's
`--baseline`/`--candidate` options, which fall back to `DEFAULT_BASELINE_SHA`/`DEFAULT_CANDIDATE_SHA`.
Whenever the arms are supplied as **directories** — the normal path once a pair has been prepared — those
options are absent, so a genuine campaign over `1f3df072`/`a89f5a81` printed `e9776ba`/`a203737`.

**RED (measured, preserved as `.ci/n1/acceptance-summary.RED.json`):** observation `1f3df072`/`a89f5a81`
vs summary `e9776ba`/`a203737` — the summary contradicted this run's own `observation-summary.json`, and
a reviewer recomputing identity from it would have read revisions that never executed. This is precisely
the "all arm run results must be reviewable" requirement of plan line 45 failing.

**Fix (`1d3f3371`):** identity is read from the artifact **this run's own observe step wrote**; the
caller's declaration is preserved separately as `declaredBaselineSha`/`declaredCandidateSha` so a
declaration/measurement mismatch stays visible instead of being overwritten. When no observation exists
(an early failure) the fields are `null` = UNKNOWN, never a default constant.

**GREEN (measured after):** `summary == observation == 1f3df072…/a89f5a81…`, `IDENTITY_BOUND_TO_OBSERVATION = true`.

An intermediate edit of mine introduced a `ReferenceError` (`observations` is not bound inside `finish()`);
that is visible in the round's own log and was corrected before the GREEN run — reported here rather than
hidden, because the first "after" attempt left the **stale** pre-fix summary on disk, which is exactly why
the fix is verified by re-reading the artifact rather than by trusting the edit.

## 6. Duplicate-run protection (measured)

Re-running the acceptance into the **same** output dir refused: `[4/6] run FAILED status=REFUSED`, exit 1.
The campaign does not silently re-grant allowance or re-run over an existing campaign. A fresh output dir
succeeded (`exit 0`).

## 7. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `node scripts/e4/r97-observe-arms.mjs --root %TEMP%\r97-arms-n1 --baseline 1f3df072… --candidate a89f5a81…` | `0` | `baseline ready … \baseline\apps\cli\dist\main.js`, `candidate ready …` |
| `node scripts/e4/r97-closed-loop.mjs --acceptance --arms-root … --out .ci/n1` | `0` | `[2/5] acceptance OK status=OFFLINE_ACCEPTED passes=6/16` |
| same, **same output dir again** | `1` | `[4/6] run FAILED status=REFUSED` (duplicate campaign) |
| `node scripts/e4/r97-closed-loop.mjs --acceptance --arms-root … --out .ci/n1b` (after fix) | `0` | identity bound to observation |
| `pnpm exec vitest run packages/evaluation/src/r97-driver-closed-loop.test.ts -t D6` | `1` | **expected**: D6 hardcodes the default SHAs (`expect(…sourceSha).toBe("e9776ba…")`) and the arms were the new pair. `✓ the two real arm builds MUST exist` and `✓ R100 NEGATIVE CONTROL` passed |
| `pnpm test` | `1` | `Tests 22 failed | 7096 passed | 3 skipped (7121)`; FAIL-set diff vs `.ci/n0/n7-full.log` **empty in both directions** |

## 8. Windows / Ubuntu

- **Windows: MEASURED.** Every command above ran here.
- **Ubuntu: NOT_PROVEN.** The CI `r97-r98-closed-loop` job is matrixed over both platforms, but no
  runner executed it from this checkout in this round.
- The arms were built by the same platform-neutral Node mechanism CI uses, so the workflow needs no
  platform branch — that is an argument, not a measurement.

## 9. Residual limits

1. **The default pair is still the illegal one.** `DEFAULT_BASELINE_SHA`/`DEFAULT_CANDIDATE_SHA` remain
   `e9776ba`/`a203737`, and `r97-driver-closed-loop.test.ts` hardcodes them at lines 1683–1684 (D6) and
   1775–1776 (R101). The legal pair therefore exists only as an explicit argument. Re-pinning it plus a
   re-prereg is the plan's own remedy (line 37) and a cross-file change (defaults + D6 + R101 + the CI
   job's arm env) that this round did not make. Until it is made, the configured path stays
   `BLOCKED: NO_REAL_ARM_PAIR` and CI's closed-loop job still prepares ABI-less arms — I did **not**
   measure whether that job currently passes or fails, so its status is unproven either way.
2. **`strongPasses=0`.** The real chain runs, but no case is strongly verified offline. N1's "at least one
   valid offline case" is therefore PARTIAL, and a stronger case (or a real model) is needed to close it.
3. **The pair is not a controlled single-mechanism experiment.** `1f3df072` differs from HEAD by the whole
   N0–N1/N4/N5/N6/N7 stack, not by one mechanism. Plan line 41 asks for the expected single mechanism
   difference plus equivalence of everything else to be recorded; that is not satisfied by this pair.
4. **The declared entries are byte-identical**; the closure digest difference was not decomposed into the
   specific files inside the closure.
5. **`treeFingerprint` is `null`** in the observation, so tree-level identity rests on `sourceSha` + the
   build-closure digest.
6. **N1.9's negative control is partial** — the missing-case variant passed; the swapped-checkout/scrambled-ABI
   variant asserting `providerFactoryCalls=0` was not run.
7. `realTwoVersionExperimentRan=false` and `promotable=false` are the honest scope fields: this is an
   offline plumbing proof, not a promotable experiment.

## 10. Reproduction

```powershell
$base = (git rev-parse 1f3df072).Trim(); $cand = (git rev-parse HEAD).Trim()
node scripts/e4/r97-observe-arms.mjs --root "$env:TEMP\r97-arms-n1" --baseline $base --candidate $cand
$env:R97_ARM_BASELINE_DIR="$env:TEMP\r97-arms-n1\baseline"
$env:R97_ARM_CANDIDATE_DIR="$env:TEMP\r97-arms-n1\candidate"
node scripts/e4/r97-closed-loop.mjs --acceptance --arms-root "$env:TEMP\r97-arms-n1" --out .ci\n1b
# identity: .ci\n1b\acceptance\acceptance-summary.json baselineSha/candidateSha
#           must equal .ci\n1b\acceptance\observation-summary.json arms.*.sourceSha
```

Artifacts (all gitignored under `.ci/`): `.ci/n1/acceptance-summary.RED.json` (the RED), `.ci/n1b/acceptance/`
(the GREEN), `.ci/n1/d6-real-arms.log`, `.ci/n1/observe-arms.log`, `.ci/n1/1-full.log`.
