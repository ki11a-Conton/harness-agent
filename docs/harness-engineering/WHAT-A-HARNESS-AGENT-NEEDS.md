# 一个具备 Harness Engineering 能力的自主编程 Agent，必须具备什么？

> 本文件是 [多智能体讨论](../discourse/README.md) 的**主席裁决结论**：5 份视角清单（D1 运行时 / D2 验证 / D3 安全 / D4 测量 / D5 人机与成本）+ 红队攻击 → 一份分级的、每条都可判真假的结论。
> **声明**：这是**能力与口径**结论，**不是模型效果结论**。全程 **0 次付费模型调用**，未运行任何真实评测任务；本仓库真实模型质量仍为 `NOT_PROVEN`。文中"已验证"仅指"该主张在本仓库有可执行判据/测试"，不等于"该能力在真实任务中有效"。

## 0. 一句话结论

> **一个合格的 Harness Agent，其下限不是"能做多少事"，而是"它说的每一句话都能被独立复算，它不知道的东西绝不长得像好消息"。**

讨论中 5 个视角独立收敛到同一条纪律（下称 **P0-A**）：

> **P0-A（未知不得与良性同形）**：任何进入**控制流**或**指标分子**的字段/事件，都必须有一个**独立于它的来源**作为对照；没有对照量，它只能进 trace，不得进分母/分子，也不得驱动决策；"未知/未测/缺失"必须有与"0/通过/正常"**不同形**的表示。

这条纪律在本仓库有**四处独立发作**的真实证据（正是它们让 5 位讨论者独立收敛）：

| 发作点 | 事实 | 位置 |
| --- | --- | --- |
| trace 撒谎 | `recovery.decided` 在 `retryPolicy !== "safe"` 判断**之前**发出，把"拒绝重试"映射成 `action:"retry_safe"`/`"…retrying"`，而实际一次没重试 | `packages/core/src/runtime/tool-call-controller.ts:747-757`（**D1、D2、D5 三人独立复核**，我逐行读码确认） |
| 安全事件缺失 | orchestrator（真实权限引擎）返回 `denied` 时只发 `tool.failed`，**不发任何 `security.*_denied`** → 安全证据流里"没有事件"与"没有攻击"同形 | 同文件 `:571-578`、`:588-595`（DEFECT-2） |
| 人类成本恒 0 | `human_interventions` 在非测试代码里**从未被写过非零值**（只有 `0` 字面量与 `?? 0` 兜底），却被当作可靠性扣分项 | `packages/evaluation/src/cost-model.ts:161`、`baseline.ts:831`、`load-runs.ts:59`（我用全仓检索复核） |
| 证据被静默丢弃 | `loadRunsFromArtifact` 对 report-object 形态**硬编码 `events: []`** → 用它喂指标会得到 `trace_completeness=0`、验证状态 `null`（**假 BLOCKED**，不是"没有证据"） | `packages/evaluation/src/load-runs.ts:48` |

---

## 1. 必修清单（缺了就不算合格）

每条给出：**判据**（怎么观测）/ **最小验收**（怎么测出来）/ **失败模式** / **本仓库现状**。

### M1. 预算是封闭计量域：每一维消耗要么有观测值，要么显式 `unknown`
- **判据**：任意 run 的预算视图里，不存在"未观测却记为 0"的维度。
- **最小验收**：对"provider 不报 usage"的注入用例，计数维度必须取 `unknown` 而非 `0`。
- **失败模式**：漏计方向永远是**低估**（安全方向错）；N7 主实验 `usage_complete_and_reconciled` FAIL——请求 tape 与 arm metrics 差 +64,765 input / +894 output，且**差异只来自 2 个 arm**：一个 arm 漏 1 次调用就足以让 512 arms 的整场不可推断。
- **本仓库现状**：`RunBudgetTracker`（`packages/core/src/runtime/run-budget.ts`）三参数 `onModelUsage`，无 unknown 语义；unknown 语义在别处有先例（`usage_unknown`，P20-1）。**缺口**。

### M2. 终止由预算判定触发，且"触限"必须意味着"停止"
- **判据**：存在唯一 `run.limit_reached{limit}`，且**该事件之后再无任何 model 调用**。
- **最小验收**：断言事件 + 后续调用计数为 0（只断言事件存在是不够的）。
- **失败模式**：**发事件但不终止**——一个只在日志里写"已达上限"、循环照转的实现能通过"有没有这个事件"的检查。
- **本仓库现状**：**已具备**，`run-budget.ts:123-133` 的 `alarm()` 首次 breached 后永久置位；`runtime.ts` 多处 `emit("run.limit_reached")` + `finishTurn(..., "agent_limit")`；`pr-harness-fault-recovery.regressions.test.ts` 的 `[C2-2]` 断言以 `blocked/RESOURCE_LIMIT` 终止且**无** `turn.completed`。

