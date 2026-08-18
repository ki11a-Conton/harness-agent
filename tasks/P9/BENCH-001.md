# TASK: BENCH-001

## Status

In Progress（主会话待验收）

## Goal

Create `BenchRunner` in `packages/evaluation` — head-to-head harness comparison, per AGENT_ARCHITECTURE_PLAN v2.0 §133 (compare Harness versions), §149 (Agent Quality Metrics: correctness/safety/reliability/efficiency/latency/cost, never one collapsed score), §150 (Harness Quality: a harness change is good only if it improves task outcomes without unacceptable regression).

`BenchRunner.runCompare({ cases, runA, runB })` runs the same `EvalCase[]` through two harness implementations (or the same harness twice) and returns a `BenchReport` with per-case winners plus aggregated §149 totals for both sides.

## Why

§133 requires comparing harness versions under "same model, same task, same environment, different harness". EVAL-001 provides the per-case `EvalOutcome`; BENCH-001 is the comparison layer that turns two outcome sets into a winner verdict and §149 quality aggregates. No runtime changes — it only consumes `EvalOutcome`/`RunMetrics`.

## Dependencies

- EVAL-001: `EvalCase` (eval-case.ts), `EvalOutcome`/`EvalStatus` (runner.ts)
- TRACE-001: `RunMetrics` (`@ar/observability`)

## Scope

### Create

- `tasks/P9/BENCH-001.md` (this file)
- `packages/evaluation/src/bench.ts` — `BenchRunner`:
  - `runCompare(deps: { cases: EvalCase[]; runA: (c: EvalCase) => Promise<EvalOutcome>; runB: (c: EvalCase) => Promise<EvalOutcome> }): Promise<BenchReport>` — runs every case through both harnesses sequentially (report order === input order) and compares per case.
  - `BenchReport { cases: Array<{ caseId: string; resultA: EvalOutcome; resultB: EvalOutcome; winner: "A" | "B" | "tie" | "both_failed" }>; summary: { a: BenchTotals; b: BenchTotals } }`
  - `BenchTotals` aggregates §149 metrics: `success` (passed count), `safety` (zero-violation count), `reliability` (non-error count), `efficiency` (average `tool_call_count`), `latency` (average `duration_ms`), `cost` (sum of `estimated_cost`; 0 when metrics absent).
  - Winner determination: status first (`passed` > `failed` > `error`), then fewer `violations`, then tie — two failed runs with equal violations report `"both_failed"`, everything else equal reports `"tie"`.
- `packages/evaluation/src/bench.test.ts` — ≥ 10 cases, fake `EvalOutcome`s built by factory (no runtime, no `AgentRuntime` needed).

### Modify

- `packages/evaluation/src/index.ts` — export `bench.js`

### Forbidden

- No third-party dependencies
- No changes to contracts, core, tools, observability, or any other package
- No runtime changes (comparison is read-only over `EvalOutcome`s)
- No fabricated outcomes: a throwing harness run rejects the whole comparison (harness crashes surface as `EvalOutcome` with `status: "error"` instead, per runner.ts convention)

## Key Design Decisions

- **Same case object to both runs**: `runCompare` hands the identical `EvalCase` instance to `runA` and `runB` — "same model, same task, same environment, different harness" (§133) is the caller's contract to arrange (the harness provides model/environment parity).
- **Winner is status-first, never violations-first**: a passed run with many violations beats a failed run with none (correctness outranks side-effect noise); violations only decide within equal status.
- **`both_failed` is the failed-tie**: both failed with equal violations → `"both_failed"` (more informative than `"tie"` for harness comparison); equal passed → `"tie"`; equal error → `"tie"`.
- **Empty reports are honest zeros**: zero cases → empty `cases`, all totals 0, `efficiency`/`latency` are `0` not `NaN`.
- **Cost fallback**: `EvalOutcome.metrics` is required by contract (TRACE-001 zeros), but the cost sum guards absent metrics (`?? 0`) so malformed inputs cannot produce `NaN`.

## Tests

`packages/evaluation/src/bench.test.ts` (15 tests):

1. A wins when A passes and B fails on every case (all winners "A", totals reflect 3/0 success)
2. B wins when B passes and A fails on every case
3. Reports "tie" when outcomes are identical (summary.a deep-equals summary.b)
4. Reports "both_failed" when both fail with equal violations
5. Fewer violations decides a failed-vs-failed case (both directions)
6. Status ranks above violations (passed with 3 violations beats failed with none)
7. Error ranks below failed regardless of violations
8. Both error → "tie"
9. Aggregates success/safety/reliability/efficiency/latency/cost exactly (2-case totals asserted field-by-field)
10. Safety counts failed outcomes that carry no violations
11. Reliability excludes error outcomes
12. Cost falls back to 0 when metrics are absent
13. Empty case list → empty report with zeroed totals (no NaN)
14. Input case order preserved in the report regardless of resolution timing (async delays)
15. Same case object handed to both harness runs (§133 same task)
16. Deterministic: identical inputs produce identical reports (JSON-equal)
17. A throwing harness run rejects (no fabricated outcome)
18. Per-case entries carry caseId, both outcomes, and the winner

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/evaluation` passes (≥ 10 tests)
- `pnpm test` (full suite) shows no regression
- No third-party dependencies added
- Evidence: typecheck + test output reported

## Residual Risks

- Winner semantics for `status: "error"` are per-case only; totals treat errors as not-`success` and not-`reliable`, which is the honest §149 reading (an error run provides no evidence of correctness).
- `efficiency`/`latency` averages include error outcomes' metrics — usually zeroed by the runner (honest zeros), so the average is not skewed by crashes.
- Comparison assumes both harness runs are genuinely comparable (same model/environment); parity enforcement is the caller's job, not the runner's.

## Verification

- `pnpm typecheck` — pending
- `pnpm vitest run packages/evaluation` — pending
- Full suite `pnpm test` — pending

## Definition of Done

- [ ] `tasks/P9/BENCH-001.md` exists
- [ ] `packages/evaluation/src/bench.ts` implements §133/§149/§150 deliverables
- [ ] `src/index.ts` exports `bench.js`
- [ ] ≥ 10 tests pass in `packages/evaluation/src/bench.test.ts`
- [ ] Root `pnpm typecheck` passes
- [ ] Full `pnpm test` shows no regression
- [ ] No third-party dependencies
- [ ] Evidence: typecheck + test output reported
