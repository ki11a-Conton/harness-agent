# E4 / N7 — the closed loop in two-platform CI, and documentation that is executable

Plan: `plan(20260926-175819).md` §N7 (line 117); acceptance at line 130.
Baseline HEAD: `a17cf21bcf82fc9a4eb42b6205dbb2fc0fe805b6` (N0–N6 landed, N0 gate 12/12 GREEN).
Commits this round: implementation `53d8ee4bc7152ae261a59ece70933ec75710964b` (CI wiring + readiness
script + doc smoke + approval template + portable links), then the documentation commit that carries
this report (`git log -1 -- docs/evidence/E4-N7-report.md`).
Platform measured on: Windows 10 / PowerShell 7, Node `v24.14.0`, vitest `4.1.10`.
Rules: no real key, no paid endpoint, no `paid:true` auto-authorization, no promotion. Unknown = `NOT_OBSERVED`, never `0`.

## 1. Labels

| # | Deliverable (plan §N7) | Label | Basis |
|---|---|---|---|
| N7.1 | Both-platform CI explicitly runs the dedicated configs; stale "deliberately RED" prose corrected | **PASS (wired, Windows-measured)** | Three N7 steps added to the both-platform `verify` matrix and the E2E matrix job; the same commands were executed locally: `12 passed` / `14 passed` / `4 passed` |
| N7.2 | Read-only prereg build input + `validate --json`, no key, 0 factory calls | **BLOCKED** (static legal config) / **FIXTURE_PASS** (read-only property) | A *static* legal config cannot exist — measured refusal quoted in §5. The key-free, 0-factory-call property is proven by the E2E certification phase |
| N7.3 | Approval template the report references; portable links; doc examples in a smoke test | **PASS** | The referenced `prereg-paid-approval.template.json` **did not exist** and was created; the loader refuses it (4/4 smoke tests); 18 `file:///workspace/...` links replaced, 0 remain |
| N7.4 | Two-platform GitHub Actions URLs + uploaded artifacts | **BLOCKED** | No Actions run is possible from this checkout (no runner, no push). Ubuntu is `NOT_PROVEN`; the artifact contract is implemented but unexecuted on a runner |
| N7.5 | One artifact a reviewer recomputes identity/counts from | **PASS** | `ci-readiness.json` with `ciRunSha`, OS, exit codes, measured counts, five separated levels |
| N7.6 | Five levels reported separately, never one overall PASS | **PASS** | The artifact has **no** top-level `ok` by construction |
| N7.7 | Paid run / promotion | **BLOCKED / NOT_RUN** | `paidExperimentRun=NOT_RUN`, `championPromotion=NOT_RUN` |

## 2. The separated levels (plan line 130)

Measured on `a17cf21bcf82` (`.ci/n0/ci-readiness.json`):

| Level | Status | Basis |
|---|---|---|
| `fixtureProtocolReady` | **PASS** | the synthetic fixture closed loop: 124/124 verified, decision `INCONCLUSIVE` |
| `realBuildOfflineReady` | **BLOCKED** | the E2E's own forward basis reads `SYNTHETIC_FIXTURE_BUILD`; no real dual pinned build exists (N1's scope) |
| `budgetEvidenceReady` | **NOT_PROVEN** | journal-bound token/cost accounting is measured, but the full `armRunId ↔ request IDs ↔ ledger reservation/commit ↔ verifier bytes` chain is not bound and needs real arm artifacts |
| `paidExperimentRun` | **NOT_RUN** | no paid authorization exists; nothing creates one |
| `championPromotion` | **NOT_RUN** | no promotion performed or authorized |

`realBuildOfflineReady` is **derived from the E2E's own statement**, not hardcoded: the script reads
`readiness.productionOfflineReady` and requires it to name a REAL dual pinned build. A green fixture
loop therefore can never mark it green — which is exactly the substitution plan line 125 forbids.

## 3. Change list

`.github/workflows/ci.yml`
- `verify` (both `ubuntu-latest` and `windows-latest`): new steps running `pnpm test:n0-gaps`,
  `pnpm test:red-next-gaps` and the documentation smoke, with the historical note corrected — these
  suites were excluded because they were **deliberately RED**; as of N6 all twelve are GREEN, so they
  are now ordinary gates on both platforms.
- `r97-r98-closed-loop` (both platforms): a readiness step (`if: always()`) and an artifact upload named
  `ci-readiness-<os>-<sha>-<run_id>-attempt-<n>`.

`scripts/e4/ci-readiness.mjs` (new)
- Writes the single readiness artifact; runs the fast gates itself; derives the levels; refuses to
  collapse them. Exits `0` on a successful write and encodes **no verdict** — the levels are the verdict.

`apps/cli/src/prereg-docs-smoke.test.ts` (new, 4 GREEN)
- N7.1/N7.2: the committed template is refused, with a stable refusal code, never `ADMITTED`.
- N7.3: the read-only build input has no inline `catalog`/`selection` and a portable root.
- N7.4: the two doc files contain no `file:///` link.

`docs/evidence/prereg-paid-approval.template.json` (new)
- The file `tool-call-efficiency-p1-p7-report.md` referenced **without it existing**. `paid:false`,
  unsigned, non-runnable, every value a `<placeholder>`; documents that a paid run needs a separately
  issued `paid:true` approval naming model/endpoint/amount/SHA/window.

`docs/evidence/prereg-build.readonly.config.json` (new)
- The legal *shape* of a read-only build input, with the identity fields left explicit and the reason
  they cannot be committed stated in the file.

`docs/evidence/prereg-next-gap-matrix.md`, `docs/evidence/tool-call-efficiency-p1-p7-report.md`
- 18 `file:///workspace/...` links → repo-relative links (portable; they resolved on one machine only).

