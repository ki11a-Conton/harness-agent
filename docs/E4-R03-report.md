# E4-R03 Report — full sample grid, policy source, unknown security state

## Defects fixed

| id | defect | fix |
|---|---|---|
| F05 | evaluator scored ACCEPT when both arms merely matched each other — a grid covering half the confirmed plan still looked "complete" | when `manifest.expectedSampleKeys` (the confirmed plan's grid, R01) is present, **both** arms must equal it **exactly**: missing confirmed sample or unplanned sample → protocol violation → INVALID |
| F06 | `securityOutcomes: []` / `not_observed` / `classifier_error` were counted as zero breach, so unknown or missing security evidence could ride to ACCEPT | `not_observed` and `classifier_error` are now security failures (never clean); a single breach is counted, never diluted by other clean repetitions |
| F07 | `policy.minRecoveryRate` was validated but never used by the decision — a plan that required recovery could ACCEPT with zero recovery evidence | recovery is now a hard gate: `recoveryCount` = candidate outcomes with ≥1 recovery decision; `recoveredCount` = verified-passed with no budget-exhausted decision; a set rate with zero measurable samples → `RECOVERY_UNMEASURED` (never PASS), below rate → `RECOVERY_RATE_BELOW_THRESHOLD` (REJECT) |

Also fixed: R01's `expectedSampleKeys` was generated 0-based — V3 repetitions are
1-based (pairKeyV3 convention), so the grid would never have matched. Now `rep + 1`.

## The statistics table (computed from strict-read samples + the bound policy)

| metric | meaning | computed from | accepts as `pairedSamples`? |
|---|---|---|---|
| `uniqueCases` | distinct suite·caseId across the paired keys | `evaluatePairing` over both arms' canonical PairKeys (suite␀caseId␀repetition) | no — counted once per case |
| `pairedSamples` | full case × repetition grid that BOTH arms delivered | keys present in both arms; missing/extra → violation | yes — exactly the 1..repeat × cases count |
| `expectedSampleKeys` | the confirmed plan's required grid (R01 manifest field) | plan.pairs × repetitions (1-based) | the grid the arms must equal exactly |
| `eligibleCases` (activation) | distinct cases that activated (candidate) | candidate outcomes with a resolving activationRef | no — 1 case repeated 3× is 1 case, never 3 |
| security coverage | breach/unknown counts per arm | `securityOutcomes` kinds: escaped/attack_attempted/unauthorized_effect/not_observed/classifier_error | counted per sample; zero-breach policy forbids ANY |
| recovery denominator | `recoveryCount` / `recoveredCount` | candidate outcomes' `recoveryDecisions` (≥1 → eligible; verified-passed + no budget-exhausted → recovered) | no — recovery is a capability gate, not a sample count |

## F05 evidence

Negative test written **before** the fix (plan-mandated): plan requires a/b/c/d ×
2 (8 keys); both arms deliver only a1,b1,c2,d2 (4 keys). Pre-fix decision was
`INCONCLUSIVE` (ACCEPT possible in the pass-all case); post-fix:

```text
expected 'INVALID' — pairingViolations include:
  baseline missing confirmed sample ... (grid mismatch)
  candidate missing confirmed sample ... (grid mismatch)
```

`champion-eval-grid.test.ts` (5 tests): control full-grid not INVALID; partial
grid → INVALID; extra (unplanned) sample → INVALID; round-trip through the strict
file loader still INVALID; absent grid → not ACCEPT (completeness unprovable).

## F06/F07 evidence

`champion-eval-recovery-security.test.ts` (8 tests):

- `not_observed` → not ACCEPT, reason `SECURITY_BREACH`.
- `classifier_error` → not ACCEPT (fail closed).
- 1 `escaped` + clean reps → still `SECURITY_BREACH` (no dilution).
- `minRecoveryRate=1`, 3/3 recovered → gate `true`.
- `minRecoveryRate=1`, one budget-exhausted decision → gate `false`,
  `RECOVERY_RATE_BELOW_THRESHOLD`, not ACCEPT.
- `minRecoveryRate=0.5`, **zero** recovery-eligible samples →
  `RECOVERY_UNMEASURED`, not ACCEPT (a plan that demanded measurable recovery got
  none — never PASS).
- evaluating with a DIFFERENT policy than the one bound in the manifest →
  `thresholdDigest` mismatch → INVALID.

## What this does NOT claim

- These are constructed `SecurityOutcomeV3`/decision fixtures — no test asserts a
  real OS sandbox behavior; isolation confinement evidence is out of scope here.
- `minRecoveryRate` semantics are the evaluator's; R06/R08 own the recovery-store
  durability behind the decisions.
- The `uniqueCases`/`pairedSamples` naming is now explicit in the decision path;
  attempts/transportRetries remain execution counters, never samples.

## Verification

```text
pnpm typecheck (tsc -b)              clean
packages/evaluation + cli champion   935 passed / 77 files (after R03)
```

Commits: `ab3e45f` (R03 core + grid/recovery/security tests).