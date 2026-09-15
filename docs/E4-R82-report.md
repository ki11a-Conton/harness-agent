# E4-R82 — Offline Linux cold-start verification (the POSIX half of R79)

Plan: `plan(20260915-052655).md`, task R82 (last of R79–R82).
Scope: a **new CI job** that walks the README cold-start path on GitHub's
`ubuntu-latest`, plus the report that separates what was measured here from what
was measured there. **No production code changed in this task, no benchmark case
content, holdout, digest, billing or isolation change, and no paid run.**

| Field | Value |
| --- | --- |
| Starting SHA | `597b34a6…` (R81) |
| Code SHA (job added) | `0ca421e6fed7168bd91463950b76bc15bb63c3e7` |
| Final pushed SHA | `b1efddc8e434d82d1c14332a79d87059c05b5da0` |
| Environment (local) | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, vitest 4.1.10 |
| Environment (CI job) | GitHub-hosted `ubuntu-latest`, Node 22, pnpm 11.21.0 |
| Provider calls | **0** — local and CI |

---

## 1. Status summary

The whole point of this report is that it **does not blur two different things**:
what could be measured on this machine, and what had to be measured on a Linux
runner. R79 fixed the verifier; the POSIX half of that verdict can only be
*observed* on POSIX.

| Item | Status | Where the evidence comes from |
| --- | --- | --- |
| Local gate: `pnpm build` | **PASS** | §2 — this machine (Windows) |
| Local gate: `pnpm test` | **PASS** (328 files / 5924 tests / 3 skipped) | §2 — this machine |
| Local gate: `pnpm test:coverage` | **PASS** (exit 0, clean tree only) | §2, §5.1 — this machine |
| Local gate: `pnpm docs:verify` | **PASS** | §2 — this machine || Cold-start job definition (README order on Linux) | **DEFINED** | §3 — `.github/workflows/ci.yml` |
| `LOCAL_LINUX` (cold start on *the user's own* Linux) | **BLOCKED** | §4 — no Linux/WSL/Docker on this machine |
| `CI_UBUNTU` (cold start on GitHub `ubuntu-latest`) | **PASS** | §5 — bound to run id / attempt / head SHA |
| Frozen command specs on Linux through the REAL verifier | **PASS** | §5 — CI step "Linux oracle" |
| Real-model baseline | **NOT_RUN** | unchanged since R78; cost **UNKNOWN** |

`LOCAL_LINUX` is **BLOCKED**, not PASS and not FAIL. It is recorded as BLOCKED
because the capability is genuinely absent here — not because an attempt failed.

---

## 2. Local gates (Windows, clean tree)

Run on a **clean** tree (nothing untracked, nothing modified) so the promotion
path's clean-tree gate cannot be confused with a real failure:

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm build` | 0 | `tsc -b` across all packages, no diagnostics |
| `pnpm test` | 0 | 328 files passed, 5924 tests passed, 3 skipped (5927) |
| `pnpm test:coverage` | 0 | per-package thresholds met (see §5.1 and below) |
| `pnpm docs:verify` | 0 | `ALL CHECKS PASS` |

A dirty-tree run additionally reports 3 failing files
(`benchmark-command.test.ts`, `e4-09-production-e2e.test.ts` ×4,
`e4-r55-failure-wiring.test.ts`) — or just the first, if the dirt is a single
untracked file. These are **pre-existing and not a regression**: the clean-tree
gate in the promotion path (`benchmark-command.ts:648-673`) refuses on purpose
and `probeSourceSnapshot` is module-local, so a test cannot stub it. Measured
identically at `7798d3a`, i.e. **before** R79. §5.1 has the full matrix, and
`README.md` now documents the trap.

The coverage gate is a separate CI job and a per-package threshold set
(`vitest.config.ts:52-61`). R79 rewrote `packages/tools/src/verification/task-verifier.ts`
and R81 changed `packages/evaluation`, both gated at `lines: 85`
(`tools` additionally `branches: 68`), so coverage was the one place a "more
tests, less coverage" tradeoff could have surfaced. It did not: measured locally,
`task-verifier.ts` sits at **98.57% lines / 92.55% branches / 100% functions**
(98.76% statements), and the run exits 0.

---

## 3. What the cold-start job actually does

`.github/workflows/ci.yml`, job `cold-start-ubuntu`, name
`offline cold-start (ubuntu)`. Inserted before `release-attestation`; `verify` is
at line 31, `coverage` at 244, `cold-start-ubuntu` at 325,
`release-attestation` at 504.

The job exists because the frozen-baseline handoff had only ever been walked on
the author's Windows machine. It is deliberately hostile to the failure modes
this project has actually hit:

| Step | What it establishes |
| --- | --- |
| Checkout into `"cold start checkout"` (path **contains a space**) | A space in the path is a real Windows/Linux quoting hazard; both platform paths must survive it |
| `test "$HEAD_SHA" = "${{ github.sha }}"` | The evidence is bound to the SHA that was tested, not to a branch name |
| `test ! -d node_modules`, `test ! -d apps/cli/dist` | **Genuine** cold start: reuses nothing from the `verify` job |
| README order: install → build → doctor → `--allow-stub` → keyless frozen dry-run | The documented first-run path is the one that is actually executed |
| `grep -nE 'RUN_PAID_BENCHMARKS\s*[:=]\s*["'"'"']?1' .github/workflows/ci.yml` | The workflow **asserts about itself** that it contains no paid authorization |
| `node -e` artifact checks | Machine-checked, not "exit code was 0": `avg_model_calls === 0`, `providerCalls === 0`, `casesTotal === 8` with the exact frozen id set, `sourceSha === github.sha`, `endpointIdentity` is a 64-hex digest, `billingClass === "external-billed"`, `schemaVersion === "e4-02"` |
| Linux oracle: real `TaskVerifier` on the frozen specs | The POSIX half of R79, through the production verifier — **not** a direct-argv helper |
| Reduced evidence bundle | `identity.json` carries head SHA / run id / attempt / runner OS / node / pnpm and `paidAuthorizationPresentInWorkflow: false`; deliberately **no environment dump** |

`permissions: contents: read`, and `RUN_PAID_BENCHMARKS: ""` is set at job level
as belt-and-braces. Verified locally: `ci.yml` is the only file under
`.github/workflows/`, so the self-grep reads the same file it runs in, and no
workflow in the repo sets `RUN_PAID_BENCHMARKS=1` — the guard passes by
construction, and would fail loudly if someone later added an authorization.

---

## 4. Why `LOCAL_LINUX` is BLOCKED (and not silently omitted)

This machine is Windows NT 10.0.19044.0. There is no Linux host, no WSL
distribution and no Docker daemon available to this session, so the README
cold-start path **cannot** be executed on POSIX here. That is a capability gap,
not a test failure.

The plan's completion definition allows exactly two honest outcomes for this
item: a Linux cold-start from a keyless CI job, **or** an explicit BLOCKED.
This report does both where each applies — the CI job supplies the POSIX
evidence, and `LOCAL_LINUX` is recorded BLOCKED so nobody later reads the green
CI run as "the author verified Linux locally."

Explicitly **not** done, per the plan's not-complete conditions:

- GitHub Ubuntu is never described as "the user's Linux";
- the POSIX verdict is never inferred from Windows behaviour;
- R79's earlier Windows-only green is never reused as Linux evidence.

---

## 5. `CI_UBUNTU` — the actual run

Bound to a specific run, not to a branch name or a remembered result. The
**headline run is the one for the pushed tip**, so the evidence describes exactly
what is on `main`:

| Field | Value |
| --- | --- |
| Run id | `34941745736` |
| Attempt | 1 |
| Head SHA | `b1efddc8e434d82d1c14332a79d87059c05b5da0` (= pushed `main`) |
| Conclusion | **success** |
| Runner (cold-start job) | GitHub Actions, `ubuntu-latest`, Node 22, pnpm 11.21.0 |

| Job | Conclusion |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | **success** |
| `release attestation (P38-12)` | success |

Three earlier runs in this task were also fully green with the same five-job
shape: `34940787769` (attempt 1, head `cbb8a64`), `34939903886` (attempt 1, head
`b0a4dd2`) and `34938827497` (attempt 1, head `07adf3f`). Every commit after each
was documentation-only, and each was re-verified rather than assumed for exactly
that reason.

The `offline cold-start (ubuntu)` job (job id `104291785820`) ran **16/16
productive steps to `success`** plus 4 post-steps — 20 steps, **zero non-success**,
none skipped:

```
[5]  success  Assert the tested HEAD is the workflow SHA
[6]  success  Assert this is a genuine cold start (no node_modules, no dist)
[7]  success  README step 1 — install (frozen lockfile)
[8]  success  README step 2 — build
[9]  success  Verify the workflow itself cannot authorize a paid run
[10] success  README step 3 — doctor
[11] success  README step 4 — single adversarial case with the stub provider
[12] success  README step 5 — frozen baseline plan (dry-run, no key, 0 provider calls)
[13] success  Machine-check the artifacts (not just exit codes)
[14] success  Linux oracle — the REAL TaskVerifier on the frozen baseline
[15] success  Write the reduced cold-start evidence bundle
[16] success  Upload cold-start evidence (E4-R82)
```

Step 6 proves the run reused nothing; step 9 proves the workflow carries no paid
authorization; step 13 machine-checks the artifacts (rather than trusting exit
codes); step 14 is the POSIX verdict. The run published
`cold-start-ubuntu-b1efddc…-34941745736-attempt-1` (5626 bytes) plus the Ubuntu
`test-report` and `observation-evidence` artifacts. (Artifact **bodies** require
authentication to download; the step conclusions and artifact listing above are
the publicly readable evidence, and are what this report relies on. No step
output is paraphrased as if it had been read.)

The Linux oracle step ran the real verifier
(`packages/evaluation/src/e4-r77-baseline-oracle.test.ts`,
`packages/tools/src/verification/task-verifier.test.ts`,
`packages/tools/src/process/executor.test.ts`) on `ubuntu-latest` and passed, so
the POSIX half of R79 is observed rather than assumed.

For contrast, the run that motivated R79 was `34929969915` (attempt 1, head
`7798d3a…`): ubuntu `verify` and `coverage` both failed and
`release attestation` was skipped. R79's intermediate run `34934589407`
(attempt 1, head `345274b…`) was the first green.

---

## 5.1 What local verification of the gates cost (a real, pre-existing trap)

While validating the gates locally, `pnpm test:coverage` failed with 3 failed
files / 7 failed tests on a tree that had been clean when the run started. The
cause is **not** coverage and **not** an R79–R82 regression, and it is worth
recording because it will bite the next person:

| Tree state | `--coverage` | Result |
| --- | --- | --- |
| clean | no | 328 files, 5924 tests, exit **0** |
| clean | yes | exit **0** |
| one tracked file modified | no | `benchmark-command.test.ts` fails |
| one **untracked** scratch file | no | `benchmark-command.test.ts` fails |
| one tracked file modified | yes | 3 files / 6 tests fail |

The promotion path asserts the source tree is clean before it will emit
promotion-grade evidence (`apps/cli/src/benchmark-command.ts:648-673`), and
`probeSourceSnapshot` is module-local so it cannot be stubbed. A dirty tree makes
that gate refuse *by design*; three `apps/cli` suites observe the refusal and
fail. Measured identical at `7798d3a` (pre-R79), so it is pre-existing.

**CI is unaffected** because it always runs on a pristine checkout — run
`34941745736`'s `coverage gate (ubuntu)` passed. The trap is local-only, and it
is now documented in `README.md`. To reproduce the clean behaviour:

```bash
git stash -u && pnpm test:coverage   # or commit first
```

---

## 6. What is still NOT done

- **The real evaluation has not been run.** No paid baseline, no model call, no
  cost figure. The price of a real run remains **UNKNOWN** — no pricing is
  invented anywhere in this report or in the repo.
- **No R83+ was invented.** The plan stops here and awaits the user's real
  evaluation parameters and explicit paid authorization.
- The environment is keyless (`OPENAI_API_KEY`, `RUN_PAID_BENCHMARKS` and the
  other provider keys are unset), so a paid run is structurally impossible from
  this session even by accident.

## 7. Push

`main` was pushed in four steps, each followed by a re-read of the remote rather
than a trust in the push exit code:

```
345274b..07adf3f  main -> main
07adf3f..b0a4dd2  main -> main
b0a4dd2..cbb8a64  main -> main
cbb8a64..b1efddc  main -> main
```

`git ls-remote origin refs/heads/main` was re-read **after** the final push and
returned `b1efddc8e434d82d1c14332a79d87059c05b5da0`, identical to local `HEAD`.
The CI evidence in §5 is the run for that exact SHA, attempt 1 — not an earlier
run and not a branch name.

The commits that make up R79–R82, in order:

| Commit | Task |
| --- | --- |
| `78b69ff` | R79 — argv execution path + verifier dispatch |
| `345274b` | R79 — report + R77 erratum |
| `edf9b05` | R80 — turn/cleanup error precedence |
| `597b34a` | R81 — keyless billed planning, explicit identity, endpoint-bound digest |
| `0ca421e` | R82 — offline Linux cold-start CI job, R81 runbook/helper follow-ups |
| `99707bc` | R82 — this report |
| `07adf3f` | README corrections (stale `e4-01`, R81 flags, clean-tree trap) |
| `b0a4dd2` | R82 — bind this report to a green run, add the clean-tree matrix |
| `cbb8a64` | R82 — bind this report to the run for `cbb8a64` |
| `b1efddc` | R82 — bind this report to the run for the final pushed tip |
