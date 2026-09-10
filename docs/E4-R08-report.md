# E4-R08 Report — `observed` from runtime evidence, post-startup behavior proven

## Defect (F17) and fix

`observed` was inferred by scanning files whose NAME matched `e2e|production-e2e`
and whose SOURCE mentioned the symbol — a one-line comment in a file named
`not-real-e2e.test.ts` made `fictionalCapability` "observed". Now `observed` is
decided **only** from `ObservationEvidence` rows:

- written by a real passing production-path test AFTER its assertions hold;
- carrying `capabilityId`, `symbol`, `entrypoint`, `testFile`, `testName`,
  `testedSourceSha` (git HEAD at run time), `runStatus: "passed"`, `invocation`
  (what actually ran), and a row `evidenceDigest`;
- matched in the audit against the audited HEAD: a failed, skipped or
  stale-SHA row is a hard reject; no evidence ⇒ not observed.

The audit still reports exported/tested/wired from static references — those
separate levels keep their meaning — but they never decide `observed`
(`usage-audit.ts`).

## Evidence generation → consumption (the exact commands)

```bash
# 1. GENERATE: run the real production-path chain; it records 7 observation rows
E2E_OBSERVATION_EVIDENCE=<path> npx vitest run apps/cli/src/e4-09-production-e2e.test.ts

# 2. CONSUME: the audit reads that evidence and marks observed only from it
E2E_OBSERVATION_EVIDENCE=<path> node apps/cli/dist/main.js usage-audit --strict
```

Without step 1 the strict audit FAILS by design (the plan allows this; we do not
lower strictness to force exit 0).

## Capability → entrypoint → runtime observation → result

| capability | entrypoint | runtime observation (what actually ran) | test result |
|---|---|---|---|
| createActivationRecorderV2 | benchmark | real paired benchmark produced candidate `activationEvidence` rows | PASS |
| classifySecurityOutcomeV2 | benchmark | real paired benchmark produced `securityOutcome` records | PASS |
| canonical V3 writer | benchmark | executor's in-process canonical V3 strict-reloaded from disk | PASS |
| strict promotion loader | cli | real envelope bundle verified (artifact refs + decision replay) | PASS |
| resolveChampionHarness | cli | `createHarnessWithChampion` resolved + applied the champion (status applied) | PASS |
| durable RecoveryStore | cli | `createHarness(dataDir)` INJECTED `DurableRecoveryStore` into the actor; put/get on **that** instance | PASS |
| GateEvidenceV2 generator | release | `runGateV2` ran real commands (exit 0 / exit 2), real exit codes + gitSha + providerCalls=0 | PASS |

Durable-store observation uses the harness-injected instance
(`startup.harness.recoveryStore`), never a freshly constructed look-alike.

## Post-startup behavior (startup-verified, per the deliverable's second half)

- CLI startup: applied budget-aware champion's main agent prompt contains the
  installed guidance; a REAL turn's provider request carries it
  (`champion-application-r05.test.ts`).
- Web startup: same install assertion on the `web` entrypoint
  (`champion-application.integration.test.ts`).
- **Negative**: if the mechanism install is removed (config built without
  `completionGuidance`), application FAILS — the E2E fails, never applied on
  flags alone.

## Tests (F17 negatives + evidence lifecycle)

`usage-audit.test.ts` (+3):

```text
F17 five static classes (comment, string, import, typeof, file name) -> observed=false
failed / skipped / stale-SHA rows -> observed=false
passed + sha-matched row -> observed=true
```

Integration (`champion-application.integration.test.ts` +2) + the e4-09 chain
writing the 7 rows. Whole flow verified end-to-end:

```text
tsc -b clean; usage-audit 10/10; e4-09 5/5; integration 11/11
strict audit against fresh e2e evidence: PASS 7/7, exit 0
```

## Explicit non-claims

- Mock-isolation evidence is NOT presented as OS-confinement proof: the e2e
  chain uses an injected strong-isolation probe; a real-backend confinement test
  remains BLOCKED/NOT_RUN on this host (no bwrap), and would be reported as such
  (R09/collector concern), never as a mock-pass.
- The observation records are produced + consumed by the commands above; the
  audit does not read its own output to prove itself.