# WHA-01｜运行时与生命周期视角（D1 / `runtime-lifecycle`）

> Round 1，独立撰写（未读他人文件）。视角锁定：Runtime / Lifecycle / Budget / Recovery。
> 评价单位是**可判据的机制**，不是模块名。每条主张末尾标注可复核的仓库路径；**未在仓库中找到实现的，直接写"本仓库无对应实现"**。
> 本文件不产生任何模型质量结论；全部判据为离线可复跑的确定性测试。

## 主张 1（P0）｜预算是**封闭计量域**，不在域内的消耗不得记为 0

- **主张**：运行时对每一维度消耗要么给出观测值、要么显式给出 `unknown`；"无观测"绝不出现在计数字段里当 0。
- **为什么（运行时视角）**：预算强制的前提是"消耗可数"。计量域一旦有洞，上限就成了装饰：靠"打印 token 数"来估算的 harness，在流式中断、供应商不报 usage、并发子代理三条路径上都会漏计，而漏计方向永远是**低估**（安全方向错）。
- **怎么验证（可观测判据）**：`packages/core/src/runtime/run-budget.ts` 的 `RunBudgetTracker.onModelUsage(input,output,cost)` 只有三个 number 形参，`snapshot()` 无 unknown 表达（`run-budget.ts:74-96`）；本仓库**有** unknown 语义的实现在别处——`packages/evaluation/src/tool-call-efficiency-formal-run.ts:858-867`（`journalChargedTokens`，缺失即 NOT_OBSERVED）、`packages/evaluation/src/prereg-n0-gaps.test.ts`。判据：对任意 run，若 provider 未报 usage，存在字段取值为"unknown"而非 0。
- **失败模式**：N7 真实 campaign 的 `usage_complete_and_reconciled` FAIL：请求 tape 合计 44,280,105 tokens，arm metrics 合计 44,214,446，差 +64,765 input / +894 output，且差异只来自 2 个 arm（`docs/evidence/agent-next7-20261006/N7-RESULT-20261007.md` §4 D2）。计量的洞不需要大，**一个 arm 漏 1 次调用就足以让整场 512 arms 不可推断**。
- **最容易被伪造的方式**：把"只要没抛异常就当 usage 完整"。N7 的 `metricsComplete=true`、`tapeComplete=true` 都成立，`reconciliation` 仍为 false——"自报完整"和"两路独立计量相等"是两回事。

## 主张 2（P0）｜终止必须由**预算判定**触发，且终止原因可被单一字段判定

- **主张**：任一硬上限触达时，运行时在**同一次**运行内终止该 turn，并发出可判定的终止原因；不存在"模型自己决定停"才能停的路径。
- **为什么（运行时视角）**：规格 §四写"Runtime 负责预算、状态机、生命周期，不应依赖模型自觉停止"。区别很实：请求上限（`maxModelCallsPerRun`）被放在**调用封顶**层（`scripts/research/agent-next7-20261006/n7-paired-campaign.mjs:101` 的 `withModelCallCap`），而不是靠模型放弃。
- **怎么验证（可观测判据）**：`RunBudgetTracker` 的 `alarm()`（`run-budget.ts:123-133`）在**首次** breached 后置位并永久返回 `undefined`——首次触限永不被第二次检查掩盖；`runtime.ts:1196/1211/1230/1250/1548/1589` 在触限处 `emit("run.limit_reached", …)` 后走 `finishTurn(..., "agent_limit")`。判据：一次运行的事件流中，存在唯一 `run.limit_reached{limit}` 且其 `used > allowed`，并伴随 `turn.failed`。
- **失败模式**：缺了它，长任务靠模型"感觉够了"停下——本仓库明确的反例是它**不**这样做：`[C2-2]` 断言连续不可恢复错误以 `blocked` + `RESOURCE_LIMIT` 终止且**不出现 `turn.completed`**（`packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts:580-604`）。
- **最容易被伪造的方式**：**发事件但不终止**。`run.limit_reached` 是纯观测事件，不参与控制流；一个只在日志里写"已达上限"、循环照转的实现完全能通过"有没有这个事件"的检查。判据必须绑定"该事件之后**没有再发生任何 model 调用**"。

