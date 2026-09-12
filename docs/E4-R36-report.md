# E4-R36 Report — 首次恢复发现失败后能够重新扫描并自行恢复（J01）

- reviewedSourceSha（本计划基线）：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- testedSourceSha：**dirty worktree on `a7950fa1`**（本轮 R36 改动未提交；被测即工作树源码 + `tsc -b` 重建 dist）
- 比较基线（上一轮审查）：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`
- 状态：**PASS**（确定性复现 + 最小恢复发现修复 + 6 条正负例 + 判别性回退验证 + 回归）
- 真实模型调用：0（全部 fault-injection / scripted provider）
- Runtime Freeze 例外：仅因 **J01 的确定性复现**获得最小恢复**发现**阶段修改范围；未新增架构、未重写 Runtime、保留 ToolOrchestrator / PermissionEngine / SandboxManager / Verification / 晋升资格门禁。
- 变更文件：
  - `packages/core/src/runtime/session-actor.ts`
  - `packages/core/src/runtime/recovery-durable.test.ts`（+6 例，共 **29** 例）

## 1. 问题与范围

`drainFollowupsInner` 在 **await 之前** 就把 `_recoverableChecked = true`：

```ts
if (!this._recoverableChecked) {
  this._recoverableChecked = true;          // ← 先提交
  await this.discoverRecoverableTurns();    // ← 之后才扫描
}
```

语义错误：`_recoverableChecked` 事实表达的是「扫描**已启动**」，被当作「发现**已完成**」使用。后果链：

| # | 后果 | 说明 |
|---|---|---|
| J01-a | 首次扫描的暂时读取故障 → 异常**逃逸** drain（后台未处理拒绝） | `inbox.listRecoverable` / `store.getTurn` / 终态分支的 `_recoveryStore.getRecord` 均在 discovery 内直接 await |
| J01-b | `checked=true` 永久成立 → 后续 drain **跳过发现**，无 timer、无重扫 | 只能靠新用户消息或手工 drain；promoted prompt 滞留在无 owner 的非终态 turn 上 |
| J01-c | 部分扫描会**半提交** | 读到 T1 后 T2 读失败 → T1 已入队但 `checked=true`，T2 永久丢失 |

**范围声明**：本项证明的是**恢复发现阶段的停滞与扫描标志错误**，**不**声称已产生外部动作重复或数据损坏。J01 与 R32 不同层级——R32 修的是**已有 recovery head** 的重进/清理错误（head 已发现）；J01 发生在 **head 尚未发现时**，两者不能共用一个「已关闭」结论。

## 2. 复现（修复前，确定性）

复现夹具（测试内固定，非手工）：

| 夹具 | 注入故障 |
|---|---|
| `ReadFailSessionStore` | 主 store `getTurn` 全量抛错（首次发现失败） |
| `ListFailInbox` | `listRecoverable` 持续抛错（列表故障） |
| `SelectiveReadFailSessionStore` | 仅对指定 turn id 抛错（T1 可读 → T2 失败的部分扫描） |
| `ReconcileDiscoveryReadFailStore` | 终态 turn 的 pending-commit record 查询抛错，写路径正常 |

```text
$ env -u NODE_OPTIONS node_modules/.bin/vitest run packages/core/src/runtime/recovery-durable.test.ts -t E4-R36
 × R36-a … FIRST-scan getTurn failure does NOT complete the scan
 × R36-b … persistent listRecoverable failures escalate to a CAP
 × R36-c … a scan that reads T1 then FAILS on T2 commits NOTHING
 × R36-d … an unresolved scan does NOT let a NEW pending followup overtake
 × R36-e … a discovery lookup failure on a TERMINAL pending-commit turn
 × R36-f … close cancels the discovery wake-up
  Error: session store temporarily unavailable
   ❯ DefaultSessionActor.discoverRecoverableTurns session-actor.ts:1853
   ❯ DefaultSessionActor.drainFollowupsInner   session-actor.ts:1624
 Test Files  1 failed (1)
      Tests  6 failed | 23 skipped (29)
