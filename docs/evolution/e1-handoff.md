# Evolution E1 — handoff

**Status:** COMPLETE (all 16 items executed, committed, and pushed to `origin/main`).

**HEAD:** `1cfc549` (E1-15: failure-cluster backlog)

**Active Champion:** C0 (frozen production baseline) — no candidate has passed strict E1 promotion.

---

## 1. Baseline (E1-00)

| Dimension | Value |
|-----------|-------|
| Baseline commit | `84c7163eb68493c6bc4aa59cb78a83d3af7faa03` |
| Historical results | `benchmarks/results/2026-08-27-deepseek-v4-flash*` (6 directories, 84-case, never overwritten) |
| Historical wasn't overwritten | ✅ — commit `84c7163` still owns `benchmarks/results/` |
| Six repros documented | `docs/evolution/e1-baseline.md` |
| Decision ledger | `docs/evolution/e1-decision-ledger.json` (schema `1.1.0`, 4 legacy entries audited) |

## 2. E1 Free Gates

| Gate | Status | Notes |
|------|--------|-------|
| `pnpm typecheck` | ✅ | Passes |
| `pnpm build` | ✅ | Passes |
| E1-01 audit (`--json` stdout-only) | ✅ | `git diff` no longer pollutes `CAPABILITY_MATRIX.*` |
| E1-02 exec cwd containment | ✅ | Sentinel wired in `runOneCase` |
| E1-03 CandidateRegistry | ✅ | 10 registered candidates (6 experimental, 4 unsupported), semantic delta proven |
| E1-04 ActivationEvidence | ✅ | 5 contracts (incl. `budget_aware_completion_v1`), fail-closed default |
| E1-05 deferred-schema + memory retrieval wiring | ✅ | Real mechanisms in benchmark runner |
| E1-06 loadRunsFromArtifact + artifact-validate | ✅ | Flat + report-object dual-path, manifest optional |
| E1-07 provenance-v2 (judgePairComparability) | ✅ | 5 strict gates, INCOMPARABLE for legacy |
| E1-08 champion eval decision state machine | ✅ | ACCEPT/REJECT/INCONCLUSIVE/INVALID, exit codes 0/1/2/3 |
| E1-09 security taxonomy | ✅ | 8 typed classifications, `countSecurityViolations` in 4 locations |
| E1-10 liveness fix | ✅ | drainFollowups recovery error handler re-enters |
| E1-11 repeated protocol | ✅ | `runRepeatedBaseline` + `judgeRepeatedPair`, 7 tests |
| E1-12 re-audit 4 challengers | ✅ | All INCOMPARABLE (legacy_no_activation_evidence), ledger updated |
| E1-13 budget_aware_completion_v1 | ✅ | Registered (experimental, agent-strategy), wired step-budget prompt, activation evidence |
| E1-14 champion state machine | ✅ | C0→C1→C2, evaluate/apply separated, `agent champion state|promote` |
| E1-15 failure-cluster backlog | ✅ | `docs/evolution/e1-failure-cluster-backlog.json`, 3 clusters, 4 next-round priorities |
| E1-16 handoff | ✅ | This file |
| Worktree clean | ✅ | Only 3 pre-existing deleted plan files (never committed) |

## 3. Challenger Status

> **Suite count note:** the historical runs above used the 30-case holdout
> (as recorded in `benchmarks/results/2026-08-27-*` artifacts). The suite
> directory `benchmarks/holdout/` now has 32 cases — E1-05 added two seeded-
> memory cases (ho-31/ho-32) that were NOT part of the historical runs. A new
> run therefore covers 32 cases, which is NOT directly comparable to the
> historical 30-case artifacts without a strict E1-07 pairing.

| Candidate | Status | Holdout (30) | Strict E1-07 | Activation | Notes |
|-----------|--------|-------------|-------------|------------|-------|
| tool_selector_deferred_schema | ACCEPTED | +1 pass (9→10/30) | INCOMPARABLE (legacy) | has contract | Accepted pre-E1, re-audit finds incomparable |
| memory_retrieval | **INVALID** (fail-closed) | 10/32 → 12/32 (+2) | **INCOMPARABLE (not_activated)** | activated 2/2 eligible | Real-model 2026-09-01: +2 wins, -169K tokens, but eligible=2 < minEligibleCases=3 → E1-08 INVALID (exit 3), Champion stays C0 |
| adaptive_recovery | REJECTED | -1 pass | INCOMPARABLE (legacy) | has contract | Rework hypothesis needed |
| **adaptive_recovery_v2** | historical ACCEPT, **E2: INVALID_PROVENANCE** | 10/32 → 11/32 (+1) | **COMPARABLE** ✅ | activated 32/32 | Real-model 2026-09-01 single run: conservative planner, +44K tokens, raw E1-08 ACCEPT (exit 0); **E2-00 audit quarantined it** (dirty cross-SHA single run) → active Champion stays **C0**; signal at most PROMISING_BUT_INCONCLUSIVE |
| adaptive_context_policy | REJECTED | 0 delta +1.48M tokens | INCOMPARABLE (legacy) | not_observable | Config-level, never proven |
| budget_aware_completion_v1 | **REJECTED** | 10/32 vs 10/32 (32-case arm) | **COMPARABLE** ✅ | activated 32/32 | Real-model 2026-08-31: netDelta 0, +968K tokens, 2 infra failures → E1-08 REJECT (exit 2) |
| delegation | **INVALID** (fail-closed) | 10/32 → 9/32 (-1) | **INCOMPARABLE (not_activated)** | no contract | Real-model 2026-09-01: net -1, +686K tokens, no activation contract wired → E1-08 INVALID (exit 3) |

