# TASK: HARNESS-001

## Status

In Progress（主会话待验收）

## Goal

Prepare for future automatic Harness optimization, per AGENT_ARCHITECTURE_PLAN v2.0 §134 (component inventory / trace evidence / prediction / change / evaluation / rollback), §177 (evolution loop: run → trace → failure attribution → hypothesis → change → held-out evaluation → accept/reject → rollback), §150 (a harness change is good only if it improves task outcomes without unacceptable regression), §148 (architecture quality metrics).

Do NOT automatically mutate the production harness. This task builds the read-side scaffolding only: `HarnessInventory` (component inventory) and the `HarnessChangeProposal` lifecycle (propose → evaluate → rollback) in `packages/observability`.

## Why

§134 requires preparing closed-loop harness evolution: component-level observability, experience distillation and falsifiable predictions. EVAL-001/BENCH-001 provide per-case `EvalOutcome` and head-to-head `BenchReport`; HARNESS-001 is the inventory + proposal lifecycle layer that consumes them. No runtime changes — everything is driven through injected deps.

## Dependencies

- TRACE-001 (`@ar/observability` itself): `AgentEvent` (via `@ar/contracts`), metrics conventions
- BENCH-001: `BenchReport`/`BenchTotals` from `@ar/evaluation` (type-only import — no runtime dependency, see Key Design Decisions)
- CONTRACT-001: `AgentEvent` types

## Scope

### Create

- `tasks/P9/HARNESS-001.md` (this file)
- `packages/observability/src/inventory.ts` — §134 component inventory:
  - `ComponentInventory { name: string; path: string; version: string; deps: string[]; hasTests: boolean }`
  - `scanWorkspace(deps: { packagesRoot: string }): Promise<ComponentInventory[]>` — scans each direct subdirectory of `packagesRoot`; a component requires a parseable `package.json` with a non-empty string `name`. `version` = manifest `version` ("" when absent). `deps` = sorted unique names from `dependencies` + `devDependencies` + `peerDependencies`. `hasTests` = existence of any `src/**/*.test.ts` file (recursive walk). Non-existent or unreadable `packagesRoot` → `[]`. Non-package entries (files, dirs without `package.json`, unparseable manifests) are skipped. Result sorted by `name` (deterministic).
  - `summarize(inventory): InventorySummary { total; withTests; dependencyEdges; packagesWithoutTests }` — `dependencyEdges` = Σ `deps.length`; `packagesWithoutTests` = names of components with `hasTests === false`, in inventory order.
- `packages/observability/src/harness-evolution.ts` — §134/§177 change lifecycle:
  - `HarnessChangeProposal { id: string; hypothesis: string; expectedImprovement: string; component: string; evidenceRefs: string[]; status: "draft" | "accepted" | "rejected" | "rolled_back" }`
  - `proposeChange(deps: { inventory: ComponentInventory[]; evidence: AgentEvent[]; hypothesis: string; expectedImprovement: string }): HarnessChangeProposal` — creates a `draft` with a generated `id` (`hc_<n>`). `component` = the inventory component most often mentioned by evidence payloads (recursive string scan for name or absolute path; ties → first in inventory order); `evidenceRefs` = ids of the evidence events mentioning the winner, in evidence order. Empty inventory → `component: "unknown"`, `evidenceRefs: []`. No mentions → first inventory component, `evidenceRefs: []`.
  - `evaluateProposal(p, deps: { benchmarkBefore: () => Promise<BenchReport | undefined>; benchmarkAfter: () => Promise<BenchReport | undefined>; threshold?: number }): Promise<{ action: "accept" | "reject"; reason: string }>`:
    - only evaluates `draft` proposals (non-draft → `reject`, no benchmark calls)
    - missing baseline (`benchmarkBefore` → `undefined` or throws) → `reject` (§147-style: repeated evidence requires a recorded pre-change baseline)
    - missing `benchmarkAfter` (→ `undefined` or throws) → `reject` (fail-closed: acceptance requires a measured held-out comparison, §177)
    - improvement check: `gain = after.summary.b.success - after.summary.a.success` (the §133 head-to-head inside the after-change report: a = unchanged harness, b = changed harness); `gain < threshold` (default 1) → `reject`
    - §150 safety gate: `after.summary.b.safety < after.summary.a.safety` (zero-violation case count regressed) → `reject`
    - otherwise → `accept`. Status transitions `draft → accepted/rejected` on the proposal object; every decision carries a specific reason.
  - `rollbackProposal(p, deps: { revert: () => Promise<void> }): Promise<{ action: "rolled_back" }>` — §177 rollback: requires `status === "accepted"` (throws otherwise), awaits `deps.revert()` exactly once, sets `status = "rolled_back"`. A throwing `revert` propagates.
- `packages/observability/src/inventory.test.ts` — ≥ 6 cases (real `packages/` scan + temp-dir fixtures)
- `packages/observability/src/harness-evolution.test.ts` — ≥ 10 cases, all deps injected as fakes

### Modify

- `packages/observability/src/index.ts` — append `export * from "./inventory.js"` and `export * from "./harness-evolution.js"`
- `packages/observability/package.json` — add devDependency `@ar/evaluation: workspace:*` (type-only import of `BenchReport`; see Key Design Decisions)

### Forbidden

- No third-party dependencies
- No changes to contracts, evaluation, core, or any other package
- No runtime changes; no automatic mutation of the production harness (§134 "Do not automatically mutate production Harness yet")
- No side effects outside the injected deps (no stores, no network) — `scanWorkspace`'s `node:fs` reads are the single exception (it IS the inventory scanner)

## Key Design Decisions

