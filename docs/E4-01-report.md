# E4-01 Report

## Outcome
- Status: DONE
- Source SHA before: `e9023ed` (E4-00 completion / branch tip when E4-01 began)
- Source SHA after: this commit (branch `e4-production-closure`)
- Provider calls: **0** (all verification uses fake providers / dry-run)

## What changed
- Production files:
  - `apps/cli/src/benchmark-command.ts`:
    - **Mandatory paid plan digest** (#1): an external-billed, non-dry-run must pass the exact `--plan-digest` from a prior `--dry-run`; missing or mismatched → refused in preflight (before provider resolution). Dry-run exempt (it produces the digest). Offline-test unchanged.
    - **Unambiguous hard limits** (#2): `maxLogicalRuns/maxModelCalls/maxEstimatedTokens/maxEstimatedCostUsd` are now `number | null` — `null` (omitted) = unlimited, `0` = FORBID, positive = cap. Preflight rejects a plan needing >0 of a resource when its cap is 0, before any call. A paid run must set an explicit positive `--max-model-calls` (omitted/unlimited refused). The paired executor keeps its internal `0=unlimited` sentinel; the CLI maps `null→0` and a user `0` never reaches it.
    - **Fail-closed isolation probe** (#4): a throwing `probeIsolationBackend()` now refuses a promotion-intent run instead of logging `[degraded]` and continuing.
    - **Isolation + promotion eligibility folded into the digest** (#3): preflight captures `isolationBackendId`, `isolationStrength` (strong|insecure-local|none) and derives `promotionEligible`, all bound into the canonical plan digest.
    - **Insecure permanently ineligible** (#5): an `--allow-insecure-local-benchmark` run carries `promotionEligible=false` into the digest AND into the paired artifact (new `promotionEligible` + `isolationStrength` fields), so no downstream converter can re-qualify it.
    - **Single `BenchmarkExecutionPlan` schema + builder + digest** (deliverable): `buildBenchmarkExecutionPlan()` / `computeBenchmarkPlanDigest()`; volatile fields (sourceSha/createdAt) excluded from the reproducible digest. `DryRunPlan` now surfaces `estimateStatus`/`isolationStrength`/`promotionEligible` (schemaVersion e3-01 → e4-01).
    - **Uniform validation entry** (#6): `runSmokeBenchmark` now calls the shared `preflightBenchmark` before `executeBenchmark`, so no programmatic entry reaches execution without the same gate.
- Test files:
  - `apps/cli/src/benchmark-command.test.ts` — +8 tests (paid-no-digest, mismatch, exact-digest-proceeds, offline-unaffected, forbid-0, paid-unlimited-rejected, isolation-throw-fail-closed, digest-stability, strong-vs-insecure-digest-differ, plan-builder-determinism, insecure-artifact-promotionEligible-false).
- Docs/evidence files:
  - `docs/E4-01-report.md` — this report.

## Why this closes the task
- 信任边界：付费/可促销运行在第一次 provider 调用前必须确认完整计划（digest 绑定 case 集、上限、隔离强度、promotion 资格）。
- 失败语义：隔离探测抛错 fail-closed；0 上限=禁止；付费缺 digest/缺显式上限一律拒绝，全部 0 provider calls。
- 不可篡改：insecure 的 `promotionEligible=false` 进入 digest 与 artifact，下游转换器无法翻转为 true。
- 统一入口：CLI 与 programmatic（smoke）都经 `preflightBenchmark`，校验不再只在 parser。

## Tests
| Command | Exit code | Result | Notes |
|---|---:|---|---|
| `tsc -b apps/cli` | 0 | PASS | |
| `vitest run apps/cli/src/benchmark-command.test.ts` | 0 | PASS | 48 tests |
| `benchmark --suite holdout --limit 1 --dry-run` | 0 | PASS | canonical plan, providerCalls 0 |
| `benchmark smoke` | 0 | PASS | routed through preflight |
| full `pnpm test` | 0 | PASS | see below |

## Required negative reproductions
| Reproduction | Before | After |
|---|---|---|
| paid run without `--plan-digest` | proceeded on unconfirmed plan | refused, 0 provider calls |
| paid run with mismatched digest | (only checked if supplied) | refused, 0 provider calls |
| `--max-model-calls 0` | treated as UNLIMITED | FORBID → refused, 0 provider calls |
| paid run with omitted (unlimited) cap | unbounded spend allowed | refused |
| isolation probe throws | `[degraded]` + continue | fail-closed refuse |
| insecure run artifact eligibility | not recorded | `promotionEligible=false` in artifact + digest |
| smoke bypassing validation | direct `executeBenchmark` | shared preflight gate |

## Worktree
- `git status --short`: empty after each commit.
- Temp files cleaned: yes (test fixtures use tmpdir; `vi.doUnmock`+`resetModules` in finally).

## Remaining risks / deferred to later tasks
- `decisionPolicyVersion` / `decisionThresholds` are listed in the spec's aspirational schema but are owned by **E4-05** (versioned DecisionPolicy); folding a placeholder now would churn the digest again when E4-05 lands. The digest already binds the concrete policy thresholds present in the plan (the `max*` caps).
- "V3 writer preserves `promotionEligible=false`" and "promotion loader rejects it" are **E4-02 / E4-06** acceptance items; E4-01 records the flag in the paired artifact and binds it into the digest so those downstream tasks can enforce it.
- `estimateStatus` is always `bounded` (the estimator is deterministic); the unknown→reject path is wired in the schema but currently unreachable.