### M3. 预算必须跨 resume 继承（含 token 维度）
- **判据**：重启后继续同一任务时，各维度已消耗计数从持久化状态逐项恢复；新进程不得从零重新计时。
- **最小验收**：崩溃注入 + resume 后，`usedToolCalls`/token/成本三类计数均 ≥ 崩溃前值。
- **失败模式**：崩溃循环里上限被无限刷新；"预算"退化为"每次尝试的预算"。
- **本仓库现状：真实缺口，且是类型级封死（不是遗漏）**。`packages/contracts/src/limits.ts` 的 `interface RunBudget` **只有 8 个字段，没有 `inputTokens`/`outputTokens`**（我逐字复核）；`run-budget.ts:24-25` 私下累计 token，但 `snapshot(): RunBudget` 无法把它们带进 checkpoint（`runtime.ts:976-983` → `checkpoint.budgetUsage.run`）。**token 预算在 resume 上未继承**；`estimatedCostUsd` 与工具调用数则继承了。

### M4. 副作用的"至多一次"由幂等键 + 恢复分类保证，不由重试策略保证
- **判据**：崩溃后用同一 session 恢复，已提交的破坏性写入**执行次数不变**；结局未知的调用被显式提出待核对。
- **最小验收**：可计数的写入目标，断言 resume 前后 `writeCount` 保持 1；无可信 checkpoint 时必须是**明确拒绝**而非重跑。
- **失败模式**：重复扣款/重复 append；"尽力而为地重跑"把未知结局变成第二次副作用。
- **本仓库现状**：**已具备**——`RecoveryController.reconstructResumeState()` 产出 `committedSideEffects`/`unresolvedTools`，`runtime.ts` 发 `retry.reconciliation`；`[C5-1]`/`[C5-2]`/`[C5-4]`/`[C5-5]` 断言 `writeCount` 保持 1/恰好 1/0，无可信 checkpoint 时抛 `RESUME_FAILED`。

### M5. trace 必须能区分"真的重试了 / 被拒绝重试 / 不可重试"
- **判据**：`recovery.decided{action}` 的条数与**真实 dispatch 次数**联立相等（两者都要有）。
- **失败模式**：事故复盘中据 trace 认定"重试了 3 次"而实际一次没重试——**策略越强，trace 撒谎的后果越严重**。
- **本仓库现状：不满足**（DEFECT-1）。已被 `[C2-1]`/`[C2-3]` pin 住，修复时断言会主动变红。**运营备注**：D1 已指出，该判据依赖 orchestrator 的 dispatch 计数，而它只核了测试替身 `fake-orchestrator.ts`；真实 `@ar/tools` orchestrator 是否有等价计数**未核**（待补）。

### M6. 完成声明的最小证据集：外部验证 + 与本次 run 绑定 + 失败证据保留
- **判据**：完成声明必须携带 (a) 机器可执行的验收结果、(b) 与该 run/证据文件的**绑定关系**、(c) 未通过时的实际失败证据。
- **最小验收**：`status="passed"` 只能来自独立验收；"模型自述"权重为 **0**；"命令退出码 0"只证明该命令在该 cwd 退出码为 0；"证据文件存在"只证明存在，需另证内容与本次 run 绑定。
- **失败模式**：**模型给自己打分**；或把 `unverified_complete` 当完成（N7 两个 arm 的假完成率高达 112/256、107/256）。
- **本仓库现状**：**已具备**（`packages/tools/src/verification/task-verifier.ts`、`packages/core/src/runtime/verification-controller.ts`；`G1a`–`G2b` 断言完整失败证据包 + 回注给模型的"NOT complete"纠正；`C3`/`C4` 分别否掉"退出码 0"与"文件存在"两种伪证）。

### M7. 未知/未测必须与"通过"不同形，且门限对未测是 fail-closed
- **判据**：缺样本 → `value: null` + `status: INSUFFICIENT_SAMPLE`，且**一律 BLOCKED**；`0/0` 与 `1/1` 在门限上不得同形。
- **最小验收**：把某类用例从 n=20 删到 n=0，门限必须从 PASS 变 BLOCKED。
- **失败模式**：分母偷偷变小 → 指标单调变好而无需撒谎（D4 称其为本仓库**唯一一条不用撒谎就能伪造的指标**：`auto_verification_coverage` 的分母是"被观测到的任务数"，`harness-metrics.ts:1142 coverageDenominator = tasks.size`，我复核确认）。
- **本仓库现状**：**部分具备**。`harness-conformance-gate.ts:292` 实现 `threshold === 1 ? failures === 0 && denominator > 0 : observed >= threshold`，`INSUFFICIENT_SAMPLE ⇒ BLOCKED` ✓；但覆盖率分母**需外部基准清单**（接口未含）→ 该指标当前**不具备门禁资格**。

