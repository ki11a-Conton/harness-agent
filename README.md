# Harness Agent

A TypeScript agent runtime with a **single-owner session actor**, **live-streaming SDK**, **defense-in-depth security gates**, and **benchmark-driven evolution**.

Built as a pnpm workspace monorepo: 24 `@ar/*` packages under `packages/` plus `apps/cli` and `apps/web`.

> English · [中文](./README.zh-CN.md)

---

## Highlights

- **SessionActor — one owner per session.** `activeTurn ∈ {0,1}` enforced by a single unified actor state machine (`idle → starting → running → closing`). Follow-up queues, steer, interrupt, cancel and unload all share the same linearizable admission path; durable follow-ups are consumed only after turn creation succeeds.
- **LoadedSessionManager — generation fencing.** An older in-flight load can never resurrect after unload/close or delete a newer generation's single-flight entry.
- **Stream-first SDK.** `runStreamed()` subscribes before invoking `turn/run` and returns before terminal completion. Every terminal path (event, abort, transport EOF, buffer overflow, invoke error) settles **exactly once** and releases all run-scoped listeners; the event channel is bounded (4096) and a stream failure is an error, never a clean EOF.
- **Defense-in-depth security.** Canonical-path containment (fail-closed on EACCES/EPERM/ELOOP/EIO/depth), sandboxed exec with shell-composition detection, prompt-injection detection on tool output, secret redaction, approval/permission engine, and a `no-silent-catch` static scan.
- **Evidence-truth release pipeline.** `agent audit --strict` requires documentation truth **and** profile requirements **and** current-HEAD execution evidence (test + benchmark, kind-checked). `agent release verify` derives READY only from real per-gate evidence bound to the release SHA; the CI attestation job reduces evidence files — no hard-coded PASS table.
- **Benchmark-driven evolution.** `agent benchmark --candidate <id>` runs a challenger mechanism through the real harness; paired eval (per-case wins/losses/ties) decides promote-or-reject. The first loop rejected 4 challengers — the champion wiring stays.

---

## Repository layout

```
apps/cli        CLI: run, benchmark, audit, release verify, docs:verify, doctor, ...
apps/web        web shell (DSH harness web UI)
packages/       24 @ar/* packages
  contracts     shared types, error taxonomy, recovery planner
  core          AgentRuntime, SessionActor, context, verification, recovery
  security      canonical paths, sandbox, process gate, injection/secret gates
  sdk           stream-first client (RunEventHub, bounded PushChannel)
  gateway       in-memory RPC + protocol transport conformance
  harness       composition root (createHarness), introspection, scope resolver
  model         OpenAI-compatible provider (deepseek thinking-mode support)
  evaluation    benchmark runner, paired eval, evolution loop, champion manifest
  ...           agents, checkpoint, context, events, learning, mcp, memory,
                observability, orchestration, plugins, protocol, session,
                skills, store, store-integrity, tools
```

---

## Getting started

Requirements: **Node ≥ 22**, **pnpm ≥ 9** (workspace pinned to pnpm 11.21.0).

```bash
pnpm install --frozen-lockfile   # install
pnpm typecheck                   # tsc -b across all packages
pnpm test                        # full vitest suite
pnpm build                       # build all packages
```

### CLI quick tour

```bash
node apps/cli/dist/main.js doctor        # environment + store wiring report
node apps/cli/dist/main.js run           # run an interactive turn
node apps/cli/dist/main.js benchmark --suite adversarial --limit 1 --allow-stub   # smoke benchmark (no API key needed)
node apps/cli/dist/main.js audit --strict        # capability audit (release truth axes)
node apps/cli/dist/main.js release verify        # release verdict from evidence
node apps/cli/dist/main.js docs:verify           # documentation truth checks
```

### Running with a real model

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
export OPENAI_MODEL=gpt-4o-mini                     # or deepseek-v4-flash, etc.

node apps/cli/dist/main.js benchmark --suite adversarial --out .ci/bench
```

`deepseek`-style thinking models are supported: `reasoning_content` is parsed from the stream, persisted on the assistant message, and passed back on the next request (required by the API).

### Benchmark challengers

```bash
# champion baseline (all candidates off)
node apps/cli/dist/main.js benchmark --suite adversarial

# one challenger mechanism at a time
node apps/cli/dist/main.js benchmark --suite adversarial --candidate adaptive_recovery
node apps/cli/dist/main.js benchmark --suite adversarial --candidate memory_retrieval
node apps/cli/dist/main.js benchmark --suite adversarial --candidate tool_selector_deferred_schema
```

Supported candidates: `adaptive_recovery`, `memory_retrieval`, `tool_selector_deferred_schema`, `adaptive_context_policy`, `context_pipeline_v5`, `memory_write_learning`, `independent_reviewer`, `delegation`, `adaptive_scheduler`. See [`docs/evolution-decisions.md`](./docs/evolution-decisions.md) for the first loop's results.

---

## Release gates

| Gate | Command | What it verifies |
| --- | --- | --- |
| typecheck / build | `pnpm typecheck` / `pnpm build` | `tsc -b` zero errors |
| tests | `pnpm test` | full suite (248 files, ~4800 tests) |
| coverage | `pnpm test:coverage` | per-package thresholds |
| docs | `pnpm docs:verify` | documentation truth (incl. package count integrity) |
| protocol | `pnpm test:protocol` | transport conformance |
| security | `pnpm test:security` | sandbox / canonical-path / process gate / regression matrix |
| race | `pnpm test:race` | same-session race suite (no sleeps) |
| chaos | `pnpm test:chaos` | MCP chaos |
| capability audit | `pnpm capability:audit` | strict audit (docs + profile + evidence) |
| release verify | `pnpm release:verify` | READY only when all required gates pass at the release SHA |

CI (GitHub Actions) runs Linux + Windows verify, coverage, and a `release-attestation` job that reduces per-gate evidence files and produces `release-evidence-<sha>` with `releaseReady`.

---

## Design notes

- **One canonicalization semantic.** All filesystem containment (sandbox, capability guard, workspace manager) goes through `canonicalizePath` — realpath of the deepest existing ancestor + lexical tail resolution; non-ENOENT errors fail closed with a typed `CanonicalizationFailed`.
- **No silent failure.** `no-silent-catch` scans for empty/comment-only catch blocks; degraded paths must surface observability.
- **Deterministic concurrency tests.** Race tests use gated fakes and entered-signals, never `setTimeout` to hope a path started; max concurrency is measured directly.
- **One handoff truth.** Handoff status lives in code + CI; `docs/evolution-decisions.md` records benchmark-driven evolution verdicts.

Architecture details: [`docs/architecture/`](./docs/architecture/) (session-actor, runtime-scopes, tool-snapshot, orchestration, durability, mcp-runtime, app-server, release-integrity).

---

## Status

P35 → P38 closure is complete and CI-green (`typecheck/test/coverage/docs/protocol/security/race/chaos/capability-audit/release-verify` all PASS, attestation READY). Architecture-closure work is stopped; future changes require benchmark or production evidence.

See `plan.md` for the closure plans, `docs/migration.md` for public notes, and `docs/evolution-decisions.md` for the evolution loop.
