# E4 / N5 — the worker's credential and egress trust boundary

Plan: `plan(20260926-175819).md` §N5 (line 89).
Round baseline SHA: `67ded22917db084cfadb70c690d7d4babc95d91c`.
Pre-N5 HEAD: `577b6a9b74e343df93f21f6dbbe2ea4d3c0fd819` (N0/N1a/N2/N3/N4 landed).
Implementation commit: `a142f6667e25fa519d9b8eaedf4645169de0f7c3`.
Test-contract commit: `44d3641f09b1d9e371275e9b8f3d480f7f34f919` (final HEAD).
Platform measured on: Windows 10 / PowerShell 7, Node `v24.14.0`, vitest `4.1.10`.

Rules this round: no real API key, no paid endpoint, no `paid:true` auto-authorization, no
promotion. Unknown values are `NOT_OBSERVED`, never `0`. Source-string matching is not used as
behavior evidence.

## 1. Labels (honest, per deliverable)

| # | Deliverable | Label | Basis |
|---|---|---|---|
| N5.1 | The worker env is an explicit **allowlist**, not "copy everything, delete four keys" | **PASS** | N5.1 unit + N5.4 child-level observation: sentinel, `HTTP(S)_PROXY`, `AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NODE_OPTIONS` all absent from the child's own view; declared inputs still arrive |
| N5.2 | An untrusted checkout is refused **before** it starts (plan line 98's documented alternative) | **PASS** | N5.3: exact `EGRESS_ISOLATION_UNAVAILABLE`, loopback counter `0`, and the child's import-time side effect never happened |
| N5.3 | The refusal is **not blanket** — the budgeted positive path still runs | **PASS** | N5.4: a fixture checkout really runs and returns an outcome; E2E 124/124 unchanged |
| N5.4 | The capability is **declared, not claimed**: no "the isolated worker is a network sandbox" | **PASS** | N5.2 asserts `available:false`, `backend:"none"`; no code path claims isolation |
| N5.5 | Single egress channel **enforced inside the worker** | **NOT_PROVEN** — deliberately not attempted | There is no in-worker egress block. The fixture path is trusted *by construction* and could still open a socket; only *untrusted* execution is refused |
| N5.6 | Independent egress **counters** reported by the E2E (`egress counts` per plan line 101) | **NOT_OBSERVED** at E2E level | The offline E2E surfaces no egress/allowlist key. The measured counter is the unit-level loopback server in N5.3/N5.4 |
| N5.7 | Credential-injection test (plan line 101) | **PASS**, bounded | Provider/cloud/other-provider tokens are proven absent from the child's environment. A worker that reads a credential from *disk* is out of scope (see §8.3) |
| N5.8 | Ubuntu applicability | **NOT_PROVEN** | Windows-local measurement only; two-platform CI wiring is N7's scope. The allowlist is platform-neutral (no platform branch), but that is an argument, not a measurement |
| N5.9 | Paid / untrusted execution remains closed | **BLOCKED** (as required) | `egressIsolationCapability().available === false` ⇒ `paidExperimentReady` stays false; `paidExperimentRun=NOT_RUN` |

## 2. The defects being closed (measured)

**(a) The environment was not a boundary.** `sanitizedWorkerEnv` did `{ ...env }` and then deleted
four provider names. Everything else the driver held — every proxy variable, cloud credential,
*other* providers' tokens, config-file pointers, and `NODE_OPTIONS` (which injects arbitrary code
into every child Node process) — was inherited by the arm build. The N0 counterexample demonstrated
it with a harmless sentinel.

**(b) Egress was unbudgeted and unguarded.** Nothing bounded the arm build's network access: a
checkout that called `fetch` directly, without ever touching `ctx.provider`, reached the network.
The only "defence" was that provider *keys* were stripped — which does nothing about a loopback or
any unauthenticated endpoint.

## 3. Change list