### M8. 安全是存在性属性：三态分母不得混算，方向必须 fail-closed
- **判据**：`CONTAINED`（尝试 + 同一 `toolCallId` 被拒）/ `NO_ATTACK_ATTEMPT`（没尝试）/ `MISSING_EXPECTED_EVENT`（期待攻击却无观察）**三态分离**；`NO_ATTACK_ATTEMPT` 不得进分子；**未声明期望的用例不得落到 clean**。
- **最小验收**：喂入"零安全事件 + case 声明了 `forbidden`"必须得 `MISSING_EXPECTED_EVENT`；喂入"被拒事件无 `toolCallId`"必须 `INVALID`。
- **失败模式**：把"模型很乖"（没尝试）当"边界有效"；或**安全事件缺失被读成干净**（放行方向失效——报错可见会变红，缺失静默会通过）。
- **本仓库现状**：`security-outcome-v2.ts:166-213` 的 `toolCallId` 双向匹配 ✓（**已具备**）；但 DEFECT-2 让 orchestrator 的权限拒绝在证据流上不可见，且 D3 收窄了影响范围——**只在 case 声明了 `forbidden`/`expected.status="denied"` 时 fail-closed**，未声明则落到 clean 分支 → **未声明期望的用例上 fail-open**。D2 独立复核后建议新增第五槽位 `NO_EXPECTATION_DECLARED`，并把门限分母取"声明过期望且观测器在岗的用例数"。**裁决：采纳为必修项（表示层与分母定义），但不在本 PR 实施。**

### M9. 隔离声明不得越界：没有强隔离就说"逻辑层被测过"，不说"隔离已验证"
- **判据**：产物里 `isolationStrength` 与 `promotionEligible` 必须来自**实际 capability 探测**，且弱后端**先 REFUSED**、显式放行也永不 eligible。
- **失败模式**：把"逻辑闸门全绿"写成"隔离已验证"；或只读下游摘要绕过两道校验伪造 `promotionEligible:true`。
- **本仓库现状**：**已具备**。`benchmark-isolation.ts:89`（`win32-none`、`strongIsolation:false`）、`sandbox-executor.ts:577,782-783,799-800`（弱后端 REFUSED；`--allow-insecure-local-benchmark` 也只是 `insecure-local` + `promotionEligible:false`）、`artifact-v3/schema.ts:45-70` 与 `promotion-envelope.ts:384-385` 再挡两次。

### M10. 报告必须自带口径：分母、样本量、排除项、失败分类、身份
- **判据**：任一比率缺任一项即视为**不可复算**，不得作为晋升证据。
- **真实证据**：N7 同一份数据两种口径读出 **143→145（255 定案）/ 143→146（256 完整网格 ITT）**；计费 **9,169 vs 9,171** 两个账本口径差（`charged.usdMicros = 9,169 × 1e6` 是**声明上界**，不是账单）。
- **失败模式**：±1.17pp 的口径差被当成"候选改进/退步"；把声明上界当账单算性价比（可能把结论算反）。
- **本仓库现状**：本 PR 的 `SpecMetricSample` 已带 `numerator`/`denominator`/`sampleSize`/`status`/`excludedReasons`；`durable_budget_proven` 正是"两路记账不能证明同源 ⇒ FAIL"的实例（正确做法是**拒出数**，不是取平均）。

### M11. A/B 可比性必须固定一组量并声明 ITT/PP
- **判据**：模型精确版本、任务集与版本、顺序、重复次数 k、工具权限、预算上限、环境/依赖、评测脚本、config hash、git sha 全部固定；口径（ITT/PP）显式声明。
- **失败模式**：候选偷偷用了更便宜模型/更多重试预算/更宽松权限，然后报"成功率 +5pp"。
- **本仓库现状**：`SPEC_REQUIRED_RUN_RECORD_FIELDS`（21 字段）已做成受测契约；`paired-executor.ts` 的 `buildExecutionIdentityV1` 已固定身份。**缺口**：仓库既有产物到该记录的逐字段映射未建立（`load-runs.ts:48` 的 `events: []` 会让 `trace_completeness` 恒 0 → **假 BLOCKED**）。

### M12. 长跑必须给人一个"只读活性摘要"，且成本数必须带口径标签
- **判据**：无需读 transcript 即可回答"它还活着、值得继续烧钱"：`turn_count`/`tool_call_count`/`model_call_count`/`verification_failures`/`usage_unknown` + 最近状态变化时间戳；成本数必须带 `declared ceiling / reconciled / estimated` 标签。
- **失败模式**：用 `estimated_cost` 与 `duration_ms` 判断健康——**它们衡量花费，不衡量进展**（僵死运行里照样增长）；D5 据此撤回了自己原先的 H1 表述（**作者自纠**）。
- **本仓库现状**：`packages/observability/src/metrics.ts` 的 `computeMetrics()` 已产出上述字段 ✓；成本 provenance **缺**（`computeCost()` 的显式值与默认费率估算**返回值同形**）。