- **§133 head-to-head is the judgment basis**: `evaluateProposal` judges improvement and safety from the after-change report's own `summary.a` (unchanged harness) vs `summary.b` (changed harness), per the task contract "summary 中 a 与 b 的 success 差". `benchmarkBefore` is the recorded pre-change baseline whose *presence* is required — a proposal without a recorded baseline cannot distinguish harness effect from noise and is rejected without ever measuring "after".
- **Fail-closed acceptance**: a throwing/missing `benchmarkAfter` rejects (acceptance without a completed held-out measurement is exactly the §177 hazard). This diverges from `LearningPromoter.promote` (which propagates `benchmarkAfter` errors) — documented here deliberately: a harness-evolution gate must not accept on unmeasured evidence.
- **§150 safety gate = `BenchTotals.safety`**: the task's "violations 总和" maps to the available aggregate `summary.*.safety` (cases with zero violations); a drop in zero-violation cases rejects regardless of success gain. Cost/latency/reliability regression gates are future work (HARNESS-001 scope is the safety gate only).
- **`@ar/evaluation` is a devDependency, not a dependency**: `@ar/observability` only imports the `BenchReport` *type* (`import type`, erased at runtime). Evaluation already depends on observability at runtime; putting evaluation in observability's `dependencies` would create a real package cycle. The devDep + type-only import keeps the runtime graph acyclic (same pattern as evaluation's own `@ar/model`/`@ar/tools` devDeps).
- **Evidence → component attribution is a deterministic heuristic**: payload strings (recursive) are scanned for the component name or absolute path; the most-mentioned component wins (ties → first in inventory order). Honest fallbacks: no inventory → `"unknown"`, no mentions → first component with empty `evidenceRefs`. Raw-string matching (not `JSON.stringify`) so Windows backslash paths match.
- **Status transitions live on the proposal object**: `draft → accepted/rejected` (evaluate), `accepted → rolled_back` (rollback). Re-evaluating a decided proposal rejects without calling benchmarks; rolling back a never-accepted proposal throws (caller bug).

## Tests

`packages/observability/src/inventory.test.ts` (8 cases):

1. Real `packages/` scan: non-empty; every entry has string name/path/version, `deps: string[]`, boolean `hasTests`
2. Real scan: `@ar/contracts` present with `version "0.1.0"`, `hasTests === true`, `deps` contains `"zod"`
3. Determinism: two scans JSON-equal
4. Non-existent root → `[]`
5. `summarize` over the real scan: `total`/`withTests`/`dependencyEdges` computed consistently; `@ar/contracts` not in `packagesWithoutTests`
6. `summarize([])` → all zeros, empty array
7. Temp-dir: fake packages (with/without `src/**/*.test.ts`), stray file and package.json-less dir skipped, sorted by name, deps merged from dependencies+devDependencies
8. Temp-dir: unparseable package.json skipped

`packages/observability/src/harness-evolution.test.ts` (18 cases):

1. `proposeChange` → draft with generated id, hypothesis/expectedImprovement preserved
2. `evidenceRefs` records the ids of evidence events mentioning the chosen component
3. Empty inventory → `component: "unknown"`, `evidenceRefs: []`
4. No evidence → first inventory component, `evidenceRefs: []`
5. Component selection: most-mentioned wins; tie → first in inventory order
6. Accept: success 5→7, safety equal → `accept`, status `accepted`, reason cites gain
7. Accept with safety improvement (b.safety > a.safety)
8. Reject: success improved 4→6 but safety 3→2 → `reject`, status `rejected`, reason cites safety
9. Reject: no baseline (`benchmarkBefore` → `undefined`); `benchmarkAfter` not called
10. Reject: `benchmarkAfter` → `undefined`
11. Reject: no improvement (5→5, default threshold 1)
12. Threshold: gain 1 with threshold 2 → reject; gain 2 with threshold 2 → accept (boundary inclusive)
13. Threshold 0: equal success → accept
14. Reject: `benchmarkBefore` throws, message preserved in reason, `benchmarkAfter` not called
15. Reject: `benchmarkAfter` throws (fail-closed), message preserved
16. Non-draft proposal → reject, benchmarks not called, status unchanged
17. Rollback: accepted proposal → `revert` called once, action `rolled_back`, status `rolled_back`
18. Rollback on a draft → throws, `revert` not called

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/observability` passes (≥ 6 + ≥ 10 tests)
- `pnpm test` (full suite) shows no regression
- No third-party dependencies added
- Evidence: typecheck + test output reported

## Residual Risks

- The §150 regression gate covers only safety (`BenchTotals.safety`); cost/latency/reliability regression checks are explicitly deferred (documented in the module). A future HARNESS-002 can extend `evaluateProposal`'s gate list without changing its signature.
- `benchmarkBefore`'s numeric content is not consulted, only its presence — the improvement verdict rests entirely on the after-change report's internal a/b comparison. If a baseline-vs-after cross-check is ever wanted, it is a documented extension point.
- The evidence→component attribution is heuristic; a real failure-attribution stage (§177) may replace it later. `proposeChange` never fabricates associations: no mentions → empty `evidenceRefs`.

## Verification

- `pnpm typecheck` — pending
- `pnpm vitest run packages/observability` — pending
- Full suite `pnpm test` — pending

## Definition of Done

- [ ] `tasks/P9/HARNESS-001.md` exists
- [ ] `packages/observability/src/inventory.ts` implements §134 inventory + summary
- [ ] `packages/observability/src/harness-evolution.ts` implements §134/§177/§150 proposal lifecycle
- [ ] `src/index.ts` exports both modules
- [ ] ≥ 6 inventory tests + ≥ 10 evolution tests pass
- [ ] Root `pnpm typecheck` passes
- [ ] Full `pnpm test` shows no regression
- [ ] No third-party dependencies
- [ ] Evidence: typecheck + test output reported
