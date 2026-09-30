# task-6 / N5-BLOCKER — 单飞行槽释放过晚，误杀合法的顺序第二次 model request

任务：task-6（本轮头号缺陷；**不属于 F30-1…F30-7 中任何一条**，是 N5 首次让真实 arm build 跑真实 case 才**变可达**的缺陷）
状态：**DONE**（Windows 本地实测；Ubuntu 见 §12）
实现 commit：`8ee372a1f76b567db306bb652bd5b2737d693431`
起始基线：`04dbd7116059f38aae2a225cab04c95401749c47`（N2 落地后的干净 HEAD）
修改文件（2 个，+229/−6）
- `scripts/e4/prereg-arm-isolated-worker.mjs`（+75）
- `apps/cli/src/n1-worker-lifecycle.test.ts`（+160）
反例：旧实现下**合法顺序第二次请求被误判并发违规** → arm stop、`records=0`；新实现下同一用例通过，且真并发**仍被拒**（控制组）
付费模型请求数：0 ｜ 离线 physical generate：见 §5.3（探针链 60，非可比 pair 结论）
剩余问题：见 §12

---

## 1. 缺陷与机制

正式链（`prereg run` → `createPreregArmExecutor` → `scripts/e4/prereg-arm-isolated-worker.mjs`）的协议 arity 是**一个 worker 一次只有一个在飞的 model request**。这条不变量由两侧共同维护，而两侧对"一个请求什么时候结束"的理解**不一致**：

**父进程侧**（`apps/cli/src/prereg-arm-executor.ts`，`serviceModelRequest`）：

```
streamOwner.current = { id, controller }          ← 取槽
for await (const event of client.generate(...)) {  ← 驱动器 provider（正式链里是 budgeted provider）
  reply({ t: "event", id, event })
  if (event.type === "completed" || "error") break ← 终止事件
}
↓ break 触发 iterator.return()：生成器的清理在这里跑
   —— 正式链里那是 **durable cost-journal 结算**（文件 I/O，实测 ~38ms）
if (!stopTriggered) reply({ t: "done", id })       ← 清理之后才写 `done`
finally { streamOwner.current = null }             ← 再之后才释放槽
```

**子进程侧**（`prereg-arm-isolated-worker.mjs` 的 proxy `generate()`，**修复前**）：

```js
if (frame.t === "event") {
  yield frame.event;
  if (frame.event?.type === "completed" || frame.event?.type === "error") return;  // ← 收到终止事件就结束
}
```

**后果**：槽的占用窗口 = `[取槽, 清理完成]`，而协议真正的 in-flight 窗口 = `[取槽, 终止事件交付]`。**前者比后者宽**。真实 benchmark case 需要**多次** model call（先 act、再 finish），于是臂在收到终止事件后**合法地**立刻发起下一次请求，而父进程仍在该次请求的清理里，槽尚未释放 → N1 的 ONE-ACTIVE-REQUEST 规则把它判为并发违规 → 该臂被 stop，**整个 campaign 记录 0 个 armRun**，每个真实 case 都表现为基础设施错误。

**为什么以前不可达**：E2E 的 fixture arm 是合成的，其 `runOneCase`（`scripts/e4/prereg-production-e2e.mjs` L801-808）**只发一次** model call 并在终止事件上 `break`，永远不会发第二次请求；该文件 L776-790 也自述它是"声明 ABI 并真正履行"的合成臂。**只有真实 arm build 跑真实 case 才会到达这条路径。**

## 2. 插桩证据（原文）

方法：对 **dry worktree 的构建产物**（`apps/cli/dist/prereg-arm-executor.js`，gitignore 的艺术品）插桩，打印每一条 `frame t=… id=…` 与槽的 ACQUIRE/RELEASE；**主仓零改动**，dry worktree 的 `git status` 仍为 0 行。同一探针**连跑两次**，结果**逐行相同**：

```
[probe] frame t=hello   id=1 at=1790775304180
[probe] frame t=request id=2 at=1790775304359     ← 第 1 次物理请求
[probe] slot ACQUIRE    id=2 at=1790775304359
[probe] frame t=request id=3 at=1790775304398     ← 第 2 次请求，**39ms** 后到达
[probe] slot RELEASE         at=1790775304436     ← 槽在 request #3 之后 **38ms** 才释放（ACQUIRE→RELEASE = 77ms）
```

两次运行的拒绝也完全相同：`refusals=1`、`modelCalls=1` → **确定性，不是 flake**。
插桩脚本：`%TEMP%\n5-instrument-dist.mjs`（不入库；它只改 throwaway worktree 的构建产物）。

## 3. 排除的假设

