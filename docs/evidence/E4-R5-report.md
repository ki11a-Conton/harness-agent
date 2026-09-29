# E4-R5 — the real dual build inside formal `prereg run`

Branch `e4/r5-real-formal`. Driver HEAD at the time of these runs is printed in the
evidence JSON (`scripts/e4/r5-real-formal.mjs --all`). Zero paid requests, zero
external network, no credentials: the only provider is an in-process scripted
double, and the arms' own builds execute real tools and the real `TaskVerifier`.

## 0. What this task added

| Surface | Change |
| --- | --- |
| `apps/cli/src/prereg-arm-executor.ts` | A second DECLARED isolation posture, `trusted-build` / `no-os-network-sandbox`, that admits two REAL git checkouts. Before the child starts it proves, for BOTH arms: a 40-hex HEAD, a CLEAN work tree, a resolving execution closure, DIFFERING closures, a regular build entry (hashed), and — when the test host injected one — every field of a branded `TrustedBuildGrant` (canonical dir + HEAD + closure digest + entry hash). Git identity is now a property of the MODE, not of `R97_ARM_REQUIRE_GIT=1`. Untrusted checkouts still refuse with `EGRESS_ISOLATION_UNAVAILABLE`. |
| `apps/cli/src/prereg-production-runner.ts` | Forwards the optional `TrustedBuildGrant`. |
| `apps/cli/src/prereg-trusted-build.test.ts` | 11 acceptance/refusal cases, all in-process with ZERO provider calls on every refusal path. |
| `scripts/e4/r5-real-formal.mjs` | The acceptance harness: identity/ancestry, formal `prereg run` over the published real pair, the independent content-sensitive fixture, and the negative-refusal matrix. |

**The mode enters the pre-registration and the approval.** `isolationBackendId` /
`isolationStrength` live in the digest-bound artifact, and the authorization binds
`preregistrationDigest`; changing the posture changes the artifact digest and
invalidates the approval. No marker, env var or CLI flag can switch the posture on
— the grant is a branded in-process capability whose brand is a `Symbol`, so it
does not survive any JSON/env round trip (pinned by test `[R5.2]`).

**No sandbox is claimed.** `TRUSTED_BUILD_NETWORK_SANDBOX = "none"` and the strength
string itself is `no-os-network-sandbox`; the executor logs
`network sandbox=none` per arm run.

## 1. The published pair — and whether the arms contain the newest protocol fixes

Asked of each ARM's OWN git history (`git merge-base --is-ancestor <sha> HEAD`),
never of the driver's HEAD:

| Arm | HEAD | clean | closure digest (short) | P2-41 `9df60bd5` | P2-43 `a85db6dc` |
| --- | --- | --- | --- | --- | --- |
| baseline | `8265dc39f74b3d556e059bb86b1cc192357e21dd` | yes | `09c832a9124c…` | **NOT PRESENT** | **NOT PRESENT** |
| candidate | `ee15e7e7c65d9f62b5fc92d4d5cb69c97a3925fd` | yes | `6bdb2ce094a7…` | **NOT PRESENT** | **NOT PRESENT** |

Mechanism difference: the two arms are the same repository at two commits; the
candidate arm carries the mechanism under test and the baseline arm is the
purpose-built comparable baseline. The executor passes
`candidate = tool_call_efficiency_v1` only for the candidate arm, so the difference
is the arm BUILD, never a CLI flag.

**Consequence for the plan:** a formal experiment on THIS pair measures the
mechanism WITHOUT P2-41/P2-43. Updating the driver does not put those fixes into
the arms; an experiment that needs them must re-pin the arm SHAs and re-preregister.

## 2. The formal path (`prereg run`, release CLI code path)

`preregCmd(["run", …])` — the release CLI's own implementation — with the declared
`trusted-build` posture over the two real checkouts:

- exit 0, ADMITTED and executed: 5 frozen cases × 2 repetitions × 2 arms = **20 records**
- **20/20** records' evidence re-verified from the raw artifacts the arms wrote
- **60** model calls, all serviced by the in-process scripted double (0 HTTP, 0 paid)
- R2 cost journal: **total 1080, baseline 540, candidate 540, delta 0**, basis
  `JOURNAL_PER_ARM`, 30 requests per arm, 0 reserved-bound attempts; the aggregate's
  block equals this script's INDEPENDENT recomputation from the raw journal entries
  (`costMatches = true`)