## 主张 3（P0，本仓库**部分**具备）｜预算计量必须跨 resume 继承，否则恢复即洗预算

- **主张**：进程重启后继续同一任务时，已消耗的预算计数从持久化状态**逐项恢复**，新进程不得从零重新计时。
- **为什么（运行时视角）**：这是"恢复"里最容易被漏掉的半个语义。恢复有两种用途——继续把活干完（做对的事）和把已花的钱忘掉（做错的事）。只有前者写进 checkpoint 时，`maxModelCalls`/`maxToolCalls` 这类上限在崩溃循环里会被无限刷新。
- **怎么验证（可观测判据）**：`run-budget.ts:105-119` `seedConsumed()` 恢复 6 个计数器（turns/toolCalls/outputChars/retries/subagents/cost），`runtime.ts:1775-1782` 从 `checkpoint.budgetUsage` 取 `budgetSeed`/`recoveryUsageSeed`/`verificationRetriesSeed`/`stallRecoverySeed`；测试 `packages/core/src/runtime/resume.test.ts:330-424`（"run/recovery budgets persist across checkpoint/resume"，含 `bu.run.usedToolCalls >= 1`）。
- **失败模式（本仓库的真实缺口）**：`seedConsumed` **不含** `inputTokens`/`outputTokens` 两个字段（`run-budget.ts:106-111` 的 `Pick<>` 仅 6 键），且 `snapshot()`（`:83-96`）**根本不返回 token 字段**——即 token 计数在 tracker 内累积却从未被 checkpoint 覆盖。Token 维度的上限在 resume 上是**未继承**的（与 `estimatedCostUsd` 不同，后者被继承）。
- **最容易被伪造的方式**：只断言 `usedToolCalls` 被恢复（这正是既有测试做的），从而让"预算继承"看起来成立；而 token 维度是空的。

## 主张 4（P0）｜副作用的"至多一次"必须由**幂等键 + 恢复时分类**保证，而不是由重试策略保证

- **主张**：崩溃后用同一 session/turn 恢复时，任何已提交的破坏性写入不得被自动重放；结局未知的调用必须被显式提出待核对。
- **为什么（运行时视角）**：崩溃发生在"效应已发生但记录未落"的窗口时，进程**不可能知道**自己做到哪一步。此时唯一安全动作是"不重放 + 提出核对"，而不是"重试一次试试"。
- **怎么验证（可观测判据）**：`RecoveryController.reconstructResumeState()`（`packages/core/src/runtime/recovery-controller.ts:374-473`）把 post-checkpoint 事件重放成 `committedSideEffects` / `unresolvedTools`；`runtime.ts:1737-1758` 为每个 unresolved 发一条 `retry.reconciliation`（带 typed verdict）。判据是**计数**：破坏性工具的真实执行次数。`[C5-1]/[C5-2]/[C5-5]` 断言 resume 后 `writeCount` 保持 1 / 恰好 1 / 0（`pr-harness-fault-recovery.regressions.test.ts:716-845`）；9 个 kill point 全矩阵见 `packages/core/src/runtime/crash-matrix.test.ts:173-317`。
- **失败模式**：重复破坏性写入（append 两次、重复扣款、重复发信）。本仓库的强反例设计是 `[C5-4]`：**没有可用 checkpoint 时抛 `RESUME_FAILED` 并拒绝重跑**（`:804-822`），而不是"尽力而为地重跑"。
- **最容易被伪造的方式**：把"进程没崩过"当作"幂等"。另外，若 fixture 的写入计数在 override `execute()` 时忘记自增，`writeCount` 会静默保持 0，"恰好一次"的断言就变成空洞——本文件测试头专门写了这条警告（`:193-200`），这本身就是伪造手法的现实版本。

## 主张 5（P1，但被普遍高估）｜"能恢复"必须区分"恢复被**尝试**"与"恢复**成功**"