## 4. Failure Clusters (baseline 30-case holdout)

| Cluster | Count | Targeted by |
|---------|-------|-------------|
| `agent_limit` | 9/30 | `budget_aware_completion_v1` — **TESTED 2026-08-31: REJECT** (10/32 vs 10/32, netDelta 0, +968K tokens); `adaptive_recovery_v2` — **ACCEPTED 2026-09-01: CHAMPION C1** (11/32 vs 10/32, netDelta +1, +44K tokens) |
| `verification_failed` | 7/30 | No winning challenger yet |
| `model_error` | 5/30 | adaptive_recovery (REJECTED) |

Next round priorities (all BLOCKED on `RUN_PAID_BENCHMARKS=1`):
1. ~~`budget_aware_completion_v1` → agent_limit~~ **TESTED 2026-08-31: REJECT** (see §3) — rework step-budget hypothesis or deprioritize
2. ~~`memory_retrieval` → fresh run with E1-04 evidence~~ **TESTED 2026-09-01: INVALID** (eligible=2 < 3, not_activated) — add more seeded-memory cases or deprioritize
3. ~~`adaptive_recovery` → reworked hypothesis~~ **TESTED 2026-09-01: adaptive_recovery_v2 ACCEPT → CHAMPION C1** — conservative planner promoted
4. ~~`delegation` → first benchmark~~ **TESTED 2026-09-01: INVALID** (no activation contract, net -1) — wire a contract or deprioritize

## 5. Evidence Migration

| Artifact | Path | Status |
|----------|------|--------|
| Champion state | `docs/evolution/champion-state.json` | **C0 active — adaptive_recovery_v2 history QUARANTINED (E2-00)**; raw C1 promotion recorded in history with original evidence path |
| Evolution ledger | `docs/evolution/evolution-ledger.json` | **E2-12 single machine-truth source** — refs/digests/summaries verified by `docs:verify` |
| Decision ledger | `docs/evolution/e1-decision-ledger.json` | 4 entries with E1-12 audit block |
| Baseline facts | `docs/evolution/e1-baseline.md` | 152 lines, 6 repros, known risks |
| Failure cluster backlog | `docs/evolution/e1-failure-cluster-backlog.json` | Derived from on-disk artifacts |
| **E1-next eval evidence** | `docs/evolution/e1-next-evidence.json` | budget_aware_completion_v1 real-model, 2026-08-31 |
| **E1-next run artifacts** | `benchmarks/results/2026-08-31-deepseek-v4-flash-budget-aware/` | baseline + candidate holdout + paired report (untouched 84-case preserved) |
| **E1-next memory evidence** | `docs/evolution/e1-next-evidence-memory.json` | memory_retrieval real-model, 2026-09-01, INVALID (not_activated) |
| **E1-next memory artifacts** | `benchmarks/results/2026-09-01-deepseek-v4-flash-memory-retrieval/` | candidate holdout + paired report (baseline reused from 08-31) |
| **E1-next delegation evidence** | `docs/evolution/e1-next-evidence-delegation.json` | delegation real-model, 2026-09-01, INVALID (no contract) |
| **E1-next delegation artifacts** | `benchmarks/results/2026-09-01-deepseek-v4-flash-delegation/` | candidate holdout + paired report |
| **E1-next ar2 evidence** | `docs/evolution/e1-next-evidence-ar2.json` | adaptive_recovery_v2 real-model, 2026-09-01 — raw ACCEPT history; **E2 validity INVALID_PROVENANCE** (see e2-02 rejection) |
| **E1-next ar2 artifacts** | `benchmarks/results/2026-09-01-deepseek-v4-flash-ar2/` | candidate holdout + paired report (promotion evidence) |
| Historical results | `benchmarks/results/2026-08-27-*` | Untouched, owned by commit 84c7163 |
| Historical results | `benchmarks/results/2026-08-26-*` | Pre-existing, also untouched |

## 6. Key Risks Carried Forward

- **Parallel test isolation:** 3 E2E tests (orchestrator P2-25 x2, executor) flake when run in parallel; pass serially.
- **capability:audit exit 1 pre-existing:** `evidenceFresh=FAIL` from the one-off `pnpm test` run tracked in P22-4 audit.
- **`pnpm test` pollutes `CAPABILITY_MATRIX.*`:** E1-01 fixed via `--json` stdout-only for audit, but a full `pnpm test` still writes to the root. Worktree is clean only because those files are gitignored.
- **No paid benchmark rerun:** All 4 next-round priorities blocked on `RUN_PAID_BENCHMARKS=1`. The `budget_aware_completion_v1` candidate has NEVER been run against a real model.
- **Champion stays C0:** Without a strict ACCEPT from a real-model repeated paired eval, no evidence exists to promote to C1.

## 7. Commands Reference

```bash
# Show current champion state
node apps/cli/dist/main.js champion state
node apps/cli/dist/main.js champion state --json

# Evaluate a candidate (compare baseline vs candidate runs)
node apps/cli/dist/main.js champion eval <baseline.json> <candidate.json> --mode real-model --strict --candidate <id>

# Explicitly promote (only if champion eval exited 0 ACCEPT)
node apps/cli/dist/main.js champion promote <candidate-id> --evidence <report.json> --decision ACCEPT

# Benchmark with a candidate
node apps/cli/dist/main.js benchmark --suite holdout --candidate budget_aware_completion_v1 --out <dir>

# Repeat protocol (E1-11)
node apps/cli/dist/main.js benchmark --suite adversarial --repeat 3 --interleave --shuffle --seed 42

# Run the free gate
pnpm typecheck
pnpm build
pnpm test
```

---

*Generated by E1-16 handoff. All E1 commits pushed to `origin/main`.*