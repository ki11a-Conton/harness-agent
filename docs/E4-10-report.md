# E4-10 Report: Single HEAD-Bound Gate Evidence + Honest Smoke Semantics

## Objective

Make capability, docs, release, and smoke all conclude from the **same current-HEAD
evidence source**, eliminating "command passed but the feature actually failed"
and "old ledger passed but the current release never ran". No paid model runs.

## Completion status

E4-10 is implemented across four commits: `3218be0` (generator), `576fd56`
(usage audit), `cd66ffa` (capabilities observed + generator wired + honest
smoke), `e2c59e5` (docs gate-command check).

## 1. GateEvidenceV2 real generator + production consumption

`packages/evaluation/src/gate-evidence-v2.ts`:

- `GateEvidenceV2` gained `providerCalls`, `environmentClass`, and
  `artifactRefs` (path + content digest, `null` when missing).
- `runGateV2` **runs** an allowlisted offline command, captures the **real exit
  code**, binds HEAD + cleanness before/after, digests the gate's output
  artifacts, and derives `passed` ONLY from (exit 0 AND every declared artifact
  present). A nonzero exit or a missing artifact yields `state=failed`, never a
  fabricated PASS.
- `writeGateEvidenceV2` persists atomically (temp + fsync + rename);
  `loadGateEvidenceV2` returns a `not_run` sentinel for a missing/unparseable
  file — a missing evidence file is never read as PASS.
- `verifyGateEvidenceV2` adds `PROVIDER_CALLS_ON_OFFLINE` (an offline gate must
  report 0 calls) and `MISSING_ARTIFACT_REF` (a PASS over a null-digest artifact
  is invalid).
- **Production consumer:** `release-artifacts.ts` step 9 now generates
  HEAD-bound evidence via `runGateV2` (injectable for tests), so the generator
  is genuinely wired, not just exported/tested.

## 2. Production usage audit (exported / tested / wired / observed)

`apps/cli/src/usage-audit.ts` classifies each key capability from on-disk
evidence — never a hand-maintained table:

| level | meaning |
|---|---|
| exported | re-exported from a package index |
| tested | referenced by a unit test |
| wired | referenced by a non-test production source (excluding the symbol's own definition file) |
| observed | exercised by a production-path e2e |

It reports the honest highest level + wired-by / observed-by files, so an
"exported but never wired" or "wired but never observed" gap is surfaced rather
than papered over. The auditor's own module is excluded (it lists symbols as
strings). Exposed as `agent usage-audit [--strict]` and
`pnpm e4:verify-production-usage` (--strict exits non-zero unless every key
capability is observed).

**Real-repo result: all seven key capabilities are OBSERVED** —
`createActivationRecorderV2`, `classifySecurityOutcomeV2`, canonical V3 writer,
strict promotion loader, `resolveChampionHarness`, durable `DurableRecoveryStore`,
and the `runGateV2` generator — each genuinely exercised by the e4-09 production
e2e (their real products asserted) or the release command.

## 3. Honest smoke semantics

`runSmokeBenchmark` is a **boot/health** gate and now says so: it fails when no
case ran, when a run **ERRORED** (infrastructure), or when token usage
accounting is broken. An adversarial case that correctly RESISTS (does not
"complete" a poisoned task) is NOT a smoke failure — that is its purpose. The OK
line names the boot-smoke semantics; the JSON summary's case status and the exit
code are consistent.

## 4. docs:verify — gate commands exist

`verifyDocs` adds a check that every release `GATE_COMMANDS` entry maps to a real
`package.json` script; a gate command referencing a missing script fails closed
(its evidence could never be produced).

## Negative tests added

- gate evidence: stale HEAD; hand PASS with nonzero exit; missing artifact ref
  (and a forged PASS over it); offline gate reporting provider calls; output
  changed but digest not updated; missing evidence file → NOT_RUN.
- usage audit: wired-not-observed reported honestly; exported-only flagged;
  absent symbol all-false.
- docs:verify: a gate command referencing a missing script fails closed.
- release artifacts: the gate-evidence artifact is recorded (produced/missing).

## Acceptance evidence

- `tsc -b` clean.
- Full suite green (see commit-time run).
- Real `usage-audit`: PASS (7/7 observed).
- Real `docs:verify`: exit 0 (ALL CHECKS PASS).
- Real `benchmark:smoke`: exit 0 with honest boot-smoke semantics.
- Working tree clean at each commit.

## Deliverables

- GateEvidenceV2 generator + atomic loader + extended verifier: complete.
- Production usage audit (exported/tested/wired/observed) + CLI command + script: complete.
- runGateV2 wired into the release-artifacts production path: complete.
- Honest smoke semantics: complete.
- docs:verify gate-command existence check: complete.
- E4-10 report: complete.

## Note on release:verify

`release:verify` already binds every gate to the exact release HEAD
(`STALE_HEAD` / `blocked` on a different headSha) and rejects command
substitution and exit/passed contradictions (P36-1 / P38.1 / P38.3). E4-10's
generator now feeds it HEAD-bound `GateEvidenceV2`; the "all NOT_RUN" condition
is resolved by producing real evidence per gate rather than hand-writing PASS.
