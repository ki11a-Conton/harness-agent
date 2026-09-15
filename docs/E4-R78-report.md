# E4-R78 — Cold-start handoff validation and real-baseline authorization checklist

Plan: `plan(20260915-033502).md`, task R78 (final task of R75–R78).
Scope: validation + documentation only. **No runtime, verifier, digest, billing or
isolation change.** No paid run was performed.

Sources of truth for this report: the commands below and their real output, captured
under `docs/r78-evidence/`. Nothing here is asserted without a command that produced it.

---

## 1. Status summary

| Item | Status | Evidence |
| --- | --- | --- |
| Windows offline cold-start handoff | **PASS** | §2, `docs/r78-evidence/r78-windows-coldstart.txt` |
| Linux cold-start | **BLOCKED** | §3, `docs/r78-evidence/r78-linux-coldstart-blocked.txt` |
| Full test suite | **PASS** | §4 |
| Typecheck / build | **PASS** | §4 |
| Documentation truth | **PASS** | §4 |
| Real-model baseline run | **NOT_RUN** | §6 — awaiting authorization |
| Real-model cost | **UNKNOWN** | §6 — no pricing invented |

---

## 2. Windows offline cold-start handoff — PASS

Method: a **fresh `git clone`** into a directory whose name contains a space
(`…\Temp\r78 cold checkout`), i.e. a genuine cold checkout rather than the working
tree, deliberately exercising unquoted-path assumptions. The clone's HEAD was
`c4dc6155403b0f97bf6f39140e961eb8b57574aa` (E4-R77).

The four README "Offline smoke (no API key, no network)" steps were run in order:

| Step | Command | Exit |
| --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | 0 |
| 2 | `pnpm build` | 0 |
| 3 | `node apps/cli/dist/main.js doctor` | 0 |
| 4 | `node apps/cli/dist/main.js benchmark --suite adversarial --limit 1 --allow-stub` | 0 |
| 5 | `node apps/cli/dist/main.js benchmark --suite adversarial --dry-run` | 0 |

Each documented claim was then checked against real output rather than assumed:

- **Stub is a measurement, not a verdict.** The run printed `benchmark: 0/1 passed
  (0.0%)`; the artifact's `summary.success_rate = 0` and `summary.avg_model_calls = 0`.
  This matches the README's "success rate 0.0% and model calls 0 because no model was
  invoked" — the stub is honestly reported as solving nothing.
- **`providerCalls: 0` for dry-run.** The emitted plan JSON contains
  `"providerCalls": 0`, so the dry-run really did not contact a provider.
- **Manifest provenance.** `manifest.gitSha = c4dc6155…4aa`, `platform = win32`,
  `provider = stub`, `model = stub-model` — an artifact can be tied to the exact
  source it came from, as documented.
- **`--out` into a path with a space.** `--out "out stub"` wrote both
  `adversarial.json` (5541 B) and `adversarial-summary.md` (2673 B) into that
  directory. Both files present.
- **A clean clone binds a real fingerprint.** The dry-run plan reported
  `treeFingerprint = bf4fbfdd…e870`, a real 64-hex content fingerprint — not the
  `"dirty"` placeholder. This is the expected contrast with a dirty tree (§5).

Windows R73 evidence from the earlier round remains valid for the same mechanism but
was produced on the **original** checkout version; the run above is the
post-R75–R77 confirmation at a spaces-containing path.

## 3. Linux cold-start — BLOCKED (environmental)

A Linux cold-start could not be performed on this host. Probes and their real exits:

| Probe | Result |
| --- | --- |
| `wsl --list --verbose` | exit **1**; prints `wsl.exe` usage/help, no distro table |
| `wsl --status` | exit **1**; same usage/help text, no default distribution |
| `docker --version` | exit **1**; `docker` not recognized — no container fallback |

A working WSL install would print a `NAME  STATE  VERSION` distro table and exit 0
instead of usage text. There is therefore **no Linux runtime and no container runtime
available in this environment**, so the Linux cold-start path (POSIX quoting,
`bwrap`-based isolation, case `verification.kind: "command"` under `sh`) is
**NOT validated here**. Captured in `docs/r78-evidence/r78-linux-coldstart-blocked.txt`.

This is a real coverage gap and is reported as such rather than worked around:

- The Windows V1 defect (POSIX single-quote escaping applied under `cmd.exe`, see
  `docs/E4-R77-baseline-cases-rev1.md`) is **Windows-specific and invisible to CI**,
  because CI runs only `pnpm benchmark:smoke` (the adversarial suite), which does not
  execute the frozen baseline cases.
