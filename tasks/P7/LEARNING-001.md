# TASK: LEARNING-001

## Goal

Create `packages/learning`: the promotion stage of the learning pipeline (§69: trace → outcome → reflection → candidate → evaluation → promotion). `LearningCandidate` carries the §69 candidate types; `LearningPromoter.promote` gates promotion on security check + benchmark improvement + recorded baseline, and rolls back when a later benchmark regresses (§70, §147, §194).

## Why

REFLECTION-001 already produces reflection outputs with procedural memory candidates. Those candidates must NOT be promoted on trust alone: §147 requires repeated evidence + generalizable behavior + evaluation improvement + no security regression, and §194 explicitly forbids auto-promotion purely because the benchmark score increased. The benchmark gate also serves §76 (specification gaming defense: promotion must rest on a measured, repeatable evaluation, not a single sample) and §150 (harness changes are good only when outcomes improve without unacceptable regression). LEARNING-001 is the gate that enforces this, and the §70 rollback path protects production behavior from regressions after a promotion lands.

## Dependencies

- `@ar/contracts` (declared per package convention; this stage's types are self-contained and currently do not import contract types — revisit on pipeline integration)

## Preconditions

- `packages/memory` exists (REFLECTION-001): `Reflector`/`ReflectionOutput` produce the pipeline input candidates.
- `packages/evaluation` exists (EVAL-001): benchmark scoring the promotion gate consumes via injected functions.

## Scope

### Create

- `tasks/P7/LEARNING-001.md` (this file)
- `packages/learning/package.json` (name `@ar/learning`, mirror `packages/skills`)
- `packages/learning/tsconfig.json` (extends root base, `tsBuildInfoFile` under `node_modules/.cache/tsbuildinfo/learning.tsbuildinfo`)
- `packages/learning/src/candidate.ts` — `LearningCandidate { id: string; kind: "memory" | "skill" | "workflow" | "tool_preference" | "prompt_rule"; content: string; sourceReflectionId?: string; benchmarkScoreBefore?: number; benchmarkScoreAfter?: number; proposedAt: number; securityChecked: boolean }` (§69 candidate types)
- `packages/learning/src/promoter.ts` — `LearningPromoter.promote(c: LearningCandidate, deps: { securityCheck; benchmarkBefore; benchmarkAfter; threshold?; persist }): Promise<PromotionDecision>` with `PromotionDecision { action: "promoted" | "rejected" | "rolled_back"; reason: string }`:
  - Security check runs FIRST and a failure rejects regardless of benchmark score (§194); when it fails, no benchmark function is called
  - `benchmarkBefore` resolving to a non-finite value means no baseline → `rejected` (§147 repeated evidence requires a measurable baseline); `benchmarkAfter` is not called
  - `benchmarkAfter ≤ benchmarkBefore + threshold` (threshold default 0, boundary inclusive) → `rejected` ("one accidental success is insufficient", §147)
  - Otherwise the measured scores are recorded on the candidate, `persist` is called exactly once, → `promoted`
  - A later `promote` call on the same candidate whose current score fell below the recorded post-promotion score → `rolled_back` (§70 rollback; `persist` is not called again)
  - Every decision carries a non-empty, specific `reason`
- `packages/learning/src/index.ts` — export `LearningCandidate`/`LearningPromoter`/`PromotionDecision`/`PromoteDeps`
- `packages/learning/src/promoter.test.ts` — 12+ cases (see Tests), all with injected fake security/benchmark/persist functions

### Modify

- `tsconfig.json` (root references — add `./packages/learning`)

### Forbidden

- No third-party dependencies
- No side effects outside the injected deps (no `node:fs`, no stores, no network)
- No contract type changes
- No bypass of the promotion gate (no path that persists without the security+benchmark checks passing)

## Contracts

`LearningCandidate` and `PromotionDecision` shapes as specified above; the deps object is the injection point for security check, benchmark and persistence. The "missing baseline" convention: `benchmarkBefore()` resolving to a non-finite value (e.g. `NaN`) means no baseline → `rejected`; a thrown `benchmarkBefore` error is also transformed to `rejected` with the error message preserved in the reason (`benchmarkAfter` is not called in either case). Errors thrown by `securityCheck`/`benchmarkAfter` propagate — they are never swallowed or turned into fake decisions.

## Security Invariants

- A failing security check rejects the candidate even when the benchmark improved (§194 — never auto-promote on score alone).
- Nothing is persisted on `rejected` or `rolled_back`; `persist` fires exactly once per successful promotion.
- The rollback path never writes (it only reports; undoing the live change is the caller's action).

## Tests

- security ok + score improvement → `promoted`, persist called once, reason cites the gain
- security fail → `rejected` even with a high score, and no benchmark function is called
- score not improved (after == before) → `rejected`
- score decreased → `rejected`
- no baseline (NaN) → `rejected`, `benchmarkAfter` not called
- baseline benchmark throws → `rejected` with the error message in the reason, `benchmarkAfter` not called
- configurable threshold (boundary inclusive: after == before + threshold → `rejected`)
- default threshold 0
- promoted candidate's later call with regressed score → `rolled_back`, persist not called again
- persist called exactly once across a promote/rollback lifecycle
- candidate kind passthrough (persist receives the same candidate with its kind intact)
- kind=memory and kind=skill take the same path (same decisions for identical scores)
- every decision has a non-empty, specific `reason`
- security check receives the candidate

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/learning` passes
- `pnpm test` passes (full suite, no regression)

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (no score-based auto-promotion, no persist on reject/rollback)
- [ ] Evidence: typecheck + test output
