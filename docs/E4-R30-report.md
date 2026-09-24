# E4-R30 Report — 恢复存储暂时故障后的有限唤醒（G04）

- 被测 SHA：工作树基于 `964ecc94`（R27 `f2f1b0b` / R28 `fb33ba9` 之后）；R29/R30 为**未提交工作树**改动。
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`；reviewedSourceSha `493866f03d942e85870cc658eb721cfbf2389ec2`。
- 状态：PASS（确定性复现 + 最小恢复调度修复 + 逐条正负例 + 全回归）
- 真实模型调用：0（全部 fault-injection / scripted）
- Runtime Freeze 例外：已复现的**活性**缺陷（动作 0 次是正确的 fail-closed，但存储恢复后不会自愈），
  仅做最小恢复调度修复，未扩展 Architecture。
- 变更文件：
  - `packages/core/src/runtime/session-actor.ts`
  - `packages/core/src/runtime/recovery-durable.test.ts`（+7 例，共 19 例）

## 1. 复现（修复前，确定性）

G04：bound nonterminal turn 遇 RecoveryStore **暂时拒绝** lease/intent 写入时，`action=0`
（fail-closed 正确），但**没有 scheduler callback** —— 存储恢复后该 actor 不会自动重新
drain，必须等外部消息或显式 drain。计划复现锚点：

```json
{"id":"LEASE_FAILURE_WAKE","scheduled":0,"calls":0}
```

**实测复现**（把 `session-actor.ts` 临时回退到 HEAD、保留新增测试）：

```text
$ ./node_modules/.bin/vitest run packages/core/src/runtime/recovery-durable.test.ts -t "R30"
 × R30-a: a refused LEASE write is fail-closed (0 actions) yet schedules exactly ONE bounded re-check
 × R30-b: after the store heals, firing the RECORDED callback converges with NO new user message
 × R30-c: a refused INTENT write is fail-closed (0 actions) and schedules a bounded re-check
 × R30-d: a lost CAS race (another owner won) schedules a bounded re-check, never a stall
 × R30-e: an UNREADABLE durable turn is 'unknown' — no dangerous replay, a bounded re-check instead
 × R30-f: close() cancels the timer; a stale callback performs NO action and schedules NO new timer
 × R30-g: a long outage backs off with a BOUNDED delay — never a hot loop, never a permanent stall

AssertionError: expected +0 to be 1     (R30-a/b/c/d/f: scheduled.length was 0)
AssertionError: expected +0 to be 6     (R30-g: no re-check was ever scheduled)
AssertionError: expected 'RETRY_SCHEDULED' to be 'RECOVERY_IN_PROGRESS'   (R30-e)

 Test Files  1 failed (1)
      Tests  6 failed | 1 passed | 12 skipped (19)
