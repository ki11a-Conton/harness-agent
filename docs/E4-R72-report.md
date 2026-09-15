# E4-R72 报告：worker 写入/合并间歇失败的根因定位与最小修复

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260915-021130).md` §3 |
| reviewedSourceSha（计划 §0） | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` |
| 本报告绑定实现 SHA | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` + 本任务测试改动（未提交） |
| 本地环境 | Windows (win32)、Node `v24.18.1`、pnpm `11.21.0`、vitest `4.1.10` |
| 工作树起点 | 干净，仅 `plan(20260915-021130).md` 为 untracked |
| 改动范围 | **仅测试**：`packages/harness/src/delegation-worker.integration.test.ts`（+36/−6） |
| Runtime 改动 | **无**（符合 Runtime Freeze；见 §7） |

被调查对象：R71 报告 §4.2 记录的 run `34916638862` attempt 1，Windows runner 上
`packages/harness/src/delegation-worker.integration.test.ts` 失败：

```
ENOENT: no such file or directory, open
C:\Users\RUNNER~1\AppData\Local\Temp\ar-worker-e2e-VMqHZV\src\helper.ts
```

## 2. 结论摘要（先给结论）

**根因已定位并受控复现，不是 merge / lifecycle / 清理缺陷，而是测试自身的审批窗口竞态。**

测试用固定预算的自动审批循环：

```ts
for (let i = 0; i < 200; i += 1) {   // 固定 200 × 10ms ≈ 2s 总预算
  for (const req of harness.approvalStore.listPending()) { ... resolve(req.id, "allow", "test"); }
  await new Promise((r) => setTimeout(r, 10));
}
```

该循环的预算从**测试开始**计时，与 turn 的真实生命周期无关。在负载较高的 runner 上，
`delegate_worker` 的审批请求可能在循环**已经退出之后**才被创建。此时：

1. 没有消费者再调用 `resolve()`，审批请求保持 pending；
2. turn 阻塞，直到 `StoreApprovalResolver` 的 **60s 默认过期**（`expiresAfterMs ?? 60_000`）才继续；
3. 过期后 `delegate_worker` 未获批准，**worker 根本没有启动**，`src/helper.ts` 从未被写出；
4. 测试随后执行 `readFile(join(cwd, "src", "helper.ts"))`，得到 ENOENT。

ENOENT **不是**失败的根因，而是失败被推迟到文件断言处才暴露的表象。错误信息把注意力
错误地引导向 merge 路径，而真正的断点发生在审批阶段之前——worker 从未运行。

## 3. 证据链

### 3.1 正常路径的真实事件序列（插桩探针）

对同一测试做完整事件/审批/子会话插桩（临时探针，已删除），正常一次运行的关键事实：

| 观测 | 值 |
|---|---|
| 父 turn 终止 | `model_stopped` / `completed` |
| 审批请求 | **恰好 1 个**：`action=edit`, `target=.`, `reason="delegate_worker: rule 'anon' (ask) matched"` |
| 审批归属 | 父会话 `delegate_worker`（**不是**子会话的 `write_file`） |
| 子会话 `write_file` | `effect=allow`, `reason="rule 'anon' (allow) matched"` — 子代理策略直接放行，**不产生审批** |
| 子会话 turn | `completed` |
| merge 结果 | `[workspace merge] applied: src\helper.ts` |
| 子会话 cwd | `...\Temp\child-ws-safAQI`（隔离根），父 cwd 为其自身 temp |

关键推论：**整个流程只依赖 1 个审批**，且该审批在父侧。因此审批窗口的可用性是唯一
与「turn 是否推进」耦合的时序条件。

### 3.2 排除「审批窗口太小」假设（受控实验）

先验证计划 §3.4 提出的候选假设：200×10ms 是否因调度延迟而实际不足。

| 用例 | 轮询间隔 × 次数 | 观察窗口 | 结果 |
|---|---|---:|---|
| A | 50ms × 4 | ~200ms | ✅ 通过，`approvalsSeen=1` |
| B | 10ms × 200 | ~2s（原实现） | ✅ 通过 |
| C | 10ms × 20 | ~200ms | ✅ 通过，`approvalsSeen=1` |

**结论：把窗口从 2s 缩小到 200ms 仍能通过。**「窗口太小」不是根因——这排除了该假设，
并说明真正的失败条件比「窗口略短」苛刻得多。

### 3.3 定位真实失败边界（决定性实验）

改为延迟**第一次 provider 调用**，让审批请求在时间轴上后移：

| 用例 | 首次调用延迟 | 审批请求相对循环 | `runTurn` 耗时 | 循环退出时刻 | 审批命中 | merge | 文件 | 结果 |
|---|---:|---|---:|---:|---:|---|---|---|
| D | 0ms | 循环内 | 995ms | 2987ms | 1 | ✅ | ✅ | 通过 |
| E | 2500ms | 循环内（临界） | 3545ms | 3076ms | 1 | ✅ | ✅ | 通过 |
| **F** | **8000ms** | **循环已退出** | **128544ms** | 3252ms | **0** | **❌** | **❌** | **失败** |
| **G** | **61000ms** | **循环已退出** | **181342ms** | 3214ms | **0** | **❌** | **❌** | **失败** |

F/G 的失败签名与 CI 完全一致：

```
mergedOk=false
readErr="ENOENT: no such file or directory, open '...\ar-r72-x-u518vP\src\helper.ts'"
types=["approval.created","approval.resolved","approval.created","approval.resolved"]
danglingPending=2
decisions=[]          // 没有任何 allow 决策被记录
```

注意 `runTurnMs` 达 **128s / 181s**，远超 60s——与「turn 因审批过期而长时间阻塞」的
机制吻合；且 `hasSubagentStarted=false`，证明 **worker 从未运行**，merge 从未发生。
这与 §1 的错误信息（指向 `src/helper.ts`）在语义上完全不同。

复现证据（完整输出）：
- `docs/r72-evidence/r72-controlled-repro.txt`

### 3.4 反例验证：旧实现失败 / 新实现通过

计划 §3 要求「受控延迟反例证明旧实现失败、新实现通过」。同一注入（8s 延迟）下
分别运行旧循环与新循环：

| 实现 | outcome | subagent.started | subagent.completed | merge applied | mergedOk | 残留 pending |
|---|---|---|---|---:|---|---:|
| **旧**（固定 200×10ms） | completed | ❌ false | ❌ false | ❌ false | ❌ false（**ENOENT**） | 2 |
| **新**（绑定 turn 生命周期） | completed | ✅ true | ✅ true | ✅ true | ✅ true | **0** |

旧实现输出原文：

```
VALIDATION OLD: {"mode":"old","delayMs":8000,"outcome":"completed","mergedOk":false,
"readErr":"ENOENT: no such file or directory, open
'C:\\Users\\s5605\\AppData\\Local\\Temp\\ar-r72-v-XZbO5t\\src\\helper.ts'","hasSubagentStarted":false,
"hasSubagentCompleted":false,"mergeApplied":false,"danglingPending":2,"backgroundLeftRunning":false}
```

新实现输出原文：

```
VALIDATION NEW: {"mode":"new","delayMs":8000,"outcome":"completed","mergedOk":true,
"hasSubagentStarted":true,"hasSubagentCompleted":true,"mergeApplied":true,
"danglingPending":0,"backgroundLeftRunning":false}
```

新实现耗时 8882ms（≈ 注入延迟 + 正常工作量），而旧实现耗时 **128411ms**——旧实现把
时间全部消耗在等待 60s×2 审批过期上。

复现证据（完整输出）：
- `docs/r72-evidence/r72-fix-counterexample.txt`

## 4. 最小修复

### 4.1 修复内容（仅测试同步，依据计划 §3.7）

1. **审批循环绑定 turn 生命周期**，取代固定预算：

```ts
let turnSettled = false;
const autoApprove = (async () => {
  while (!turnSettled) {
    for (const req of harness.approvalStore.listPending()) {
      harness.approvalStore.resolve(req.id, "allow", "test");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
})();
const outcome = await harness.runtime.runTurn(...);
turnSettled = true;
await autoApprove;
```

循环终止条件与 turn 终态绑定，因此无论审批请求何时到达都会被处理；`await autoApprove`
保证**没有审批协程存活到测试体之外**（反例已验证 `backgroundLeftRunning=false`）。

2. **在文件内容断言之前先断言 worker/tool/merge 的真实结果**（依据计划 §3.8），
使失败不再退化为裸 ENOENT：

- `events` 先读取，断言 `subagent.started` / `subagent.completed` 存在；
- 断言 `delegate_worker` 的 `tool.completed.outputPreview` 含 `[workspace merge]` 与 `applied:`；
- 断言子会话最后一 turn 状态为 `completed`；
- **之后**才 `readFile` 断言文件内容。

### 4.2 未做的事（刻意）

- **没有**把检查移后或单纯放大 timeout 当作修复（计划 §3.8 明确禁止）。
  本次是改变**同步条件**，不是绕过等待：旧实现即使给 10 倍轮询次数，在「审批在循环
  退出后才到达」的场景下依然失败——瓶颈是循环**退出**，不是它跑得不够久。
- **没有**修改 `StoreApprovalResolver` 的 60s 过期语义、没有放宽权限、
  没有改生产 merge/lifecycle 代码。
- **没有**新增通用取证框架（计划 §3.3）；诊断只使用既有事件与 `approvalStore` 查询。

### 4.3 修复后验证

| 项 | 结果 |
|---|---|
| `npx tsc -b` | **exit 0** |
| 目标测试单次 | **1 passed**，730ms |
| 目标测试连续 5 次 | **5/5 passed**，exit 0 |
| 反例（8s 延迟）新实现 | **passed**，merge applied，残留 pending = 0 |
| 反例（8s 延迟）旧实现 | **failed**，复现 CI ENOENT |

修复后测试耗时由 3055ms 降至 **730ms**——旧实现把时间花在等待满 2s 固定预算上，
这本身就是「测试等待的是时钟而非被测行为」的直接旁证。

证据：`docs/r72-evidence/r72-fixed-test.txt`

## 5. 对历史 CI 失败的归因（严格边界）

**可以断言**：测试存在一个可确定复现的同步缺陷；在「审批请求晚于循环退出」时，
失败表现为 `src/helper.ts` 的 ENOENT，且 worker 从未运行。这与 R71 §4.2 记录的
CI 症状（同一文件、同一 ENOENT、同一路径形态）在**机制上充分**。

**不能断言**：CI 那次具体失败已由本报告逐条证据直接证明同因。理由：

1. 未取得 attempt 1 的 job 日志正文（仅有 R71 转述的错误字符串）；
2. 未在真实 GitHub Windows runner 上重放；
3. 未观测到该次运行的实际时序（循环退出时刻 vs 审批创建时刻）。

因此按计划 §3.6 的口径，本项**从「根因未知」提升为「存在已复现的确定性同步缺陷，
且其失败签名与历史 CI 一致」**，但不宣称历史 CI 事件已被证明。

**未复现部分保留 UNRESOLVED**：导致 runner 上审批请求被推迟的**具体底层原因**
（冷启动、文件系统压力、CI runner 调度尖峰等）未被测量，也未在真实 runner 上复现。
本报告不猜测该原因。

## 6. 验收对照

| 计划 §3 验收项 | 结果 |
|---|---|
| 实验记录真实退出码与事件身份 | ✅ 事件类型、审批 ID/归属、子会话 ID/turn 状态均记录 |
| 正常路径证明：隔离根写入、merge 成功、父文件内容正确、子工作区按合同处置 | ✅ §3.1 + 修复后测试新增断言 |
| worker/merge 失败时输出明确原因，而非仅用 parent completed 解释成功 | ✅ §3.3 F/G：`hasSubagentStarted=false` 直接暴露「worker 未运行」 |
| 若修同步机制：受控延迟反例证明旧失败/新通过，且无无限循环、无退出后后台任务 | ✅ §3.4 双向验证；`backgroundLeftRunning=false`；循环与 turn 同生命周期 |
| 若未复现历史失败则标 UNRESOLVED | ⚠️ 部分复现：缺陷本身已复现；**触发该缺陷的 runner 侧诱因仍 UNRESOLVED**（§5） |
| 不扩大权限、不忽略 worker 错误、不改业务完成语义迁就测试 | ✅ 无权限改动；worker 错误仍会使断言失败；`outcome.status` 断言保留 |
| 确认的修复在 Windows 真实 runner 验证 | ❌ **NOT_RUN**（见 §7） |

## 7. NOT_RUN 与残余限制

1. **真实 Windows CI runner 验证：NOT_RUN。** 本任务未推送、未触发远端 CI。按项目
   Runtime Freeze 与「不修改远端」约束，本报告只做本地受控复现；该修复需在真实
   Windows runner 上确认后方可作为最终关闭依据。
2. **attempt 1 的原始 job 日志正文：未读取**（沿用 R71 的转述）。
3. **触发审批延迟的 runner 侧底层原因：UNRESOLVED**，未测量。
4. **全量 `pnpm test`：NOT_RUN。** 本机长期存在符号链接沙箱限制（R71 §3.1 记录的
   6 个套件）与重负载下 `orchestrator.test.ts` 的 500ms 超时，均与本改动无关；
   为避免把环境噪声当成回归证据，本轮只运行目标测试与 `tsc -b`。
5. **未做付费模型调用、未发布 release、未强推、未修改远端权限。**
6. 临时探针文件（`_tmp_r72_*.test.ts`）已全部删除；`docs/r72-evidence/` 保留为证据。

## 8. 为什么不改 Runtime（冻结合规）

本缺陷属于**测试同步**问题，不满足 AGENTS.md 所列任何一条 Runtime 变更依据：

- 不是确定性生产正确性缺陷（生产路径在审批到达时行为正确）；
- 不是安全漏洞；
- 不是发布完整性缺陷；
- 不是已证明源自 Harness 基础设施的 benchmark 失败；
- 无性能回归测量。

因此按计划 §3.7「若复现明确的测试同步问题，只修测试同步」，**未触碰 Runtime**。
