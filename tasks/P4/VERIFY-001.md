# TASK: VERIFY-001

## Status

In Progress（主会话待验收）

## Goal

Independent verification, per AGENT_ARCHITECTURE_PLAN v2.0 §115 (build order `16 verification`).

Acceptance (verbatim): Agent cannot declare completion when

``` text
required test fails
required artifact missing
required file unchanged
```

## Why

Prior phases built the loop (LOOP-001) and the verifier core (VS-001 TaskVerifier), but nothing connected them: the runtime could declare completion while a required check failed. VERIFY-001 provides the runtime-side gate that assembles run evidence (transcript from session history, changed paths, cwd) into a VerificationContext and delegates to an independent Verifier, failing closed on verifier errors.

## Dependencies

- VS-001 (`TaskVerifier` in `@ar/tools`) — executes command / artifact / requirement specs
- CONTRACT-001 (`verification.ts`) — TaskSpec / VerificationContext / Verifier / VerificationResult all pre-existed
- SESSION-001 — `store.listMessages` for the transcript

## Scope

### Create

- `packages/core/src/verification/runtime-verifier.ts` — `RuntimeVerifier`
- `packages/core/src/verification/runtime-verifier.test.ts` (12 tests)

### Modify

- `packages/core/src/index.ts` — export RuntimeVerifier

### Forbidden

- No changes to contracts, tools package, or the verifier implementations
- No silent pass on verifier exceptions (fail closed)

## Key Design Decisions

- **Transcript rendering** — one `[role] content` line per message, per-message truncation (`messageTruncate`, default 1000) plus hard overall cap (`maxTranscriptChars`, default 16_000).
- **Fail-closed gate** — any exception from `verifier.verify` becomes `status: "blocked"` with a synthetic `kind: "review"` failing check (INTERNAL_ERROR). Errors are never swallowed as passes.
- **No short-circuit** — empty/absent `task.verification` still delegates (TaskVerifier returns deterministic level-0/passed=false), keeping every turn on the same code path.
- **Gate statuses** — `"passed" | "failed" | "blocked"`; `reason` built from failed checks (`description: error message`).
- **Integration point** — `AgentRuntime.runVerificationGate` (LOOP-001) calls this on `finishReason === "stop"`; non-passed gate → turn `failed` with `VERIFICATION_FAILED`.

## Tests

- passed path; failed path (reason contains error message); blocked path (verifier throws)
- transcript rendering includes all roles; truncation at overall cap
- cwd / changedPaths / runStartedAt / turnId passthrough into VerificationContext
- real TaskVerifier command success/failure (exit 0/1 via `process.execPath`) — verified in an out-of-tree harness; @ar/tools is intentionally not a dependency of @ar/core (reported as a known gap)

## Acceptance Criteria

From plan §115 (verbatim): agent cannot declare completion when required test fails / artifact missing / file unchanged — demonstrated by `VERIFY-001: blocks completion when the required test fails` (loop-integration.test.ts) plus TaskVerifier's own artifact/mustChange checks; gate also blocks on verifier failure (blocked) which is strictly stricter.

## Residual Risks

- `@ar/tools` is not a dependency of `@ar/core`, so RuntimeVerifier tests use inline fakes; real TaskVerifier interoperability was verified out-of-tree. A future phase may move TaskVerifier into core or add the dependency.
- Transcript truncation can cut evidence detail needed by requirement checks (soft risk; documented in code).
- changedPaths come from an injected provider; default none, so `mustChange` semantics depend on the embedding app.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **241 passed / 1 skipped (exit 0)** — 2026-08-11, main session（RuntimeVerifier 12/12；loop-integration 中 gate 拦截用例与整体联动）
- Main-agent review: **done** — 逐文件审查 runtime-verifier.ts + 测试；修复：TurnId brand 类型（newTurnId 而非字面量）、errorInfo 构造失败 check、清理临时 e2e 文件。gate 接入 runtime.ts 的 stop 分支（主会话集成，见 LOOP-001）
- Known gap: @ar/tools → @ar/core 依赖未建立（报告入库，后续阶段决策）