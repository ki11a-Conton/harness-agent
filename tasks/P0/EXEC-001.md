# TASK: EXEC-001

## Status

**Completed** — ProcessExecutor implemented, 9 unit tests written, main-agent review done.

## Goal

Implement the process execution primitive in `packages/tools`: `ProcessExecutor` (pure spawn → stream → bounded collect → exit code, with timeout / abort / tree-kill / output truncation), plus the `exec` tool that shells out through it. Streaming output must reach the event trail as `tool.output` events without breaking execution.

## Why

Runtime side effects need a bounded, cancellable process primitive. It must be a pure primitive: **no permission/sandbox decisions inside** — all authorization stays in the ToolOrchestrator pipeline (permission engine + sandbox allowlist), and the shell itself is an explicit, testable injection point. The executor must never silently hang (timeout), never leak processes (tree kill), and never let an aborted run be misreported as `failed`.

## Dependencies

CONTRACT-001 (ToolStreamEvent, ToolExecutionContext.onOutput), TOOL-001 (ToolOrchestrator pipeline + sandbox process policy), SEC-001 (command allowlist gating in SandboxManager).

## Scope

### Create

- `packages/tools/src/process/executor.ts` — `ProcessExecutor`, types `ExecOptions` / `ExecOutcome` / `ExecStatus` (`"success" | "failed" | "timeout" | "cancelled" | "error"`), `EXECUTOR_MARKER` = `"verbatim-recipe-v3"` (revision marker for the win32 quoting recipe). Defaults: 60s timeout, 1 MiB per-stream output cap.
- `packages/tools/src/process/executor.test.ts` — 9 unit tests (see Tests).
- `packages/tools/src/tools/exec.ts` — `exec` tool: zod schema (command min 1 char, cwd/env/timeoutMs bounded ≤ 10 min), `risk: "elevated"`, `metadata.process: true`, maps outcome → `PROCESS_TIMEOUT` / `USER_CANCELLED` / `PROCESS_ERROR`, command evidence on success.

### Modify

- `packages/contracts/src/tool.ts` — `ToolStreamEvent` and `ToolExecutionContext.onOutput` streaming channel consumed by exec.ts (contract surface for EXEC-001).
- `packages/tools/src/orchestrator.ts` — `runBounded` wires `onOutput` → `tool.output` events into the event trail (fire-and-forget, emit failure swallowed).

## Key Design Decisions

### 1. win32 quoting recipe (empirically derived, `EXECUTOR_MARKER`)

```
cmd.exe /d /s /c "<command>"   with  windowsVerbatimArguments: true
```

- Node's default argument escaping rewrites embedded double quotes into `\"`, which `cmd.exe` does not recognize — commands with quotes (e.g. `node -e "…"`) fail.
- `shell: true` and double-wrapped quotes (`""…""`) were both tested and fail on win32.
- Default shell is `process.env.ComSpec || "cmd.exe"`; non-`cmd` shells (regex `/cmd(\.exe)?$/i` mismatch) fall back to `-c <command>` without verbatim args.
- `windowsHide: true`; `EXEC_DEBUG` env var dumps the resolved spawn shape for diagnosis.

### 2. Dual output buffering + live streaming

- stdout/stderr are collected **separately** into `ExecOutcome.stdout` / `.stderr`.
- Every chunk is also forwarded to `onOutput` in real time (streaming) — the orchestrator turns this into `tool.output` events.
- `maxOutputBytes` is enforced **per stream**: collected buffer is sliced to the remaining cap and `truncated` is set once a stream overflows; the flag survives even if the subsequent stream stays under cap.
- Truncation affects only collection — `onOutput` keeps receiving raw (untruncated) chunks.
- An exception in an `onOutput` observer is caught and ignored: streaming observers must never break execution (see Residual Risks).

### 3. Timeout / abort race handling (recently fixed bug)

- `killTree()`: win32 → fire-and-forget `taskkill /pid <pid> /t /f` (tree + force, reaps detached grandchildren), `unref()`ed; fallback → `child.kill("SIGKILL")`.
- On timeout or abort, a `forced` status (`"timeout"` / `"cancelled"`) is recorded **before** the kill completes, and `done()` prefers the forced status over the later `close` event's exit code. This prevents the fixed bug where a post-abort `close` with nonzero code overwrote the result into `"failed"`.
- `settled` guard makes settlement exactly-once (resolves the promise once, clears the timer, detaches listeners); `child.on("error")` and `close`-without-exit-code map to `"error"`.
- Pre-aborted signals are honored (`opts.signal?.aborted` checked synchronously after wiring the handler).

### 4. Pure primitive — zero policy inside