| 假设 | 排除依据 |
| --- | --- |
| 两个臂被**并发**执行，互相抢槽 | campaign 是**严格顺序**的：`packages/evaluation/src/tool-call-efficiency-paired-campaign.ts` L441 `for (const run of orderedRuns) { … await … }`（同一函数 L384 注释也自述 "executed strictly sequentially"） |
| 子进程**真的**开了并发请求 | 子进程守卫 `budget.modelInFlight` 是 **per-worker** 的；真并发会在**子进程内**抛 `PREREG_WORKER_CONCURRENCY`，而不会发出第二个 `request` 帧。既然父进程收到了第二帧，说明子进程第一次 `generate()` **已经返回**（合法顺序） |
| provider 双发/script exhausted | `modelCallsByTranscript=1`，即只有**一次**调用到达 driver provider；被拒的第二次请求**从未**触达 provider |
| 脏树/ABI/身份是原因 | 该次运行为干净工作树（`git status --porcelain` = 0 行）、两臂 ABI 齐备、`closuresDistinguishable=true`、P2-41/P2-43 均 present |

## 4. 所选修法与理由：**(b) 子进程等父进程的 `done` 帧**

两种候选：(a) 父进程把槽的释放提前到"终止事件已交付"之后、`iterator.return()` 清理**之前**；(b) 子进程在收到父进程 `done` 帧（该帧本身就是"本请求已结束"的信号）之前不得结束/发起下一次请求。

**选 (b)**，理由：
1. **不动父进程不变量**。ONE-ACTIVE-REQUEST 的意图是"绝不覆盖 `streamOwner.current`，否则第一个流的 controller 永远失去可取消性"（F30-1 的泄漏类）。选 (a) 就必须让槽在清理期间被新请求接管，于是要重新设计 `streamOwner`（单槽 → 多活流）以及 `streamSettled` 的归属，**风险与 blast radius 都更大**，且正是 N1 明确修过的地方。
2. **`done` 帧就是窗口终点**：它由父进程在清理**之后**、释放**之前**写出（见 §1 代码），因此"等到 `done`"与"槽已归还"在时序上等价，且不依赖任何超时或猜测。
3. **两类消费者都要覆盖**——这是实现里最容易漏的一点。臂的运行时若**自然 drain** 流，proxy 的 `for(;;)` 会一直读到 `done`（第一次修复只做了这件事，`[sequential]` 用例仍然红）。但若消费者在终止事件上 **`break`**（`AsyncIteratorClose` 会在 **yield 处**强制 return 生成器），yield 之后的语句**永远不会执行**。因此：
   - 终止标志在 **yield 之前**置位；
   - **`finally`** 里做同一个"等一帧 `done`"的等待。
   ```js
   let terminalDelivered = false;   // 声明在 try 之外：finally 要读
   let doneSeen = false;
   …
   if (frame.t === "event") {
     if (frame.event?.type === "completed" || frame.event?.type === "error") terminalDelivered = true;  // 先置位
     yield frame.event;
   } else if (frame.t === "done") { doneSeen = true; return; }
   …
   finally {
     if (terminalDelivered && !doneSeen) {
       const last = await Promise.race([box.next(), cancelled]).catch(() => null);
       if (last !== null && last.t === "done") doneSeen = true;
     }
     …
     budget.modelInFlight = false;
   }
   ```
4. **保留 `terminalDelivered` 的 EOF 兼容分支**：若父进程在交付终止事件之后关闭通道（例如在这段窗口里 stop 了本臂），子进程**干净结束**而不是抛 `PREREG_WORKER_EOF` —— 即**保留修复前该路径的行为**，不把一个 stop 变成 spurious EOF。
5. **等待不可能停泊**：它被 `cancelled`（臂自己 abort）与通道关闭两端约束；外层还有 executor 自己的 `workerTimeoutMs`/campaign deadline。父进程要么发 `done`，要么结束子进程，二者都会解开等待。

## 5. RED → GREEN 实测

### 5.1 RED（旧实现）
保存补丁 → 把 worker 还原成基线字节 → 跑**同一个**新用例：

```powershell
git diff -- scripts/e4/prereg-arm-isolated-worker.mjs > "$env:TEMP\n5-task6-worker-fix.patch"   # 6170 bytes
git checkout -- scripts/e4/prereg-arm-isolated-worker.mjs
npx vitest run apps/cli/src/n1-worker-lifecycle.test.ts -t "TWO sequential model calls"
```
```
❯ apps/cli/src/n1-worker-lifecycle.test.ts (17 tests | 1 failed | 16 skipped)
   × [sequential] a real arm build whose case makes TWO sequential model calls completes, both streams serviced
AssertionError: a legitimate SEQUENTIAL second request was refused as a concurrency violation:
  expected 'Error: ARM_WORKER_PROTOCOL_VIOLATION:…' not to contain 'ARM_WORKER_PROTOCOL_VIOLATION'
Received: "Error: ARM_WORKER_PROTOCOL_VIOLATION: the arm worker opened a SECOND concurrent model request
  while one was already in flight (refusals=1); this driver services ONE active request per worker, so the
  arm was stopped rather than let the first controller be lost (termination=protocol_violation,
  signalAborted=true, providerReturnedWithinGrace=true)"
Tests  1 failed | 16 skipped (17)
```
（我实际用的是 `git checkout --` 还原字节，而不是 `git apply -R`；效果等价，且这里报告的是**真实执行过**的命令。）

