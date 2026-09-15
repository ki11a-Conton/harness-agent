# E4-R82 — Offline Linux cold-start verification (the POSIX half of R79)

Plan: `plan(20260915-052655).md`, task R82 (last of R79–R82).
Scope: a **new CI job** that walks the README cold-start path on GitHub's
`ubuntu-latest`, plus the report that separates what was measured here from what
was measured there. **No production code changed in this task, no benchmark case
content, holdout, digest, billing or isolation change, and no paid run.**

| Field | Value |
| --- | --- |
| Starting SHA | `597b34a6…` (R81) |
| Task SHA | `0ca421e6fed7168bd91463950b76bc15bb63c3e7` |
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
| Local gate: `pnpm docs:verify` | **PASS** | §2 — this machine |
| Cold-start job definition (README order on Linux) | **DEFINED** | §3 — `.github/workflows/ci.yml` |
| `LOCAL_LINUX` (cold start on *the user's own* Linux) | **BLOCKED** | §4 — no Linux/WSL/Docker on this machine |
| `CI_UBUNTU` (cold start on GitHub `ubuntu-latest`) | **PASS** | §5 — bound to run id / attempt / head SHA |
| Frozen command specs on Linux through the REAL verifier | **PASS** | §5 — CI step "Linux oracle" |
| Real-model baseline | **NOT_RUN** | unchanged since R78; cost **UNKNOWN** |

`LOCAL_LINUX` is **BLOCKED**, not PASS and not FAIL. It is recorded as BLOCKED
because the capability is genuinely absent here — not because an attempt failed.

---

## 2. Local gates (Windows, tree at `0ca421e`)

Run on a **clean** tree (nothing untracked, nothing modified) so the promotion
path's clean-tree gate cannot be confused with a real failure:

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm build` | 0 | `tsc -b` across all packages, no diagnostics |
| `pnpm test` | 0 | 328 files passed, 5924 tests passed, 3 skipped (5927) |
| `pnpm docs:verify` | 0 | `ALL CHECKS PASS` |

A dirty-tree run of `pnpm test` additionally reports 3 failing files
(`benchmark-command.test.ts`, `e4-09-production-e2e.test.ts` ×4,
`e4-r55-failure-wiring.test.ts`). These are **pre-existing and not a regression**:
the clean-tree gate in the promotion path (`benchmark-command.ts:648-673`)
preempts them, and `probeSourceSnapshot` is module-local and therefore
unmockable. Proven by committing the tree and re-running — the same tests pass.
This is recorded because a reader who runs the suite mid-edit will see them.

The coverage gate is a separate CI job and a per-package threshold set
(`vitest.config.ts:52-61`). R79 edited `packages/tools` and R81 edited
`packages/evaluation`, both of which are gated at `lines: 85`
(`tools` additionally `branches: 68`), so the coverage job is the one place a
"more tests, less coverage" tradeoff could have shown up. §5 records its verdict.

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

Bound to a specific run, not to a branch name or a remembered result:

| Field | Value |
| --- | --- |
| Run id | `34936858530` |
| Attempt | 1 |
| Head SHA | `0ca421e6fed7168bd91463950b76bc15bb63c3e7` |
| Conclusion | **success** |

| Job | Conclusion |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | success |
| `coverage gate (ubuntu)` | success |
| `offline cold-start (ubuntu)` | **success** |
| `release attestation (P38-12)` | success |

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

`main` was pushed to `0ca421e6fed7168bd91463950b76bc15bb63c3e7`; `git ls-remote
origin refs/heads/main` was re-read after the push and matched local `HEAD`. The
CI evidence in §5 is the run for that SHA.