- `ProcessExecutor` performs **no permission / sandbox / approval checks**; all authorization happens upstream in ToolOrchestrator (permission engine, approval, command allowlist in SandboxManager).
- The shell is an explicit, overrideable injection point; the command string is never parsed or validated inside the executor.
- Orchestrator additionally layers its own `runBounded` timeout race (PROCESS_TIMEOUT) on top of the executor's timeout — defense in depth, both bounded by `sandboxPolicy.process`.

### 5. exec tool risk and error mapping

- `risk: "elevated"` → elevated actions default to "ask" under `defaultEffectForRisk`, triggering approval flow before any command runs.
- Outcome mapping: `success` → status success + command evidence; `timeout` → `PROCESS_TIMEOUT`; `cancelled` → `USER_CANCELLED`; `failed`/`error` → `PROCESS_ERROR` with exit code / reason.

## Tests

Nine cases in `packages/tools/src/process/executor.test.ts` (temp cwd per suite):

1. `runs a command to success and captures stdout` — success path, exitCode 0, exact stdout.
2. `reports failed status on nonzero exit` — exit(3) → `failed`, exitCode 3, error mentions code.
3. `captures stderr separately` — stderr routed to its own field; stdout stays empty.
4. `streams chunks through onOutput` — chunk-by-chunk real-time delivery (`"a"`, `"b"` → `"ab"`).
5. `times out and reports PROCESS_TIMEOUT` — `timeoutMs` → `timeout` status + "timed out" error.
6. `kills the process tree on timeout (no orphan)` — child spawns a `detached: true` grandchild; tree kill must reap it, outcome `timeout`.
7. `returns cancelled when the signal aborts` — `AbortController` abort → `cancelled` (not `failed` — regression guard for the race fix).
8. `truncates oversized output` — 10k bytes vs 100-byte cap → `truncated: true`, captured length ≤ cap.
9. `honors cwd and env` — `cwd` is the process working dir and env vars are merged under `process.env` (`MARKER=42`).

## Acceptance Criteria

| Criterion | Status |
| --- | --- |
| Spawn → stream → bounded collect → exit code, one promise, exactly-once settlement | Covered by tests 1, 3, 8 |
| Timeout bounded, PROCESS_TIMEOUT semantics (error mapped in exec.ts) | Covered by tests 5, 6 |
| Abort → `cancelled`, never overwritten to `failed` by race | Covered by test 7 |
| No orphan processes on force-kill (taskkill /t reaps grandchild) | Covered by test 6 |
| stdout/stderr separated; `onOutput` streams raw chunks even past truncation | Covered by tests 3, 4, 8 |
| cwd/env honored; env merged over process.env | Covered by test 9 |
| No permission/sandbox logic inside the executor | Static review of executor.ts — verified |
| exec tool: elevated risk, bounded schema, error mapping + evidence | Static review of exec.ts — verified |
| Streaming reaches event trail as `tool.output` | Static review of orchestrator.ts `runBounded` — verified |

## Residual Risks

- **Non-win32 path untested in CI**: the `-c shell` branch (POSIX) and SIGKILL tree-kill never execute in this Windows environment; no CI covers them. First Linux/macOS run should be treated as an unknown.
- **onOutput errors swallowed**: a raising observer is silent — only visible if streams are otherwise lost. Consider surfacing observer failure via diagnostics, not by breaking execution.
- **taskkill is fire-and-forget**: `unref()` + no exit-code check means the tree kill is not observed; in pathological cases a descendant could briefly outlive the promise settlement. Accepted trade-off to avoid blocking the kill path.
- **Recipe is empirically derived**: `"${command}"` + verbatim args depends on stock `cmd.exe` behavior; exotic `ComSpec` substitutions (e.g. PowerShell-as-ComSpec) are not covered by tests.
- **Double timeout layering**: both executor (`timeoutMs`) and orchestrator `runBounded` race fire — normally consistent because exec.ts passes `sandboxPolicy.process.timeoutMs` through, but a caller passing a larger `timeoutMs` than the policy value would yield orchestrator-level timeout with a partially killed process (executor timer still armed; cleared only on settle).

## Verification（主会话填写）

> 主会话执行 `pnpm typecheck` 与 `pnpm test` 后在此填写结果（含测试总数与 EXEC-001 相关用例通过情况）。

- `pnpm typecheck`: **green (exit 0)** — 2026-08-11, main session
- `pnpm test`: **115/115 passed (exit 0)** — 2026-08-11, main session; EXEC-001 executor.test.ts 9/9, vs001 exec pipeline 5/5 (含 tool.output 流式、timeout、approval 路由)
- Main-agent review: **done** — 逐文件审查 executor.ts / exec.ts / orchestrator.ts runBounded；修复 orchestrator `classify` 对无 `path` 参数的 filesystem 工具产生空 sandbox target 的 bug（`this.str(args.path ?? args.file) || "."`）；另修复 executor abort 竞态（forced status 优先于 close exit code，见 Key Design Decisions §3）。