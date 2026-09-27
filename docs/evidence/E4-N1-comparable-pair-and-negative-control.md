# E4 / N1 — the comparable pair and the ABI negative control (corrected, rounds 12–15)

Plan: `plan(20260926-175819).md` §N1 (line 33); 怎么做 3 at line 43; 验收 at line 45.
Platform: Windows 10 / PowerShell 7, Node `v24.14.0`. Offline throughout: **zero provider
requests, no key, no paid endpoint, no cost.**

> **This document CORRECTS an earlier version of itself.** The first version concluded
> `NOT PASSED / open finding` for the negative control and `BLOCKED: NO_REAL_ARM_PAIR` for the
> pair. Both conclusions were wrong, and the measurements that overturn them are below. The
> earlier text is superseded, not quietly edited away: §3 records exactly what was wrong.

## 1. Labels

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N1.1 | Two different, real, traceable source SHAs, both carrying the worker ABI | **PASS** | `8265dc39f74b3d556e059bb86b1cc192357e21dd` (baseline) / `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` (candidate) |
| N1.2 | A legal **comparable** pair — differing only in the mechanism under test | **PASS** | the pair's entire diff is **1 file, +1/−20**, and it is exactly the one strategy artifact (§2) |
| N1.3 | Per-arm module-load records and real verifier bytes | **PASS** | 16/16 units reached an arm-worker verdict; both arms recorded a `buildDigest` that differs (§4) |
| N1.4 | ≥1 valid offline case completing real harness → tool execution → verifier → artifact | **PARTIAL** | 6/16 units reached a verifier verdict, all **weak**; `strongPasses = 0` |
| N1.5 | Negative control: scrambled ABI ⇒ explicit refusal with 0 factory calls / 0 physical requests | **PASS** | v2: both entry points refuse with `status=FAILED`, 0 units measured, 0 external calls (§3) |
| N1.6 | The control leaves the arm byte-exactly as found | **PASS** | sha256 restored on every scramble; final positive run green |
| N1.7 | Ubuntu | **NOT_PROVEN** | Windows-only measurement; no runner reachable from this checkout |

## 2. The comparable pair — generated, not improvised

The earlier finding stands as a **fact**: no *pre-existing* pair of revisions in this history is a
legal comparison, because every ABI-bearing revision is an N3–N7 infrastructure commit (18
revisions measured; diffs span `.github/workflows`, `apps/cli`, `packages/evaluation`,
`scripts/e4`, docs — e.g. `42ea342d` 17 files, `35eeb5f4` 29, `a2c65e44` 31), and the ABI only
arrives at `1f3df072`, so no earlier revision can serve as a baseline either.

Plan line 37 gives the remedy for exactly that situation: *do not* patch an old SHA and reuse its
digest — **generate a traceable new SHA** and re-prereg. That is what was done:

| | candidate | baseline |
|---|---|---|
| SHA | `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` (HEAD) | `8265dc39f74b3d556e059bb86b1cc192357e21dd` |
| nature | the real current revision | **purpose-built measurement baseline** on branch `e4/n1-baseline-comparable` |
| diff vs HEAD | — | `packages/evaluation/src/mechanism-guidance.ts`: 1 file, **+1 / −20** |
| build closure digest | `6bdb2ce094a70c55e4ea052941f684e8a12999282454d93c8b52d9434559e364` | `09c832a9124c46c56216410cda08026dd89d37b5f96f9c8c9d6a613e8cfab0c0` |

**The expected UNIQUE mechanism difference (plan line 41):** `TOOL_CALL_EFFICIENCY_GUIDANCE_V1`,
the strategy-layer guidance block appended to the *candidate* arm's system prompt. The baseline
neutralizes that constant to the empty string and changes nothing else — same code, same tests,
same workflow, same ABI. Its digest flows into the arm digest, the execution identity and the
promotion target, which is why the closure digests above differ. This is precisely the single
mechanism axis `tool_call_efficiency_v1` is supposed to test.

**Honesty note:** the baseline is a *purpose-built* baseline, not a historical release. It is a
real, committed, traceable revision whose sole purpose is to be the A/B control; it is not
presented as a shipped version.