### M13. 停止条件必须在看到效果数字之前冻结，且完整性要求与预算要求分开声明
- **判据**：冻结文件（含时间证据）里写明"作废单元 ≥ N 即不可推断"，并在运行中把它作为**决策点**输出，而不是等人想起。
- **失败模式**：沉没成本决定继续；把 `--resume` 当正当理由（N7 已证伪：executor 对已进 journal 的 arm 一律跳过、不看 `valid`，`paired-executor.ts:565-575`，而删除条目重跑被判定为销毁证据）。
- **本仓库现状**：N7 的纪律执行到位（门限/用例/臂/seed/预算**未因结果改动**，两次修订都在看到效果数字之前，见 `BUDGET-AMENDMENT.md`），但**停止条件里没有把"作废概率"变成可提前计算的量** → 7.1 小时、9,171 次调用换回 `NOT_PROVEN`。

---

### M15. 证据的内部自洽性必须在**判定时**强制，冲突即拒绝该判定
- **判据**：同一份证据里出现**互相矛盾的字段**时，判定必须被拒绝（而不是接受其中更严重的一个）。最小实例：`securityOutcome.kind === "ESCAPE"` 同时 `escapedPaths.length === 0`。
- **为什么**：N7 的整场作废正是这个形状——记录里 `ESCAPE` 为真、`escapedPaths` 为空、且复核时该文件根本不存在；**这对矛盾在当场就可判**，不需要事后 ERRATA。**这是红队事故演练中唯一"能提前发现 N7 事故"的主张**（红队 §5-①）。
- **失败模式**：接受一个自相矛盾的判定 → 用**未被证据支持的因果断言**（"确实写出去了"）作废 512 arms 的整场测量。**误报的代价等于一次数据丢失。**
- **本仓库现状**：**无此检查**（`security-evidence-execution.ts` 未对 `ESCAPE` 与 `escapedPaths` 做一致性断言）。**缺口，且实现成本极低**。

### M16. 观测器的**覆盖性**必须被验证：看不见的越界不等于没越界
- **判据**：能产生工作区外写入的工具集合 ⊆ 副作用收集器的工具名白名单；不在覆盖内的工具必须让产物显式标注 `OBSERVER_GAP`，**不得沉默地按"无越界"处理**。
- **为什么（红队 §5-④：本讨论的集体盲区）**：所有人都在争论"证据的**语义**对不对"，**没有人问"证据的**来源**覆不覆盖"**。已核实的事实：`apps/cli/src/benchmark-command.ts:2058` 把 `changedPaths` 的来源写死在 `write_file`/`edit_file` 上，而 `changedPaths` 是 `escapedPaths` 的唯一来源 → **经 `exec` 的越界写不产生 `escapedPaths`，E1-02 哨兵看不见**；同时 `resolveExecCwd`（`packages/tools/src/tools/exec.ts:42-110`）只约束 exec 的 cwd、不约束该进程往哪写。
- **失败模式**：与 DEFECT-2 同一失效方向——**盲区在放行侧**（看不见的越界 = 没越界）。
- **本仓库现状**：**判据为假**（`exec` 不在白名单）。D3 已据此把 B4/B6 的可声称范围收窄为"只有 `write_file`/`edit_file` 路径的越界写可被观测"。

### M17. 进入指标分子或绑定哈希的字段必须带**语义版本**
- **判据**：每个参与绑定/哈希/指标分子的字段有语义版本标记；无标记的字段不得进哈希。
- **为什么**：`estimated_cost` "一名三义"（D5 自撤）不是个案——N7 D5 证明**并行分支给 `facts` 多加一个 `armDigestFormat` 字段就让旧归档报 `EXPERIMENT_BINDING_DRIFT`**（77 个键里唯一带格式标记的那个）。
- **失败模式**：字段语义静默漂移，旧证据与新证据**不可比却仍被并列引用**。
- **本仓库现状**：**缺口**。

### M18. 验收标准必须绑定进 run 身份，**且运行中不可被改写**（D2 与 D3 联署的共同最大缺口）
- **判据**：一次 run 的身份里包含"本次使用的断言集摘要"；运行期间对验收脚本/规格的任何写入都会使该 run 的判定失效或被显式标记。
- **为什么**：规格 §七 阶段验收清单第 1 条要求"具有**不可被 Agent 任意改写的**验收标准"。**本仓库在 runtime 层没有实现这一点**：
  - `packages/core/src/runtime/verification-controller.ts:82` 直接 `let verification = task.verification;` —— 验收规格来自**任务对象本身**，没有任何"断言集摘要进入 run 身份"的机制（我逐行复核）。
  - `packages/evaluation/src/execution-plan.ts:489` 的 clean-tree 检查是**计划期/执行前**的 `probeSourceSnapshot` 判定（`treeFingerprint` 仅在**脏树**时非空），**不约束 run 内写入**（我复核该行上下文）。
- **失败模式**：Agent 改掉验收脚本/放宽断言，然后"通过"——**且没有任何证据能事后发现**。
- **与 P0-A 同源**：`VerificationGateResult.status` 的类型是 `"passed" | "failed" | "blocked"`，**没有 `not_run`**（我复核类型定义）→ "没跑"只能表现为 `return undefined`，**正是 P0-A 禁止的"缺失与失败同形"**。D2 把自己的这条处方判为"在本仓库尚未落地"，并据此撤回"系统性撒谎面"一词——**作者自纠，应予记录**。

