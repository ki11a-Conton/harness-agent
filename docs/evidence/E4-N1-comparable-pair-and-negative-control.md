# E4 / N1 (rounds 12–14) — the comparable-pair question and the ABI negative control

Plan: `plan(20260926-175819).md` §N1 (line 33); 怎么做 3 at line 43; 验收 at line 45.
Base HEAD when this work began: `d0eed2d789edfb8cbde1bde017d743e2b7d54445`; current HEAD `3c3a9d70abe4be6752379b9785fe4e03fa51e4ae`.
Platform: Windows 10 / PowerShell 7, Node `v24.14.0`. Zero provider requests; no key; no paid path.

## 1. Labels

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N1.5 | A legal **comparable** arm pair exists in this repository | **BLOCKED: NO_REAL_ARM_PAIR** | measured across 18 revisions: every ABI-bearing revision differs from HEAD by the whole N3–N7 stack; no pair differs only in the arm mechanism (§2) |
| N1.9 | Negative control: scramble the ABI ⇒ explicit refusal with 0 factory calls / 0 physical requests | **NOT PASSED — open finding** | 0 requests observed, but the acceptance stayed green; the control's own assertion did not hold (§3) |
| N1.12 | The arm's build closure covers its own entry and is re-derived from the arm's tree | **PASS** | scrambling the entry moved the recorded `buildDigest` `6bdb2ce0…` → `fbb11ef8…`; closure covers `apps/cli/dist/benchmark-command.js` (360 files) |
| N1.13 | The control leaves the arm byte-exactly as it found it | **PASS** | entry sha256 restored to `4a11bcc1d8b76ab5…` (166182 B) |
| N1.14 | Ubuntu | **NOT_PROVEN** | Windows-only measurement |

## 2. There is no legal comparable pair (systematic, not anecdotal)

The round-11 result showed the **configured** pair is illegal (`e9776ba` / `a203737`: `runOneCase` exports
**0**, probe references **0**). This round asked the stronger question the plan actually poses: is there a
pair that is both legal **and comparable** — differing only in the mechanism under test?

Measured across 18 revisions from HEAD down to `a2c65e44`, every one has the ABI (`YES`) and every one
differs from HEAD across the whole infrastructure stack, e.g.:

| revision | ABI | files vs HEAD | areas changed |
|---|---|---|---|
| `a89f5a81` | YES | 4 | docs/evidence:3 scripts/e4:1 |
| `42ea342d` | YES | 17 | .github/workflows:1 apps/cli:3 docs/evidence:9 packages/evaluation:2 scripts/e4:2 |
| `a142f666` | YES | 25 | .github/workflows:1 apps/cli:5 docs/evidence:10 packages/evaluation:6 scripts/e4:3 |
| `35eeb5f4` | YES | 29 | .github/workflows:1 apps/cli:8 docs/evidence:11 packages/evaluation:6 scripts/e4:3 |
| `a2c65e44` | YES | 31 | .github/workflows:1 apps/cli:8 docs/evidence:12 packages/evaluation:7 scripts/e4:3 |

**Conclusion:** the only ABI-bearing revisions are the N3–N7 infrastructure commits, so any pair of them
differs by a stack of unrelated changes — not by one mechanism with everything else equivalent, which is
what plan line 41 requires to be recorded. The ABI was introduced at `1f3df072`, *after* the mechanism
work, so no earlier revision can serve as a baseline either.

Per plan line 45 — "若找不到合法可比的两臂，明确 `BLOCKED: NO_REAL_ARM_PAIR`、本项不算 PASS，更不能转 N8" —
N1's acceptance is therefore **BLOCKED: NO_REAL_ARM_PAIR**. The real dual build of round 11 remains a
genuine plumbing proof (`PASS` for "two real distinct builds can execute the real harness"), but it is not
the legal comparable pair N1 asks for, and N1 is **not PASS**.

## 3. The ABI negative control (plan line 43) — did not pass

`scripts/e4/n1-abi-negative-control.mjs` implements the required control: back up the candidate arm's
`apps/cli/dist/benchmark-command.js`, rename all 7 `runOneCase` occurrences to `runOneCaseABIScrambled`,
run the full acceptance, restore byte-exactly, re-run the positive path, and assert.

**Measured:**

| Observable | SCRAMBLED | POSITIVE (restored) |
|---|---|---|
| entry sha256 | `505cdc94eed2e9d9…` | `4a11bcc1d8b76ab5…` (byte-exact restore ✓) |
| candidate `build.sourceSha` | `a89f5a8183eb4bfc6ed554a065a9821c51a5a135` | same |
| candidate `build.buildDigest` | **`fbb11ef89bb264cd927a10351175c7bfed6f831ebbec01770188ae04112dc9dd`** | **`6bdb2ce094a70c55e4ea052941f684e8a12999282454d93c8b52d9434559e364`** |
| acceptance `ok` / `status` | `true` / `OFFLINE_ACCEPTED` | `true` / `OFFLINE_ACCEPTED` |
| `providerRequests` / `externalProviderCalls` | `0` / `0` | `0` / `0` |
| `campaign` | `logicalCalls 42, measuredUnits 16, verifiedPasses 6, strong 0, weak 6` | **identical** |
| candidate unit `resultHash`es | 8 distinct, **different from positive** | 8 distinct |
| script verdict | `CONTROL FAIL` (exit `1`) | — |