- decision **REJECT** (`EFFECT_BELOW_THRESHOLD`, `SECURITY_BREACH`) — see §4

The **full declared schedule** (every frozen case) was driven through the same
command in the same mode: exit 0, **124 arm records**, **123/124** evidence
re-verified, decision **INVALID** (one record's evidence did not corroborate — the
honest result for an offline double that fails cases; it is reported, not smoothed
over).

Per-arm chain (from one real record): `record.armRunId` → `manifest.json`
(`armBuildDigest` = the arm's closure, `armEntrySha256` = the entry the child really
loaded, `armProbe` = the build's versioned mechanism probe) → the journal's
`requestId/attemptId/reservationId/basis` for that same `armRunId` → `verifier.json`.

## 3. The independent CONTENT-SENSITIVE fixture (non-holdout)

`benchmarks/r98-fixtures/r98-tool-write-request` exists OUTSIDE the frozen eight and
its own command verifier compares the exact bytes of `out/r98-request.txt`. Four
variants through each arm's OWN `runOneCase` (the entry the formal worker loads) and
the arm's own `ScriptedModelProvider`:

| Variant | baseline `8265dc39` | candidate `ee15e7e7` |
| --- | --- | --- |
| correct content | `passed` / `verified_complete`, 1 tool call, 0 verification failures | `passed` / `verified_complete` |
| empty file | `failed` / `verification_failed` (3 failures) | `failed` / `verification_failed` |
| wrong content | `failed` / `verification_failed` | `failed` / `verification_failed` |
| skipped write | `failed` / `verification_failed`, **0 tool calls** | `failed` / `verification_failed` |

`bothArmsContentSensitive = true`: a correct write PASSES and empty / wrong /
skipped writes FAIL, on BOTH genuine checkouts, with the REAL `TaskVerifier` doing
the deciding. The frozen eight are untouched; nothing is lifted by editing them.

## 4. Refusals BEFORE the provider step

Every row below is a `prereg run` invocation; `modelCalls` is the harness's own
count of provider `generate()` entries.

| Violation | Refusal | model calls |
| --- | --- | --- |
| swapped arms (grant vs checkout directory) | `TRUSTED_BUILD_NOT_PROVEN` — "not the directory the grant pinned" | 0 |
| dirty arm work tree | `TRUSTED_BUILD_NOT_PROVEN` — "the baseline checkout is DIRTY" | 0 |
| tampered decision policy | `PREREGISTRATION_IDENTITY_DRIFT` (policy digest) | 0 |
| real checkouts under the undeclared `process-exec` posture | `EGRESS_ISOLATION_UNAVAILABLE` | 0 |
| unsupported backend (`os-container/strict`) | `ARM_ISOLATION_UNSUPPORTED` | 0 |
| missing ABI (arm build without `R97_ARM_PROBE`) | see below — the E2E row is NOT isolated | 3 |

**The missing-ABI row is honestly downgraded.** In the end-to-end harness the ABI-less
arm is a temp copy whose bare `@ar/contracts` import cannot resolve (no
`node_modules`), so it refuses with `ERR_MODULE_NOT_FOUND` after 3 model-call
attempts — the wrong boundary, with calls. That row therefore does NOT evidence
"refused before the provider step". The ABI boundary IS pinned, with a measured zero,
by the in-process unit test `[R5.10]` (stub arm without the probe export → worker
refusal, `calls === 0`), which is the evidence cited for it.

The unit suite pins the same matrix in-process (`apps/cli/src/prereg-trusted-build.test.ts`,
11/11) including the POSITIVE path, which spawns the shipped worker against a stub
arm's own build entry and asserts the written manifest carries the arm build digest,
the entry hash the child loaded, and the build's own probe.

## 5. NOT_OBSERVED / BLOCKED — stated plainly

1. **A content-sensitive PASS through the FROZEN catalog inside the FORMAL run is
   NOT achieved.** The formal run executes every case's own verifier (its real
   command runs and exits non-zero: `node`/`python3` failures are recorded per
   case), but the offline scripted double does not SOLVE the frozen cases — they are
   `bugfix` cases whose verifiers `import('./src/…')` after the harness stages a
   fixture, and a single scripted write does not reproduce the required workspace
   state. Reaching a PASS there needs a real model (a real, and therefore paid,
   request) or a case-specific solve script; neither is claimed here. The
   content-sensitive PASS/FAIL discrimination is proven instead on the independent
   non-holdout fixture (§3), on the same two real checkouts, with the same real
   verifier.