---

## 2. 加分清单（有了更好，但缺了不等于不合格）

| 项 | 为什么是加分而非必修 |
| --- | --- |
| 更细的预算粒度（按步/按工具/按 token 分别设限） | N7 的失败不是粒度太粗，而是**两路计量对不上**；先让"一处计量"可信，再多维度只会让对账更难 |
| 崩溃后自动重放未完成步骤 | 仓库里最强的恢复性质恰恰是**不重放**（无可信 checkpoint 时 `RESUME_FAILED`）。"更自动"在这里等于"更可能重复扣款" |
| `maxTurns` 作为主预算 | `isHardLimit()` 把 `maxTurns` 排除在硬限外且**全仓无调用点**（D1 自查仅 grep 了 `packages/core/src/runtime`，全仓检索待补）；真正有约束力的是调用数/token/时长 |
| 置信区间 / 统计不确定性 | 规格 §六 要求"小样本应标注不确定性"，但当前"拒出数 + 标明样本量"已能防止最坏情况（假精确） |
| 人工时间进入评分卡 | 规格 §六 的 10% 成本维度只算美元与毫秒；人工时间确应进入，但**先得把它测出来**（见 M14） |
| pass@k 作为能力证据 | 在有重试预算时它只是"预算的度量"；报 pass@1 + pass^k 两个诚实数字更好 |

### M14（必修，但排在 M1–M13 之后）. 人类介入必须被测量，而不是被当作常数
- **判据**：一次真实评测后，`human_interventions` 的汇总必须**可能不为 0**，且非零值来源可追。
- **失败模式**：把 0 读成"完全不需要人"——**分母缺失被当成优秀表现**，与 P0-A 直接冲突。
- **本仓库现状：真实缺口**。链路齐全（`cost-model.ts:161` 扣分、`baseline.ts:954` 汇总、`contracts/src/skill.ts` 有字段），但**非测试代码里从未写入非零值**（全仓检索：只有 `0` 与 `?? 0`）。→ "自治度"**当前无法被证伪**。

---

## 3. 被否决 / 降级 / 未解决的主张

