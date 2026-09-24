# E4-R25 Report — 恢复复合故障专项验证（V01）

- 被测 SHA：`1175acb3e03198d201b44be7b9a7adf89e6afd34`
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 状态：PASS（确定性复现 + 最小修复 + 全回归；Runtime Freeze 例外：可复现数据一致性缺陷）
- 真实模型调用：0（全部 fault-injection / scripted）

> **SUPERSEDED (E4-R30, 2026-09-12)** — 本报告的 **marker-loss 修复结论保持有效**
> （`durableTurnIsTerminal` 以 main store 的 durable TURN 终态协调，V01-a/a-restart/b/c 仍全绿）。
> 但本报告第 3 节「lease/intent 暂时错误恢复后有有限唤醒」一行的 **验收依据不充分**：
> 该行引用的是 R17 N14（**外部持有有效 lease** 的到期唤醒），与「**本 actor 自己的 lease/intent
> 写入被存储暂时拒绝**」不是同一条故障路径。后者在 R25 当时**没有** scheduler callback
> ——复现为 `{"id":"LEASE_FAILURE_WAKE","scheduled":0,"calls":0}`，即存储恢复后不会自动
> 重新 drain。该缺口由 **E4-R30 (G04)** 修复，见 `docs/E4-R30-report.md`。
> 本报告保持其被测 SHA `1175acb…` 与当时证据不变，不追改历史结论。

## 1. 复现（修复前，确定性可复现测试）

V01 复合故障窗口：**RECOVERED 终态写失败 且 needsReconcile marker 同时写失败**（恢复存储
对这两种写入持续故障，其余写入正常——lease/intent/retry-state 都成功）。与此对照的全店写入故障
（lease 也写不进去）在 E4-08 已 fail-closed（动作 0 次），本任务验证其仍然成立（V01-c）。

用 `CompoundAckFailStore`（只拒绝 RECOVERED 与 needsReconcile 写）复现：

| 场景 | 修复前行为 | 缺陷 |
|---|---|---|
| V01-b：故障期间动作 1 次；存储恢复后同一 actor 继续 drain | 记录被标 RETRY_SCHEDULED（把"终态+marker 双写失败"错判为 interrupted retryable）→ 退避后**重跑动作** | 重复外部副作用 |
| V01-a-restart：新 actor 重启（存储已恢复） | durable turn 已 terminal 但 marker 未落盘 → `discoverRecoverableTurns` 跳过 → prompt 永不消费、从不恢复 | 泄漏挂起 |

原实现只把 `needsReconcile` **布尔 marker**当作"动作已完成"的证据；marker 无法落盘时，系统
对"动作已完成"的事实失忆（重启跳过=泄漏；同进程愈合=重跑）。这正对应计划 V01 的预见：
"若 pending marker 无法落盘，系统不能假定已持久化。优先依据现有 durable turn 终态协调。"

## 2. 修复（`packages/core/src/runtime/session-actor.ts`，最小、协调层）

判别依据改为 **main store 的 durable TURN 终态**——`runTurn` 抛异常 ⇔ durable turn 非终态
（这才需要 retry）；`runTurn` 正常返回 ⇔ durable turn 已是 completed/failed/cancelled（动作已
完成）。因此：

1. `recoverHead` 的 `RECOVERY_IN_PROGRESS` 分支：`recoveryNeedsReconcile(record) ||
   await this.durableTurnIsTerminal(head.turn.id)` 时进入 reconcile——只重试终态写入并消费，
   **永不重跑动作**。存储仍故障 → `scheduleReconcileRetry` 冻结等待（T2 不越位）；
   存储恢复 → RECOVERED 落盘 + consume + shift。
2. `discoverRecoverableTurns`：terminal turn 且恢复记录为 `RECOVERY_IN_PROGRESS`（marker 丢失）
   也入队为可 reconcile，修复重启泄漏。
3. 保留 E4-08 fail-closed：全店写入故障时 lease 写失败 → wait-lease，动作 0，verbatim 不假
   consume/不假 shift（V01-c）。

事务边界诚实说明：若 main-store turn 写入前崩溃（runTurn 未返回且未落终态），仍在"动作前
崩溃"窗口；此时 durable turn 非终态 → interrupted/retry 路径正确重跑。仅当**动作已由系统自身
持久化为终态 turn** 时才承诺不重跑。非幂等外部副作用在崩溃窗口（动作后、main-store turn 终态
前）仍是有界 at-least-once（attempt budget 封顶），不伪称任意窗口 exactly-once。

## 3. 验收对照

| 计划 V01 验收项 | 结果 | 证据 |
|---|---|---|
| 每种故障都有完整状态时间线与 action 调用次数 | ✅ | V01-a/b/c 各断言 action 总数、record state、queue、prompt 状态 |
| ACK 与 marker 连续失败后不会假 consume/假 shift | ✅ | V01-a：record 保持 RECOVERY_IN_PROGRESS、队列冻结 1、prompt 未消费 |
| 新 actor 不因丢失内存 marker 静默重放已知完成的 action | ✅ | V01-a-restart：终态 turn 判定 → b.total()=0、消费完成、队列清空 |
| lease/intent 暂时错误恢复后有有限唤醒，测试真实触发 scheduler callback | ⚠️ SUPERSEDED | R25 当时以 R17 N14（**外部**持有有效 lease 的到期唤醒）代替，**并非**本 actor 自身 lease/intent 写失败的路径。该缺口由 **E4-R30 (G04)** 修复：lease/intent/CAS 各自正负例、有界退避、close 取消 —— 见 `docs/E4-R30-report.md` |
| action 未知时的行为有明确合同，不伪称 exactly-once | ✅ | 本报告第 2 节事务边界；R17 既有边界文档延续 |
| 若修改 Runtime，报告明确对应复现与 Freeze 例外类别 | ✅ | 确定性正确性缺陷 + 可重复测试（Freeze 例外 #1）；改动仅 session-actor 恢复协调，未动架构 |
| 相关 recovery、durability、race/security 回归通过 | ✅ | 见第 4 节 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（tsc -b 全仓） | exit 0 |
| `vitest run packages/core/src/runtime/recovery-durable.test.ts` | 12/12（新增 V01-a / a-restart / b / c 4 例）— R25 被测 SHA 当时的值；E4-R30 后同一文件为 **19/19**（另加 R30-a…g 7 例） |
| `vitest run recovery-state-machine + followup-recovery + durable-recovery-store` | 3 files / 30 tests PASS |
| `vitest run packages/core packages/harness` | 68 files / **658 tests** PASS |
| `vitest run session-race + session-race2 + race-split` | 3 files / 15 tests PASS |

- testedSourceSha：`1175acb`（本地 main，未推送）。

## 5. 残余限制

- 崩溃窗口（`runTurn` 已产生外部效果、但 main-store turn 终态持久化前）仍无法与"动作前崩溃"
  区分，保持有界 at-least-once（attempt budget 封顶）——本报告如实说明。
- **SUPERSEDED (E4-R30)** — ~~`durableTurnIsTerminal` 依赖 main store 读取；main store 与恢复
  store 同时不可读时 fail-closed（返回 false → 走原 interrupted/retry 路径，动作受 attempt
  budget 约束）。~~ 返回 `false` 会把「读取失败」**误当作**「已确认非终态」，从而写出
  `RETRY_SCHEDULED` 的重试 WAL（授权重跑一个可能已完成的动作）。R30 已改为三态
  `boolean | "unknown"`：读取失败 = `unknown` → 不重试、按有界退避等待协调。
- V01 关闭了"marker 丢失"这一具体复合窗口；没有为凑任务数重写 Runtime。