**Independent corroboration that the harness refuses a degenerate comparison:** asked to prepare
two arms at the *same* revision, the observer refuses outright —
`r97-observe-arms: baseline and candidate are the SAME revision … the plan refuses a same-build
A/B, so there is nothing to prepare`, exit `2`. A fake pair cannot be smuggled past it.

## 3. The ABI negative control — v1 was wrong, v2 passes

### What v1 did and why its verdict was an artifact

v1 renamed all 7 `runOneCase` occurrences in the candidate arm's
`apps/cli/dist/benchmark-command.js` and observed `ok=true / OFFLINE_ACCEPTED / providerRequests=0`
— identical to the positive run — and concluded `CONTROL FAIL`.

The method was defective in two ways, and both matter:

1. **A consistent rename keeps the module loadable.** Renaming the binding *everywhere* leaves a
   module that still defines and calls the function under its new name. A consumer that loads the
   module and calls it through its own internal wiring never notices. The control therefore did
   **not** create an unloadable arm; it created a cosmetically renamed one.
2. **It asserted at the wrong level.** A unit that fails its case is still reported
   `status:"completed", failureCategory:"case_failed"`. So a campaign can be `ok` while every arm
   unit is broken. A refusal has to be read from the per-arm unit records, not the campaign
   verdict.

v1's measured evidence that *something did* change was genuine and was recorded: the candidate
arm's `buildDigest` moved `6bdb2ce0…` → `fbb11ef8…`. That proved the closure covers the arm's own
entry — but v1 drew a conclusion about *refusal* that its method could not support.

### v2: make the entry unloadable, and read the right level

v2 injects a module-level `throw new Error("N1_ABI_PROBE_MARKER")` (nothing can import it), runs
the full acceptance, restores byte-exactly, and repeats for a second target. Measured:

| run | campaign | units measured | refusal |
|---|---|---|---|
| BASELINE (untouched) | `ok=true` `OFFLINE_ACCEPTED`, `providerRequests=0` | candidate `{completed/case_failed:5, completed/none:3}` | — |
| scramble `apps/cli/dist/benchmark-command.js` (throw) | **`ok=false` `status=FAILED`** | **`{}` — none** | **true** |
| scramble `apps/cli/dist/main.js` (throw) | **`ok=false` `status=FAILED`** | **`{}` — none** | **true** |
| FINAL (restored) | `ok=true` `OFFLINE_ACCEPTED` | — | — |

`externalProviderCalls = 0` in every scrambled run, and each scramble restored byte-exactly.

**Conclusions:** the harness **does fail closed** — an arm whose entry cannot be loaded is refused
outright with no unit measured and no provider call. And **both** `benchmark-command.js` and
`main.js` are on the loaded path (breaking either is fatal), which also disposes of the earlier
hypothesis that the mirrored path might be running something else entirely.

## 4. The acceptance over the comparable pair

| observable | value |
|---|---|
| `status` / `ok` | `OFFLINE_ACCEPTED` / `true` |
| `baselineSha` / `candidateSha` (from `acceptance-summary.json`) | `8265dc39f74b3d556e059bb86b1cc192357e21dd` / `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` |
| `logicalCalls` | 42 |
| `providerRequests` / `externalProviderCalls` | **0** / **0** |
| `measuredUnits` / `skippedUnits` | 16 / 0 |
| `verifiedPasses` | 6 (weak 6, **strong 0**) |
| `executionMode` / `workerUnits` | `arm-worker` / 16 |
| `paidStatus` / `promotable` / `realTwoVersionExperimentRan` | `PAID_NOT_RUN` / `false` / `false` |
| per-arm `build.sourceSha` | baseline `8265dc39…` (digest `09c832a9…`) / candidate `ee15e7e7…` (digest `6bdb2ce0…`) |

The summary now binds the **observed** revisions rather than the configured defaults (the
`1d3f3371` fix working end-to-end) — note these are *different* from the repository defaults
`e9776ba`/`a203737`, which is exactly the mismatch that fix eliminated.