- **主张**：存在一条可判定路径，能区分"resume 被调用过"与"resume 后状态一致且任务继续"，前者不得计入恢复成功率分子。
- **为什么（运行时视角）**：恢复失败最常见的形态不是抛错，而是**resume 之后立刻再次死掉**。任何以"出现了 `session.resumed`"为判据的指标都会把这个算成成功。
- **怎么验证（可观测判据）**：看 `session.resumed` 的 payload 字段集合——`runtime.ts:1783-1790` 只有 `checkpointId/previousTurnId/resumedTurnId/replayedEventCount/committedSideEffects/unresolvedTools`；**没有任何"一致性已验证/已继续执行"字段**。这是本仓库**已知且刻意接受**的缺口：`SPEC-CONFORMANCE.md` §六-7 记载该判据曾被尝试并**主动否决**（"该判据只能证明恢复被尝试过"，接入分子属放行方向缺陷）。当前实现只把该维度报 `INSUFFICIENT_SAMPLE` 并让门限 BLOCKED。
- **失败模式**：恢复率虚高到 ≥95% 的门限"看起来达标"，而真实事故是"每次重启都再崩一次"。规格 §三 note 5 要求的四项（持久化状态、工作区一致性、调用幂等、已执行副作用）中，**事件轨迹只能回答最后一项**。
- **最容易被伪造的方式**：用 `session.resumed` 的存在当分子。这条我要点名：它是本仓库里**最容易被写进评测脚本而无人发现**的伪造点，因为它看起来完全合理。

## 主张 6（P1）｜恢复/重试的决策必须留有"**没重试**"的记录

- **主张**：对每一次失败的工具调用，事件流能区分三种结局：真的重试了、被策略拒绝重试、不可重试。仅凭事件无法区分者，不得作为可审计证据。
- **为什么（运行时视角）**：重试策略的价值在于"拒绝重试非幂等操作"。如果 trace 只记录"我决定重试"，那审查者无法复核这条策略究竟生效没有——**策略越强，trace 撒谎的后果越严重**。
- **怎么验证（可观测判据）**：本仓库**当前不满足**。`packages/core/src/runtime/tool-call-controller.ts:747-757` 在 `retryPolicy !== "safe"`（第 757 行）判定**之前**无条件发 `recovery.decided`，并把 `decision.action==="retry"` 映射为 `action:"retry_safe"`、`reason:"…retrying"`。可判据是**两个计数的差**：`recovery.decided{action:"retry_safe"}` 的条数 vs orchestrator 记录的真实 dispatch 次数。`[C2-3]` 把当前行为 pin 住：事件条数 > 0 而实际执行次数 == 1（`pr-harness-fault-recovery.regressions.test.ts:605-651`）。此为 `EVIDENCE-INDEX.md` §5 的 **DEFECT-1**，本 PR 只记录不修，修复者会让该断言主动变红。
- **失败模式**：审查者在事故复盘中据 trace 认定"运行时重试了 3 次"，而实际一次没重试——把"策略拒绝"误读成"策略执行"，会掩盖真正的问题。
- **最容易被伪造的方式**：把"发了 `retry.*` 事件"当作"做过重试"。正确判据是**事件与真实执行计数的联立**，任缺其一都不成立。

## 主张 7（P1）｜"周期预算"必须与"单次上限"分开表达

- **主张**：campaign 级预算（整个评测周期的 token/时长/调用上限）与 per-run 上限是两个独立对象，且各自有独立的触限事件与消耗视图。
- **为什么（运行时视角）**：N7 跑了 512 arms、9171 次调用，硬上限占用是工具 15,420/32,000、时长 17,756,119/43,200,000 ms（`N7-RESULT-20261007.md` §2）——这些数**不可能**由 per-turn 的 `RunBudgetTracker` 表达。把两者混为一谈，会让"每 arm 30 次调用"这类封顶在周期维度上完全失效。
- **怎么验证（可观测判据）**：仓库**有**周期侧实现：`packages/evaluation/src/tool-call-efficiency-formal-run.ts` 的 `reserve`/`charge`/`view().charged`/`journalEntries()`（`usdMicros`/`inputTokens`/`totalTokens`/`toolCalls`/`durationMs` 六维 + `caps`），并有独立测试 `source-audit-budget.regressions.test.ts`。判据：存在一个不随 turn 重置的消耗视图，且打开持久化账本后数值一致（`tool-call-efficiency-formal-run.test.ts:463-467`）。
- **失败模式**：周期预算失效时，一场评测会超支而不自知；N7 的 `durable_budget_proven` FAIL 正是两路记账对不上的结果（cost journal 9169 条 vs ledger 自报 9171 次）。
- **最容易被伪造的方式**：用 per-run 计数求和来"重建"周期预算，绕开持久化账本。求和结果在**没有重复计量**时才等于账本；而重复计量恰恰是要检测的故障。