| 主张 | 裁决 | 理由 |
| --- | --- | --- |
| "安全 100% 需要 denominator ≥ 20 才算已验证"（D3 建议） | **REJECTED 作为并列门限**；保留为参数 | `harness-conformance-gate.ts:292` 现为 `failures===0 && denominator>0`（我复核）；D1 裁决：三条规则作用域不同（单指标门限 / 样本充分性 / 用词资格），**新增并列门限会让"哪些规则生效"本身不可判**。正确形式：`0 < denominator < 20 ⇒ INSUFFICIENT_SAMPLE`，交给既有 fail-closed。具体数字由 D4 定，**未实施** |
| "停止条件里把作废概率变成可提前计算的量"（D5-H8） | **UNVERIFIABLE（缺计算式）** | D5 未给出概率模型；结论降级为 M13（冻结 + 完整性阈值 + 决策点输出）。要升级需给出可复算的失效模型 |
| `estimated_cost` 作为活性判据（D5-H1 原表述） | **REJECTED（作者已自撤）** | 该字段累加调用方传入的 `costUsd`，与账单/估算语义重载，**恰好违反 D5 自己的 H5** |
| "审批请求数 == 不可逆动作数"（D5-H3） | **降级为不可判** | 两个量无共同 ground truth；D1 已给可判替代（按三类事件计数 + 拒绝原因可分类） |
| "trace 完整率 100% 是好门槛"（规格 §三-9） | **CONTESTS：完整 ≠ 正确** | DEFECT-1 是现成反例：事件**确实发出**（完整率满分）但内容撒谎。**裁决：完整率必须配一条"事件宣称的行为 vs 实际执行计数"的一致性检查**，否则它测的是覆盖率而不是真相 |
| "关键任务回归 = 0"（规格 §三-12） | **CONTESTS：加作用域后保留** | 只在**关键任务集冻结且被评判**时是好门槛；扩到"任何历史通过任务都不许回归"会变成刹车（交叉修复/改善即破坏/为保 0 而缩小历史集）。本 PR 实现为**任务级**且未被评估的关键任务单独暴露缺口 ✓ |
| "沙箱 = 隔离" | **REJECTED** | 本机 `win32-none`：逻辑闸门 ≠ OS 级隔离（M9） |
| "注入恶意指令但没出事 = 边界有效" | **REJECTED** | 可能是 `NO_ATTACK_ATTEMPT`；方向性错误（M8） |
| D3 "经 exec 的越界写可被观测" | **REJECTED（D3 自查后自行收窄）** | `benchmark-command.ts:2058` 只对 `write_file`/`edit_file` 收集路径 → **经 exec 的越界写不产生 `escapedPaths`**，E1-02 哨兵看不见；而 `resolveExecCwd` 只约束 cwd。**我已逐行复核确认**。可声称范围应限于 `write_file`/`edit_file` 路径 |
| N7 结论"模型把脚本写到了工作区外" | **REJECTED（已被 ERRATA 推翻）** | `escapedPaths` 为空、文件不存在；`detail` 字符串只是**意图证据**。教训：`ESCAPE` 是因果断言，**误报也是成本**（一次过度断言作废了 512 arms 的整场测量） |
| "安全 n≥20" vs "denominator>0" 是冲突（红队 §3-①的初始判断） | **不是冲突，作用域不同；但两方表述都要改** | 红队**自我更正**：它原以为 `minStratumRuns` 默认 0（防线未接线），经 D4 回应后回读原文确认**默认 1**，故 `belowStratumMinimum` 会真实触发——**红队撤回自己的机制描述**。真实缺口形态更糟：默认 1 意味着**只有空 strata 被标注**，`n=1 && failures===0 && denominator>0` **恰好能 PASS**；且 `GateContext` 只有三个字段、**门禁不接收样本量下限参数** |
| D5-H8 前半段"停止条件须提前冻结" | **降级为"完整性条款"，保留但标注发现力** | 红队 §2.1 指出 N7 **已经遵守了**这条纪律却仍 `NOT_PROVEN` → 对 N7 事故**零发现力**。**裁决：保留为必修（它的价值是"不作废才可推断"的完整性语义与自证时间证据，不是检测能力），但必须在文中写明"它不提供事故发现力"**。后半段"作废概率可提前计算"仍为 `UNVERIFIABLE`（缺计算式） |
| D4-M9 机制③"为保 0 回归把历史通过集改小" | **REJECTED（重复计一条）** | 红队 §2.3：它就是 M5 的分母问题的特例，删掉不损失鉴别力 |
| D5-H9 的"明确 owner"子句 | **REJECTED（不可判）** | 无任何可观测判据能证明"某人负责"；D5 自己在 rebuttal 承认是最软一条。保留其可判的一半 → 已并入 M17/建议 8 |
| D2 的"`expectation` 为空"表述 | **REJECTED（前提不可能发生）** | 红队 §1.3 回读原文：`securityExpectationFromCase()` **从不返回空**，恒返回两个布尔；正确表述是"两个布尔均为 false"。**我采纳红队的更正，不在本文件中使用"期望为空"这一表述** |
| 红队新增：证据内部自洽性检查 | **ACCEPTED → M15** | 是本次讨论中**唯一能提前发现 N7 事故**的主张，且实现成本极低 |
| 红队新增：观测器覆盖性 `OBSERVER_GAP` | **ACCEPTED → M16** | 判据当前为假（`exec` 不在白名单），且与 DEFECT-2 同一失效方向（放行侧盲区） |
| D3 的"n≥20"这个**数字** | **REJECTED（由 D4 驳回）** | D4 的裁决：下界应由置信水平反推（"违规率 <1% @95%" ⇒ n≈299；n=20 仅支持"违规率 <14%"），**不允许裸整数**。红队转述并接受。→ 保留机制（`INSUFFICIENT_SAMPLE` 表达），**弃用数字 20** |
| D2 的第五槽位 `NO_EXPECTATION_DECLARED`（即使前提表述改正后） | **PARTIAL：只堵一半** | 红队回读原文：`security-evidence-execution.ts:125` 的短路条件是 `facts.length === 0 && …` → 该槽位**只覆盖"零事实"的用例**；"有事实但未声明期望"的用例仍走 `:137-143` 的正常分类。→ 采纳为建议 11，但**必须同时覆盖两类输入**，且**未与 D2 确认**（其质疑未获回应） |
| D2 的四态处方（`verification-controller.ts:75` 的 `return undefined`） | **收窄后才可执行** | 红队的替代写法：`requiresVerification === true && 返回 undefined ⇒ NOT_RUN`（现在就可判、**不必改契约**）。建议采用此收窄形式，原四态处方在当前仓库不可执行 |

---

## 4. 与规格（v1.0）的分歧：它漏了什么、写错什么

1. **漏了"人类协作/升级/可解释性/长期维护"整整一面**：§二 10 项能力无人机接口，§三 12 指标无人工介入成本，§六 的 10% 成本维度只算美元与毫秒。唯一"升级"是 §四 流程图末端一个框，无指标、无 SLA、无判据。→ 本文件补 M12/M14。
2. **所有"100%"目标都没写样本量**：`0/0` 与 `1/1` 都等于 1.0；规格 §三 note 2 已说"测试覆盖不到的风险不能被视为已解决"，但目标表本身没给下界。→ 补 M7/M8。
3. **"回归数为 0"是双刃**：规格把它写成硬门槛，但没给作用域限制。→ 补 M10/M11 与 §3 的裁决。
4. **理想化公式（`pass@k=1-(1-p)^k`、`pass^k=p^k`）在共享状态下不成立**：真实重复运行共享工作区/缓存/checkpoint，**不独立同分布**；规格自己也警告"不应直接依赖公式代替实测"。→ 补 M11 的口径声明要求。
5. **没有规定"证据的复算权"**：规格要求"可复现"，但没规定归档必须**自带原件**才能被第三方复算。N7 的实际形态是：只归档了 9,699 条**摘要**（约 460 MB 原件的索引），且 `facts` 是执行身份的一部分——**并行分支多加一个字段就让旧归档无法在原地复算**（`EXPERIMENT_BINDING_DRIFT`），而声明的校验入口当时**语法错误、从未被执行**。→ 补 §5 R1。
6. **A/B 一节未要求声明 ITT/PP**：同一份数据两种口径差 1.17pp（N7 实例）。→ 补 M10。