### 5.2 GREEN（新实现）
`git apply "$env:TEMP\n5-task6-worker-fix.patch"` → exit 0 → `node --check` 通过 → 同一套件：

```
✓ apps/cli/src/n1-worker-lifecycle.test.ts (17 tests) 25.62s
     ✓ [sequential] a real arm build whose case makes TWO sequential model calls completes, both streams serviced
     ✓ [control] a genuinely CONCURRENT second request is still refused, inside the child
Tests  17 passed (17)
```
`[sequential]` 的断言不只看"没报错"：`run.error === null`、`result.status === "failed"`、**`settling.entered() === 2`**（两次顺序调用都真的到达 provider，修复前是 1）、`terminal() === 2`（两个流都拿到终止事件）。

### 5.3 修复让真实 formal 链**第一次真正执行**
同一探针 pair（**管线探针，不是可比 pair，不作为候选机制证据**）：

```
formal-small: exit=0 cases=5 records=20 verified=20 modelCalls=60 decision=REJECT total=1080 delta=0 costMatches=true
prereg run: executed 20 logical run(s) (resumed 0)
  provider calls: 60  remaining: 540
  tokens: total 1080 (JOURNAL_PER_ARM)  baseline 540  candidate 540  delta 0
耗时 93 秒 / 20 armRun ≈ 4.5 秒每 armRun
```
即：修复前 `records=0`；修复后 **20/20 记录、20/20 经 A6 证据校验、60 次离线物理调用、成本日志可复算且与 aggregate 一致**。

## 6. 控制组：ONE-ACTIVE-REQUEST **没有被削弱**（本节最重要）

规则的原意是"第二个并发请求绝不能覆盖第一个流的 controller"。修复只改了**子进程何时结束一次请求**，**没有**放宽父进程的判定。两侧都有控制组：

| 控制组 | 位置 | 断言 |
| --- | --- | --- |
| 父进程：真并发的第二个 request | `n1-worker-lifecycle.test.ts` **row 5**（既有用例，未改动） | `ARM_WORKER_PROTOCOL_VIOLATION`；`concurrencyRefusals > 0`；`terminationReason === "protocol_violation"`；**第一个流的 signal 仍被 abort**（`signalAborted === true`）；被拒请求**从未**进入 provider（`entered() === 1`） |
| 子进程：真并发（未等终止事件就发第二次） | 新增 `[control] a genuinely CONCURRENT second request is still refused, inside the child` | 臂内 `PREREG_WORKER_CONCURRENCY`；provider `entered() === 1` |

两条都跑在**真实 shipped worker**上（控制组用真实 worker + 一个真的并发调用两次 `generate()` 的 arm entry），不是 stub 模拟。如果这一节红了，说明规则被放宽——那是**判不合规**，而不是"跑通了"。

## 7. 既有反例仍绿的数字

`npx vitest run <files>`（Windows，Node v24.14.0）：

| 套件 | 结果 |
| --- | --- |
| `apps/cli/src/n1-worker-lifecycle.test.ts` | **17 passed**（原 15 + 新 2） |
| `apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts` | **7 passed** |
| `apps/cli/src/n3-dispatch-journal.test.ts` | **19 passed** |
| `apps/cli/src/r0-f6-ci-readiness-classification.test.ts` | **42 passed** |
| **合计** | **85 passed (85)** |

Lead 独立复核过 `n1-worker-lifecycle` + `r0-f8-formal-budget-cancel-gaps` = **24 passed (24)**，并确认 §6 两条关键用例**真的执行**（不是 skip）。`npx tsc -b` exit 0。

## 8. 预算语义未变

本次改动**没有触及**任何预算/结算路径：`tool_reserve`/`tool_settle` 的路由、`DurableToolDispatchBudget`、成本日志的 `charged`/`reserved` 全部原样。既有反例**仍然绿**：
- `[reservation] a worker that dies holding a reservation settles it as unknown, never as a refund`（17/17 里的一条）——**已派发未结算仍按原上界保守结算，没有被退款归零**；
- `[regression] the deadline still aborts the transport FIRST and records the timeout reason`；
- `r0-f8-formal-budget-cancel-gaps` 7/7 全绿（预算与取消门禁）。

