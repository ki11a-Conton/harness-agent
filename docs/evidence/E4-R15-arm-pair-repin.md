# E4-R15 — the comparable arm pair is re-pinned onto a base that CONTAINS P2-41 and P2-43

**Branch:** `e4/r15-repin` (based on local `main` `2314ce1d`)
**Baseline arm commit:** `4f8d98ec65d475844d3ed4b959a3199f84ed5d03` (local branch `e4/r15-baseline-neutralized`)
**Candidate arm commit:** `2314ce1db40bfa10dc58b0d136e0696450e90cc8` (local `main`, unmodified)
**Platform of every measurement in this file:** Windows (`win32`), Node/pnpm as installed in the worktree.
**Ubuntu: NOT RUN.** Every Ubuntu row in this document is `NOT_OBSERVED`; it is not a pass and not a fail.

## 1. The defect

The pinned pair was

| role | old SHA | ancestry relationship |
| --- | --- | --- |
| baseline | `8265dc39f74b3d556e059bb86b1cc192357e21dd` | branches off `ee15e7e7` |
| candidate | `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` | ancestor of `8265dc39` |

`git log ee15e7e7..8265dc39` is exactly one commit, whose entire diff is
`packages/evaluation/src/mechanism-guidance.ts` (+1/-20). So the mechanism under test is
the `tool_call_efficiency_v1` guidance text — that part was correct.

**The pair was stale.** Neither arm contained the protocol fixes this round depends on:

- P2-41 `9df60bd5` — an assistant `tool_calls` block must never be split or orphaned.
- P2-43 `a85db6dc` — tool names must satisfy the provider function-name grammar.

`ee15e7e7` is a **predecessor** of P2-41, and `8265dc39` branches off `ee15e7e7`, so it is a
predecessor of P2-41 as well. An experiment run on that pair therefore exercised **stale
protocol code**, and its numbers did not describe the current harness. Re-pinning only the
driver would not have fixed this: the *arms themselves* are the stale artifacts.

## 2. The new pair, and why this base

| role | new SHA | what it is |
| --- | --- | --- |
| candidate | `2314ce1db40bfa10dc58b0d136e0696450e90cc8` | local `main`, unmodified — the harness as it is now |
| baseline | `4f8d98ec65d475844d3ed4b959a3199f84ed5d03` | `2314ce1d` + the SAME single guidance-neutralization commit |

The baseline was produced by taking the file byte-for-byte from `8265dc39`:

```text
git switch -c e4/r15-baseline-neutralized 2314ce1d
git checkout 8265dc39 -- packages/evaluation/src/mechanism-guidance.ts
git diff --numstat 2314ce1d          ->  1   20   packages/evaluation/src/mechanism-guidance.ts
git diff --numstat ee15e7e7 8265dc39 ->  1   20   packages/evaluation/src/mechanism-guidance.ts
```

The two numstat lines are identical, so the pair's entire diff is again that one file, and
the mechanism difference under test is unchanged. `packages/evaluation/src/mechanism-guidance.ts`
is also identical at `ee15e7e7` and at `2314ce1d` (`git diff --stat ee15e7e7 2314ce1d -- …` is
empty), so this is the same neutralization, not a similar one.

**Why `2314ce1d` and not the protocol-fix head `a85db6dc`.** The tradeoff was stated in the task:

- `a85db6dc` keeps the experiment's base narrow: only the two protocol fixes plus the guidance
  neutralization. Fewer confounders, closest to the original N1 intent.
- `2314ce1d` describes the harness **as it is now**, which is the point of the finding.

`2314ce1d` was chosen. Commits between `a85db6dc` and `2314ce1d` change runtime tool-call
behaviour, not just evaluation plumbing — `13c00e0b` (F7/R6: validate the tool protocol on the
serialized wire body before send) and `ef8dda86` (R3: reserve tool budget before dispatch, one
durable campaign deadline). An experiment that measures tool-call efficiency but excludes those
would still be measuring a harness that no longer exists, which is the exact defect being fixed.
Both arms share the base, so the paired contrast remains exactly the guidance text; the extra
R0–R7 evaluation churn is common to both arms and cancels in the delta.

## 3. Proof: ancestry AND content, in BOTH arms

Ancestry alone is not the claim. Measured with `git merge-base --is-ancestor` on each arm and
`git show <arm>:<path>` on each arm's **tree**:

| arm | P2-41 `9df60bd5` ancestor | P2-43 `a85db6dc` ancestor | `packages/contracts/src/message-protocol.ts` (`assertToolProtocol`) | `packages/contracts/src/tool.ts` (`TOOL_NAME_PATTERN`) | `apps/cli/src/benchmark-command.ts` (`MCP_DATA_SOURCE_TOOL`) |
| --- | --- | --- | --- | --- | --- |
| OLD baseline `8265dc39` | NO | NO | FILE ABSENT | SYMBOL ABSENT | SYMBOL ABSENT |
| OLD candidate `ee15e7e7` | NO | NO | FILE ABSENT | SYMBOL ABSENT | SYMBOL ABSENT |
| **NEW baseline `4f8d98ec`** | YES | YES | PRESENT | PRESENT | PRESENT |
| **NEW candidate `2314ce1d`** | YES | YES | PRESENT | PRESENT | PRESENT |

The old candidate is `NO` for P2-41 ancestry because it is P2-41's *predecessor*: the test is
"is this fix an ancestor of the arm", and it is not.

## 4. The five re-pinned sites

The task named four. A fifth site encodes the same pair with **no CLI override**, so leaving it
would have left the R5 measurement harness pointing at the stale arms; it is changed here and
declared rather than silently dropped.

| file | what was bound |
| --- | --- |
| `scripts/e4/r97-observe-arms.mjs` | `DEFAULT_BASELINE_SHA` / `DEFAULT_CANDIDATE_SHA` + the doc comment |
| `packages/evaluation/src/r97-driver-closed-loop.test.ts` | D6 `sourceSha` assertions and R101 defaults assertions |
| `.github/workflows/ci.yml` | `R97_ARM_BASELINE_SHA` / `R97_ARM_CANDIDATE_SHA` (R101 asserts the workflow literally contains the defaults) |
| `scripts/e4/r5-real-formal.mjs` | `DEFAULT_PAIR.expectedBaselineHead` / `expectedCandidateHead` (the fifth site) |
| `docs/evidence/E4-R15-arm-pair-repin.md` | this record |

Historical evidence documents that quote the old pair were deliberately **not** rewritten: they
are measurements of the old pair and stay true about it.

## 5. Measured closed loop on the new pair (Windows local)

Two REAL arm builds were prepared into `%TEMP%\r97-arms-r15pair`:

```text
node scripts/e4/r97-closed-loop.mjs --all --out .ci/r15-closed-loop --arms-root "$env:TEMP/r97-arms-r15pair"
[1/5] setup      OK  C:\Users\MECHREV\AppData\Local\Temp\r97-arms-r15pair
[2/5] acceptance OK  status=OFFLINE_ACCEPTED passes=6/16
[3/5] suite      FAILED  555/564 test(s)
CLOSED_LOOP_EXIT=1 ELAPSED_S=249
```

Both arms installed and built; `r97-observe-arms.mjs` asserts each arm's HEAD equals the
requested SHA before returning, so the observed SHAs are bound identities, not a restatement of
the defaults. The observed identity was asserted again by the D6 test and by the acceptance
summary (declared SHA == observed SHA on both arms).

**Plan digests are DISTINCT on the new pair** (the D6 assertion at
`r97-driver-closed-loop.test.ts:1689` and an independent probe through the shipped observer):

| arm | `sourceSha` | `clean` | `planDigest` |
| --- | --- | --- | --- |
| baseline | `4f8d98ec65d475844d3ed4b959a3199f84ed5d03` | true | `cec8c5826a251f70cb193887be9a6d9fc48966b3569abcd908296978b5717e84` |
| candidate | `2314ce1db40bfa10dc58b0d136e0696450e90cc8` | true | `f394c47af8899b96f5aa64dbcdbc2783e4c2d59d4fbfb07dfa946799c4ace7b3` |

Evidence observables from `acceptance/acceptance-summary.json` (offline, scripted provider):

| observable | value |
| --- | --- |
| `status` / `ok` | `OFFLINE_ACCEPTED` / `true` |
| `baselineSha` / `candidateSha` | `4f8d98ec…` / `2314ce1d…` (equal to the declared pair) |
| `executionMode` | `arm-worker` |
| `measuredUnits` / `skippedUnits` | 16 / 0 |
| `verifiedPasses` | 6 (`strongPasses` 0, `weakPasses` 6) |
| `logicalCalls` | 42 |
| `providerRequests` / `externalProviderCalls` | 0 / 0 |
| `paidStatus` / `promotable` / `realTwoVersionExperimentRan` | `PAID_NOT_RUN` / `false` / `false` |
| physical HTTP / paid spend / USD | `NOT_OBSERVED` (offline scripted provider; no billed call exists) |
| journal | per-arm reservations and settlement observed by the acceptance path; `logicalCalls=42`, no refund of a dispatched call in the passing rows |
| verifier | 6 verified passes, 6 of them weak (artifact-touch), 0 strong — **no model-quality claim is made** |