2. **The bare `node apps/cli/dist/main.js prereg run …` cannot run offline at all.**
   R1 closed the fixture-bypass configuration: the release CLI has no way to inject
   a non-billable transport, and a paid admission needs a real price and cap. This
   harness therefore drives the SAME release command implementation
   (`preregCmd`) from a test composition root that injects the offline provider. The
   bare entry's refusal of untrusted checkouts is preserved and observed (§4). This
   is a deliberate security boundary, not a workaround.
3. **`realBuildOfflineReady` is NOT_PROVEN.** Two real pinned checkouts DID run, and
   the real verifier DID decide, but the pair predates P2-41/P2-43 (§1) and the
   frozen cases were not solved (§5.1). The legacy closed loop's 564/564 is NOT used
   as evidence here, and neither is the synthetic 124-request loop.
4. **Ubuntu was NOT run** (no Linux host in this session); everything above is
   Windows-local. The model event shapes, the git checks and the worker spawn are
   platform-neutral Node, but that is an assertion, not an observation.
5. The full 31-case formal schedule was attempted separately; its result is reported
   in the evidence JSON (`formalFull`) and is not a PASS for the same reason as §5.1.

## 6. Reproduction

```powershell
# from the worktree root, with the two arm checkouts present and a CLEAN tree
pnpm typecheck                                                    # exit 0
pnpm exec vitest run apps/cli/src/prereg-trusted-build.test.ts     # exit 0, 11 passed
node scripts/e4/r5-real-formal.mjs --identity                      # ancestry per arm
node scripts/e4/r5-real-formal.mjs --formal                        # formal small sample
node scripts/e4/r5-real-formal.mjs --content                       # 4-variant content fixture
node scripts/e4/r5-real-formal.mjs --negative                      # refusal matrix
```

The formal observer refuses a DIRTY checkout, so the positive phases require a clean
tree (`git status --porcelain` empty); `.ci/` is gitignored and holds the raw JSON.

---

# E4-R5 / S4 — the STRICT GATE (task-6, defect F5)

Everything ABOVE this line is the historical baseline and is deliberately left
unchanged, including its stale pair (`8265dc39`/`ee15e7e7`) and its numbers. This
section is the S4 round.

## N.0 Numbering, stated once

The F-numbers here use **`plan(20260929-015956).md`**'s numbering, which is the
numbering this report has always used. Under it:

- **F5 = the `scripts/e4/r5-real-formal.mjs` exit-code defect** — the subject of this
  section.
- **F6 = the readiness-classification defect**, already fixed and committed as
  `66082de` by the `readiness` owner.

The task BOARD's `task-2` subject line calls its own legacy-price defect "F6". That is
a different defect under a different numbering; it is not F6 here.

## N.1 Why the historical pair could not be reused

The historical pair is not merely old, it is **unusable for the formal chain**: neither
arm exports the versioned worker ABI that `apps/cli/src/r97-arm-abi.ts` declares
(`git show 2314ce1d:apps/cli/src/r97-arm-abi.ts` → *path exists on disk, but not in
`2314ce1d`*), so the formal worker boundary refuses both arms with
`ARM_WORKER_ABI_UNSUPPORTED` **before the first model request**. It is kept only as a
historical baseline.

The pair is now pinned in exactly ONE place, `scripts/e4/r5-formal-pair.json`
(`schemaVersion: e4-r5-formal-pair-v1`), which `r5-real-formal.mjs`,
`r97-observe-arms.mjs` (as `--pair r5`) and `apps/cli/src/r5-formal-gate.test.ts` all
read, so a re-pin is a one-file change that cannot be half-applied.

**The R97/R101 pair is deliberately NOT touched.** `DEFAULT_BASELINE_SHA` /
`DEFAULT_CANDIDATE_SHA` keep `4f8d98ec…` / `2314ce1d…`, because
`apps/cli/src/r97-driver-closed-loop.test.ts` asserts those two exact SHAs and the
historical manifests are load-bearing. The formal pair is a second, explicitly
selected pair (`--pair r5`).

