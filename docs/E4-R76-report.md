# E4-R76 报告：审批轮询在成功、异常和取消后都结束

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260915-033502).md` §5（F2） |
| reviewedSourceSha（计划 §1） | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 本次起点 HEAD | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 环境 | Windows (win32)、Node `v24.18.1`、pnpm `11.21.0`、vitest `4.1.10` |
| 改动范围 | **仅测试**：`packages/harness/src/delegation-worker.integration.test.ts` |
| Runtime / 生产审批策略改动 | **无** |
| 真实模型调用 | **0 次**（全程 scripted provider） |

本任务**不**重开已结束的 Windows runner 根因调查，**不**修改生产审批策略。

## 2. 结论摘要

**F2：REPRODUCED → FIXED（测试生命周期层）。**

R72 的轮询循环用 `turnSettled` 作为停止信号，但该赋值语句写在下标位置：

```ts
const outcome = await harness.runtime.runTurn(...);  // ← 若这里 throw
turnSettled = true;                                  // ← 永远不执行
await autoApprove;                                   // ← 永远不执行
```

`runTurn` **正常返回**时一切正确；一旦 `runTurn` **reject**，`turnSettled` 保持 `false`，
`await autoApprove` 不可达 → 轮询协程**越过测试体继续存活**，持续调用
`approvalStore.listPending()`，而外层 `finally` 已经 `harness.close()`。

修复：把停止信号移入**覆盖 runTurn 成功/失败的内层 `finally`**，外层 `finally` 仍只负责
关闭 harness。

## 3. 受控反例（可复现，不依赖机器负载或 60s 过期）

计划 §5.1 要求「先写一个受控 runTurn rejection 的反例…不要依赖机器负载或真实 60 秒过期」。
反例用**真实的 `runtime.runTurn` 拒绝路径**：同一 session 上并发发起第二个 turn，
`runTurn` 抛 `SESSION_BUSY`（`packages/core/src/runtime/runtime.ts:801-806`）。
第一个 turn 被停在无法满足的审批上——正是慢审批会造成的状态。

探针（临时文件，已删除）对**同一** `createHarness` 路径分别跑旧/新控制流：

```
VALIDATION OLD: {"mode":"old","runTurnError":"session session_1c2e6e71-… already has an active turn
(turn_40f61b55-… )","pollsAfterReject":10,"pollerStillRunning":true}

VALIDATION NEW: {"mode":"new","runTurnError":"session session_7efbdc81-… already has an active turn
(turn_5706da1e-… )","polls":1,"listCallsAfterStop":0,"pollerStopped":true}
```

| 判据 | 旧控制流 | 新控制流 |
|---|---|---|
| `runTurn` 确实 reject | ✅ `SESSION_BUSY` | ✅ `SESSION_BUSY` |
| 拒绝后轮询是否继续 | **✅ 继续（10 次）** | 已停止（`stop()` 后为 0） |
| 轮询协程是否越过测试体存活 | **`pollerStillRunning: true`** | `pollerStopped: true` |
| `stop()` 之后对 `listPending` 的调用 | 仍会调用 | **0** |

完整输出：`docs/r76-evidence/r76-counterexample.txt`

> **诊断补充（重要，避免过度归因）**：探针最初用「provider `generate()` 抛错」来制造拒绝，
> 结果 `runTurn` **没有** reject——harness 把 provider 错误吸收成了失败 outcome。因此本报告
> 的结论是「**轮询协程在 `runTurn` reject 时不会停止**」，而**不是**「provider 抛错必然导致
> reject」。这一点由真实的 `SESSION_BUSY` 路径证实，不靠推测。

## 4. 修复内容

### 4.1 测试内的最小 helper（仅测试范围）

新增 `startApprovalPoller(harness, opts?)`，接口刻意保持最小：

```ts
const approval = startApprovalPoller(harness);
let outcome;
try {
  outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
} finally {
  await approval.stop();
}
```

- 循环与 `stop()` 的**同步条件**绑定（沿用 R72 的生命周期绑定，**未**恢复固定次数轮询）；
- `stop()` **总是 await** 轮询协程，保证没有异步任务无人等待；
- 轮询自身的异常被 `stop()` 捕获并在 await 处重新抛出 → **不会变成未处理的 rejection**；
- `stop()` **幂等**：重复调用不会挂起或重跑循环。

外层 `finally` 仍只 `await harness.close()`，**未**引入新的生产轮询管理模块。

### 4.2 刻意未做的事

- **未**修改 `StoreApprovalResolver` 的 60s 过期语义；
- **未**放宽权限或修改生产审批策略；
- **未**把固定次数轮询加回来；
- **未**新增生产层模块（helper 只存在于测试文件内）；
- **未**触碰 Runtime（不满足 AGENTS.md 的 Runtime 变更依据，见 R72 §8）。

## 5. 新增回归测试

`packages/harness/src/delegation-worker.integration.test.ts` → 新增
`describe("E4-R76 (F2): the approval poller always stops, including when runTurn rejects")`：

| 用例 | 断言 | 结果 |
|---|---|---|
| **F2 REPRO** | 逐字复现旧控制流：`runTurn` reject 后 `turnSettled` 仍为 `false`，且拒绝后**仍有**轮询发生 | **PASS** |
| **F2 FIX** | 内层 `finally` 中 `stop()`：原始错误 `runTurn exploded` 正常抛出（**未被清理失败掩盖**），`stop()` 后 `listPending` 调用数**不再增长** | **PASS** |
| **F2 FIX** | `stop()` 幂等；await 后无存活 timer（调用数被冻结） | **PASS** |
| **F2 FIX** | 轮询自身抛错时，错误在 `stop()` 处抛出，且 `process.on("unhandledRejection")` 观察到**空数组** | **PASS** |
| **F2 不回归 R72** | 轮询开始后**迟到**压入的审批仍被 `allow`（证明仍是生命周期绑定、非预算绑定） | **PASS** |

**全部使用显式计数观察，未使用长 sleep 依赖**（最长 60ms 的一次性观察窗口），
**未**依赖机器负载或真实 60 秒过期。

### 5.1 成功路径断言保留

原有 P3-6 端到端用例的全部断言**原样保留**：真实子代理启动/完成、merge 事件、
父目录文件内容、子会话最后一 turn 状态。修复只改变同步条件，未削弱任何断言。

## 6. 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm exec vitest run packages/harness/src/delegation-worker.integration.test.ts` | **0** | `Tests 6 passed (6)` |
| 同上，连续 5 次 | **0** | `6 passed` × 5（无 flake） |
| 探针 `packages/harness/src/_tmp_r76_validate.test.ts` | 0 | 旧/新控制流双向对照，2 passed |

证据：`docs/r76-evidence/r76-fixed-test.txt`、`docs/r76-evidence/r76-counterexample.txt`。
临时探针文件已删除，工作树中不残留 `_tmp_*` 测试文件。

## 7. 验收对照（计划 §5）

| 计划 §5 验收项 | 结果 |
|---|---|
| 成功路径文件仍正确合并 | ✅ P3-6 断言原样保留并通过 |
| 受控延迟审批不因旧的轮询预算被漏掉 | ✅ 迟到审批用例（`late-approval` 被 allow） |
| `runTurn` reject 时轮询结束且原始错误保留 | ✅ §3 反例 + F2 FIX 用例 |
| 结束后不再调用 `listPending` | ✅ 显式计数：stop 后调用数冻结为 0 增长 |
| 取消/清理不留活动 timer 或未处理 rejection；优先 fake timers 或显式计数观察 | ✅ 显式计数 + `unhandledRejection` 观察为空 |
| `pnpm build` 与目标测试通过 | ✅ 目标测试 5/5 次通过；`pnpm build` 见 `docs/E4-R78-report.md` |
| 报告明确：此任务补异常清理，不证明历史 R71 ENOENT 一定由同一原因造成 | ✅ §8 |

## 8. 边界与未做的事

1. **本任务只补异常清理路径**，**不**证明历史 R71 CI 的 ENOENT 由同一原因造成。
   R72 §5 的 UNRESOLVED（触发审批延迟的 runner 侧底层诱因）**继续成立**，本轮未触碰。
2. 本轮**未**观测到生产环境真实发生过 `runTurn` reject（F2 原为静态控制流发现）。
   修复的价值在于：该路径一旦发生，测试会留下活动协程与未处理 rejection——属于
   确定性缺陷，但**发生频率未知**。
3. **未**做付费模型调用，**未**推送，**未**修改远端权限。
4. 全量 `pnpm test` 在 R78 收尾统一执行。