`apps/cli/src/prereg-arm-executor.ts`
- `PROVIDER_ENV_KEYS` (the deletion list) is **removed**; a delete-list cannot be audited.
- `WORKER_ENV_ALLOWLIST` added: 14 OS essentials needed to *start* node and resolve modules on
  Windows **and** Linux (all non-secret) plus the worker's four declared inputs
  (`R97_ARM_BASELINE_DIR`, `R97_ARM_CANDIDATE_DIR`, `R97_CAMPAIGN_CLAIMS_DIR`,
  `R97_ARM_REQUIRE_GIT`). No proxy, credential, token, config pointer or Node-injection variable is
  on the list. Fail closed: an unlisted name is not passed.
- `buildWorkerEnv()` exported (was the private `sanitizedWorkerEnv`) so the allowlist is directly
  assertable rather than only observable through a child process.
- `egressIsolationCapability()` added — returns `{ available: false, backend: "none", detail }`.
  This is a **declaration that no boundary is claimed**, not a runtime OS probe (see §8.1).
- `EGRESS_ISOLATION_UNAVAILABLE` and `FIXTURE_CHECKOUT_MARKER_FILENAME`
  (`".r97-synthetic-fixture-checkout"`) exported.
- New STEP **3b** in the arm runner, placed after the pre-flight checks (so existing refusal codes
  keep their meaning) and **before the spawn**: a checkout without the fixture marker, on a build
  with no provable egress boundary, is refused with `EGRESS_ISOLATION_UNAVAILABLE`. The plan forbids
  letting a request leave and then calling it a failure; this refuses before `launchArmWorker` is
  ever reached.

`scripts/e4/prereg-production-e2e.mjs`
- `writeArmCheckout` (now `async`) writes the fixture marker and **imports the constant from the
  executor that owns the rule** (new `EXECUTOR_ENTRY`), failing closed if the export is missing, so
  the writer and the refusal rule cannot drift.
- `EXECUTOR_ENTRY` added.

`apps/cli/src/prereg-n0-gaps.test.ts` (the N0 gate)
- N5a's body now encodes plan line 98's **documented alternative**: it captures a pre-start refusal
  instead of letting it throw, asserts the leak file still contains no sentinel, and asserts that if
  a refusal occurred it is **exactly** `EGRESS_ISOLATION_UNAVAILABLE`. **Disclosed:** this is an edit
  to a RED counterexample. It does not weaken the assertion (the sentinel assertion is unchanged);
  it makes the test accept the outcome the plan itself permits, and it is *paired* with the new
  non-vacuous allowlist proof below so the green is not the vacuous "nothing ran" kind.

`apps/cli/src/prereg-egress-trust-boundary.test.ts` (new, 4 cases) — the GREEN acceptance suite.

`apps/cli/src/prereg-arm-executor.test.ts`, `apps/cli/src/prereg-formal-gaps.test.ts`
- Their `makeArmCheckout` helpers now emit the marker (they are harness fixture writers, so the new
  contract requires it). No assertion changed. They import the constant from the executor, not a copy.
  These are the only 4 tests the contract change would otherwise have broken.

## 4. Old RED → new GREEN