## 主张 8（必须，且规格没写）｜"作废样本"必须与"失败样本"区分，且作废规则必须在开启前冻结

- **主张**：一场评测里，一个 arm 因基础设施原因作废，与一个 arm 因模型表现失败，必须是两个不同状态；任一状态的下界都要在**看到效果数字之前**冻结。
- **为什么（运行时视角）**：这是预算/生命周期问题的**测量化形态**。"作废"一旦可以在看到结果后决定，就等于给了操作者一个免费的样本删除权——价格是整场推断失效。
- **怎么验证（可观测判据）**：N7 的 `completionRatio=255/256=0.996` 但 `full_frozen_grid` FAIL（要求 `partial=0`），`infrastructure_qualified` FAIL（要求 `status=COMPLETED && complete=true`）（`N7-RESULT-20261007.md` §3）。两层**都要求零作废**；且 `--resume` 无法修复：executor 对已进 journal 的 arm 一律跳过、不看 `valid`（`packages/evaluation/src/paired-executor.ts:565-575`）。
- **失败模式**：N7 的实际形态——512 arms 跑完 7.1 小时、9171 次调用、约 $9.169 声明上界，因为 1 个越界 pair 被判 `infrastructure` 而**整场测量作废**（§4 D3）。更糟的是该 pair 的"确实写出去了"经复核**未被证据支持**（`N7-ERRATA-20261007.md` §5）。
- **最容易被伪造的方式**：事后重跑那一格并宣称"网格是完整的"。N7 明确记录这条红线：删 journal 条目重跑属销毁证据与按结果挑样本，本场未做（§4 D1）。

## 我认为被高估的三件事

1. **"更细的预算粒度"（每步/每工具/每 token 分别设限）**。N7 的失败不是预算太粗，而是**两路计量对不上**（D2：2 个 arm 各差 1 次调用）。先让"一处计量"可信，再谈更多维度；新增维度只会让对账更难。
2. **"崩溃后自动重放未完成步骤"**。这是最反直觉的一条：仓库里最强的恢复性质恰恰是**不重放**——`[C5-4]` 在无可信 checkpoint 时抛 `RESUME_FAILED` 拒跑（`pr-harness-fault-recovery.regressions.test.ts:804-822`），`RetryPolicy` 对非幂等工具默认 `safeToRetry:false`（`packages/contracts/src/errors.ts:127-128` 的 `PROCESS_ERROR`/`PROCESS_TIMEOUT`）。"更自动"在这里等于"更可能重复扣款"。
3. **`maxTurns` / "步数上限"作为主预算**。`isHardLimit()`（`run-budget.ts:137-139`）把 `maxTurns` 与 `maxEstimatedCostUsd` 一起排除在硬限之外，且该函数在全仓**无任何调用点**（`void isHardLimit` 仅为消 lint）。规格 §四说"不应依赖模型自觉停止"——而"模型可以再多想几轮"正是同一个漏洞的另一种写法。真正有约束力的是调用数/token/时长，不是轮数。

## 我不确定的地方（交给红队与主席）

- 主张 3 中 token 维度"未继承"的结论，我只核到 `seedConsumed` 的 6 键 `Pick<>` 与 `snapshot()` 的返回类型；我**没有**追踪 `budgetUsage` 的所有写入点，因此不能排除别处有补偿逻辑。**标注为待复核**。
- 主张 7 的判据在 `packages/evaluation`，与主张 1–6 的 `packages/core` 运行时不是同一条代码路径；"两个预算对象各司其职"这句是我从两处实现**推断**的架构意图，而非某处写下的不变式。