### The pinned pair, as OBSERVED (not as claimed)

Both arms are real `git worktree` checkouts built by the committed
`scripts/e4/r97-observe-arms.mjs --pair r5` (real `git worktree add --detach <sha>` →
`pnpm install --prefer-offline` → `pnpm build` → clean-tree and built-entry
assertions):

| Arm | sourceSha (pinned) | observed HEAD | clean | execution closure (sha256) | worker ABI | P2-41 / P2-43 |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | `6d60920830e02a338ef6db34ac5f163cad1f1e09` | `6d60920830e0…` | yes | `29fd03e2f9ee6da61df273ec243235b2e1b0ed66617c529a67cd136e969be890` | `model-proxy-rpc-v1`, `tool-budget-rpc-v1` | present / present |
| candidate | `66082ded3fec1f7ce9734d891023bc39c52c09b1` | `66082ded3fec…` | yes | `d926e846544727c2b76b81f30b39e3694ad13d376999f44fcc963e2949c2c46f` | `model-proxy-rpc-v1`, `tool-budget-rpc-v1` | present / present |

`closuresDistinguishable = true`. Both arms carry the SAME S1/S2 infrastructure (both
declare both ABI strings), so the only difference under test is the mechanism.

**The complete arm diff is ONE file.** The baseline commit was created in an isolated
worktree from the candidate SHA and its entire diff is:

```
git diff --name-only 66082ded… 6d609208…
packages/evaluation/src/mechanism-guidance.ts
```

That single change sets `TOOL_CALL_EFFICIENCY_GUIDANCE_V1` to `[""].join("\n")` — the
pre-registered guidance neutralised, nothing else. The candidate carries **no extra
infrastructure fix**, which is what `allowedArmDiff` in the pair config asserts.

**The baseline commit is NOT an ancestor of product main** and is not required to be:
it is fetched by SHA (CI) or created locally by `r5-real-formal.mjs --setup-pair`. It
deliberately fails its own product-strategy assertions; that is the point of a
comparable baseline and must not be "fixed" on product main.

## N.2 The F5 defect, before and after

The pre-S4 script decided success from exactly ONE thing. Verbatim from
`git show ade2a53^:scripts/e4/r5-real-formal.mjs` (890 lines):

```js
return report.fatal === undefined ? 0 : 1;
```

`GATE FAIL` occurrences in that file: **0**. `verifyEvidenceBundle` occurrences: **0**.
Every assertion it made lived inside `report`, so a report recording a missing record, a
substituted "passed", a corrupted record, a deleted verifier, a journal mismatch or
incomplete evidence still **exited 0**, and a downstream job could not tell a passing
gate from a failed one without parsing prose.

The gate now (a) re-derives every claim from the RAW BYTES rather than a self-reported
count, and (b) turns every violation into a NAMED failure with a NONZERO exit.
`report.fatal` remains a failure, but it is no longer the only one.

### The named failure codes

| Code | What it means |
| --- | --- |
| `PAIR_NOT_PINNED`, `WRONG_PAIR`, `DIRTY_ARM`, `IDENTICAL_CLOSURE`, `CLOSURE_UNRESOLVABLE`, `PROTOCOL_FIX_MISSING`, `WORKER_ABI_MISSING`, `INFRASTRUCTURE_DIFF` | the pair is not the pinned, comparable, clean, ABI-complete pair |
| `IDENTITY_MISSING`, `IDENTITY_INVALID` | the bundle carries no usable build identity |
| `MISSING_RECORD` | the schedule planned N logical runs and carries fewer; the missing `case/arm/rep` triples are NAMED |
| `MISSING_EVIDENCE`, `INCOMPLETE_EVIDENCE` | an arm-run's evidence directory is absent, or a required member of it is |
| `CORRUPT_RECORD` | `traceDigest` ≠ `sha256(manifest bytes)` |
| `WRONG_AS_PASSED` | the record claims `verifiedCompletion` the raw verifier denies |
| `JOURNAL_MISMATCH` | `aggregate.cost` disagrees with the raw journal entries recomputed per the documented contract |
| `CONTENT_MATRIX_INCOMPLETE` | a four-variant cell is missing — the case is NOT deleted; the missing variant is NAMED |
| `CONTENT_CORRECT_FAILED` | the correct variant did not pass its own content verifier |
| `CONTENT_INSENSITIVE` | a degradation variant PASSED, so the result cannot support a strategy claim |
| `NEGATIVE_ROW_MISSING`, `NEGATIVE_ACCEPTED` | a required counter-example is absent, or was accepted |
| `NEGATIVE_WRONG_REASON` | a counter-example was refused by an UNRELATED condition, so it evidences nothing about the boundary it names |
| `MISSING_ABI_REACHED_MODEL`, `POLICY_OR_ISOLATION_UNREFUSED` | the boundary under test was crossed |
| `UNEXPLAINED_INFRA_ERROR` | an infrastructure error with no reason |
| `BUNDLE_ERROR`, `FATAL` | the run itself failed |

