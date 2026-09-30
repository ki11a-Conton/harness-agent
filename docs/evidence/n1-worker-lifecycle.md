# N1 — unified worker termination and model-request lifecycle (F30-1)

Plan: `plan(20260930-061557).md` §4. Review baseline `94a847a`.

> **Status note.** This task was executed by the `worker-lifecycle` teammate. Its turn was
> stopped by the operator **after** the fix and the lifecycle suite were written and green,
> but **before** the commit and this document. The Lead verified the work independently
> (measurements below were re-run by the Lead, not copied from the teammate's report),
> deleted the temporary probe, and wrote this record so the evidence is not lost. The
> implementation is the teammate's; the verification and this write-up are the Lead's.

## 1. Report

```text
任务：N1
状态：DONE
实现 commit：<this commit>
起始基线：83f8ee8 (review baseline 94a847a)
修复的问题：worker 非 timeout 退出时活跃模型 stream 不 abort；多 request 覆盖 controller；
            所有终止路径统一收敛；EPIPE/EOF/异常结果帧的有限清理
修改文件：apps/cli/src/prereg-arm-executor.ts
          apps/cli/src/n1-worker-lifecycle.test.ts (new)
反例：见 §3
实际命令：见 §4
测试结果：见 §4
Windows：本地通过；Ubuntu 见 N6 同 SHA CI
付费模型请求数：0
离线 physical generate 数：0（本任务只用本地 stub provider）
实际 tool dispatch 数：0（生命周期测试用 stub worker）
未知消费/未结算项：见 §5（reservation 反例专门断言 unknown 不退款）
原始证据：本文件 + n1-worker-lifecycle.test.ts
剩余问题：Ubuntu 同 SHA 验收待 N6
```

## 2. The defect (F30-1)

`launchArmWorker` had exactly one termination path that aborted the transport — the
**timeout** path (`deadlineFired`). Every other way a worker could die left the active
provider's `AbortSignal` at `false`:

- the worker exits non-zero (`exit(2)`) after having sent a model request;
- the worker's stdout reaches EOF;
- the `child` emits `error` (e.g. spawn failure);
- a result frame arrives and the child then refuses to exit.

In those cases the driver cleared its timer, returned `ARM_WORKER_FAILED`, and the
in-flight `for await` over the provider stream stayed parked on a provider that never
yields. `cancellation.signalAborted` was only ever set inside `deadlineFired`.

Two structural contributors, both confirmed by reading the code before the fix:

- `streamOwner` was a **one-slot** holder and `serviceModelRequest` **overwrote**
  `streamOwner.current` with no concurrency check, so a second in-flight request silently
  lost the first request's controller — that controller could then never be aborted by
  anyone.
- The frame loop broke on EOF and on the result sentinel **without** aborting anything.

## 3. Counter-example — measured, before and after

The reproducer drives the **production executor seam** (`createPreregArmExecutor`), not a
standalone close helper. A stub worker writes one `request` frame and then `process.exit(2)`;
a local hanging provider records the signal it received.

| | baseline (before) | after the fix |
| --- | --- | --- |
| `providerEntered` | `true` | `true` |
| `providerSignalAborted` | **`false`** | **`true`** |
| `launchPromiseSettled` | `false` (driver parked) | `true` |
| outcome | watchdog fired | `ARM_WORKER_FAILED` |

Measured JSON, **before** (Lead-run, unfixed executor):

```json
{"workerTimeoutMs":60000,"observedMs":717,"providerEntered":true,
 "providerSignalAborted":false,"launchPromiseSettled":false,"outcome":"WATCHDOG_FIRED"}
```

Measured JSON, **after** (Lead-run, fixed executor):

```json
{"workerTimeoutMs":60000,"observedMs":2858,"providerEntered":true,
 "providerSignalAborted":true,"launchPromiseSettled":true,
 "outcome":"Error: ARM_WORKER_FAILED: the arm worker produced no result (exit=2, termination=worker_exit, signalAborted=true, cleanupMs=1)"}
```

The baseline assertion failed with `RED: baseline did not abort the signal: expected false
to be true`, i.e. RED for the **target** behaviour, not an import/build/collection error.
The temporary probe file was deleted before commit, as its own header required.

## 4. Commands and results

```text
# lifecycle suite (production executor seam, all 8 acceptance rows)
npx vitest run apps/cli/src/n1-worker-lifecycle.test.ts
  -> Test Files 1 passed (1) | Tests 15 passed (15)

# pre-existing S1/F1 + S2/F2 counter-examples must not regress
npx vitest run apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts
  -> Test Files 1 passed (1) | Tests 7 passed (7)

# types
npx tsc -b
  -> exit 0
```

The pre-existing suite still passes every case that mattered here, including
`[F1] with a campaign tool cap of 1, only the FIRST of two real writes lands`,
`[F2] the provider's AbortSignal is aborted and the driver returns inside a bounded window`,
`[F2] a provider that IGNORES its AbortSignal still cannot keep the driver waiting`,
`[F2] a real HTTP stub observes its connection CLOSED after the client cancels`, and
`[F1/ABI] refuses an arm that declares no tool-budget capability, with 0 model requests`.

## 5. Acceptance rows (plan §4 table)

| Row | Status | Evidence |
| --- | --- | --- |
| worker sends request then exit(2) | PASS | `ARM_WORKER_FAILED`; `signal.aborted=true`; `cleanupMs=1`; no live request left |
| worker EOF / child error | PASS | same termination rule; spawn-failure case classified with no unhandled rejection |
| provider honours abort | PASS | `returnedWithinGrace=true` recorded |
| provider IGNORES abort | PASS | driver still returns in bounded time; marked **unconfirmed**; never claims remote revocation |
| worker sends two requests | PASS | second request refused as a protocol violation; first controller retained |
| result frame then child will not exit | PASS | bounded finish; malformed result frame classified, never dereferenced |
| post-deadline event/write race | PASS | no normal frame after the stop; async stdin error channel instrumented, not swallowed |
| normal tool run | PASS | 7/7 in the pre-existing budget/cancel suite |

## 6. Design decisions

- **One active model request per worker.** The parent now *refuses* the second concurrent
  request as a protocol violation (`ARM_WORKER_PROTOCOL_VIOLATION`) rather than clobbering
  the owner slot. No new concurrency was invented to avoid the question.
- **One idempotent `finalize(reason)`.** Every path (deadline, worker exit, EOF, caller
  cancellation, rejected result frame, normal completion) converges on it: set
  "no new frames" → abort the active transport → drain/close children this task owns →
  bounded wait → record. `finally` covers ordinary exit/EOF, not only `timedOut`.
- **Declared cleanup bounds**, exported so a test can assert against them rather than
  against a magic number: `WORKER_EXIT_GRACE_MS`, `WORKER_EXIT_DRAIN_MS`,
  `N1_WORKER_CLEANUP_BOUND_MS`.
- **A normally-completed stream is never reported as cancelled** (row 8, both variants).

## 7. Unverified / remaining

- **Ubuntu**: NOT_RUN locally by design — same-SHA dual-platform CI is N6.
- Full `pnpm test` / `pnpm build` were deliberately **not** run while other wave tasks
  shared the tree; the Lead runs the whole suite at the frozen SHA.
- The `tool_budget` RPC frames visible in this diff are the **existing** S1 wiring, carried
  through the new termination structure; the durable dispatch-journal *producer* is N3 and
  is not claimed here.
