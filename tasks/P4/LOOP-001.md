# TASK: LOOP-001

## Status

In Progress（主会话待验收）

## Goal

Full Agent Loop, per AGENT_ARCHITECTURE_PLAN v2.0 §114 (build order `15 loop`).

Acceptance task (verbatim):

``` text
Read README
→ identify issue
→ make small change
→ run test
→ report evidence
```

## Why

The runtime already had the loop skeleton (CORE-001 AgentRuntime: model round-trips, tool execution, limits, abort); LOOP-001 wires the phase-built subsystems into it so a real task can flow end-to-end: context pipeline (CTX-001/002/003) feeds every model call, verification (VERIFY-001) gates completion, recovery (RECOVERY-001) bounds failures. Without this the runtime cannot honestly declare "task done".

## Dependencies

- MODEL-001 (scripted provider driveability)
- TOOL-001 / EXEC-001 (orchestrator)
- SESSION-001 / EVENT-001 (durable history the loop reads)
- CTX-001 / CTX-002 / CTX-003 (ContextPipeline)
- VERIFY-001 (RuntimeVerifier gate)
- RECOVERY-001 (RecoveryPolicy)

## Scope

### Create

- `packages/context/src/pipeline.ts` — `ContextPipeline`: assemble discovery results + system prompt + prior tool-result blocks → budget plan → compact on overflow (placeholder summary; richer summaries are the runtime's job). Includes `pipeline.test.ts` (7 tests).
- `packages/core/src/runtime/loop-integration.test.ts` — end-to-end loop tests (6 tests).

### Modify

- `packages/core/src/runtime/runtime.ts` — new optional deps: `context` (pipeline + budget), `task` + `verifier` (gate), `recovery`, `toolSpecs`, `changedPathsProvider`. runTurn: context build per model call (system prompt = joined blocks; overflow after compaction → `run.limit_reached` + fail via recovery decision); `tools` advertised to the model; tool results appended as compressible ephemeral context blocks; stop-branch runs the verification gate before `completed`; tool failures/timeouts run the bounded recovery retry loop.
- `packages/core/src/index.ts` — export RuntimeVerifier + RecoveryPolicy.
- `packages/context/src/index.ts` — export ContextPipeline + types.
- `packages/core/package.json` + tsconfig — add `@ar/context` workspace dependency.

### Forbidden

- No changes to contracts (all interfaces already existed).
- No behavior change when the new deps are absent (backward compatible; existing runtime tests unchanged and green).

## Key Design Decisions

- **Context blocks join into the system prompt** — `system = blocks.map(b => b.content).join("\n\n---\n\n")`; the security-invariant blocks (system/user/project, trusted) survive compaction byte-for-byte via CTX-003.
- **Overflow handling** — pipeline compacts first; only when the compacted report still exceeds maxTokens does the runtime consult `RecoveryPolicy.decide("context_overflow", n)`: "ask"/"fail_safe" end the turn with RESOURCE_LIMIT, "retry" continues the loop (compressible blocks shrink next iteration).
- **Verification gate is completion-critical** — `finishReason === "stop"` passes through RuntimeVerifier; non-passed gate → turn `failed` with `VERIFICATION_FAILED` + `verification.failed` event. The agent cannot declare completion when the required test fails, artifact is missing, or a file is unchanged (VERIFY-001 acceptance, enforced via TaskVerifier checks).
- **Tool retry is bounded** — failed/timeout results loop through `RecoveryPolicy` up to its per-kind cap; "ask" surfaces as RESOURCE_LIMIT with the policy reason; "fail_safe" keeps the last failed result. `denied`/`cancelled` never retry.
- **rationale for placeholder summary** — ContextPipeline cannot know files changed/commands run; the loop runtime can, and a future phase can hand it a complete `CompactionSummary` while the pipeline stays the trigger. Documented in code.

## Tests

- ContextPipeline unit tests: discovery→blocks, overflow compaction, no-overflow passthrough, non-compressible preserved, report recompute, invalid cwd rejects, determinism.
- Loop integration (scripted model + fake orchestrator): acceptance flow read→change→test→report through the orchestrator; multi-iteration loop; gate failure blocks completion; recovery retry heals a flaky tool; pipeline discovery receives the session cwd; tiny budget overflows and the loop still completes.

## Acceptance Criteria

From plan §114 (verbatim): `Read README → identify issue → make small change → run test → report evidence` — demonstrated by `acceptance: read README → change → run test → report` in loop-integration.test.ts (3 tool calls via orchestrator + completion + evidence in message log + verification.completed event).

## Residual Risks

- Scripted-model tests validate the skeleton, not real provider behavior (temperature, malformed tool calls, tool-call echoes). Tool spec plumbing is model-provider dependent; the scripted provider ignores `tools`.
- The verification gate runs once at stop; a task whose test only passes after more turns is declared failed (intended fail-closed).
- `changedPathsProvider` defaults to none — artifact `mustChange` checks therefore see no changes unless the embedding app supplies the provider.
- Placeholder summaries lose detail compared to a runtime-built CompactionSummary; acceptable until a later phase.

## Verification

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **241 passed / 1 skipped (exit 0)** — 2026-08-11, main session（含 loop-integration 6/6：acceptance 全流、多迭代、gate 拦截、recovery 重试、pipeline cwd、tiny-budget 溢出后仍完成）
- Main-agent review: **done** — 逐文件审查 runtime.ts 集成点（context build、verification gate、recovery retry）、pipeline.ts、loop-integration.test.ts。修复：integration 测试 script 类型标注与 ScriptedModelProvider 语义（Script[] 逐次消费）、ToolError 用 errorInfo 构造（retryable/safeToRetry 字段）、删除无用占位测试
- Backward compatibility: 原 runtime.test.ts 12 用例未改且全绿；新增 deps 全部可选