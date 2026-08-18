# TASK: RECOVERY-001

## Status

In Progress（主会话待验收）

## Goal

Bounded recovery, per AGENT_ARCHITECTURE_PLAN v2.0 §116 (build order `17 recovery`).

Test (verbatim):

``` text
tool failure
test failure
timeout
context overflow
```

Agent must:

``` text
recover
or ask
or fail safely
```

## Why

The loop (LOOP-001) can fail many ways; an unbounded retry loops forever and an unconditional abort destroys work. RECOVERY-001 makes the failure response bounded and policy-driven: a pure decision component answers "retry / ask / fail safely" for each failure kind and attempt count, and the runtime executes it.

## Dependencies

- CONTRACT-001 — no new contracts; pure logic component
- LOOP-001 — the runtime consumes the decisions in the tool-failure and context-overflow paths

## Scope

### Create

- `packages/core/src/recovery/recovery.ts` — `RecoveryPolicy`
- `packages/core/src/recovery/recovery.test.ts` (15 tests)

### Modify

- `packages/core/src/index.ts` — export RecoveryPolicy and types

### Forbidden

- No I/O, no retry execution, no randomness — decision-only component
- No changes to runtime.ts (integration belongs to LOOP-001)

## Key Design Decisions

- **Decision matrix** — `attempt < effectiveMax(kind)` → `retry` (with `retryDelayMs`, per-kind override otherwise global default 500); exhausted → `context_overflow` always `ask`; exhausted → `askOn`-configured kinds `ask`; otherwise `fail_safe`.
- **Effective attempt cap** — `maxAttemptsByKind[kind] ?? maxAttempts` (default 3), surfaced in the decision so the caller knows the bound.
- **Boundaries** — `maxAttempts: 0` → first decision is ask/fail_safe, never retry; `attempt <= 0` or non-integer → TypeError.
- **Deterministic** — pure function of (kind, attempt, config); reasons are human-readable and stable.
- **Runtime integration** — tool failed/timeout results loop through `decide` until non-retry (denied/cancelled never retry); context overflow consults the same policy after compaction; "ask" surfaces as RESOURCE_LIMIT with the policy reason (graceful ask semantics land with a future interactive layer).

## Tests

- Default matrix across all four kinds (retry while under cap; context_overflow asks; others fail safely)
- per-kind caps, askOn sets, per-kind and global delays
- maxAttempts 0; attempt ≤ 0 / non-integer throws; attempts above cap
- Determinism (same input → same output)

## Acceptance Criteria

From plan §116 (verbatim): the four failure kinds are each mapped to recover (retry) / ask / fail safely decisions; the runtime bounds tool attempts (proven by loop-integration `RECOVERY-001: retries a failed tool call up to the policy bound, then fails safely`: flaky tool healed by retry, turn completes) and context overflow cannot loop forever (ask/fail_safe terminal).

## Residual Risks

- True "ask" (parking the turn for user input) is surfaced as a RESOURCE_LIMIT error until an interactive layer exists — documented in code and plan integration notes.
- `retryDelayMs` is advisory; the runtime does not sleep (tests must stay fast). Backoff policy remains open for a later phase.
- test_failure recovery is represented by the VERIFY-001 gate decision (fail closed), not by a separate retry of the whole turn — a deliberate scope decision recorded for LOOP evolution.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **241 passed / 1 skipped (exit 0)** — 2026-08-11, main session（RecoveryPolicy 15/15；loop-integration 重试用例 1/1）
- Main-agent review: **done** — 逐文件审查 recovery.ts + 测试；矩阵/边界/防御与契约一致，无遗漏
- Integration: runtime.ts tool-retry loop consumes `RecoveryPolicy.decide` (主会话集成，见 LOOP-001)