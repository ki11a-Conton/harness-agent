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