**Two things this establishes, and one it does not.**

Established: the closure **does** cover the arm's own entry (360 covered files, including
`apps/cli/dist/benchmark-command.js`) and the digest **is** re-derived from the arm's own tree — scrambling
the bundle moved `buildDigest` from `6bdb2ce0…` to `fbb11ef8…`. That supports round 11's claim that the
arm's own build is what is identified and covered.

**Not established — and this is the finding:** the required observable was *not* produced. Renaming the
exported `runOneCase` binding did **not** make the harness refuse; the campaign still reported
`OFFLINE_ACCEPTED` with 16 measured units and 6 verifier passes. Either

- **(a)** the R98 acceptance execution path does not call `runOneCase` from that bundle — consistent with
  `scripts/e4/r97-arm-worker.mjs`, whose own header documents the arm being run as
  `node <checkoutDir>/apps/cli/dist/main.js benchmark …` and which exports
  `cliEntryOf(checkoutDir) => join(resolve(checkoutDir), "apps", "cli", "dist", "main.js")` (line 1461–1462);
  `main.js` (9349 B) is a **different** closure entry that this control did not scramble; or
- **(b)** the harness does not fail closed when an arm's ABI is scrambled, which would be a real defect.

I could not separate (a) from (b) within this round's budget, so the honest label is **NOT PASSED —
open finding**, not "the harness refuses". Reporting it as a pass would be exactly the vacuous
negative-control pattern the control exists to prevent.

**Concrete next experiment** (one run, offline): re-run the control scrambling **`apps/cli/dist/main.js`**
instead of — or in addition to — `benchmark-command.js`. If the verdict then flips to a refusal with
`providerRequests=0`, the root cause is (a) and the control must target the executed entry; if it still
stays green, the cause is (b) and N1 has uncovered a fail-open path that must be fixed before any paid run.

## 4. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `node scripts/e4/n1-abi-negative-control.mjs --arms-root %TEMP%\r97-arms-n1 --out .ci\n1nc` | **`1`** | `SCRAMBLED exit=0 ok=true status=OFFLINE_ACCEPTED providerRequests=0`; `restored sha256 = 4a11bcc1d8b76ab5 (byte-exact: true)`; `VERDICT: CONTROL FAIL` |
| `git diff --name-only <rev> HEAD` per revision (18 revisions) | `0` | drives the §2 table |
| `git show <rev>:apps/cli/src/benchmark-command.ts \| Select-String runOneCase` | `0` | `e9776ba`/`a203737` = 0 matches; `a89f5a81` = 2 |
| `computeExecutionIdentityV1({rootDir: <candidate arm>, …})` | `0` | `COVERED_FILES=360`; covers `apps/cli/dist/benchmark-command.js` |
| `pnpm exec vitest run packages/evaluation/src/r97-driver-closed-loop.test.ts -t D6` (round 11) | `1` | expected: D6 hardcodes `e9776ba`/`a203737` |

## 5. Windows / Ubuntu

Windows: measured. Ubuntu: **NOT_PROVEN** — no runner executed this from this checkout. The control and
the closure computation are platform-neutral Node/`git` calls with no platform branch.

## 6. Residual limits

1. **N1 is not PASS and cannot become PASS here.** No legal comparable pair exists in this history; the
   configured pair lacks the ABI outright. This is the plan's own `NO_REAL_ARM_PAIR` outcome.
2. **The negative control did not produce the required refusal.** Whether the executed entry is `main.js`
   or the harness fails open on a scrambled ABI is unresolved; the next experiment is named in §3.
3. **`strongPasses = 0`** in every acceptance run: the real chain executes but nothing is strongly
   verified offline, so "at least one valid offline case" stays PARTIAL.
4. **The default SHAs are still the ABI-less `e9776ba`/`a203737`**; `r97-driver-closed-loop.test.ts`
   hardcodes them at lines 1683–1684 (D6) and 1775–1776 (R101), and the CI closed-loop job prepares arms
   from them. Whether that job currently passes is unmeasured.
5. The two arms' 5 **declared** closure entries are byte-identical; the closure-digest difference was not
   decomposed into the specific covered files.
6. The control's backup lives in `.ci/` (gitignored); the script restores and verifies, but a hard kill
   between scramble and restore would leave the arm scrambled — re-running the observe/build step repairs
   it.

## 7. Reproduction

```powershell
# the comparable-pair question
git log --format=%H -20 | ForEach-Object { git show "${_}:apps/cli/src/benchmark-command.ts" 2>$null | Select-String runOneCase | Measure-Object | Select-Object -Expand Count }

# the negative control (offline, restores the arm byte-exactly)
$env:R97_ARM_CANDIDATE_DIR="$env:TEMP\r97-arms-n1\candidate"
node scripts/e4/n1-abi-negative-control.mjs --arms-root "$env:TEMP\r97-arms-n1" --out .ci\n1nc
```