## 9. 交叉印证（两条独立路径、两套 harness、同一拒绝）

n2-cli 在**完全独立**的工作流（发布入口 `node apps/cli/dist/main.js prereg …` 的 E2E）里也撞上**同一个** `ARM_WORKER_PROTOCOL_VIOLATION`，`refusals=1`、`providerFactoryCalls: 1`。
（该观测由 Lead 从独立工作流转述；本文件作者未亲自复跑那条路径，故标注来源。）
意义：两个互不相干的 harness 得到同一具名拒绝 → **不是 N5 夹具或配置问题**，而是 worker 协议本身的真实缺陷。这也解释了为什么它在本轮才浮现：N2 是第一条把**真实 release CLI** 接到真实 arm build 上的路径。

## 10. Runtime Freeze (P38.4-11) 许可理由

**第 1 类：「确定性正确性 bug（有复现）」**。复现是 §2 的插桩轨迹与 §5.1 的 RED：确定的时序（+39ms/+38ms）、连跑两次逐行相同、且真实 campaign 可观测地 `records=0`。
因此本次修改限于"何时结束一次请求"这一处语义，**没有**重构、改名或清理 `prereg-arm-executor.ts`，也**没有**放宽任何 gate/检查/预算。

## 11. 方法与自我纠正（本次任务内实际发生的）

1. **第一次离线安装/构建探测无效，已作废**：我只 `git worktree add` 却没进目录，`pnpm install`/`pnpm build` 实际跑在**主仓**上（781ms "Already up to date"、`tsc -b` 2s 而 scratch 树里根本没有 `main.js`）。该结果**未用于任何结论**；用正确 cwd 重跑得 install 4s / 0 下载、build 13s、产物存在、树仍 clean。一个"781ms 假构建"被当成真实证据，正是最容易被误读成绿的形状。
2. **为 `213a63e9` 臆造过完整 SHA**（`213a63e9fd4f4814bd666685ccac14bec5af7079` 之外的假值）：发出后立刻核对发现，**kill 了那个后台任务（pwsh-347）**，取真实 SHA 后重跑（pwsh-349）。被 kill 的任务只到"创建 driver 工作树"，未产出任何被引用的结论。
3. **`require` in ESM**：篡改预检脚本在 ESM 里用了 `require("node:crypto")` → `require is not defined`；改为顶层 `import { createHash }` 并重跑。
4. **在 `tsc -b` 是红的时候提交过 A**（4 × `TS18048: 'first'/'second' is possibly 'undefined'`，新篡改测试里的解构）：先跑提交、后跑 typecheck 的顺序错误。修好类型 → `tsc` exit 0 → **amend A**（当时 baseline B 尚未派生、A 的 SHA 未被任何地方引用，故 amend 安全）。最终 A = `b6e6d942`。
5. **`--derive-baseline` 参数个数 bug**：调用点是 `deriveBaselineCommit(args.deriveBaseline)`，而函数签名是 `(repoRoot, candidateSha)` → `git -C <sha> show undefined:…`。**单测没抓到**（单测调的是**函数**而非**旗标**），是新增的 **CLI 冒烟测试**先红才暴露；修复后该旗标正常工作。这条说明"函数正确 ≠ 旗标正确"，故 CLI 入口必须有冒烟测试。

## 12. 剩余问题

1. **全量 `pnpm test` = NOT_RUN**：本机 Node **v24.14.0**，CI 是 Node 22（已确认存在真实行为差异）。本次只跑定向套件（§7），不做全量。
2. **Ubuntu = NOT_RUN**：本机 git 到 GitHub 完全不通（代理 `127.0.0.1:7897` 未监听），无法 push、也无法触发 Actions，因此**本 SHA 没有 CI URL / run / attempt / artifact**。跨平台验证只能由 N6 在能联网的环境完成。
3. **本修复的验证平台**：仅 Windows 本地。协议层改动本身与平台无关（stdio 帧 + 微任务/I/O 时序），但**没有**在 Linux 上实测过。
4. **等待的边界是父进程的生命周期**：子进程 `finally` 的等待由"父进程发 `done`"或"通道关闭"解开；若父进程两者都不做，等待不会自行超时，由 executor 的 `workerTimeoutMs` / campaign deadline 作为外层界。当前父进程的两条路径都保证二者之一，故不构成停泊风险；这一点在实现注释中已写明，供后续修改者保持。
5. **真实 formal campaign 的数字**（schedule/records/aggregate/cost journal/**tool dispatch journal**/内容矩阵四组/负例矩阵）在 `docs/evidence/n5-real-formal-offline.md` 报告，与本文件相互独立：本文件的结论**不依赖**campaign 的统计结果，只依赖"修复前 records=0 / 修复后 20 条记录且证据可校验"这一执行事实（§5.3）。
