# Harness Agent

A TypeScript **agent runtime** with a single-owner session actor, live-streaming
SDK, defense-in-depth security gates, and benchmark-driven mechanism evolution.

Built as a pnpm workspace monorepo: **24 `@ar/*` packages** under `packages/`
plus `apps/cli` and `apps/web`.

> English · [中文](./README.zh-CN.md)

---

## Table of contents

- [What this repository is](#what-this-repository-is)
- [Highlights](#highlights)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [CLI quick tour](#cli-quick-tour)
- [Running with a real model](#running-with-a-real-model)
- [Benchmark challengers](#benchmark-challengers)
- [Release gates](#release-gates)
- [CI pipeline](#ci-pipeline)
- [Design notes](#design-notes)
- [Architecture documentation](#architecture-documentation)
- [Status: completed, in progress, unfinished](#status-completed-in-progress-unfinished)
- [Verification truth & honesty policy](#verification-truth--honesty-policy)

---

## What this repository is

The repo is both a **runtime** (session actor + orchestration + tools +
security) and an **evaluation harness** (benchmarks, paired evaluation,
promotion envelopes, release attestation). The runtime is architecture-FROZEN:
changes after the P38.4 freeze require a reproducible correctness defect, a
security vulnerability, a release-integrity defect, a benchmark failure proven
to originate in harness infrastructure, or a measured performance regression.

Everything that can affect what an experiment actually does is folded into a
canonical, content-addressed **execution plan** (suite, case set + per-case
input fingerprints, limits, isolation posture, promotion eligibility,
provider/model identity, judge version, source snapshot, pre-registered
decision policy). Promotion-grade evidence must carry the full plan, a complete
sample grid and a completion marker — an internally consistent record can still
be semantically impossible (e.g. `insecure-local` isolation claiming
`promotionEligible=true`), so eligibility is enforced by a shared semantic
validator at the evaluator, writer and promotion-loader boundaries, not by field
agreement alone.

## Highlights

- **SessionActor — one owner per session.** `activeTurn ∈ {0,1}` enforced by a
  single unified actor state machine (`idle → starting → running → closing`).
  Follow-up queues, steer, interrupt, cancel and unload all share the same
  linearizable admission path; durable follow-ups are consumed only after turn
  creation succeeds.
- **LoadedSessionManager — generation fencing.** An older in-flight load can
  never resurrect after unload/close or delete a newer generation's single-flight
  entry.
- **Stream-first SDK.** `runStreamed()` subscribes before invoking `turn/run`
  and returns before terminal completion. Every terminal path (event, abort,
  transport EOF, buffer overflow, invoke error) settles **exactly once** and
  releases all run-scoped listeners; the event channel is bounded (4096) and a
  stream failure is an error, never a clean EOF.
- **Defense-in-depth security.** Canonical-path containment (fail-closed on
  EACCES/EPERM/ELOOP/EIO/depth), sandboxed exec with shell-composition
  detection, prompt-injection detection on tool output, secret redaction,
  approval/permission engine, and a `no-silent-catch` static scan.
- **Evidence-truth release pipeline.** `agent audit --strict` requires
  documentation truth **and** profile requirements **and** current-HEAD
  execution evidence (test + benchmark, kind-checked). `agent release verify`
  derives READY only from real per-gate evidence bound to the release SHA; the
  CI attestation job reduces evidence files — no hard-coded PASS table.
- **Benchmark-driven evolution.** `agent benchmark --candidate <id>` runs a
  challenger mechanism through the real harness; paired eval (per-case
  wins/losses/ties) decides promote-or-reject. The first evolution loop rejected
  all 4 challengers — the champion wiring stays (see
  [`docs/evolution-decisions.md`](./docs/evolution-decisions.md)).

## Repository layout

```
apps/cli        CLI: run, benchmark, audit, release verify/gate, docs:verify, doctor, ...
apps/web        web shell (DSH harness web UI)
packages/       24 @ar/* packages
  agents        agent-level mechanism layer (adaptive strategies, delegation)
  checkpoint    deterministic checkpointing for resumable runs
  context       context window / budget-aware context management
  contracts     shared types, error taxonomy, recovery planner contracts
  core          AgentRuntime, SessionActor, context, verification, recovery
  evaluation    benchmark runner, paired eval, execution-plan protocol,
                promotion envelope, evolution loop, champion manifest,
                gate evidence (V2)
  events        typed runtime event definitions
  gateway       in-memory RPC + protocol transport conformance
  harness       composition root (createHarness), introspection, scope resolver
  learning      mechanism learning/feedback loop
  mcp           Model Context Protocol server/client + chaos tests
  memory        working memory tooling
  model         OpenAI-compatible provider (deepseek thinking-mode support)
  observability logging / tracing utilities
  orchestration ToolOrchestrator: all side effects flow through here
  plugins       plugin system boundaries
  protocol      wire protocol definitions
  sdk           stream-first client (RunEventHub, bounded PushChannel)
  security      canonical paths, sandbox, process gate, injection/secret gates,
                no-silent-catch static scan
  session       session admission / lifecycle helpers
  skills        skill registry / mechanism skills
  store         storage abstraction (durable store, recovery store)
  store-integrity  store-integrity verification
  tools         production tool set (sandbox executor, process confinement)
```

Architecture contract: **Core must not depend on UI, providers, business plugins
or external integrations; all side effects go through ToolOrchestrator and are
subject to PermissionEngine and SandboxManager.**

## Getting started

Requirements: **Node ≥ 22**, **pnpm ≥ 9** (workspace pinned to pnpm 11.21.0).

```bash
pnpm install --frozen-lockfile   # install (CI uses the frozen lockfile)
pnpm typecheck                   # tsc -b across all packages
pnpm test                        # full vitest suite (unit + integration)
pnpm build                       # build all packages
```

The full suite is the default `pnpm test` command. Dedicated gates:

```bash
pnpm test:coverage               # per-package coverage thresholds (CI gate)
pnpm test:protocol               # transport conformance
pnpm test:security               # sandbox / canonical-path / process gate
pnpm test:race                   # same-session race suite (no sleeps)
pnpm test:chaos                  # MCP chaos
pnpm docs:verify                 # machine-derivable documentation truth
pnpm capability:audit            # strict capability audit
pnpm release:verify              # release verdict from evidence
pnpm release:gate <gate>         # run ONE gate and write V2 evidence
```

## CLI quick tour

```bash
node apps/cli/dist/main.js doctor                      # env + store wiring report
node apps/cli/dist/main.js run                         # run an interactive turn
node apps/cli/dist/main.js benchmark --suite adversarial --limit 1 --allow-stub  # smoke (no API key)
node apps/cli/dist/main.js benchmark --suite adversarial --dry-run    # plan digest (0 provider calls)
node apps/cli/dist/main.js audit --strict              # capability audit (release truth axes)
node apps/cli/dist/main.js usage-audit --run <id> --strict   # E4-R24 named-run observation audit
node apps/cli/dist/main.js release verify              # release verdict from real evidence
node apps/cli/dist/main.js release gate <gate>         # one gate + durable V2 evidence
node apps/cli/dist/main.js docs:verify                 # documentation truth checks
```

## Running with a real model

A paid run must first **dry-run** to get the canonical plan digest, then confirm
the **exact** plan (digest + explicit spend cap) — `benchmark` refuses a billed
provider without both (E4-01). Set `RUN_PAID_BENCHMARKS=1` to authorize a paid
run; an API key alone is **not** authorization.

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
export OPENAI_MODEL=gpt-4o-mini                     # or deepseek-v4-flash, etc.

# 1) dry-run — prints the canonical e4-01 plan + planDigest (0 provider calls, offline)
node apps/cli/dist/main.js benchmark --suite adversarial --dry-run

# 2) confirm the EXACT plan and cap spend before the run starts
node apps/cli/dist/main.js benchmark --suite adversarial \
  --max-model-calls 800 \
  --plan-digest <planDigest from the dry-run output> \
  --out .ci/bench
```

`deepseek`-style thinking models are supported: `reasoning_content` is parsed
from the stream, persisted on the assistant message, and passed back on the
next request (required by the API).

Promotion-grade runs additionally require a **strong isolation backend** (OS-level
confinement; e.g. bwrap on Linux), a **provably clean source tree** and a named
challenger. Insecure local execution is available behind an explicit
`--allow-insecure-local-benchmark` flag and is **never promotion-eligible**.

## Benchmark challengers

```bash
# champion baseline (all candidates off)
node apps/cli/dist/main.js benchmark --suite adversarial

# one challenger mechanism at a time
node apps/cli/dist/main.js benchmark --suite adversarial --candidate adaptive_recovery
node apps/cli/dist/main.js benchmark --suite adversarial --candidate memory_retrieval
node apps/cli/dist/main.js benchmark --suite adversarial --candidate tool_selector_deferred_schema
```

Supported candidates: `adaptive_recovery`, `memory_retrieval`,
`tool_selector_deferred_schema`, `adaptive_context_policy`,
`context_pipeline_v5`, `memory_write_learning`, `independent_reviewer`,
`delegation`, `adaptive_scheduler`. See
[`docs/evolution-decisions.md`](./docs/evolution-decisions.md) for the first
loop's results (all challengers rejected; champion kept).

## Release gates

| Gate | Command | What it verifies |
| --- | --- | --- |
| typecheck / build | `pnpm typecheck` / `pnpm build` | `tsc -b` zero errors |
| tests | `pnpm test` | full suite (file/test counts move with the tree — see CI `verify` job output) |
| coverage | `pnpm test:coverage` | per-package thresholds (missed threshold = red job) |
| docs | `pnpm docs:verify` | documentation truth (benchmark counts, package count, plan entry, evolution ledger, capability matrix) |
| protocol | `pnpm test:protocol` | transport conformance |
| security | `pnpm test:security` | sandbox / canonical-path / process gate / regression matrix |
| race | `pnpm test:race` | same-session race suite (no sleeps) |
| chaos | `pnpm test:chaos` | MCP chaos |
| capability audit | `pnpm capability:audit` | strict audit (docs + profile + evidence) |
| usage audit | `node apps/cli/dist/main.js usage-audit --run <id> --strict` | independent named-run observation audit (E4-R24) |
| release verify | `pnpm release:verify` | READY only when all required gates pass at the release SHA |

Every gate also emits **durable V2 evidence** (`release gate <gate>
--evidence-dir ...`) — a real command, real exit code, git state before/after,
digests and a bounded failure summary, all content-addressed (R12).

## CI pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs:

- **verify** matrix on **ubuntu-latest and windows-latest**: install →
  typecheck → test (log tee'd) → build → strict usage audit of the named
  observation run → benchmark smoke (stub provider, no paid model) → gate
  evidence generation for 9 gates per OS (P38.2-4/10, unified V2).
- **coverage** on ubuntu: `pnpm test:coverage` (thresholds fail the job) +
  coverage gate evidence.
- **release-attestation** (needs verify + coverage): downloads gate evidence
  per platform, verifies SHA/argv, derives the verdict with `pnpm
  release:verify`, and writes `release-attestation.json`
  (`runtimeReleaseReady` + `championPromotion.status`). The job fails when the
  verdict is not READY — no hard-coded PASS table (P38-12, INV-P38.3-007).

## Design notes

- **One canonicalization semantic.** All filesystem containment (sandbox,
  capability guard, workspace manager) goes through `canonicalizePath` —
  realpath of the deepest existing ancestor + lexical tail resolution;
  non-ENOENT errors fail closed with a typed `CanonicalizationFailed`.
- **No silent failure.** `no-silent-catch` scans for empty/comment-only catch
  blocks; degraded paths must surface observability.
- **Deterministic concurrency tests.** Race tests use gated fakes and
  entered-signals, never `setTimeout` to hope a path started; max concurrency
  is measured directly.
- **One handoff truth.** Handoff status lives in code + CI;
  `docs/evolution-decisions.md` records benchmark-driven evolution verdicts.
- **One plan entry.** `plan.md` is the single current-plan entry; `docs:verify`
  enforces that it references an existing plan spec (E4-00).
- **Honest NOT_RUN.** Gates that were not run are recorded as NOT_RUN —
  `runtimeReleaseReady` is never fabricated from an old run, and paid real-model
  champion quality (`championPromotion`) is reported NOT_RUN until actually
  paid for and measured.

Architecture details: [`docs/architecture/`](./docs/architecture/)
(session-actor, runtime-scopes, tool-snapshot, orchestration, durability,
mcp-runtime, app-server, release-integrity).

## Status: completed, in progress, unfinished

### Completed (pushed to origin/main, CI-green at their SHAs)

- **P35 → P38 closure** — `typecheck/test/coverage/docs/protocol/security/race/
  chaos/capability-audit/release-verify` all PASS, attestation READY
  (see `docs/E4-00…E4-11`, `docs/E4-R01…R11`).
- **E4-R12 … E4-R20** (2026-09-10 plan) — report chain
  `docs/E4-R12-report.md` … `docs/E4-R20-report.md`; CI run 34548502173
  (bcf34b7) four jobs green, `runtimeReleaseReady=true`.
- **E4-R21 … E4-R26** (2026-09-11 plan) — `docs/E4-R21-report.md` …
  `docs/E4-R26-report.md`; origin/main CI run #112 (2b2d3db) four jobs green,
  strict usage-audit on both platforms, release attestation READY=true.
- **E4-R27 … E4-R31** (2026-09-11 plan) — `docs/E4-R27-report.md` …
  `docs/E4-R31-report.md`; pushed to origin/main and CI-green at their SHAs
  (four jobs: Ubuntu main gate, Windows main gate, Ubuntu coverage, release
  attestation). This batch closed G01 (promotion isolation eligibility),
  G02 (execution-plan field/scale constraints), G03 (raw-byte source
  fingerprint), G04 (bounded recovery wake-up) and the independent close-out.

### E4-R32 … E4-R35 (2026-09-12 plan) — pushed to origin/main, CI-green at their SHAs

- **E4-R32** (H01/H02 recovery-store combined failure + intent backoff) —
  [`docs/E4-R32-report.md`](./docs/E4-R32-report.md): lease cleanup is now
  best-effort and cannot abort the bounded re-check; the recovery read entry
  fail-closes and keeps a finite wake-up path; the backoff counter resets only
  after the round's strict persistence (lease + intent) succeeds, so a
  persistent intent-write outage really escalates. `recovery-durable.test.ts`
  23/23.
- **E4-R33** (H03 execution-plan scale validation before dangerous work) —
  [`docs/E4-R33-report.md`](./docs/E4-R33-report.md): `parseExecutionPlan` no
  longer uses an argument spread (a ~130k-case plan inside the documented cap
  used to throw `RangeError`), uses a `Set` for case membership (drops the
  quadratic query), and validates the grid-scale/capacity contract before any
  per-case traversal. `e4-r33-execution-plan-scale.test.ts` 7/7.
- **E4-R34** (H04 isolate deliberately-failing fixtures) —
  [`docs/E4-R34-report.md`](./docs/E4-R34-report.md): the final-result protocol
  fixtures moved out of the root vitest `include` into
  `apps/cli/test-infra/observation-fixtures/` with a dedicated subprocess
  config that keeps the production reporter; a leftover fixture can no longer
  be collected by the next full run. `e4-r24-final-result-protocol.test.ts`
  4/4.
- **E4-R35** (post-push status + final acceptance close-out) —
  [`docs/E4-R35-report.md`](./docs/E4-R35-report.md): closure matrix, full-repo
  gates on a clean tree, and read-only remote CI verification, summarised in
  `docs/E4-STATUS.md`.

### E4-R36 … E4-R39 (2026-09-12 plan) — implemented, pushed, closing out the status

- **E4-R36** (J01 first recovery discovery must be re-scannable) —
  [`docs/E4-R36-report.md`](./docs/E4-R36-report.md): `_recoverableChecked` now
  means "a discovery pass COMPLETED", not "one was started". A transient read
  failure during the very first scan used to escape the drain AND mark discovery
  done forever (no timer, no re-scan, a promoted prompt left on an unowned
  turn); the scan now commits atomically (a partial scan enqueues nothing) and a
  failed pass fail-closes with a bounded, self-healing wake-up.
  `recovery-durable.test.ts` 29/29 (6 new cases fail without the fix).
- **E4-R37** (J02 upgraded workspaces must not collect legacy fixtures) —
  [`docs/E4-R37-report.md`](./docs/E4-R37-report.md): `.gitignore` is not a
  Vitest exclude. The root config now structurally excludes the generated
  `apps/cli/src/e4-r24-fixture-*.test.ts` pattern (framework defaults preserved
  via `configDefaults.exclude`), so a leftover deliberately-failing fixture can
  never enter the official run — no manual cleanup required.
  `e4-r24-final-result-protocol.test.ts` 5/5.
- **E4-R38** (J03 valid positive + promotion-loader boundary) —
  [`docs/E4-R38-report.md`](./docs/E4-R38-report.md): acceptance hardening, **no
  production change**. A fully cross-bound baseline pair (real
  `computeExecutionPlanDigest`, real identity/policy/grid/evidence bindings)
  reaches a real `ACCEPT` and a real `loader.ok=true`; the over-cap negative is
  derived from that same pair by changing only `repeat` and is refused by BOTH
  the evaluator (exactly one calibrated capacity violation) and the promotion
  loader. `e4-r38-execution-plan-boundary.test.ts` 3/3.
- **E4-R39** (status sync + final gates) — ⚠️ **PARTIAL** —
  [`docs/E4-R39-report.md`](./docs/E4-R39-report.md): the J01…J04 closure matrix,
  the gates measured on the frozen, clean `01c4ec74` tree, and the read-only
  remote CI verification for this round's own SHA. Green: `pnpm typecheck` (0),
  `pnpm docs:verify` (ALL CHECKS PASS), `test:race` 23, `test:security` 2133,
  `test:protocol` 52, `test:chaos` 12. **NOT green: the full `pnpm test`** — 318
  files, `1 failed | 5738 passed | 1 skipped (5740)`, the same single failure in
  3/3 runs (`e4-09-production-e2e.test.ts` → `buildRealChain` judges a valid
  chain `INVALID`), while that file passes 5/5 in isolation (4 runs) and
  `apps/cli/src` passes as a whole (2 runs). Root cause **undetermined**; two
  hypotheses (CPU load, transient dirty tree) were tested and **falsified**.
  The Windows CI job for `01c4ec74` (run `34687657690`) also failed both
  attempts, with a different failure set each time. Two docs-only commits with
  the *same code* (`2db1a9cd` / run `34689110496`, `40d5588b` / run
  `34689429297`) are four-jobs green — the latter including the release
  attestation job — so that Windows failure is **flaky rather than
  revision-determined**; the factual result for `01c4ec74` itself remains a
  failure, and CI is not claimed green for it.

### Unfinished / NOT_RUN (see [HANDOVER.md](./HANDOVER.md) for the detail)

- **Full-repo `pnpm test` is not green at the frozen revision** — the `e4-09`
  valid-chain `INVALID` failure above, and the Windows CI job for this round's
  SHA. Both are recorded as real open gaps with their evidence; neither is
  explained away as fixture dirt.
- **Real-model champion quality**: `championPromotion.status=NOT_RUN` — the
  paid real-model benchmark was not requested; no fake readiness is claimed.
- **Release publish action**: plans stop at attestation; no automatic publish.

The authoritative, machine-checked list of unfinished tasks lives in
[`HANDOVER.md`](./HANDOVER.md); `plan.md` points at the current plan spec.

## Verification truth & honesty policy

- **PASS requires per-item acceptance evidence**; not run → NOT_RUN; partial →
  PARTIAL; already fixed → NOT_NEEDED only after verification.
- **No fabricated readiness.** `runtimeReleaseReady` comes from the real
  exact-SHA CI attestation; `championPromotion` is NOT_RUN until a paid
  real-model benchmark is actually run.
- **No lowering thresholds, no deleting failing tests, no hand-editing ACCEPT**
  to force evidence.
- Every report records the tested SHA, reproduction before/after, implementation
  symbols, test commands/exit codes and residual limits.

See `plan.md` for the current plan, `docs/migration.md` for public notes, and
`docs/evolution-decisions.md` for the evolution loop.