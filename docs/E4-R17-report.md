# E4-R17 报告：修复 terminal ACK 失败后仍消费 prompt，并补租约到期唤醒（N13/N14）

```text
任务：E4-R17（修复 N13/N14）
起始 SHA：15f2ec1（E4-R16 报告）
被测源码 SHA：39adc9a（E4-R17 提交，本地 main，未推送）
开发工作树 fingerprint：39adc9a 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（N13 pending-commit 机制 + N14 租约到期唤醒；Runtime Freeze 例外：
      可复现数据一致性缺陷，附复现测试；未重写 Runtime）
```

## 1. 缺陷与复现

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N13 | `persistRecoveryRecord` 吞掉写入异常并返回输入记录——调用方把失败的 RECOVERED 写入当作 ACK：动作 1 次、storedState=RECOVERY_IN_PROGRESS、queueLength=0（已出队）、promptStatus=consumed、lease=null（plan 附录二精确复现） | 终态写入改 **strict**（失败即抛）：动作完成后 RECOVERED 写失败 → 进入 pending-commit（`needsReconcile`）——队列冻结、prompt 不消费、动作不再执行；重启 actor 发现 pending-commit 记录（`discoverRecoverableTurns` 现包含带 pending-commit 记录的终态 turn）只重试**终态写入**；store 恢复后提交终态并消费（动作仍只 1 次）。EXHAUSTED+proceed 的队列前进同样改为 strict 后才 shift |
| N14 | wait-lease 分支不安排到期唤醒——租约被他人持有时无外部消息永不重试 | `scheduleLeaseWake` 在租约到期时安排有限唤醒（actor 自动重读）；`scheduleReconcileRetry` 对有界 reconcile 窗口重查，瞬态 store 故障自愈 |

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/core/src/runtime/recovery-state-machine.ts` | `RecoveryTaskRecord.needsReconcile?` + `recoveryNeedsReconcile()` 查询 |
| `packages/core/src/runtime/session-actor.ts` | 终态写入 strict（RECOVERED/EXHAUSTED）；失败 → `needsReconcile` pending-commit（队列冻结/prompt 不消费/不重跑动作）；重启分支只重试终态写入；`discoverRecoverableTurns` 纳入 pending-commit 终态 turn；`scheduleLeaseWake`/`scheduleReconcileRetry` |
| `packages/core/src/runtime/recovery-durable.test.ts` | +5 条回归（N13 基本、重启不重跑、store 恢复提交、租约唤醒、到期后继续） |

Runtime Freeze 符合性：属确定性数据一致性缺陷（N13 精确复现），附故障窗口测试；
改动限于 session-actor 的恢复协调逻辑，未改动运行时架构。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| terminal 写失败时不 consumed、不 shift、不让 T2 越过未提交 T1 | ✅ | N13 测试：queueLength=1、prompt 仍 promoted、record.needsReconcile=true、lease undefined |
| store 恢复后可提交终态并消费，动作不会无依据重复执行 | ✅ | `failRecoveredWrites=false` 后再次 drain：state=RECOVERED、prompt consumed、queue=0、动作总数仍 1 |
| 崩溃发生在动作结束后、终态前和终态后、prompt consume 前，均可明确恢复 | ✅ | 重启 actor（同 store）只重试终态写入，不重跑动作（b.total()=0）；pending-commit 记录对重启可见 |
| intent 写失败仍动作数 0；旧 attempt budget 回归保持 | ✅ | 既有 3 条 E4-08 测试通过（FailingStore 0 动作、budget 跨实例、lease 单飞） |
| wait-lease 到期后无外部消息也会重试，未到期不偷跑 | ✅ | 租约生效期 drain 不动作且安排了有限唤醒；到期+有界退避后动作 1 次、RECOVERED |
| durable terminal 重启不重复动作；无法判定外部效果时明确 reconcile | ✅ | pending-commit = 明确 reconcile 态（不重跑）；崩溃窗口内（动作后、marker 前）为有界 at-least-once（attempt budget 封顶） |
| 实进程测试与内存 fault-injection 各覆盖不同层 | ✅ | 本任务 fault-injection 在 actor/store 层（durable-recovery-store-xproc 既有实进程测试 5/5 通过） |
| 所有等待有有界 timeout，使用 barrier/clock 而非长 sleep | ✅ | 测试用注入时钟（now/scheduler）；无真实长 sleep |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| R17 目标集（recovery-durable/followup-recovery/recovery-state-machine/durable-recovery-store/durable-recovery-store-xproc） | PASS：5 files / **39 tests** |
| `pnpm exec vitest run packages/core packages/harness` | PASS：68 files / **654 tests** |
| `pnpm test`（全仓） | 311 files：**5612 passed / 1 skipped / 4 failed**（仅 e4-09 脏树 dirty-refusal，pristine/CI 下通过） |

- reviewedSourceSha：`39adc9a`。
- 真实模型网络调用数：**0**；fake 调用数：0。

## 5. 未完成 / 后续任务接口

- 崩溃窗口（动作结束后、`needsReconcile` marker 写入前）无法与“动作前崩溃”区分，
  保持有界 at-least-once（attempt budget 封顶）——这是最小的诚实窗口，报告中如实
  说明，不承诺 arbitrary exactly-once。
- 纠正 R06 报告“已 durable 才 shift”的过度描述由 R20 文档收口统一处理（本任务
  提供新故障窗口证据：终态写失败时队列冻结）。
