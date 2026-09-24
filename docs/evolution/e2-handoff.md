# E2 Handoff — Historical Snapshot

> **⚠ HISTORICAL DOCUMENT** — This file describes the E2 evolution state at
> `subjectSha: d7ead299f3092336c7e243934befb3a27e0bb5de` (subject tree digest:
> `19920f8c5373857d83d107bf4308f3c69b87faa7`). The original file was generated
> by PowerShell and contains interpolation artifacts (PowerShell `$()` expressions
> and `System.Object[]` values). The factual content is preserved below; the
> upstream `e2-handoff.json` is the canonical data source.
>
> The documentation commit that last modified this file is NOT part of the tested
> code tree — the subject SHA above is the commit being described, not the commit
> carrying this document.
>
> ### Known errors in the original generated .md
> - PowerShell `$(@{...}.headSha)` was not expanded — the PS logic expected
>   `e2-handoff.json` fields but the generator ran in a different context.
> - `System.Object[]` appears where array values were not rendered.
> - `activeChampion=` has no value (the JSON has `activeChampion.level=C0`).
> - The test count (5236) is stale for the current f73a337 HEAD (5250 tests).
> - The generated .md claims "PASS" for all gates, but the worktree was NOT clean
>   during gate generation — the ground truth is in `e2-handoff.json`.

## Gate status (E2 free implementation chain)

Truthful source: `e2-handoff.json` (see that file for exact gate results).

| Gate | Result |
|------|--------|
| typecheck | PASS |
| build | PASS |
| test | PASS (5236 passed, 1 skipped, 280 files — stale for current HEAD) |
| protocol | PASS |
| security | PASS |
| race | PASS |
| chaos | PASS |
| benchmark:smoke | PASS |
| docs:verify | PASS |
| coverage | RUN (slow; not gate-completing in 120s window) |
| capability:audit | behavioral PASS (worktree unchanged; strict exit 1 = stale benchmark evidence, expected) |
| release:verify | BLOCKED (no gate evidence for current HEAD — stale, not fabricated PASS; E2-15 paid unauthorized) |

## Champion state

- **Active: C0 — E2-00 quarantined the historical adaptive_recovery_v2 C1; no new valid paid ACCEPT exists**
- Quarantined history: adaptive_recovery_v2 (historical raw ACCEPT 2026-09-01, E2 validity INVALID_PROVENANCE; evidence path preserved)

## Paid benchmark

- Status: **BLOCKED** (operator has NOT authorized real-model spend)
- Dry-run/preflight: `docs/evolution/e2-15-dry-run.json`

## Schemas / policy versions

- artifact: 3.0.0 · provenance: 3.0.0
- promotion: e2-07-policy-v1 · decision: e2-06-policy-v1
- evolution ledger: PASS (docs:verify)

## Residual risks

- E2-15 AR2 paid re-evaluation is BLOCKED until operator authorizes cost (RUN_PAID_BENCHMARKS=1) and a strong-isolation sandbox backend is available (E2-09: win32-none has none)
- release:verify has no gate evidence for the current HEAD — CI on a clean checkout must run each gate and commit evidence before release
- coverage gate needs a longer window/batch script to complete

## Conclusion

Promotion NOT currently allowed. Active production Champion is C0. E2-15 was NOT executed (no operator authorization). The full E2 free implementation chain (artifacts/provenance/pairing/decision/promotion/profile/security/recovery) is implemented, tested and committed.

## Post-E3 note

The E3 evolution supersedes this handoff. The E3 baseline (`e3-review-baseline.json`) records the current truthful machine status at `subjectSha: f73a337d71027afd48a8ac5ac0de1a7f4ae8497c` with all R-01~R-12 defect reproductions and accurate gate results.