`--verify <bundleRoot>` re-verifies a KEPT bundle from its bytes alone, in any
directory; `--verify-pair-observations <json>` verifies pair observations;
`--emit-fixture-bundle <dir>` writes a labelled `fixture: true` bundle used only by the
counter-example suite.

**What the gate does NOT prove.** `verifyEvidenceBundle` proves a bundle is CONSISTENT
WITH ITSELF and with the pinned pair. It does NOT prove a real experiment ran — a
synthetic fixture can be perfectly consistent, which is exactly why the bundle carries
`fixture: true|false`, and why the report keeps `realModelQuality: "NOT_RUN"` and
`promotion: "NOT_RUN"` separate from `gate.passed`.

## N.3 What was RUN, and what the gate said

Driver HEAD `ad8aa8e5981f0b3f313c6515ec3e37cd503bf892`, `treeClean: false` (the shared
multi-agent work tree holds uncommitted work from other owners).

```
node scripts/e4/r97-observe-arms.mjs --pair r5 --root %TEMP%\r97-arms-r5pair
  → exit 0; both arms prepared and built
node scripts/e4/r5-real-formal.mjs --identity --formal --negative \
     --evidence-dir .ci\r5-evidence --out .ci\r5-real-formal.json
```

Observed:

- **identity — REAL and PASSING for both arms**: real HEADs, clean trees, differing
  closures, both ABI strings, P2-41 and P2-43 present in each arm's own history.
- **formal — BLOCKED, and the gate says so.** `formal-small: exit=1 cases=5 records=0
  verified=0 modelCalls=0`. The formal chain refuses to execute because the DRIVER work
  tree is not clean: `REFUSED (PREREGISTRATION_IDENTITY_DRIFT)` — *"execution identity
  drifted from the pre-registration: worktree: not clean (a run must execute from an
  exact, unmodified source)"*. That is the documented `require-clean` behaviour of the
  real observer, not a defect.
- **negatives — 6/6 "refused" with 0 model calls, but the gate REFUSES to count them.**
  All six rows were refused with `PREREGISTRATION_IDENTITY_DRIFT` (the dirty driver
  tree) rather than the code each violation must produce, so the gate reports
  `NEGATIVE_WRONG_REASON` for 5 of them. This is the finding of the round and is
  described next.

**The gate exited NONZERO with 27 NAMED failures** (and `gate.passed: false`), where the
pre-S4 script would have exited **0** on the same run. That contrast is defect F5, fixed
and demonstrated:

```
MISSING_RECORD           1
JOURNAL_MISMATCH         1
CONTENT_MATRIX_INCOMPLETE 16
CONTENT_CORRECT_FAILED   4
NEGATIVE_WRONG_REASON    5
```

The kept bundle (`.ci/r5-evidence`, gitignored): `identity.json`, `schedule.json`,
`content-matrix.json`, `negatives.json`, `report.json`. `schedule.json` records 0
records against a plan of 20 logical runs, which is why `MISSING_RECORD` fires; no
evidence directory, no cost journal and no `aggregate.json` were produced, so
`JOURNAL_MISMATCH` and the `CONTENT_MATRIX_INCOMPLETE` cells follow from the same cause
and are reported rather than suppressed.

## N.4 The real defect this round FOUND

A negative matrix of rows that merely "refused" is worthless: one environmental
condition — a dirty driver work tree — refuses **every** row with
`PREREGISTRATION_IDENTITY_DRIFT`, so all six rows looked like passing counter-examples
while proving nothing about swapped arms, the missing ABI, the policy digest, the
undeclared posture or the unsupported backend. The first real run of this round did
exactly that and the gate caught it:

