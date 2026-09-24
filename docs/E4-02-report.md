# E4-02 — Real Paired Benchmark Emits Canonical V3 In-Process

**Status: DONE.** The paired executor's real outcomes now feed the single V3
writer directly; `paired-to-v3.mjs` is no longer a required production step.
**Branch:** `e4-production-closure` · **Commits:** `38f2611` (part 1), `de41911`
(script fix), part 2 (eventRecords) · **Offline:** providerCalls = 0.

## Scope (from plan §E4-02)

Eliminate the lossy, guess-based `paired-experiment.json → V3` manual
conversion so the real paired executor's events go straight into the one
canonical V3 writer. No re-implementation of the paired executor; no real model.

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Paired benchmark writes `ExperimentArtifactV3` directly | ✅ `runPairedPromotion` builds + writes + strict-reloads both arms |
| 2 | `paired-to-v3.mjs` not a required production step | ✅ nothing in `apps/cli/src` calls it; in-process sink replaces it |
| 3 | No guessed provider/model/runtimeConfigHash/candidateConfigHash/verification | ✅ `assertRealDigest` refuses non-64-hex; facts from plan+manifest |
| 4 | V3 keeps full paired records, isolation eligibility, budget facts, event refs | ✅ outcomes + `eventRecords` + `promotionEligible`/`isolationStrength` |
| 5 | Controllable eventRecords size, summary independently recomputable | ✅ chunked embedded events, per-chunk digest recomputable |
| 6 | verificationPassed from real verifier events | ✅ `verificationPassedFromEvents` (never status) |
| 7 | Keep `paired-to-v3.mjs` only as migration tool | ✅ header marked, fails on missing fields, forces `promotionEligible:false` |

## Part 1 — in-process canonical sink

`packages/evaluation/src/paired-v3-builder.ts` (new):
`buildV3ArtifactsFromPaired(pairs, facts)` maps each finalized pair's real
`EvalOutcome` to a `CaseOutcomeV3`:

- **facts from execution, never defaults** — `planDigest`, `runtimeConfigHash`,
  `model`, `provider`, `gitSha`, `dirty`, `candidateConfigHash` come from the
  plan + manifest; `assertRealDigest` throws on any non-64-hex value (a
  placeholder can never reach the writer).
- **verificationPassed** derived from REAL `verification.completed` events
  (null when the gate never ran — never inferred from status).
- **activationRef** = the E4-04 recorder event id; **securityOutcomeRef** = the
  E4-04 classifier caseId; **outputDigest** = sha256 over real model output text;
  **workspaceDigest** = null (workspace torn down pre-build — honest absence,
  not a fake value).
- executor 0-based `repetition` → V3 1-based at this seam only (pairId/journal
  keep the 0-based index).

`runPairedPromotion` writes `v3-baseline.json` / `v3-candidate.json` via the
production writer and **strict-reloads** them (schema + refs + digest + summary
+ eventRecords integrity), so the round-trip is proven in production.

### Two latent producer bugs the strict sink exposed (fixed at source)
1. `candidateConfigHash` was the raw canonical config **string**
   (`resolved.semanticDigest`), not a hash → now `computeRuntimeConfigHash(
   semanticDigest)`. The old value would have failed E4-03 strict-load anyway,
   so the manual path was emitting **non-loadable** artifacts.
2. `manifest.isolationStrength` in the migration script was a free-form tag →
   must be the `strong|insecure-local|none` enum (fixed to `none`).

## Part 2 — eventRecords (#5/#6)

- `types.ts`: `EventChunkV3` (`chunkIndex`/`firstSeq`/`lastSeq`/`count`/
  `digest`/`events`) + `EventRecordsV3` (`mode:"embedded"`, `totalEvents`,
  `chunks`); optional `eventRecords?` on `CaseOutcomeV3` (backward compatible).
- `writer.ts`: `buildEventRecordsV3(events, chunkSize=256)` splits the trail
  into digest-anchored chunks; `computeEventChunkDigestV3` = sha256 over the
  stable serialization. Events are JSON-normalized before digesting so the
  builder's digest equals the loader's recomputed digest across serialization.
- `schema.ts`: `parseEventRecords` (structure) + `findEventRecordViolations`
  (integrity: lost chunk / duplicate seq / out-of-order / digest mismatch /
  count-totalEvents inconsistency).
- `loader.ts`: strict path throws on any eventRecords violation.
- `validate.ts`: `EVENT_RECORDS_INVALID` check in `validateArtifactV3`.
- `paired-v3-builder.ts`: populates `eventRecords` from `outcome.events`.

## Tests
- `event-records.test.ts` (7): chunking shape + recomputable digest; clean
  artifact strict-parses; **tampered event → digest mismatch**; **lost chunk →
  seq gap**; **out-of-order chunks**; **duplicated seq (overlap)**; empty →
  absent, never flagged.
- `benchmark-command.test.ts` (+1 production): a real paired run writes both V3
  artifacts; asserts schemaVersion 3.0.0, every case in both arms, provider /
  model / runtimeConfigHash / candidateConfigHash real + candidate differs,
  security + activation evidence present with resolving refs, `promotionEligible`
  matches the insecure-local posture, verificationPassed from events.

## Acceptance
- `tsc -b` clean; full `packages/evaluation` + `apps/cli/src` **1159 passed
  (94 files)**.
- The fake-provider production path (real CLI → real paired executor → real
  recorder/classifier → real V3 writer → strict loader) runs with **no**
  `paired-to-v3.mjs` invocation; provider calls are the scripted fake.

## Notes / deferrals
- `workspaceDigest` is null (the case workspace is torn down before the V3
  build). Recording it requires capturing the final workspace state at the fact
  site — tracked as a follow-up, deliberately NOT faked.
- Very large runs still embed (bounded by `boundOutcomeEvents`); an
  archive-ref mode (external event store referenced by digest) is a future
  size optimization, not required for correctness.