```

`R30-e` 修复前失败在另一处：`durableTurnIsTerminal` 把**读取失败**返回 `false`，被当作
「已确认非终态」，于是把中断记录推进为 `RETRY_SCHEDULED`（授权重跑一个可能已完成的动作）。

## 2. 修复（`packages/core/src/runtime/session-actor.ts`）

### 2.1 有界、单一的重检 timer

新增常量与字段：

| 符号 | 值/作用 |
|---|---|
| `RECOVERY_STORE_RECHECK_BASE_MS` | `1_000` — 重检下限 |
| `RECOVERY_STORE_RECHECK_MAX_MS` | `30_000` — 退避上限（有界） |
| `_storeRecheckCount` | 连续暂时故障计数；一次成功写入即归零 |
| `scheduleStoreRecheck()` | 新增私有方法：**取消旧 timer 再排一个**（每 actor 同时至多 1 个有效 timer），延迟 `min(base × 2ⁿ, max)` |

回调语义（满足计划的四条硬约束）：

- **开始 action 前仍要求 lease/intent 已持久化** — 失败分支不调用 `begin`、不执行动作，fail-closed 不变。
- **回调执行前重新读 durable 状态** — 回调 `→ drainFollowups() → recoverHead() →
  loadOrCreateRecoveryRecord() → store.getRecord()`，从不沿用过期记录。
- **重检不消耗模型 action 的 attempt budget** — 全程没有 `transitionRecoveryTask(begin)`。
- **关闭取消、旧 callback 不复活 actor** — `close()` 已取消 `_retryTimer`；回调自身再判
  `if (this.closed) return;`，且 `drainFollowups()` 首行也 `if (this.closed) return;`（三重保险）。

### 2.2 三个失败分支接入

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `acquireLease` throw（store 拒绝 lease 写 / CAS 冲突） | `return "wait-lease"`（无 timer） | `scheduleStoreRecheck()` + `return "wait-lease"`；成功路径 `_storeRecheckCount = 0` |
| `persistRecoveryIntent`（attempt-intent）throw | `releaseLease` + `return "wait-lease"`（无 timer） | `releaseLease` + `scheduleStoreRecheck()` + `return "wait-lease"` |
| `durableTurnIsTerminal` 读取失败 | `return false`（→ 推进重试 WAL） | `return "unknown"` |

### 2.3 `durableTurnIsTerminal` 改三态

`Promise<boolean>` → `Promise<boolean | "unknown">`：

- `completed`/`failed`/`cancelled` → `true`（动作已完成，只 reconcile）
- 记录不存在 → `false`（确实没有 durable turn，非终态）
- **读取抛错 → `"unknown"`**（无法判定，不得当作「已确认非终态」）

`recoverHead` 的 `RECOVERY_IN_PROGRESS` 分支在 `unknown` 时**不重试**、`scheduleStoreRecheck()`
后 `return "wait-backoff"`：既不危险重跑，也不永久停顿。

> 说明：CAS 冲突（另一 owner 胜出）与 store 暂时拒绝写入走**同一条**有界重检路径。重检会
> 重新读取记录：若另一 owner 仍持有效 lease，`leaseHeldByOther` 会改排 `scheduleLeaseWake`
> （N14），行为正确且不会抢占。

## 3. 验收对照

| 计划验收项 | 结果 | 证据（测试名） |
|---|---|---|
| 故障时 provider/action 调用数 0，prompt 不 consume，T1 不 shift | ✅ | 全部 R30 用例断言 `total()===0` + 队列长度 1 + 无 `consumed` |
| 有且仅有有效的有限重检 timer；测试触发 callback，而不是主动再调用 drain | ✅ | R30-a/b `scheduled.length===1`；R30-g `liveTimers(scheduled)===1`；R30-b 由 `scheduled[0].fire()` 驱动收敛 |
| 切换 store 恢复并触发 callback 后无需新消息即可完成 | ✅ | R30-b：`failLeaseWrites=false` → `fire()` → `RECOVERED` + consumed + 队列清空 |
| lease、intent、CAS、有效外部 lease 分别有正负例 | ✅ | R30-a（lease 写失败）、R30-c（intent 写失败）、R30-d（CAS 冲突）、N14（有效外部 lease，既有正负例保留） |
| marker 丢失但 durable turn 已终态时仍只补 ACK，不重跑已知完成动作 | ✅ | 既有 V01-a-restart / V01-b 仍全绿（本次未改该路径） |
| durable turn 读取未知时不会被当作确认未完成而危险重试 | ✅ | R30-e：读取失败 → 记录保持 `RECOVERY_IN_PROGRESS`/attempt 1（修复前为 `RETRY_SCHEDULED`）；动作 0 次 |
| close 后触发旧 callback 无 action、无新 timer | ✅ | R30-f：`close()` → `cancelled===true`；fire 旧 callback → `total()===0` 且 `scheduled.length===1` |
| 长期故障有界退避，attempt/队列状态准确；相关 race/security 回归通过 | ✅ | R30-g：6 次 drain → 延迟非递减、max ≤ 30 s、且末次 > 首次（确实在退避）；`_storeRecheckCount` 在写成功后归零（R30-a 断言 attempt 未被消耗） |
| 至少一项测试使用真正的 durable store 或可控持久化接口 | ✅ | R30-d 使用 `MemoryRecoveryStore` 的真实 CAS 版本号语义（陈旧版本 → 写入被拒） |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/core/src/runtime/recovery-durable.test.ts`（**修复后**） | **19/19 PASS**（Test Files 1 passed，exit 0） |
| 同上，**修复前**（源码临时回退） | 6 failed \| 1 passed \| 12 skipped — 见第 1 节 |
| `vitest run packages/core/src/runtime` | **34 files / 406 tests PASS**，exit 0（含全部 `race-*`、`fault-injection*`、`crash-*`） |
| `pnpm typecheck`（`tsc -b` 全仓） | exit 0 |

- 本轮 R29/R30 改动为本地工作树改动，**未提交、未推送**；推送与新 CI run 按计划 R31 #4 处理
  （testedSourceSha 与 documentationCommitSha 严格区分）。

## 5. 残余限制与诚实边界

- **本任务只关闭「暂时性」写失败**。永久错误或损坏记录仍走既有 `blocked`/`terminal` 合同
  （`TERMINAL_FAILED` / EXHAUSTED-block-queue 冻结队列），**不会**被自动清除，也**不会**无界热循环。
- **崩溃窗口不变**：`runTurn` 已产生外部效果但 main-store turn 终态尚未落盘时崩溃，仍是有界
  at-least-once（受 attempt budget 封顶）—— 与 R25 的事务边界声明一致，本次未改变该承诺。
- **重检延迟是固定退避，不是时钟对齐**：真实时钟下用 `setTimeout`；注入 `now`（测试/手动时钟）时
  默认 scheduler 是 no-op，由调度器驱动 —— 与既有 E3-10 约定一致。
- **不构成「存储必定最终恢复」的保证**：上界 30 s 是单次重检间隔上限，不是总时长上限；长期故障
  会以 30 s 间隔持续重检，直到 actor `close()`（这是有界退避，不是有界总时长）。
- **R25 的 marker-loss 修复结论仍然有效**；本任务只替换其「有限唤醒已验收」的不充分依据，
  未改写 R25 的历史证据（见 `docs/E4-R25-report.md` 顶部 SUPERSEDED 指引）。