```
GATE FAIL NEGATIVE_WRONG_REASON: the "missing-ABI (arm build without R97_ARM_PROBE)" row
  was refused with PREREGISTRATION_IDENTITY_DRIFT but this violation must produce
  ARM_WORKER_ABI_UNSUPPORTED; the refusal is not evidence for this boundary
```

The fix is `EXPECTED_REFUSAL_CODES` in the producer plus the `NEGATIVE_WRONG_REASON`
check in the gate; a row with no expectation is reported, never passed silently.

## N.5 The counter-example suite

`apps/cli/src/r5-formal-gate.test.ts` — **25 passed / 25**, under the repo's normal
`apps/*/src/**/*.test.ts` include pattern with **no `vitest.config.ts` change**. It
drives the gate as a SUBPROCESS, because the thing under test is the exit code and the
NAMED reason, not an in-process return value. Each case copies the consistent fixture,
breaks exactly ONE invariant, and asserts a NONZERO exit plus the specific code:
missing record, wrong-as-passed substitution, corrupted record, deleted verifier,
absent evidence directory, journal mismatch, unexplained infrastructure error,
content-insensitive matrix, incomplete matrix, correct-variant failure, missing-ABI
reaching the model, wrong reason, no expectation, wrong pair, identical closure, dirty
arm, unrefused isolation/policy, missing ABI declaration, plus re-verification of a
bundle copied to a DIFFERENT directory and the pair-config agreement with
`r97-observe-arms.mjs` (including that the R97 pair is untouched).

```
npx tsc -b                                          → exit 0
npx vitest run apps/cli/src/r5-formal-gate.test.ts   → 25 passed (25)
```

## N.6 NOT_RUN / NOT_PROVEN — stated plainly

1. **The positive formal path did NOT run in this session.** The real observer requires
   a CLEAN driver work tree and the shared workspace is dirty by design. `records=0`,
   `modelCalls=0`. This is BLOCKED on a clean checkout, not on the gate.
2. **The four-variant content matrix did NOT run.** `--content-matrix` schedules
   correct/empty/wrong/skipped through the actual formal chain (`phaseFormal` per mode),
   but it needs the same clean tree. Every cell is therefore `absent` and the gate says
   `CONTENT_MATRIX_INCOMPLETE` rather than reporting a pass.
3. **The missing-ABI counter-example is NOT evidenced here.** Its row was refused by the
   dirty tree, so it carries no measurement of the ABI boundary. The ABI boundary's
   measured-zero evidence remains the in-process `[R5.10]` unit test cited in §4 above.
4. **No real dual build of the arms was verified end-to-end inside a formal run** — the
   arms WERE really built and really observed (N.3), but the formal chain never reached
   the worker boundary because it refused first.
5. **Real model quality: NOT_RUN. Promotion: NOT_RUN.** `gate.decision` is `null`; a
   passing gate would still not be an experiment decision of ACCEPT.
6. **Ubuntu was NOT run** (no Linux host); everything above is Windows-local.
7. **CI does not invoke `r5-real-formal.mjs`.** `.github/workflows/ci.yml` runs the A7a
   release-CLI POS-REFUSE step and `r97-closed-loop.mjs --all`; a formal-gate step must
   be added by its owner (the workflow file is outside this task's write scope). A CI
   step needs `--pair r5` arms, `--evidence-dir`, and an upload of that bundle.

## N.7 Reproduction

```powershell
node scripts/e4/r97-observe-arms.mjs --pair r5 --root "$env:TEMP\r97-arms-r5pair"
node scripts/e4/r5-real-formal.mjs --verify-pair-observations <obs.json>   # pair only
node scripts/e4/r5-real-formal.mjs --identity --formal --content-matrix --negative `
     --evidence-dir .ci\r5-evidence --out .ci\r5-real-formal.json
node scripts/e4/r5-real-formal.mjs --verify .ci\r5-evidence                 # re-verify
npx tsc -b                                                                  # exit 0
npx vitest run apps/cli/src/r5-formal-gate.test.ts                          # 25 passed
```

To unblock N.6.1/2/3 the driver work tree must be clean; in CI that is a fresh
checkout, which is why the gate is designed to be run there rather than in a shared
working directory.