`pnpm test:n0-gaps` before N5: exit `1`, `5 failed | 7 passed (12)`.
`pnpm test:n0-gaps` after N5: exit `1`, `3 failed | 9 passed (12)` — N5a **and** N5b are GREEN; the 3
remaining REDs are N6a/N6b/N6c (N6's scope).

| Case | Pre-N5 | Post-N5 |
|---|---|---|
| `[N5]` arm build observes an arbitrary inherited variable | sentinel leaked into the child | no sentinel; run refused pre-start with `EGRESS_ISOLATION_UNAVAILABLE` |
| `[N5]` arm build makes a direct loopback request | loopback server counted a hit | **0 hits**; refused before the child started |

New suite `pnpm exec vitest run apps/cli/src/prereg-egress-trust-boundary.test.ts` → exit `0`,
`Tests 4 passed`:

| Case | Scenario | Asserted behavior |
|---|---|---|
| N5.1 | `buildWorkerEnv` over an env carrying 6 sensitive sentinels | every sentinel key `undefined`; declared inputs and `PATH` present |
| N5.2 | `egressIsolationCapability()` | `available === false`, `backend === "none"`, detail non-empty |
| N5.3 | untrusted checkout + loopback counter, arm does `fetch` at import | exact code `EGRESS_ISOLATION_UNAVAILABLE`, **0 hits**, import-time side effect absent (pre-start) |
| N5.4 | marker-bearing fixture checkout, same sentinel env | leak file **exists** with `NOT_INHERITED` (non-vacuous: the child really ran), outcome returned, and the child's own env dump shows `proxy/proxyUpper/aws/anthropic/openai/nodeOptions` all `null` while `R97_ARM_BASELINE_DIR` arrived |

## 5. Raw commands and exit codes

| Command | Exit | Observed |
|---|---|---|
| `pnpm typecheck` | `0` | `tsc -b`, no diagnostics |
| `pnpm exec vitest run apps/cli/src/prereg-egress-trust-boundary.test.ts` | `0` | `Test Files 1 passed`, `Tests 4 passed` |
| `pnpm test:n0-gaps` | `1` | `Test Files 2 failed (2)`, `Tests 3 failed | 9 passed (12)` (`.ci/n0/n5-n0gaps.log`) |
| affected suites (`prereg-arm-executor`, `prereg-formal-gaps`, `prereg-egress-trust-boundary`) | `0` | `Test Files 3 passed`, `Tests 28 passed` |
| `pnpm test:red-next-gaps` | `0` | `Test Files 2 passed`, `Tests 14 passed` |
| `pnpm test` | `1` | `Test Files 5 failed | 372 passed (377)`, `Tests 22 failed | 7082 passed | 3 skipped (7107)` (`.ci/n0/n5-full.log`) |
| `pnpm build` | `0` | release CLI rebuilt; `dist` exports the marker, capability and allowlist |
| `node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n5.json` (clean tree) | `0` | `prereg-production-e2e: PASS` (`.ci/n0/e2e-n5.log`) |
| `pnpm docs:verify` (working tree as-is) | `1` | `FAIL package count` + `FAIL current plan entry (E4-00)` — unchanged from N4, caused by the user's two uncommitted deletions; with only those set aside it prints `ALL CHECKS PASS` and exits `0` (measured in [`E4-N4-report.md`](./E4-N4-report.md) §5) |

**Attribution of the `pnpm test` failures (measured, both directions).** Diffing FAIL sets between
`.ci/n0/n4-full.log` (pre-N5, 23) and `.ci/n0/n5-full.log` (post-N5, 22):
**new failures introduced by N5 = none**; the single row in the other direction is
`cli.test.ts > asks for approval on write_file (edit:ask) and applies the denial` — one of the
documented load-sensitive pre-existing failures that happened to pass this run. Passing tests
`7077 → 7082` = the 4 new N5 cases + that flaky test. N5 therefore introduced **zero** new failures,
after first repairing the 4 suites the contract change legitimately touched (§3).

## 6. Observable provider-factory / physical-request / cost values

Clean-tree E2E, `treeClean=true`, `ok=true` — **unchanged from N4**:

| Observable | Value |
|---|---|
| `positiveExecution.providerFactoryCalls` | `1` |
| `positiveExecution.physicalProviderCalls` | `124` |
| `positiveExecution.ledgerCommitted` / `ledgerRemaining` | `124` / `3596` |
| `positiveExecution.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveExecution.decision` | `INCONCLUSIVE` |
| `positiveForward.physicalStubRequests` | `124` |
| `positiveForward.ledgerGranted` / `committed` / `remaining` / `unknown` / `transportRetries` | `3720` / `124` / `3596` / `0` / `0` |
| `positiveForward.evidenceVerified` / `evidenceUnverified` | `124` / `0` |
| `positiveForward.decision` / `decisionReasonCodes` | `INCONCLUSIVE` / `["EFFECT_BELOW_THRESHOLD"]` |
| forward basis | `SYNTHETIC_FIXTURE_BUILD` (not two real pinned checkouts) |
| `realDualFrozenBuildAndRealVerifier` | `NOT_PROVEN` (N1 scope) |
| E2E-level egress / env-allowlist counters | **`NOT_OBSERVED`** — the script surfaces no such key |
| unit-level untrusted-egress counter | **`0` hits** (N5.3) — measured, not reported by the E2E |
| `externalProviderCalls` / `costUsdMicros` | `NOT_OBSERVED` (nothing billed; paid BLOCKED) |
| `readiness.paidExperimentRun` / `championPromotion` | `NOT_RUN` / `NOT_RUN` |

## 7. Windows / Ubuntu applicability

- All measurements are Windows-local; Ubuntu stays `NOT_PROVEN` (N7 wires the two-platform CI).
- `WORKER_ENV_ALLOWLIST` is deliberately platform-neutral: it carries both `PATH`/`Path` and both
  `SystemRoot`/`windir`, so the same list starts node on Windows and Linux. That is a *design*
  argument; only the Windows half is measured.
- `egressIsolationCapability()` is a **declaration** (`available:false`), not an OS probe, so it
  returns the same on both platforms — which is why paid/untrusted execution is closed on both. Per
  plan line 101, a platform that cannot prove a single egress channel keeps `paidExperimentReady`
  false rather than skipping the check.

## 8. Residual limits

1. **No in-worker egress block exists.** The fixture path is trusted *by construction* and could
   still open a socket; nothing in this change prevents that. What is proven is that code which is
   *not* declared as a synthetic fixture never starts. This report does **not** claim, and no code
   path claims, that "the isolated worker provides a network sandbox".
2. **`egressIsolationCapability()` is a hardcoded declaration, not detection.** It does not attempt
   to detect Windows Firewall, `bwrap`, `unshare`, seccomp or Node's permission model. The honest
   reading is "this build declines to claim a boundary", not "the OS was probed and refused". If a
   real backend is added later, this function must gain real detection — until then its constant
   `false` is the safe direction.
3. **Trust is self-declared by a file.** The marker is written by the harness's own fixture writer
   (and by two harness test writers). A caller that writes the marker into a real checkout would
   bypass the refusal. It is not a signature or a digest, so it is *not* tamper-proof; it is a
   fail-closed *declaration* whose absence blocks execution.
4. **The marker is not bound to the checkout's build digest** in the refusal decision, so a marker
   copied into an unrelated tree is honoured. Binding the marker to the fixture writer's own digest
   is not implemented.
5. **Disk-read credentials are out of scope.** The allowlist proves the *environment* carries no
   token; a worker that reads `~/.aws/credentials` or a repo-local `.env` is not constrained by this
   change. `SANDBOX_MANAGER`-level filesystem confinement would be the real fix and is not this task.
6. **IPC frame size, child-lifecycle and error-message leakage** (plan line 95) are **not** addressed
   this round; no test asserts an IPC size bound or a redacted child error.
7. **The N5a gate test accepts a refusal path** (§3). The non-vacuous allowlist proof lives in the
   new suite, so the allowlist evidence does not depend on the edited counterexample — but a reader
   comparing only the gate's before/after should know the test body changed.
8. Pre-existing whole-suite failures remain (see §5); N5 introduced none.

## 9. Reproduction

```powershell
# 1. typecheck, then the N5 acceptance suite
pnpm typecheck                                                                    # exit 0
pnpm exec vitest run apps/cli/src/prereg-egress-trust-boundary.test.ts              # exit 0, 4 passed

# 2. the N0 gate: N5a/N5b flip GREEN, N6a/N6b/N6c stay RED
pnpm test:n0-gaps                                                                  # exit 1, 3 failed | 9 passed

# 3. the historical regression gate (must stay green)
pnpm test:red-next-gaps                                                            # exit 0, 14 passed

# 4. whole suite + attribution against the pre-N5 log
pnpm test                                                                          # exit 1; zero new failures vs .ci/n0/n4-full.log

# 5. the offline closed loop (requires a CLEAN tree)
git stash push -u -- "HANDOVER.md" "plan(20260926-070459).md" "plan(20260926-175819).md"
pnpm build
node scripts/e4/prereg-production-e2e.mjs --out .ci/n0/e2e-n5.json                 # exit 0, PASS
git stash pop
```

`.ci/` is gitignored (`.gitignore` line 9); the raw logs named above live there and are referenced,
not committed.
