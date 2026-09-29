# S0b / F3 — forged readiness JSON counter-example (task-9) and its fix (task-7)

Plan: `plan(20260929-015956).md` §4 item 5 and Appendix B (§1-4), §10 (S6, §6 below).

Status of this note: **the counter-example was established by task-9 (RED at
`f23de8e`) and the defect it demonstrated was fixed by task-7/S6. §1-4 are the
as-measured BEFORE record and are kept unchanged; §5 states what this does NOT
establish; §6 is the AFTER-fix replay of the byte-identical input.**

- Repository: `D:\Harness Agent`
- BEFORE run SHA: `f23de8edcfb32d53fbed9cb12202d5f32cbf8e28` (task-9, RED capture)
- AFTER run SHA: `75cb09e7aa72e9d1e41f051751bc08b4d0be91da` (task-7, fix)
- Platform: Windows 11, `process.platform = win32`, Node `v24.18.1`
- Script under test: `scripts/e4/ci-readiness.mjs` — **UNMODIFIED during the BEFORE
  capture** (that capture is the reproducer); MODIFIED by task-7 for the AFTER capture
- Offline: local files and local child processes only. Zero provider, zero key, zero
  network, zero cost.

## 1. The frozen forged input

Every field `verifyRealEvidence()` reads is present and self-reportedly good, so the
script cannot bail early on an unrelated missing field. Only three things are absent —
exactly the three that must be real:

| dimension | forged value |
| --- | --- |
| `executionKind` | `REAL_DUAL_PINNED_BUILD` (a real, known enum) |
| `dualBuild.baselineArm.sourceSha` / `candidateArm.sourceSha` | two distinct 40-hex SHAs (`a…a`, `b…b`) |
| `dualBuild.baselineArm.buildDigest` / `candidateArm.buildDigest` | `"x"` for **both** arms |
| `dualBuild.verifier` | `{ ran: true, casesVerified: 1, casesTotal: 1 }` |
| `commandExits` | `{ typecheck: 0, test: 0, build: 0 }` |
| `ok` | `true` |
| `ciRunSha` | the current HEAD (so `SHA_MISMATCH` cannot mask the target failure) |
| `os` | `"windows-latest"` |
| artifact `runId` | **absent** |
| raw arm / verifier / journal files | **none exist anywhere** |

The caller still passes `--run-id 36540000000`, exactly as the reviewer did: the defect
is that the ARTIFACT's own run identity is never required (L207-210 accepts the
caller-supplied value in its place).

Raw input, verbatim (one line, as passed to `--e2e`):

```json
{"ok":true,"positiveExecution":{"providerFactoryCalls":0,"physicalProviderCalls":124,"ledgerCommitted":124,"journalChargedTokens":248,"evidenceVerified":124,"evidenceUnverified":0,"decision":"INCONCLUSIVE"},"positiveForward":{"physicalStubRequests":124,"ledgerCommitted":124,"journalChargedTokens":248,"aggregateTokensTotal":248,"aggregateTokensDelta":-60,"aggregateTokensBaseline":100,"aggregateTokensCandidate":40,"independentTokens":{"delta":-60},"costMatchesJournal":true},"ciRunSha":"f23de8edcfb32d53fbed9cb12202d5f32cbf8e28","os":"windows-latest","commandExits":{"typecheck":0,"test":0,"build":0},"dualBuild":{"baselineArm":{"sourceSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","buildDigest":"x"},"candidateArm":{"sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","buildDigest":"x"},"verifier":{"ran":true,"casesVerified":1,"casesTotal":1}},"readiness":{"productionOfflineReadiness":{"executionKind":"REAL_DUAL_PINNED_BUILD"}}}
```

This object is frozen in the test as `forgedF3E2e()`. Task-7 (S6) must replay **the same
object unchanged**, so the before/after pair is comparable.

## 2. Reproduction — exact command and raw result

```
node "D:\Harness Agent\scripts\e4\ci-readiness.mjs" --e2e "<tmp>\e2e.json" --out "<tmp>\readiness.json" --os-label windows-local --run-id 36540000000
```

Exit code `0`. The three nested gates (`pnpm test:n0-gaps`, `pnpm test:red-next-gaps`,
docs smoke) were neutralised by a `pnpm` shim first on `PATH`, exactly as the test does;
this counter-example targets the CLASSIFICATION, not the gates.