Targeted per-file run of the D6/R101 file against the two REAL arm directories:

```text
node node_modules/vitest/vitest.mjs run packages/evaluation/src/r97-driver-closed-loop.test.ts
Test Files  1 passed (1)
     Tests  77 passed (77)
TARGETED_D6_FILE_EXIT=0        (167.52s)
```

This includes `E4-R97 D6: … the two real arm builds MUST exist`, `… both arms are observed by the
real CLI dry-run and the plan FINALIZES`, `… R100 NEGATIVE CONTROL`, and
`R101: the arm-setup command EXISTS and agrees with the SHAs this file asserts`.

## 6. The nine suite failures are pre-existing, not caused by this change

`555/564` is not green, so the failure set was triaged rather than explained away.

- All 9 failures are in **one** file: `packages/evaluation/src/r97-arm-worker-contract.test.ts`.
  Nothing in the D6/R101 file failed (77/77 passed).
- The same file was run in the untouched base checkout `%TEMP%\r97-arms-r15pair\candidate`
  (detached at `2314ce1d`, clean tree, its own build):
  `Tests 9 failed | 39 passed (48)`, exit 1.
- The failing **test-name sets are identical** on the base tree and on the re-pin tree
  (`Compare-Object` over the two vitest JSON reports: no differences).
- The committed triage already records this file as a pre-existing Windows-local environment
  failure: `docs/evidence/current-prereg-status.md:273` (`r97-arm-worker-contract` — **9**),
  `docs/evidence/E4-full-suite-failure-triage.md`, `docs/evidence/prereg-N0-gap-matrix.md:145`.

The `--matrix` phase therefore reports `6/9` rows and `5/9` plan rows: every failing status
inside those rows belongs to `r97-arm-worker-contract.test.ts`. The matrix gate was **not** run on
the base tree — that row is `NOT_OBSERVED`, and the attribution rests on the identical failing
test set plus the committed triage, not on a base-tree matrix run.

## 7. Acceptance gates (Windows local)

| gate | literal command | exit | result |
| --- | --- | --- | --- |
| typecheck/build | `pnpm typecheck` | 0 | — |
| R0 gate | `pnpm exec vitest run --config apps/cli/test-infra/r0-gaps-vitest.config.ts apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | 0 | 16 passed (16) |
| n0-gaps | `pnpm test:n0-gaps` | 0 | 12 passed (12) |
| red-next-gaps | `pnpm test:red-next-gaps` | 0 | 14 passed (14) |
| D6/R101 file | `node node_modules/vitest/vitest.mjs run packages/evaluation/src/r97-driver-closed-loop.test.ts` | 0 | 77 passed (77) |

## 8. NOT_OBSERVED / BLOCKED

- **Ubuntu: NOT_OBSERVED.** Not run. No Ubuntu result may be inferred from the Windows numbers.
- **Remote publication: BLOCKED.** GitHub is unreachable (the user's proxy is down), so nothing
  was pushed. Both arms exist as local commits/branches in this checkout. Consequence, stated
  plainly: **CI cannot fetch `4f8d98ec` until `e4/r15-baseline-neutralized` is pushed**, so the
  `r97-r98-closed-loop` job's setup phase will fail as a SETUP failure (by design) until then.
  `2314ce1d` is already an ancestor of `main` and needs no branch.
- `closed-loop-identity.json` was **not** produced: the runner stopped after the failing suite
  phase, and the standalone `--matrix` run does not write it. Its fields (including
  `providerCalls`, `paidTwoVersionExperimentRan`) are therefore `NOT_OBSERVED` here; the
  equivalent fields were read from `acceptance-summary.json` instead.
- The paid two-version experiment did **not** run (`realTwoVersionExperimentRan=false`,
  `paidStatus=PAID_NOT_RUN`): no model-quality, cost or promotion claim is supported.
- `strongPasses = 0`: the offline fixture verifies weakly. Not upgraded, not relabelled.

## 9. Runtime Freeze (P38.4-11)

No runtime behaviour was changed. This change moves baseline SHAs, test assertions, a CI
environment binding, one script's expected-head defaults, and adds this document. The
sanctioned justification is a **release integrity defect**: the published comparable pair, which
the closed loop and CI bind as the experiment's identity, predated the protocol fixes P2-41/P2-43,
so the experiment's own identity did not describe the shipped harness. The fix is a re-pin, not a
runtime rewrite.