```

基线形态与计划 J01 复现输出一致：`rejected="discovery getTurn outage", scheduled=0, calls=0, checked=true, queue=0, prompt=promoted`。

## 3. 根因与修改点（`packages/core/src/runtime/session-actor.ts`）

### 3.1 发现完成态只在**完整成功路径**提交

```diff
 if (!this._recoverableChecked) {
-  this._recoverableChecked = true;
-  await this.discoverRecoverableTurns();
+  const discovered = await this.discoverRecoverableTurns();   // → Promise<boolean>
+  if (!discovered) {
+    this.scheduleStoreRecheck();   // fail-closed + 有限、自愈的唤醒
+    return;                        // 本次推进到此为止：T2 不得越过未确认的旧恢复任务
+  }
+  this._recoverableChecked = true;
 }
```

`_recoverableChecked` 语义重定义为：**一次恢复发现已完整成功**。失败 ⇒ 保持可重扫 + 复用既有 `scheduleStoreRecheck()`（递增退避、封顶 30 s、每 actor 至多一个有效 timer、不消耗模型动作 attempt、后台拒绝局部处理）。

### 3.2 扫描**原子提交**（消除部分扫描）

`discoverRecoverableTurns(): Promise<void>` → `Promise<boolean>`：

| 变更 | 修复前 | 修复后 |
|---|---|---|
| 提交点 | 逐条 `this._recoverableTurns.push(...)` | 先收集到**局部缓冲** `candidates`，整段扫描无异常后才 `push(...candidates)` |
| 读取异常 | 直接逃逸出 discovery → drain 拒绝 | `try/catch`：`listRecoverable` 失败与逐 turn 读取失败分别记录 `[degraded]` 日志后 `return false` |
| 去重基准 | 每轮局部 `seen` | `seen` 初始化为「已在队列中的 turn id」∪ 本轮已见 → 重扫**不会重复入队** |
| 无 inbox/store | `return`（void） | `return true`（「无可发现的恢复源」= 发现完整，避免无 inbox 的 actor 陷入无限重检） |

顺序合同不变：仍按 `listRecoverable` 的持久顺序入队、仍以队头为 peek、仍在既有 same-T recovery/lease/CAS 流程里执行——**没有复制第二套执行器**。fail-closed 合同不变：动作前仍要求 lease + attempt-intent 已持久化。

## 4. 验收对照

| 计划验收项 | 结果 | 证据 |
|---|---|---|
| 首次 `getTurn` 失败：无动作、无 consume、无新 turn；扫描**不被标记成功**；恰好一个有效有限 timer | ✅ | **R36-a**：`drainError===undefined`、`total()===0`、`_recoverableChecked===false`、队列长 0、`scheduled.length===1`、`liveTimers===1`、`0 < delay ≤ 30000`、无 `consumed` |
| 存储恢复后**只触发已记录的 callback**：原 turn 恰好执行一次、`RECOVERED`、prompt consumed，不需新用户消息或手工 drain | ✅ | **R36-a** 后半：`breakReads=false` → `scheduled[0].fire()` → `total()===1`、`_recoverableChecked===true`、队列长 0、record `RECOVERED`、`consumed` 出现 |
| `listRecoverable` 持续失败：延迟有下限且封顶、不递归忙循环、不产生未处理拒绝、不消耗 attempt | ✅ | **R36-b**：7 轮 → `drainError===undefined` ×7、延迟精确 `[1000,2000,4000,8000,16000,30000,30000]`、`liveTimers===1`、`total()===0`、recovery record **未创建**（`getRecord` → `undefined`，即 0 attempt 预算被消耗）；治愈后 fire 最后一个 callback → `total()===1` |
| 两个旧 turn，读完 T1 再在 T2 失败：再次扫描不重复 T1，最终各处理一次 | ✅ | **R36-c**：故障后队列长 **0**（半提交被消除）、`checked===false`；治愈后 fire → `total()===2`、T1/T2 record 均 `RECOVERED`、`consumed` 计数 2、队列长 0 |
| 有新 pending followup 时，扫描失败不能让它越过未确认的旧恢复任务 | ✅ | **R36-d**：故障期 `store.listTurns()` 仍为 **1**（未创建 T2）、新 prompt 仍 `pending`、`total()===0`；治愈后旧 turn `RECOVERED` 且 durable turn `completed` |
| 终态 turn + pending-commit recovery record 的读取故障：恢复后只 reconcile，不重跑已完成动作 | ✅ | **R36-e**：actor A 跑动作一次（`a.total()===1`）、terminal ACK 被打回；actor B 的 discovery 查询故障 → `b.total()===0`、`checked===false`、队列 0、一个 timer；治愈 + fire → record `RECOVERED`、`b.total()===0`（**无重放**） |
| close 取消 timer；触发旧 callback 不复活 actor；有效外部 lease 仍受尊重 | ✅ | **R36-f**：`close()` 后 `liveTimers===0`；手工 fire 陈旧 callback → 25 ms 后 `total()===0`、无 `consumed`。外部 lease 尊重由 **R32-d** 继续覆盖（本轮未改动该路径） |
| R30/R32 原有回归继续通过；recovery-durable、相关 followup/crash 测试、`pnpm test:race`、`pnpm typecheck` | ✅ | 见第 5 节 |

## 5. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `env -u NODE_OPTIONS npx vitest run packages/core/src/runtime/recovery-durable.test.ts`（**修复后**） | **29/29 PASS**，Test Files 1 passed，exit 0 |
| 同上 `-t E4-R36`（**修复前**，判别性回退验证） | **6 failed \| 23 skipped** —— 6 个新用例全部因 J01 失败；恢复源码后全绿 |
| `env -u NODE_OPTIONS npx vitest run` recovery-durable + followup-recovery + followup-crash-matrix + crash-matrix + crash-sideeffect + recovery-controller + recovery-state-machine | **7 files / 74 tests PASS**，exit 0 |
| `pnpm test:race`（11 文件） | **11 files / 23 tests PASS**，exit 0 |
| `pnpm typecheck`（`tsc -b` 全仓） | **exit 0** |

判别性说明：R36 的 6 条用例并非「本来就通过」——第 2 节给出修复前的失败输出，第 5 节给出「仅回退 `session-actor.ts`、保留测试」得到的 6/6 失败。即测试确实锚定本修复。

## 6. 报告纪律：首次发现 vs 已有 head 重进

- **首次发现（本项 J01/R36）**：head 尚未发现，`_recoverableChecked` 被错误提前提交；证据 = R36-a…f。
- **已有 head 重进（R32/H01、H02）**：head 已在 `_recoverableTurns` 中，故障发生在 `recoverHead` 的 record 读 / lease / intent 路径；证据 = R32-a…d。
- 本报告**不**引用 R32 的通过结果作为 J01 的关闭依据；R36-c/e 与 R32 场景的差异写在各自断言里。

## 7. 残余限制与诚实边界

- **只覆盖「暂时性」读取故障**：永久损坏的 inbox/store 仍走既有 `blocked` / `TERMINAL_FAILED` 合同；本轮未做存储层重构。
- **发现失败时的唤醒上界 30 s 是单次间隔上限，不是总时长上限**：长期故障会持续以 ≤30 s 重检直到 `close()`。
- **不声称消除了外部动作重复的可能**：本轮只保证「发现未完成 → 不放行动作、不半提交、不重复入队」。
- `_recoverableChecked` 仍是**进程内**状态：跨进程重启由 discovery 重新扫描 durable 状态得出，不依赖持久化该标志。
- **本轮改动未提交**：testedSourceSha = **dirty worktree on `a7950fa1`**；提交/推送与远端 CI 核实按 R39 收口处理，**不得**用基线 `a7950fa1` 的旧 CI（run 34685817447）证明 R36 新代码。