Raw output, verbatim — `levels.realBuildOfflineReady`:

```json
{
  "status": "PASS",
  "basis": "two real pinned checkouts built from distinct source SHAs, verified from the artifact's own evidence (R7)",
  "blocker": null,
  "evidence": {
    "executionKind": "REAL_DUAL_PINNED_BUILD",
    "executionKindSource": "readiness.productionOfflineReadiness.executionKind",
    "realDeclaration": true,
    "failures": []
  }
}
```

Process stdout summary (verbatim):

```text
prereg-ci-readiness (SEPARATED levels — no single overall PASS)
  ciRunSha: f23de8edcfb32d53fbed9cb12202d5f32cbf8e28
  expectedSha: f23de8edcfb32d53fbed9cb12202d5f32cbf8e28
  runId: 36540000000
  os: windows-local (node v24.18.1)
  fixtureProtocolReady: PASS
  realBuildOfflineReady: PASS
  budgetEvidenceReady: NOT_PROVEN
  paidExperimentRun: NOT_RUN
  championPromotion: NOT_RUN
  execution kind: REAL_DUAL_PINNED_BUILD (readiness.productionOfflineReadiness.executionKind)
  forward basis: REAL_DUAL_PINNED_BUILD
  platforms: this=windows windows=MEASURED ubuntu=NOT_OBSERVED cross=NOT_OBSERVED
```

Directory contents after the run (no raw evidence file was read or written):

```text
\bin
\e2e.json
\readiness.json
\bin\pnpm
\bin\pnpm.cmd
```

This matches the reviewer's Appendix B record exactly
(`inputHasRunId=false`, `inputBuildDigests=["x","x"]`, `status="PASS"`, `failures=[]`).

## 3. Why the classifier accepts it

`verifyRealEvidence()` in `scripts/e4/ci-readiness.mjs`:

- L220-221 — `buildDigest` is checked with `isNonEmptyString` only. `"x"` passes; no
  digest FORMAT is required and no raw file is hashed or compared.
- L207-210 — `runId` is satisfied by `--run-id`/`GITHUB_RUN_ID`. The artifact's own
  `runId` is only compared when it happens to be present, so omitting it is free.
- L195-240 — no arm, verifier, journal, manifest, aggregate or schedule file is ever
  opened, named or hashed. A successfully parsed JSON object is treated as evidence.

## 4. The RED test

`apps/cli/src/r0-f6-ci-readiness-classification.test.ts`
→ `S0b-F3-RED: forged REAL JSON with buildDigest 'x', no raw evidence and no artifact runId must not PASS`

It runs the real script as a real child process with the frozen input above and asserts
the CORRECT behaviour:

1. `realBuildOfflineReady.status !== "PASS"`;
2. the refusal names the missing ARTIFACT run identity (`/run[ _-]?id/i`);
3. the refusal names the malformed build digest (`/digest/i`);
4. the refusal names the absent raw evidence (`/evidence|raw|bundle|manifest/i`);
5. no arm/verifier/journal/manifest/aggregate/schedule file was created for the run;
6. the forged input really has no `runId` and no evidence root.

No `test.fails`, no `skip`, no inverted assertion. A 120 s `spawnSync` watchdog makes a
wedged child fail instead of hanging CI.

Measured RED run (`npx vitest run apps/cli/src/r0-f6-ci-readiness-classification.test.ts`):