## 4. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `pnpm typecheck` | `0` | clean |
| `pnpm test:n0-gaps` | `0` | `Tests 12 passed (12)` — the N0 gate, now a CI gate on both platforms |
| `pnpm test:red-next-gaps` | `0` | `Tests 14 passed (14)` — the retained legacy cases |
| `pnpm exec vitest run apps/cli/src/prereg-docs-smoke.test.ts` | `0` | `Tests 4 passed (4)` |
| `pnpm test` | `1` | `Test Files 5 failed | 374 passed (379)`, `Tests 22 failed | 7096 passed | 3 skipped (7121)` (`.ci/n0/n7-full.log`) |
| `node scripts/e4/ci-readiness.mjs --e2e … --out …` | `0` | five separated levels + measured counts |
| `python -c "yaml.safe_load(...)"` on `ci.yml` | `0` | `jobs=5`, the three N7 steps present; 0 tab-indented lines |
| `node apps/cli/dist/main.js prereg build docs/evidence/prereg-build.readonly.config.json …` | `1` | `INVALID_FIELD: subject.candidateSourceSha must be a 40-hex git SHA` — the measured reason N7.2 is BLOCKED |
| `pnpm docs:verify` | `1` | pre-existing, **not caused by this round**: it fails on the user's working-tree deletions (`HANDOVER.md`, `plan(20260926-070459).md`); with only those set aside it reports `ALL CHECKS PASS`, exit 0 |

**Attribution.** FAIL-set diff `.ci/n0/n6-full.log` (22) vs `.ci/n0/n7-full.log` (22): **empty in both
directions**; passing tests `7092 → 7096` = exactly the 4 new smoke tests. N7 introduced no regression.

## 5. Why N7.2 is BLOCKED, with the measurement

A legal read-only build input requires `subject.candidateSourceSha` (40-hex, from `git rev-parse HEAD`)
**and** `subject.baselineArmDigest` / `subject.candidateArmDigest`, which are computed from two **real**
arm build closures. Those digests are not constants, so a committed static config cannot be legal — the
CLI said so: `INVALID_FIELD: subject.candidateSourceSha must be a 40-hex git SHA`, exit `1`. The working
generator is `scripts/e4/prereg-production-e2e.mjs`'s `selectionEvidence()` (HEAD + two arm dirs). What
**is** proven offline is the read-only property: the E2E certification phase runs `prereg build` +
`validate --json` through the shipped CLI with **0** provider-factory calls and **0** HTTP.

## 6. Measured counts (the reviewer's recomputation source)

`ciRunSha=a17cf21bcf82fc9a4eb42b6205dbb2fc0fe805b6`, `os=windows-local`, node `v24.14.0`:

`providerFactoryCalls=1`, in-process physical provider calls `124`, ledger committed `124`,
journal `1240`; forward physical stub requests `124`, ledger committed `124`, journal `248`,
aggregate delta `248`; `evidenceVerified=124`, `evidenceUnverified=0`, decision `INCONCLUSIVE`;
`externalProviderCalls=null` and `costUsdMicros=null` (**NOT_OBSERVED** — nothing is billed).

`typecheck=0`, `build=0`, `test=1` (pre-existing suite failures), `n0GapGate=0`, `legacyRedNextGaps=0`,
`docsSmoke=0`. In CI the first three are passed via `--exit-*`; when a job cannot read a prior step's
outcome the field stays `null` = NOT_OBSERVED rather than being guessed.

## 7. Windows / Ubuntu

- **Windows: MEASURED.** Every command in §4 ran here, including the three new CI gate commands.
- **Ubuntu: NOT_PROVEN.** The workflow is written for both platforms and the YAML parses, but no
  Ubuntu runner executed it from this checkout. Nothing here may be read as an Ubuntu result.
- No change this round is platform-conditional; the readiness script's only branch is the Windows
  `pnpm` shim needing a shell, which is itself a measured Windows fact.

## 8. Residual limits

1. **N7.4 is BLOCKED, not PASS.** There are no Actions URLs and no uploaded artifacts, because no CI
   run can be produced from this checkout. The artifact contract is implemented but unexecuted on a
   runner — a reviewer must not read §6 as a CI result.
2. **The CI gates are wired but unexecuted in CI.** Local execution on Windows is the strongest
   available evidence; a runner could still surface platform-specific failures.
3. **`realBuildOfflineReady` cannot become PASS without N1** (two real pinned checkouts, distinct SHAs).
4. **`git commit` for this round happened after the readiness artifact was generated**, so the artifact's
   `ciRunSha` names its generating revision; in CI the step runs on the checked-out SHA by construction.
5. **`pnpm docs:verify` remains red for an external reason** — the user's two working-tree deletions. It
   was red before this round and is unrelated to N7's doc changes.
6. The documentation smoke tests assert *structure* (no inline catalog, portable root, no `file:///`,
   template refused). They do not execute `prereg build` to exit 0 from the committed file, because that
   is exactly the BLOCKED case in §5 — asserting it green would require the synthetic arms plan line 125
   forbids.

## 9. Reproduction

```powershell
pnpm typecheck                                                        # exit 0
pnpm test:n0-gaps                                                     # exit 0, 12 passed
pnpm test:red-next-gaps                                               # exit 0, 14 passed
pnpm exec vitest run apps/cli/src/prereg-docs-smoke.test.ts            # exit 0, 4 passed
pnpm test                                                             # exit 1, zero new failures vs .ci/n0/n6-full.log
pnpm exec vitest run ... (clean tree) ; node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n6.json
node scripts/e4/ci-readiness.mjs --e2e .ci/n0/e2e-n6.json --out .ci/n0/ci-readiness.json --os-label=windows-local
```