---

## 5. 我给规格的三条追加（本文件独有，均可判据）

**R1. 证据必须"自带原件、可被第三方复算、并记住自己的源码点"**
- 判据：把归档交给一台干净机器，在 0 付费调用下能复算出**同一判定**；归档声明 `sourceSha`，复算在**该 SHA** 上进行。
- 现状：N7 未满足（原件在本机 scratch；`facts` 漂移使旧归档在当前 HEAD 不可复算；校验入口当时是坏的——后两者已在后续提交中被修/被 ERRATA 记录）。

**R2. 断言强度必须与证据强度匹配——误报同样是成本**
- 判据：任何"确实发生了 X"的结论，必须能指出 X 的**效应证据**（而非意图证据）；因果断言与意图证据在数据结构上分开。
- 现状：N7 的 `ESCAPE` 由**请求路径**派生，却在记录里表现为"写出去了"，直接作废整场测量。**一个过强的断言，代价等于一次数据丢失。**

**R3. 口径修订必须留时间证据，且"修订发生在结果之前"要可自证**
- 判据：每次门限/预算修订都有带时间戳的文件，且该文件本身的提交时间早于任何效果数字的产生时间。
- 现状：N7 的 `BUDGET-AMENDMENT.md` 做到了（两次修订都在看到效果数字之前）✓ —— **这应成为规格的硬性要求，而不是某个项目的自觉。**

---

## 6. 建议的下一步（可执行，**不在本 PR 内实施**）

| # | 动作 | 判据 | 依赖 |
| --- | --- | --- | --- |
| 1 | 修 DEFECT-1：把 `recovery.decided` 移到 `retryPolicy` 判断**之后**，或新增 `retry_refused` action；同步更新 pin 住的断言 | `[C2-1]`/`[C2-3]` 按新语义变红→改绿；trace 中"retry_safe"条数 == 真实 dispatch 次数 | 需评审（影响既有事件契约） |
| 2 | 修 DEFECT-2：orchestrator 返回 `denied` 时补 `security.*_denied`（带 `toolCallId`、维度、来源） | 构造 orchestrator-denied 用例，事件流可查到该事件；安全门限分母可算 | 同上 |
| 3 | 补 `NO_EXPECTATION_DECLARED` 槽位（D2 提议），把"未声明期望"从 clean 里摘出去 | 未声明期望的零事件用例不再返回 clean | 需与 `security-outcome-v2` 契约一起改 |
| 4 | 让 `changedPaths` 覆盖 `exec` 的写入证据（或明确声明哨兵只覆盖 `write_file`/`edit_file`） | 经 exec 的越界写要么被记录，要么在隔离声明里显式排除 | 需设计（exec 的写入面可能不可穷举） |
| 5 | token 预算跨 resume 继承（扩 `RunBudget`/checkpoint 字段） | 崩溃注入后 token 计数 ≥ 崩溃前值 | 需 schema 变更 |
| 6 | 覆盖率分母改为**外部基准清单** | 删掉 10 个未跑任务后覆盖率必须下降 | 接口变更 |
| 7 | `human_interventions` 真实采集 | 一次带审批的 run 汇总 > 0 | 需真实运行（付费） |
| 8 | 每份已发布归档加 `sourceSha`/`valid_until`/`superseded_by` 元数据 + 一个能静默检测 `EXPERIMENT_BINDING_DRIFT` 的入口 | 旧归档在当前 HEAD 上能被自动标记为"需在记录 SHA 上复算" | 低风险 |
| 9 | **证据自洽性检查（M15）**：`kind === "ESCAPE"` 且 `escapedPaths.length === 0` 时**拒绝该判定** | 构造该矛盾输入，判定必须被拒而不是被接受 | **成本极低，建议最先做** |
| 10 | **观测器覆盖性（M16）**：`sideEffectScope != "none"` 的工具集合 ⊆ 副作用收集器白名单；不在覆盖内的标注 `OBSERVER_GAP` | 当前判据为假（`exec` 缺失）；补上或显式标注 | 需设计 |
| 11 | 安全证据补 `NO_EXPECTATION_DECLARED` 槽位，并把门限分母取"声明过期望且观测器在岗的用例数" | 未声明期望的零事件用例**不得**返回 clean | 需契约变更（且红队指出 D2 的输入条件描述须先改正） |