```text
 ❯ apps/cli/src/r0-f6-ci-readiness-classification.test.ts (18 tests | 1 failed) 12686ms
     ✓ R0-F6-0 … ✓ R7-F6-P   (17 passed)
     × S0b-F3-RED: forged REAL JSON with buildDigest 'x', no raw evidence and no artifact runId must not PASS 513ms

AssertionError: expected 'PASS' not to be 'PASS' // Object.is equality
 ❯ apps/cli/src/r0-f6-ci-readiness-classification.test.ts:543:31
    543|     expect(level?.status).not.toBe("PASS");

 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

The failure is assertion 1 — the TARGET behaviour — not an import/build/collection error
and not a missing-field parse error. Assertions 2-4 are the acceptance spec for task-7
and will only be reached once assertion 1 holds.

## 5. What this counter-example does NOT establish

- It is a counter-example against a local hand-written artifact. It does **not** claim any
  real CI artifact was forged, and it never changed the honest `BLOCKED` that the current
  GitHub CI artifacts report.
- It proves nothing about Ubuntu: the whole capture is Windows-local. Ubuntu is `NOT_RUN`.
- It is not evidence of a real dual build. No provider and no tool was executed; the
  network request count is 0.
- `paidExperimentRun` and `championPromotion` stay `NOT_RUN` — an offline readiness PASS
  never authorizes a paid run or a promotion.
- The classifier it exercises is a **trusted-CI-artifact** integrity check. It does not
  claim that an arbitrary bundle of JSON from an untrusted source is unforgeably
  authentic; it claims that the raw bytes a trusted run wrote are internally consistent
  with the claims made about them.

The defect this counter-example demonstrated (self-reported JSON rendering
`realBuildOfflineReady = PASS`) was fixed in task-7/S6 — see §6.

## 6. AFTER fix (task-7 / S6)

The counter-example was replayed with the **byte-identical** frozen input of §1 against the
MODIFIED `scripts/e4/ci-readiness.mjs`. The only added flag is `--expect-sha`, which pins
the same condition the RED capture ran under (at RED time `expectSha` defaulted to the
then-HEAD, which equalled the artifact's `ciRunSha`; HEAD has since moved to `75cb09e`, so
the SHA is now passed explicitly to keep the comparison like-for-like instead of
introducing an unrelated `SHA_MISMATCH`).

```
node "D:\Harness Agent\scripts\e4\ci-readiness.mjs" --e2e "<tmp>\e2e.json" --out "<tmp>\readiness.json" \
  --os-label windows-local --run-id 36540000000 --expect-sha f23de8edcfb32d53fbed9cb12202d5f32cbf8e28
```

Exit code `0` (report mode). Process stdout, verbatim:

```text
prereg-ci-readiness (SEPARATED levels — no single overall PASS)
  ciRunSha: 75cb09e7aa72e9d1e41f051751bc08b4d0be91da
  expectedSha: f23de8edcfb32d53fbed9cb12202d5f32cbf8e28
  runId: 36540000000
  os: windows-local (node v24.18.1)
  fixtureProtocolReady: PASS
  realBuildOfflineReady: NOT_PROVEN
  budgetEvidenceReady: NOT_PROVEN
  paidExperimentRun: NOT_RUN
  championPromotion: NOT_RUN
  execution kind: REAL_DUAL_PINNED_BUILD (readiness.productionOfflineReadiness.executionKind)
  forward basis: REAL_DUAL_PINNED_BUILD
  platforms: this=windows windows=MEASURED ubuntu=NOT_OBSERVED cross=NOT_OBSERVED
  real-build evidence failures: 6
    - NO_ARTIFACT_RUN_ID: the artifact carries no runId, so the run identity of its evidence cannot be established (a caller-supplied --run-id is not a substitute)
    - NO_ARTIFACT_ATTEMPT: the artifact carries no attempt number
    - NO_ARTIFACT_PLATFORM: the artifact carries no platform
    - BASELINE_BUILD_DIGEST_MALFORMED: dualBuild.baselineArm.buildDigest is not a 64-hex sha256 (got "x")
    - CANDIDATE_BUILD_DIGEST_MALFORMED: dualBuild.candidateArm.buildDigest is not a 64-hex sha256 (got "x")
    - NO_RAW_EVIDENCE: no --evidence-root was supplied, so no raw arm/verifier/journal file was read and the self-reported fields above are uncorroborated