**Why N1.4 is PARTIAL, not PASS:** the plan asks for at least one valid offline case completing the
real harness → tool execution → verifier → artifact chain. 16 units ran the chain with 0 physical
requests and 6 reached a verifier verdict, but every verdict is *weak* and `strongPasses = 0`, so
the offline run cannot demonstrate a strongly verified case. `realTwoVersionExperimentRan = false`
for the same reason. Nothing here is rewritten as a stronger result than it is.

## 5. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `node scripts/e4/n1-abi-negative-control.mjs --candidate-dir <arm> --out .ci\n1nc2 --mode throw --targets "apps/cli/dist/benchmark-command.js,apps/cli/dist/main.js"` | `0` | both targets `FAILED`/`ok=false`, `{}` units, restores byte-exact; `VERDICT: ARM LEFT INTACT` |
| `node scripts/e4/r97-observe-arms.mjs --root %TEMP%\r97-arms-n1pair --baseline 8265dc39… --candidate ee15e7e7…` | **`0`** | both arms ready (`baseline ready` / `candidate ready`) |
| same command with `--baseline` = `--candidate` | `2` | `the plan refuses a same-build A/B, so there is nothing to prepare` |
| `node scripts/e4/r97-closed-loop.mjs --acceptance --arms-root %TEMP%\r97-arms-n1pair --out .ci\n1pair` | **`0`** | `[2/5] acceptance OK  status=OFFLINE_ACCEPTED passes=6/16` |
| `git diff --stat ee15e7e7 8265dc39` | `0` | `1 file changed, 1 insertion(+), 20 deletions(-)` |

## 6. Windows / Ubuntu

Windows: all of the above was measured here. Ubuntu: **NOT_PROVEN** — the observer, the acceptance
and the control are platform-neutral Node/`git` calls with no platform branch, but none of them was
executed on Linux in this session, and N1's acceptance is a two-platform statement.

## 7. Residual limits

1. **`strongPasses = 0`** on this pair: the chain runs offline but nothing is strongly verified, so
   N1.4 stays PARTIAL and no promotion evidence exists.
2. **The repository defaults are still the ABI-less `e9776ba`/`a203737`.** The comparable pair is
   real and was accepted, but nothing re-pins the defaults, so a default invocation still prepares
   arms that cannot load. `packages/evaluation/src/r97-driver-closed-loop.test.ts` also hardcodes
   those revisions (D6 at lines 1683–1684, R101 at 1775–1776).
3. **The baseline is purpose-built.** A reviewer who wants a historical baseline is still out of
   luck: history contains no legal comparison, and that has not changed.
4. **The pair differs in a strategy text, not in code behaviour.** Whether that text actually
   reduces wasted tool calls is a model-quality question this offline run explicitly cannot answer
   (`realTwoVersionExperimentRan = false`).
5. The arm worktrees live in `%TEMP%`, so the pair's *checkouts* are not durable — only the
   revisions are. Re-running the build reproduces them from `8265dc39…`/`ee15e7e7…`.
6. A hard kill between scramble and restore would leave an arm scrambled; re-running the observe
   step rebuilds it. The control verifies each restore by sha256.

## 8. Reproduction

```powershell
# the purpose-built comparable baseline (branch e4/n1-baseline-comparable already holds it)
git worktree add $env:TEMP\r97-n1-baseline -b e4/n1-baseline-comparable HEAD
# ...neutralize TOOL_CALL_EFFICIENCY_GUIDANCE_V1 in packages/evaluation/src/mechanism-guidance.ts...
git -C $env:TEMP\r97-n1-baseline add -A; git -C $env:TEMP\r97-n1-baseline commit -m "comparable baseline"

# build both arms and accept over the pair
node scripts/e4/r97-observe-arms.mjs --root $env:TEMP\r97-arms-n1pair --baseline 8265dc39f74b3d556e059bb86b1cc192357e21dd --candidate ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd
node scripts/e4/r97-closed-loop.mjs --acceptance --arms-root $env:TEMP\r97-arms-n1pair --out .ci\n1pair

# the corrected negative control
node scripts/e4/n1-abi-negative-control.mjs --candidate-dir $env:TEMP\r97-arms-n1pair\candidate --out .ci\n1nc2 --mode throw
```
