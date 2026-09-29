# S0b / F3 — forged readiness JSON counter-example (task-9)

Plan: `plan(20260929-015956).md` §4 item 5 and Appendix B.
Status of this note: **counter-example established. F3 is NOT fixed by this task.**

- Repository: `D:\Harness Agent`
- Run SHA (HEAD, working tree otherwise clean except the untracked plan file): `f23de8edcfb32d53fbed9cb12202d5f32cbf8e28`
- Platform: Windows 11, `process.platform = win32`, Node `v24.18.1`
- Script under test: `scripts/e4/ci-readiness.mjs` — **UNMODIFIED** (`git diff --stat` shows no change to it)
- Offline: local files and local child processes only. Zero provider, zero key, zero network, zero cost.

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

## 5. What this does NOT establish

- **F3 is not fixed.** `scripts/e4/ci-readiness.mjs` is unmodified; the classifier still
  renders `realBuildOfflineReady = PASS` for this input.
- This is a counter-example against a local hand-written artifact. It does **not** claim
  any real CI artifact was forged, and it does not change the honest `BLOCKED` that the
  current GitHub CI artifacts report.
- `budgetEvidenceReady` stays `NOT_PROVEN`, `paidExperimentRun` / `championPromotion`
  stay `NOT_RUN`. Nothing here was measured on Ubuntu.
- The RED test makes the existing CI step `R7 — F6 readiness classification gate`
  (`.github/workflows/ci.yml` L192-193) fail until task-7 lands. Plan §4 item 6 allows
  the counter-example and its fix in one change; the Lead owns that sequencing.