```

Raw output, verbatim — `levels.realBuildOfflineReady`:

```json
{
  "status": "NOT_PROVEN",
  "basis": "execution kind declares REAL_DUAL_PINNED_BUILD but its evidence did not verify against the raw evidence root, so this level is NOT_PROVEN (S6/F3: a forged enum and a self-reported digest are not a real build)",
  "blocker": "REAL_EVIDENCE_UNVERIFIED: NO_ARTIFACT_RUN_ID: the artifact carries no runId, so the run identity of its evidence cannot be established (a caller-supplied --run-id is not a substitute); NO_ARTIFACT_ATTEMPT: the artifact carries no attempt number; NO_ARTIFACT_PLATFORM: the artifact carries no platform; BASELINE_BUILD_DIGEST_MALFORMED: dualBuild.baselineArm.buildDigest is not a 64-hex sha256 (got \"x\"); CANDIDATE_BUILD_DIGEST_MALFORMED: dualBuild.candidateArm.buildDigest is not a 64-hex sha256 (got \"x\"); NO_RAW_EVIDENCE: no --evidence-root was supplied, so no raw arm/verifier/journal file was read and the self-reported fields above are uncorroborated",
  "evidence": {
    "executionKind": "REAL_DUAL_PINNED_BUILD",
    "executionKindSource": "readiness.productionOfflineReadiness.executionKind",
    "realDeclaration": true,
    "evidenceRoot": null,
    "failures": [
      "NO_ARTIFACT_RUN_ID: the artifact carries no runId, so the run identity of its evidence cannot be established (a caller-supplied --run-id is not a substitute)",
      "NO_ARTIFACT_ATTEMPT: the artifact carries no attempt number",
      "NO_ARTIFACT_PLATFORM: the artifact carries no platform",
      "BASELINE_BUILD_DIGEST_MALFORMED: dualBuild.baselineArm.buildDigest is not a 64-hex sha256 (got \"x\")",
      "CANDIDATE_BUILD_DIGEST_MALFORMED: dualBuild.candidateArm.buildDigest is not a 64-hex sha256 (got \"x\")",
      "NO_RAW_EVIDENCE: no --evidence-root was supplied, so no raw arm/verifier/journal file was read and the self-reported fields above are uncorroborated"
    ],
    "bundle": null
  }
}
```

### 6.1 Before → after

| dimension | BEFORE (task-9, HEAD `f23de8e`) | AFTER (task-7, HEAD `75cb09e`) |
| --- | --- | --- |
| `realBuildOfflineReady.status` | **`PASS`** | **`NOT_PROVEN`** |
| `realBuildOfflineReady.blocker` | `null` | `REAL_EVIDENCE_UNVERIFIED: <6 reasons>` |
| `evidence.failures` | `[]` | 6 independent reasons |
| missing ARTIFACT run id | not checked (caller `--run-id` accepted in its place) | `NO_ARTIFACT_RUN_ID` |
| missing attempt / platform | not checked | `NO_ARTIFACT_ATTEMPT`, `NO_ARTIFACT_PLATFORM` |
| `buildDigest: "x"` | non-emptiness check passed | `BASELINE_/CANDIDATE_BUILD_DIGEST_MALFORMED` (64-hex required) |
| raw evidence files | never opened or named | `NO_RAW_EVIDENCE` |
| `budgetEvidenceReady` | `NOT_PROVEN` (hardcoded) | `NOT_PROVEN` (computed: no bundle verified) |
| `paidExperimentRun` / `championPromotion` | `NOT_RUN` | `NOT_RUN` (unchanged) |

The three refusal dimensions the task-9 acceptance required are each independent:
run identity, digest legality, and absent raw evidence.

### 6.2 What the fix is, and what it deliberately does NOT claim

The classifier now corroborates a REAL declaration against raw bytes under `--evidence-root`
(`scripts/e4/readiness-evidence-verify.mjs`): path confinement, the artifact's own
`runId`/`attempt`/`platform`, a 64-hex `buildDigest` that must EQUAL the raw `identity.json`,
per-arm A6 re-verification via `verifyArmEvidenceFromArtifacts`, and a cost-journal
recompute. `budgetEvidenceReady` is computed from those checks instead of hard-coded.

Still genuinely unproven, and reported as such:

- **The request/dispatch-journal cross-binding** (`armRunId <-> requestId <-> attemptId <->
  reservationId`, dropped retries, duplicate settlements, tool unknowns) is **deferred**
  until S4's bundle contract exists. It is emitted as
  `REQUEST_DISPATCH_JOURNAL_NOT_BOUND` / `NOT_PROVEN` — never silently dropped, and never
  promoted to PASS because the code was written.
- **Fixture values can never be promoted to a real dual build.** A synthetic bundle renders
  `realBuildOfflineReady = PASS` only when its raw identity, both arm closures and every
  per-arm artifact really verify; the readiness artifact still carries no top-level `ok`,
  and `paidExperimentRun` / `championPromotion` remain `NOT_RUN`.
- **No real dual build was produced and no paid experiment was run.** Ubuntu is `NOT_RUN`.
  This proves the integrity and internal consistency of a trusted CI artifact, not that a
  real dual build exists.