- The R77 case revisions were chosen to be cmd-native, i.e. they run correctly on
  Windows **now**. Whether the corresponding POSIX path behaves identically on Linux
  remains **NOT_RUN** until a Linux host is available.

## 4. Repository gates — PASS

Run on the committed tree (`c4dc6155…` + the R78 docs) with untracked scratch files
removed so the source-tree probe is genuinely clean:

| Gate | Result |
| --- | --- |
| `pnpm test` | **328 files passed, 5896 tests passed, 3 skipped**, exit 0 |
| `pnpm build` (`tsc -b`) | exit **0** |
| `pnpm docs:verify` | `ALL CHECKS PASS`, exit **0** |

The R75, R76 and R77 regression tests are all visible and green in that run
(e.g. `F1 REPRO: a budget-free dry-run digest is REFUSED…`,
`F1: --limit defaults to 1…`, the `invalidates the confirmed digest` matrix,
and the R77 oracle suite).

## 5. Known pre-existing environment sensitivity (not a regression)

`apps/cli/src/benchmark-command.test.ts` → *"refuses a promotion run (no provider
call) when captureHostState returns an UNVERIFIED state"* (E4-R41 / K02) is
**dirty-tree sensitive**. It exercises the promotion-eligible path but does not stub
the source probe, and `probeSourceSnapshot` is module-local to
`benchmark-command.ts`, so it cannot be mocked from the test. Any modified **or
untracked** file in the repository therefore makes the plan's
`identityFacts.treeFingerprint` non-null, and the execution-time clean-tree gate
(`benchmark-command.ts:652-671`) fires *before* the host-probe stage the test means to
reach.

Evidence that this is pre-existing and environmental, not caused by R75–R78:

1. With the R75–R78 changes stashed (tree = HEAD), the test still failed.
2. With R75–R78 **committed** but the untracked `plan(20260915-033502).md` present,
   it still failed.
3. With untracked scratch files moved aside (genuinely clean tree), it **passed**:
   `Tests 1 passed | 79 skipped`.

So the failure was caused by workflow scratch files dirtying the tree, and it clears
once the work is committed and untracked scratch is removed — which is the state
validated in §4. No runtime or production code was changed to accommodate it.

## 6. Real-baseline authorization checklist

Per the plan, the runbook stops here. Nothing below has been executed; the
real-model baseline remains **NOT_RUN** and its cost **UNKNOWN** (no pricing is
invented anywhere in this work).

Before authorizing, the operator must fill in and confirm **all** of the following:

1. **Provider and model** — provider id and exact model id. These are bound into
   `planDigest`; changing either invalidates a confirmed digest.
2. **Endpoint and data scope** — which endpoint will be contacted and which data
   (case text, fixtures) leaves the machine.
3. **Pricing source** — the actual price list used. Cost stays **UNKNOWN** until a
   real price is supplied; the runbook deliberately contains no invented rates.
4. **The four caps plus a total budget** — `--max-logical-runs`, `--max-model-calls`,
   `--max-estimated-tokens`, `--max-estimated-cost-usd`. Note that the CLI only
   *enforces* a positive `--max-model-calls`; the other three are operator
   discipline, so they must be chosen deliberately (see
   `docs/E4-R74-baseline-runbook.md` §3.1).
5. **Results directory** — the `--out` target for the artifacts.
6. **Stop conditions** — the conditions under which the run is abandoned rather than
   continued (runbook §4).
7. **A final-config dry-run digest** — the dry-run must be produced **with the exact
   final parameter set**, because a digest only authorizes a byte-identical plan
   (F1). Remember `--limit` defaults to **1**, so a case sweep must pass `--limit`
   explicitly.
8. **Explicit paid authorization** — `RUN_PAID_BENCHMARKS=1` plus the matching
   `--plan-digest`. An API key alone is not authorization.

Do **not** set `RUN_PAID_BENCHMARKS=1` on the basis of this document. It is a
checklist for a human decision, not an authorization.

---

## 7. Boundaries of these claims

- **Did not** modify the TaskVerifier, `planDigest` construction, billing gates, or
  isolation handling. R77's case revisions changed case *content* only.
- **Did not** re-run anything merely to turn it green, weaken an assertion, or alter
  the holdout. The three frozen-case revisions in R77 are the documented revision
  mechanism (rev1), with the R74 originals recoverable from git history.
- **Did not** add a ninth case.
- **Did not** run a paid benchmark, and did not fabricate a digest or a cost.
- **Did not** validate Linux (§3 — BLOCKED).
