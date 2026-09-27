# E4 — N1a / N2 report (plus the N0 residual closed this round)

Round: `plan(20260926-175819).md` §N1 (partial) + §N2, on top of §N0.
Labels used: **PASS** / **FIXTURE_PASS** / **NOT_PROVEN** / **BLOCKED** / **NOT_RUN**.

## 0. Identifiers measured here

| Item | Value |
| --- | --- |
| Round baseline SHA (before this round's commits) | `1299e5cb51a668208501ceb103d50eac5bdcfdd3` |
| Commit — N0/N1a/N2 | `1f3df072` `E4-N0/N1/N2: gap counterexamples, shipped arm probe, isolation threading` |
| Commit — N0 readiness split | `bef6e474` `E4-N0: split productionOfflineReady into synthetic-fixture basis vs NOT_PROVEN real dual build` |
| Platform measured | `win32` (Windows), Node `v24.14.0`, vitest `4.1.10`, pnpm workspace |
| Platform NOT measured | Ubuntu — **NOT_PROVEN** (no CI run this round; that is N7's scope) |

## 1. Status of the plan's tasks

| Task | Label | One-line basis |
| --- | --- | --- |
| **N0** | **PASS** | Deliberately-RED counterexample suites + gap matrix + historical banners; legacy 14 still green; root gate excludes the RED files; readiness over-claim split. |
| **N0 residual**: readiness split | **PASS** | `productionOfflineReady` no longer claims "two real isolated arm builds"; it names its `SYNTHETIC_FIXTURE_BUILD` basis and labels a real dual build + real verifier `NOT_PROVEN`. |
| **N1a**: shipped build satisfies the worker ABI | **PASS** | The shipped `benchmark-command` entry now exports a versioned `R97_ARM_PROBE`; the probe-less control still refuses. |
| **N1**: real dual frozen build + real verifier | **NOT_PROVEN** | This round built no two real pinned checkouts from distinct SHAs, so a real dual build and the real verifier over it remain unproven. |
| **N2**: declared isolation reaches the executor | **PASS** | The pre-registration's isolation contract travels on the run context; the production adapter refuses `ARM_ISOLATION_UNSUPPORTED` before any arm work. |
| **N2**: git HEAD/clean-tree identity without a forgettable env switch | **NOT_PROVEN** | Still gated by `R97_ARM_REQUIRE_GIT=1`. |
| **N3 / N4 / N5 / N6** | **NOT STARTED** | 9 of the N0 counterexamples are still RED (see §5). |
| **N7** | **NOT STARTED** | No 2-platform CI wiring this round. |
| **N8** | **BLOCKED** | Needs separate user authorization; not attempted. |
| `paidExperimentRun` | **NOT_RUN** | No paid authorization exists; no real key; not selectable. |
| `championPromotion` | **NOT_RUN** | Promotion is a separate later approval. |

## 2. Change list (this round only)

| File | Change |
| --- | --- |
| `apps/cli/src/benchmark-command.ts` | **N1a** — appended `R97_ARM_PROBE_SCHEMA_VERSION` + `R97_ARM_PROBE`: a versioned mechanism probe (schema, candidate id, guidance version, digests over the build's real runtime wiring). Declared last in the module so it never observes a partially initialized module. |
| `packages/evaluation/src/tool-call-efficiency-paired-campaign.ts` | **N2** — `PreregisteredArmContext` gains a REQUIRED `isolation` field; the driver populates it from the frozen artifact (`prereg.isolation`). |
| `apps/cli/src/prereg-production-runner.ts` | **N2** — `runArm` now builds the executor from `ctx.isolation` (memoized per distinct contract) instead of a default the adapter chose. |
| `apps/cli/src/prereg-arm-executor.test.ts`, `apps/cli/src/prereg-formal-gaps.test.ts`, `apps/cli/src/prereg-n0-gaps.test.ts` | **N2** — every context constructor declares the shipped `process-exec`/`process` contract (the type change proved the API previously could not carry the pre-registration at all). |
| `scripts/e4/r97-mutation-check.mjs` | Repaired the `a5-real-cli-adapter-never-wired` mutation anchor, which the N2 rewrite invalidated. The mutated behaviour is unchanged: the arm is still never executed. |
| `scripts/e4/prereg-production-e2e.mjs` | **N0 residual** — readiness text split into a synthetic-fixture basis and an explicit `realDualFrozenBuildAndRealVerifier: NOT_PROVEN`. |

Full N0 change list: [`docs/evidence/prereg-N0-gap-matrix.md`](./prereg-N0-gap-matrix.md).

## 3. N1a — old RED / new GREEN (behavioural, not source-matching)

Counterexample: [`apps/cli/src/prereg-n0-gaps.test.ts`](../../apps/cli/src/prereg-n0-gaps.test.ts) §N1.

- **Old (baseline `1299e5cb`)**: a REAL module load of the shipped production entry exported `runOneCase` but `R97_ARM_PROBE === undefined`; the isolated worker therefore refuses every real arm build with `PREREG_WORKER_PROBE_MISSING`.
- **New (`1f3df072`)**: the same module load yields a non-empty versioned probe string. The CONTROL in the same file still proves the refusal is real: a checkout entry exporting `runOneCase` but no probe is refused `PREREG_WORKER_PROBE_MISSING`.

The probe asserts wiring rather than restating a literal: it is `r97-arm-probe-v1;candidate=<id>;guidance=<version>;wiring=<digest over runtimeConfigForHash>`.

## 4. N2 — old RED / new GREEN (behavioural)

Counterexample: `apps/cli/src/prereg-n0-gaps.test.ts` §N2.

- **Old**: `createProductionPreregRunner` constructed `createPreregArmExecutor({ rootDir, env })` — no isolation contract. An experiment declaring `vm/strong` was silently executed under the shipped `process-exec`/`process` backend, and the existing (correct) `ARM_ISOLATION_UNSUPPORTED` check was unreachable from the production path. The CONTROL (executor told the contract) already refused correctly, proving the check existed and only the wiring was missing.
- **New**: the production adapter reaches the SAME refusal from the contract the driver carried. Two independent links enforce this:
  1. **Compile time** — `isolation` is a required field of `PreregisteredArmContext`, so no producer can omit it (the typecheck failure at the time of the change is the evidence that the API could not previously carry it).
  2. **Behaviour** — the production adapter returns `ARM_ISOLATION_UNSUPPORTED` for a declared `vm/strong`, before any arm work.

## 5. Raw commands and exit codes

| Command | Exit | Observed |
| --- | --- | --- |
| `pnpm typecheck` | `0` | `tsc -b` clean. |
| `pnpm test:n0-gaps` | `1` | `Test Files 2 failed (2)`, `Tests 9 failed \| 3 passed (12)` — 9 deliberate RED counterexamples remain (N3×1, N4×3, N5×2, N6×3). Raw: `.ci/n0/n1n2-after.log`. |
| `pnpm test:red-next-gaps` | `0` | `Test Files 2 passed (2)`, `Tests 14 passed (14)` — the previous round's 14-case gate is intact. |
| `pnpm exec vitest run packages/evaluation/src/r97-mutation-check.test.ts` | `0` | `Tests 32 passed (32)` after the anchor repair. |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-split.json` (clean tree, HEAD `bef6e474`) | `0` | `prereg-production-e2e: PASS`; evidence `.ci/n0/e2e-split.json`. |
| `pnpm test` (HEAD) | `1` | `Test Files 6 failed \| 368 passed (374)`, `Tests 23 failed \| 7058 passed`. |
| `pnpm test` (baseline SHA `1299e5cb`, changes absent) | `1` | `Test Files 3 failed \| 371 passed (374)`, `Tests 17 failed \| 7064 passed`. |

### Pre-existing-failure attribution (measured, not assumed)

The pre-existing failure set is **load-dependent** and its size fluctuates between runs at the same SHA: the baseline SHA produced 3 files / 17 failures in the run above but 5 files / 22 failures in the earlier N0 run. The always-failing intersection is `e4-r77-baseline-oracle` (7) and `r97-arm-worker-contract` (9); `e4-r55-failure-wiring`, `e4-09-production-e2e`, `cli.test` and `benchmark-command` fail intermittently.

`apps/cli/src/cli.test.ts > asks for approval on write_file (edit:ask) and applies the denial` fails **at the baseline SHA `1299e5cb` with this round's changes absent** (12305 ms), so it is **not** caused by this round. It is a bounded approval-poll that times out under contention: it passes in isolation with the changes present, and the file itself ran 9366 ms in the failing run versus 5413 ms in a passing run. This round adds **no deterministic new failure**.

## 6. Observable provider / physical-request / cost values

From `.ci/n0/e2e-split.json` (HEAD `bef6e474`, `treeClean=true`, `ok=true`):

| Observable | Value |
| --- | --- |
| `providerFactoryCalls` | `MEASURED: the gate's providerFactoryCalls = 1` |
| `physicalProviderCalls` | `MEASURED: the fake provider's generate() entry counter = 124` |
| `forwardPhysicalStubRequests` | `MEASURED: the loopback stub's request counter over the POS-FWD subprocess run = 124` |
| `forwardLedgerCommitted` | `MEASURED: the durable R97 ledger the subprocess wrote committed = 124` |
| `ledgerGranted` / `ledgerCommitted` / `ledgerRemaining` (POS-FWD) | `3720 / 124 / 3596`, `ledgerUnknown=0`, `ledgerTransportRetries=0` |
| `evidenceVerified` / `evidenceUnverified` (both phases) | `124 / 0`, `verifyProblems=[]` |
| `httpRequestsDuringBuildAndValidate` | `0` |
| `negative` | `9/9` refusals on the release CLI, `0` HTTP |
| `decision` | `INCONCLUSIVE` (`EFFECT_BELOW_THRESHOLD`) |
| `externalProviderCalls` | `NOT_OBSERVED: no externally-billed provider exists in this environment` |
| `costUsdMicros` | `NOT_OBSERVED: no provider was billed; a paid run is BLOCKED` |
| `paidExperimentRun` / `championPromotion` | `NOT_RUN` / `NOT_RUN` |
| `forward basis` | `SYNTHETIC_FIXTURE_BUILD (writeArmCheckout entries, not two real pinned checkouts)` |
| `realDualFrozenBuildAndRealVerifier` | `NOT_PROVEN: this offline script builds no two real pinned checkouts from distinct source SHAs` |

Unknown values are reported as `NOT_OBSERVED`, never as `0`.

## 7. Windows / Ubuntu applicability

- Measured on **Windows** (`win32`, Node `v24.14.0`): typecheck, both dedicated suites, the mutation gate, the full suite, and the offline E2E.
- **Ubuntu: NOT_PROVEN.** Nothing in this round ran on Linux. The N2 change is platform-neutral TypeScript; the N1a probe is pure computation. The known platform-sensitive suites (`e4-r77-baseline-oracle` command-oracle tests) already differ per platform and are untouched here.

## 8. Residual limits (explicitly not claimed)

- **N1 is not done.** No two real pinned checkouts were built from distinct SHAs and no real verifier ran over them; the E2E forward phase is still a `SYNTHETIC_FIXTURE_BUILD` IPC/protocol/ledger closed loop. **NOT_PROVEN**.
- **N2 is partial.** The isolation contract is threaded, but git-HEAD/clean-tree identity for the two arms is still controlled by the forgettable `R97_ARM_REQUIRE_GIT` env switch. **NOT_PROVEN**.
- **N3–N6 remain RED** (9 counterexamples): unknown-price/`maxUsdMicros=null` paid admission; `settle`/`charge` tool-call under- and over-consumption; the worker inherited-environment and direct-loopback egress boundaries; forged-evidence verification, self-reported `tokensDelta`, and all-`error` campaigns passing `artifactIntegrity`.
- **N7/N8 not started** — no two-platform CI wiring; the paid handover stays `BLOCKED` pending separate user authorization.
- The pre-existing suite failures listed in §5 are unrelated to this round but are **not fixed** here.

## 9. Reproduction

```powershell
$env:NODE_OPTIONS=$null
pnpm typecheck
pnpm test:n0-gaps          # expect exit 1: 9 RED counterexamples (the plan's RED gate)
pnpm test:red-next-gaps    # expect exit 0: the previous round's 14-case gate
pnpm exec vitest run packages/evaluation/src/r97-mutation-check.test.ts   # expect exit 0

# Offline E2E requires a CLEAN tree; my commit is HEAD, so only the user's own
# pre-existing entries need stashing:
git stash push -u -- "HANDOVER.md" "plan(20260926-070459).md" "plan(20260926-175819).md"
node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-split.json
git stash pop
```
