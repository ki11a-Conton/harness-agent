# E4-R32 Report — 恢复存储组合故障与 intent 退避（H01/H02）

- reviewedSourceSha（计划基线）：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- testedSourceSha：**dirty worktree on `bcf3f42c`**（本轮 R32 改动未提交；被测即工作树源码 + 重建 dist）
- 上轮基线：`493866f03d942e85870cc658eb721cfbf2389ec2`
- 状态：**PASS**（确定性复现 + 最小恢复调度修复 + 逐条正负例 + 回归）
- 真实模型调用：0（全部 fault-injection / scripted provider）
- Runtime Freeze 例外：仅因 **H01/H02 的确定性复现**获得最小恢复调度修改范围；未新增架构、未重写 Runtime、保留 ToolOrchestrator / PermissionEngine / SandboxManager / Verification。
- 变更文件：
  - `packages/core/src/runtime/session-actor.ts`
  - `packages/core/src/runtime/recovery-durable.test.ts`（+4 例，共 **23** 例）

## 1. 问题与范围

R30 关闭了「暂时故障后无 scheduler 回调」，但留下了两个确定性缺口：

| ID | 优先级 | 缺陷 |
|---|---|---|
| H01 | P1 | intent 写失败后，`releaseLease` 的 `getRecord` **再失败**会把异常抛出失败处理器 → 跳过 `scheduleStoreRecheck()`；队头保留、`action=0`、**timer=0**，并产生未处理的后台 drain 拒绝 |
| H02 | P2 | 连续 intent 失败时，每一次**成功的 lease 写**都会提前把 `_storeRecheckCount` 清零 → 6 次重检延迟恒为 `[1000,1000,1000,1000,1000,1000]`，与「递增退避」的声明不符 |

范围声明：H01 证明的是**异常逃逸与恢复停滞**，不声称已发生外部动作重复；H02 有 1 s 下限，**不是零延迟死循环**。两者都以 `RecoveryStore` 读取/写入失败为同一根因，本次**限定**修复相邻重检入口的该根因分支，未做存储层重构。

## 2. 复现（修复前，确定性）

复现脚本（测试内固定，非手工）：`IntentFailReadFailStore` 在**第一次**写 `RECOVERY_IN_PROGRESS` intent 时抛错，并让**其后所有** `getRecord` 抛 `recovery read outage`（同一次故障同时打掉写与读）。

```text
$ env -u NODE_OPTIONS node_modules/.bin/vitest run packages/core/src/runtime/recovery-durable.test.ts -t R32
 × R32-a (H01): an INTENT refusal whose lease-cleanup READ also fails still schedules exactly ONE bounded re-check …
 × R32-b (H02): consecutive INTENT-write failures ESCALATE and cap the re-check delay …
 × R32-c (H01): a re-check callback that fires while the recovery READ is STILL down …
 × R32-d (H01): once healed, a FOREIGN live lease is respected …

AssertionError: expected Error: recovery read outage to be undefined      (R32-a：清理读异常逃逸为 drain 拒绝)
AssertionError: expected [ 1000, 1000, 1000, 1000, 1000, …(2) ] to deeply equal [ 1000, 2000, 4000, 8000, 16000, …(2) ]  (R32-b：H02)
 Test Files  1 failed (1)
      Tests  4 failed | 19 skipped (23)
```

H01 基线实测与计划一致：`rejected="recovery read outage", scheduled=0, calls=0, queue=1`。

## 3. 根因与修改点（`packages/core/src/runtime/session-actor.ts`）

### 3.1 H01 — 清理读失败不得阻断重检、不得逃逸

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `releaseLease()` | `getRecord` 抛错 → **逃出**调用方 catch → 跳过 `scheduleStoreRecheck()`，drain Promise 拒绝 | 整体 `try/catch`：清理是**尽力而为**，错误写 degraded 通道（可观察）；**无论成功与否调用方都保留有限唤醒路径**；仍只用 `lease.owner === this._ownerId` 判定，**绝不释放他人 lease** |
| `recoverHead()` 首段 `loadOrCreateRecoveryRecord()` | recovery-store 读失败 → 抛出 `recoverHead` → drain 拒绝、无 timer | `try/catch`：读失败 ⇒ durable 状态**未知** ⇒ **不执行动作**、`scheduleStoreRecheck()` 后 `return "wait-backoff"`（同根因分支，fail-closed + 自愈） |
| `scheduleStoreRecheck()` 回调 | `void this.drainFollowups()`（拒绝即未处理拒绝） | `void this.drainFollowups().catch(log)`：后台回调的异步错误**局部处理**，记录后保持有限唤醒路径；**不**同步递归 drain |

解耦语义：**「安排重检」与「尽力清理 lease」彻底解耦** —— 清理失败只影响可观察日志，不影响唤醒调度。

