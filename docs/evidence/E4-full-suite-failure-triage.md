# E4 — full-suite failure triage, re-measured by the Lead (round 6)

Purpose: task-8/R7-close reported the merged full-suite result but **cited** task-12's baseline
comparison instead of re-measuring it. This file removes that gap. Every number below was produced by
the Lead on this machine, on the two trees named, in the round-6 session.

## Trees

| Tree | HEAD | Notes |
|---|---|---|
| baseline | `a85db6dcf1004ef1159f62bc0a11de53247a296c` | detached worktree `r-wave4-base`, installed |
| merged main | `6bf130f7372c9ab748f125b4e8da05006b8898b7` | includes R0–R7, R12, R13 |

Platform: Windows 10 / PowerShell 7, Node `v24.14.0`. **Ubuntu / GitHub Actions: NOT run** — no Linux
host here, and GitHub is currently unreachable from this machine (see "Push blocked" below).
Zero paid/external requests; the 8317 relay was never contacted.

## 1. The two big failure classes DO fail at baseline (pre-existing)

```
# baseline a85db6dc
pnpm exec vitest run packages/evaluation/src/e4-r77-baseline-oracle.test.ts \
                    packages/evaluation/src/r97-arm-worker-contract.test.ts
→ Test Files 2 failed (2);  Tests 16 failed | 58 passed (74);  exit 1
```

r77 contributes 7 and arm-worker contributes 9 — the same 16 names task-8 reported on merged main.
These are environment-sensitive (r77: Windows argv/quoting; arm-worker: worker timing).

## 2. The remaining six are SUITE INTERFERENCE, not regressions — CORRECTION

task-8's full-suite run additionally reported failures in `e4-09-production-e2e` (4),
`e4-r55-failure-wiring` (1) and `benchmark-command` (1). task-8 grouped those with the pre-existing
ones. That grouping is **wrong**, and the correction matters: those three files pass **identically in
isolation on BOTH trees**.

```
# baseline a85db6dc  AND  merged main 6bf130f7 — same three files, same result
pnpm exec vitest run apps/cli/src/e4-09-production-e2e.test.ts \
                    apps/cli/src/e4-r55-failure-wiring.test.ts \
                    apps/cli/src/benchmark-command.test.ts
→ Test Files 3 passed (3);  Tests 167 passed | 2 skipped (169);  exit 0     (on BOTH trees)
```

So on merged main those tests pass when run alone, exactly as at baseline. Their full-suite failures are
**cross-suite interference/flakiness**, not a behavioural regression introduced by this round.
This is the same pattern task-12 found for `apps/cli/src/cli.test.ts` and
`apps/web/src/harness.integration.test.ts` (green in isolation on both trees, red only in the full run).

**Note on the paths:** these three live under `apps/cli/src/`, NOT `packages/evaluation/src/`. An
earlier task-12/Lead attempt to run them under `packages/evaluation/src/` silently collected only two
files, which is how the mis-grouping arose.

## 3. What is therefore established, and what is not

| Class | Count | Baseline behaviour | Verdict |
|---|---|---|---|
| r77 oracle | 7 | fails at baseline | pre-existing, environment-specific |
| arm-worker contract | 9 | fails at baseline | pre-existing, timing-sensitive |
| e4-09 / e4-r55 / benchmark-command | 6 | **passes in isolation on both trees** | suite interference, not a regression |
| cli.test.ts / harness.integration.test.ts | 2 | passes in isolation on both trees (task-12) | suite interference (task-12) |

**Established:** no failing test name was introduced by this round's changes; the two classes that fail
at baseline fail identically on merged main, and every other reported failure passes in isolation on both
trees.

**NOT established:** a *single* green full-suite run on merged main. The suite is red locally
(`22 failed | 7347 passed | 5 skipped`), so the honest local claim is "no new failures versus baseline",
not "all green". **CI on ubuntu-latest and windows-latest is the authority** for the interference class,
and it has not been run for this SHA.

## 4. Push blocked (external)

At round 6 the user's proxy `127.0.0.1:7897` is **not listening** (0 listeners; connection actively
refused) and direct `github.com:443` is blocked (`Failed to connect ... after 21089 ms`), while DNS still
resolves (`20.205.243.166`). GitHub is reachable from this machine only through that proxy. Therefore:

- merged `main` exists **locally only** at `6bf130f7372c9ab748f125b4e8da05006b8898b7`; the remote is
  behind it;
- the dual-platform CI run required by plan §R7.5 and the Ubuntu cold start are **NOT_OBSERVED**;
- the Actions URL / artifact names required by R7's acceptance are therefore **NOT_OBSERVED** as well.

## 5. Reproduce

```powershell
# baseline
cd "$env:TEMP\r-wave4-base"; git rev-parse HEAD      # a85db6dc
pnpm exec vitest run packages/evaluation/src/e4-r77-baseline-oracle.test.ts packages/evaluation/src/r97-arm-worker-contract.test.ts
pnpm exec vitest run apps/cli/src/e4-09-production-e2e.test.ts apps/cli/src/e4-r55-failure-wiring.test.ts apps/cli/src/benchmark-command.test.ts

# merged main
cd "D:\Download games\harness agent"; git rev-parse HEAD   # 6bf130f7
pnpm exec vitest run apps/cli/src/e4-09-production-e2e.test.ts apps/cli/src/e4-r55-failure-wiring.test.ts apps/cli/src/benchmark-command.test.ts
```