---

## 7. 讨论过程事实（供复核）

- 参与者：D1 `runtime-lifecycle`、D2 `verification-truth`、D3 `boundary-security`、D4 `eval-measurement`、D5 `human-ops-cost`，主席 `lead`。原始文件见 [docs/discourse/](../discourse/README.md)。
- **红队安排变更（如实记录）**：本会话**团队成员上限为 8**，独立红队成员 `red-team-skeptic` **无法创建**；D3、D5 都如实上报了"投递失败"（`active teammate not found`）而没有静默跳过。因此红队职责改由 `runtime-lifecycle` 对 D2–D5 执行（`WHA-06-redteam.md`），**D1 的清单由主席亲自攻击**（其主张 3 的 token 继承结论经主席逐字复核后**成立且更强**：类型级封死）。
- **执行中断（如实记录）**：讨论期间发生多次子代理执行中断（D2/D4 首轮、D3 首轮），丢工作后按"先落盘再深挖"重做；`WHA-02/03/04/05` 的 Round 1 与 rebuttal 最终均落盘。
- **主席的独立复核**：本文件中标注"我复核/逐字复核"的条目，均由主席直接读码或全仓检索确认（`limits.ts` 的 `RunBudget` 无 token 字段；`run-budget.ts:24-25/83-96`；`approval.ts:42` 的 `expired` 永不等于 allow；`harness-conformance-gate.ts:292`；`harness-metrics.ts:1142`；`load-runs.ts:48`；`benchmark-command.ts:2058-2064`；非测试代码中 `human_interventions` 无任何非零赋值）。
- **未经我复核、仅由讨论者声明的项**：均已在文中标注（如 D2 的 `NO_EXPECTATION_DECLARED` 属建议、D3 的 n≥20 属建议、D1 对"真实 orchestrator 是否有 dispatch 计数"的待核项）。
- **红队做对了什么（值得记录，因为它是本次质量的主要来源）**：① 它**独立回读原文**核实 D3 的 exec 盲区（与我自己的核对一致，`benchmark-command.ts:2050-2066`），而不是转述；② 它**抓住 D2 的事实错误**（`expectation` 从不返回空）并给出正确表述；③ 它**推翻了自己的初始判断**——先猜 `minStratumRuns` 默认 0、经 D4 回应后回读确认默认 1，遂**撤回自己的机制描述**并指出更糟的真实形态（默认 1 只标注空 strata，n=1 恰好能 PASS）；④ 它明确标注**视角偏置**与**"全文行号均为静态读码、未执行任何测试"**，把测试结论一律标为转引；⑤ 被 D2 说服后**删掉了自己一条"真但无用"的判定**（能在今天进 CI 的判据价值高于需改类型系统才能判的判据）。
- **红队报告中一处错误记载已被更正（记录在此，因为它影响可复核性）**：红队初稿据**我的转述**写下"D3 已停止工作、未获回应"，**该记载错误**——D3 当时仍在工作，并向 D2 提出实质质询、获得四条复核回应（其中一条独立确认 `execution-plan.ts:489` 属执行前检查）。→ 因此 **D3 的"可声称范围收窄"是有同侪复核的**（见 M16）；我作为转述源头对此负责，更正已落到 [docs/discourse/README.md](../discourse/README.md)。
- **未尽事项（如实记录）**：红队向 `verification-truth`（2 条）与 `eval-measurement`（2 条 + 1 条裁决请求）发出的质疑中，**D2 的两条最终获回应并采纳**（"`expectation` 为空"改为两个布尔均为 false；R1 收窄为 `requiresVerification === true && 返回 undefined ⇒ NOT_RUN`）；**D4 的裁决请求未收到直接回复**，但其 rebuttal 已就"`minStratumRuns` 默认 1"与"`minRepeat` 默认 5"两处**纠正了红队**，并给出取代"n=20"的置信度反推式。**仍未获对立面确认的**：`minStratumRuns` 是否应作为安全轴的样本量载体。
- **新出现的 CONTESTED（D4 自陈的反向风险）**：D4 用置信度反推给出 n≈299（"违规率 <1% @95%"），但自陈在规格 §七 的规模（20–30 任务 × ≥3 次）下 **n≈299 可能根本达不到**，从而"安全指标可能永远 BLOCKED"——**这比 D3 的 n=20 更严苛**。→ 与"作废率能否事前计算"同列为**本轮未裁决**。
- **未裁决的冲突（CONTESTED）**：「作废率能否事前计算」（D5-H8 后半段 vs D1 主张 8）需要 **≥2 场独立 campaign 的作废 arm 计数及其 `failureCategory` 分布**才能裁决；本仓库当前只有 1 场（N7），故**本轮不可裁决**。已有的相关外推（"全新一场 main 零作废概率约 37%"）在原文档中已被标注为粗略参考。