### 3.2 H02 — 退避重置点必须在「本轮严格写全部成功」之后

```diff
-    record = await this.acquireLease(record);
-    // The durable write path is healthy again — restart the re-check backoff.
-    this._storeRecheckCount = 0;          // ← 单次 lease 写成功就清零（掩盖 intent 持续故障）
+    record = await this.acquireLease(record);
...
     attempt = await this.persistRecoveryIntent(attempt);
+    // lease + attempt-intent 均落盘 ⇒ 本轮必要持久化成功 ⇒ 才重置退避计数
+    this._storeRecheckCount = 0;
```

重置语义明确为：**本轮恢复所需的必要持久化步骤（lease + intent）已成功**，而非「任意单次写入成功」。故障期间**不调用 `begin`** ⇒ 不消耗动作 attempt，也不把存储 I/O 故障记为模型失败 / EXHAUSTED。

## 4. 验收对照

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| intent 失败 + release 读取失败：`action=0`、prompt 不 consumed、队头不 shift、**恰好一个有效 timer**、无未处理拒绝 | ✅ | **R32-a**：`drainError===undefined`、`total()===0`、`scheduled.length===1`、`liveTimers===1`、队列长 1、无 `consumed` |
| 存储恢复后触发该 callback：重读 durable、动作恰好一次、最终 `RECOVERED`、prompt consumed、队列继续 | ✅ | **R32-a** 后半：`readOutage=false; failIntentWrites=false` → `scheduled[0].fire()` → `total()===1`、`state==="RECOVERED"`、队列长 0、`consumed` 出现（无新用户消息、无第二次动作） |
| 重检回调期间 `getRecord` 再失败：继续安排有限重检，不挂死、不把 unknown 当不存在、不执行动作 | ✅ | **R32-c**：fire 后 `scheduled.length>=2`、`liveTimers===1`、`total()===0`、记录仍 `PENDING`/attempt 0（**未被当作不存在而重建**） |
| 长期 intent 失败：延迟**确实增长并封顶**（非全等序列蒙混） | ✅ | **R32-b**：7 轮 → `[1000,2000,4000,8000,16000,30000,30000]`（`toEqual` 精确断言；修复前为全 `1000`） |
| 故障期间 durable attempt 不增长；健康恢复后按正常状态机计数 | ✅ | **R32-a**：故障期 `peek().attempt===0`；恢复后 `state==="RECOVERED"` |
| 恢复后其他 owner 仍持 live lease：不抢跑；close 取消 timer，旧 callback 不复活 | ✅ | **R32-d**：foreign live lease → `total()===0`、`lease.owner` 仍为 `other-live-owner`（未被释放）、`liveTimers===1`；`close()` 后 `liveTimers===0` |
| R30 原 7 例 + marker-loss / reconcile 回归继续通过 | ✅ | 修复后 `recovery-durable.test.ts` **23/23**（含 R30-a…g、N13/N14、V01-a…c） |
| `vitest run recovery-durable`、`pnpm test:race`、`pnpm typecheck` | ✅ | 见第 5 节 |

## 5. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/core/src/runtime/recovery-durable.test.ts`（**修复后**） | **23/23 PASS**，Test Files 1 passed，exit 0 |
| 同上，**修复前**（`-t R32`） | **4 failed \| 19 skipped** — 见第 2 节 |
| `pnpm typecheck`（`tsc -b` 全仓） | **exit 0** |
| `pnpm test:race` | **11 files / 23 tests PASS**，exit 0 |

测试助手 `recordingScheduler()` / `liveTimers()` 语义修正（E4-R32）：一个 timer 记 `fired` 标记，`liveTimers` = 未取消**且**未触发 —— 触发过的 timer 不再存活。R30-g 的「每 actor 至多 1 个有效 timer」断言语义不变。

## 6. 残余限制与诚实边界

- **仍只关闭「暂时性」存储故障**：永久错误/损坏记录继续走既有 `blocked`/`TERMINAL_FAILED` 合同，不被自动清除。
- **H01 修复的是「异常逃逸 + 调度停滞」**，不改变 fail-closed 合同（动作前仍要求 lease + intent 已持久化），也不声称消除了外部动作的重复可能。
- **上界 30 s 是单次重检间隔上限，不是总时长上限**：长期故障会持续以 ≤30 s 间隔重检，直到 `close()`。
- **真实时钟 vs 注入时钟**：注入 `now`（测试/手动时钟）时默认 scheduler 为 no-op，由调度器驱动 —— 与 E3-10 既有约定一致。
- **本轮改动未提交**：testedSourceSha 标记为 **dirty worktree on `bcf3f42c`**；提交/推送与远端 CI 核实按 R35 收口处理，不得用基线 `bcf3f42c` 的旧 CI 证明 R32 新代码。
