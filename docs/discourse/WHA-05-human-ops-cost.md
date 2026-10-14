# WHA-05 讨论稿 — 人类协作、成本与可运维性（D5）

> 视角：Human-in-the-loop / Cost / Operability。本文只写这一面，不重复 D1–D4 的运行时、验证、安全、评测主张。
> 纪律：0 网络、0 付费调用；每条主张给出**可观测判据**与**本仓库对应实现**；没有实现的地方**明说没有**。

## 0. 先点出规格的缺口（这是本视角的立论依据）

规格 v1.0 全文 216 行，**没有任何一节**专讲人类协作/升级/可解释性/长期维护：§二 的 10 项能力里没有"人机接口"，§三 的 12 个指标里没有"人工介入成本"，§六 评分卡 10% 的"成本和延迟"只算美元与毫秒，不算**人的时间**。唯一的"升级"出现在 §四 流程图末端的 `L[Failed / Escalated with Evidence]`——一个框，没有指标、没有 SLA、没有判据。

原文写的是"失败可恢复、过程可追踪、行为可控制"，但**"谁来看、多久看一次、看到什么才决定继续"是空的**。本视角的主张就是把这个空格填成可判假的东西。

---

## 1. 主张清单

### H1 — 长跑必须有一个"人只读"的活性摘要，且它的字段是固定的

- **主张**：一次 7 小时运行中，人类判断"它还活着、值得继续烧钱"**不需要**看推理文本，只需要 6 个数：`turn_count`、`tool_call_count`、`model_call_count`、`verification_failures`、`usage_unknown`，加上"最近一次状态变化的时间戳"；成本数**必须带口径标签才可入列**（见下）。
- **为什么**：N7 跑了 7.1 小时、9,171 次调用、512 arms，人类能事后复盘的只有这些聚合量；推理文本在 44.2M token 规模下不可能被人读。**可读的是不变量，不是叙事。**
- **怎么验证**：`packages/observability/src/metrics.ts` 的 `computeMetrics()` 已经产出上述全部字段（含 P20-1 的 `usage_unknown`/`model_call_count`/`cache_tokens_*`），且存在 `metrics.test.ts` 与 `trace-exporter.test.ts:320` 的 `human_interventions` 断言。**判据**：给定任意 run 的事件流，`computeMetrics` 的输出即可回答 H1 的 5 个问题，无需读 transcript。
- **[D1 反驳采纳] 我原先把 `estimated_cost` 列入这 6 个数，这是错的，且违反我自己的 H5。** D1 指出：`run-budget.ts:74-79` 的 `onModelUsage(inputTokens, outputTokens, costUsd)` 累加的是**调用方传入的** `costUsd`（我复核确认：`:77` `this.estimatedCostUsd += costUsd;`），而 `metrics.ts` 的 `computeCost()` 在 payload 无显式 cost 时**套默认费率估算**。同一个字段名承载两种语义，而 N7 的 `usdMicros` 是**声明上界**。→ 已在 H1 中删除裸 `estimated_cost`，改为 `estimated_cost(caveat: 声明上界/估算/账单 三选一)`。**这是一处自我矛盾，由他人复核发现，我原样记录。**
- **失败模式**：摘要里出现 0。`metrics.ts:5-8` 明说"stream 无法表达的值是 0"——**"0 次验证失败"与"验证根本没跑"在输出上同形**。N7 §4 D2 正是这个形状：metrics 少记 1 次调用的 usage，人看不出缺少。
- **最容易被伪造的方式**：只看 `estimated_cost` 与 `duration_ms` 就宣布"健康"。这两个数在僵死运行中照样增长（成本按 token 累积、时长按墙钟累积），**它们是花费的度量，不是进展的度量**。

### H2 — 人类介入必须被当作指标测，而不是被当作 penalty 里的常数

- **主张**："每次通过任务需要人类介入几次"必须是**一等的成本指标**；当前仓库把它算作可靠性扣分，但**从不真正采集**。
- **为什么**：`packages/evaluation/src/cost-model.ts:161` 有 `reliability -= metrics.human_interventions * RELIABILITY_HUMAN_PENALTY`，`baseline.ts:954` 有 `total_human_interventions` 汇总，`contracts/src/skill.ts:89` 也有该字段——链路齐全，但 `paired-executor.ts:193` 的 `emptyRunMetrics()` 把它硬编码为 **0**（`human_interventions: 0`），全仓 100+ 处 metrics 字面量同样是 0。**即：真实评测里这个指标恒为 0，penalty 永不触发。**
- **怎么验证**：`grep human_interventions packages/evaluation/src/paired-executor.ts` → `:193` 为 0；`load-runs.ts:59` 用 `?? 0` 兜底。**判据（静态推断，未运行时验证）**：跑一次带人类审批的 run，`baseline` 汇总的 `total_human_interventions` 应 >0；**按当前代码应得到 0**。⚠️ **诚实标注：这条判据我没有执行**——本视角 0 付费调用、且跑一次"带人类审批的 run"需要真实 provider。已执行的只是**静态检索**（见下条本机复核）。我把"应收 0"写成推断，不写成观测。
- **失败模式**：把 0 读成"这 Agent 完全不需要人"。**分母缺失被当成优秀表现。** 这与 SPEC-CONFORMANCE §六 的口径纪律（缺数据 → `INSUFFICIENT_SAMPLE`，不得当 0）**直接冲突**：本仓库在规格指标层守住了这条，在人类成本层没守住。——**D2 的反驳成立且我采纳**：这不只是"缺指标"，而是**"缺字段的默认值伪造了证据"**——`0` 与"真的从未需要人"在输出上同形。因此 H2 的准确表述是：**仓库做了一半，并在人类成本层违反了自家已写明的口径纪律**。
- **最容易被伪造的方式**：把"人类没被叫醒"宣传成自治度。审批阈值放宽、超时自动 `expired` 放行，都能让这个数保持 0。
- **本机复核（D5 自测，非转述）**：`Select-String -Path packages\evaluation\src\paired-executor.ts -Pattern human_interventions` 只有 `:193` 一处，值 `0`；在全仓 `packages/**/src/*.ts` 与 `apps/**/src/*.ts` 中检索 `human_interventions:\s*[1-9]`，**除 `*.test.ts` 外零命中**。→ 非测试代码里这个字段**从未被写过非零值**。

### H3 — 必须停下来问人的只有三类；其余全是噪音

- **主张**：只有三类事件值得打断人类：(a) **不可逆/越界副作用**（写工作区外、删数据、外网、装依赖）；(b) **预算将要耗尽**（时间/调用/美元接近硬上限）；(c) **同一失败重复到上限且分类为不可自愈**。此外一切——工具报错、重试、压缩、单个测试失败——**绝不能问**。
- **为什么**：7 小时里 N7 有 15,420/32,000 次工具调用、208 个 arm 打满 30 次调用上限。若每次重试都问人，人类变成了重试循环的一部分，`human_interventions` 会淹没信号。**提问带宽是长跑中最稀缺的资源。**
- **怎么验证**：(a) 已有 `packages/security/src/approval.ts`——`StoreApprovalResolver.createApprovalRequest()` 带 `action`/`target`/`reason`/`policyRule`，`ApprovalScope` 默认 `"one_call"`，**不是"永久允许"**；`DurableApprovalStore` 原子写 + 重启后 `listPending()` 可重新浮出。(b) 预算门限见 `packages/core/src/runtime/run-budget.ts`。(c) 见 `packages/contracts/src/recovery.ts:177`"无法自愈的才 escalate to the user"。
  **[D1 反驳采纳] 判据改形**：我原文写"审批请求数应等于不可逆动作数"——**D1 指出这不可判**（策略引擎的请求 vs 工具语义 `sideEffectScope` 没有共同 ground truth），我接受。改为**可在事件流上判定的形式**：*每个 `sideEffectScope != "none"` 且未被策略预先 allow 的调用，必须存在一条同 `toolCallId` 的审批记录，或一条明确的 `security.permission_denied`*。不需要外部真值。
- **失败模式**：把审批做成**一次性大授权**（`scope` 被写成 session 级），人类点一次"同意"后 7 小时内再无卡点。这恰好让 N7 的越界写（D3：`C:\tmp\chunk-test.js`）类事件失去人工拦截机会。
- **最容易被伪造的方式**：用 `expiresAt` 到期自动放行（`approval.ts:42` 把过期 allow 降级为 `"expired"`，这是**正确的 fail-closed**）——但如果宿主把 `expired` 当作"用户没反对"来执行，就伪造了合规。**判据：`expired` 必须等价于 deny。**

### H4 — 成本口径必须是"每个通过任务"，并且必须同时给出两个数

- **主张**：决策口径是**每个通过验收任务的成本**（`$/passed task`）；"每次尝试"只作为优化过程的诊断量。只报其一即误导。
- **为什么**：`10` 项指标里 #10 写的就是"每个通过验收任务的平均 token 消耗及货币成本"，注释 4 也说"建议统计每成功任务的总成本"。N7 的数字正好证明为什么：9,169,000,000 µ$（= 9,169 声明上界）分配到 143 或 146 个通过 pair 上，**分母一变（143 vs 146）单位成本就变**；而 N7 里"假完成"高达 **112/256（43.8%）** 与 **107/256（41.8%）**——若把这些未验证的"完成"计入分母，单位成本会被**系统性低估一倍左右**。
- **怎么验证**：`packages/evaluation/src/harness-metrics.ts`（`computeSpecMetrics`）已实现规格 #10 口径，`SPEC-CONFORMANCE.md` §二 #10 标 `ADDED_IN_THIS_PR`；`scorecard.ts` 提供 `avgInputTokens`/`avgOutputTokens`/`avgToolCalls`、`latencyP50Ms`/`latencyP95Ms`。**判据**：同一 run 报告里 `$ / attempt` 与 `$ / verified pass` 必须同时出现，且后者分母**仅含独立验收通过者**。
- **失败模式**：用"每次尝试"报价做预算承诺 → 通过率下降时真实成本失控。N7 的 arm 上限 `maxModelCallsPerRun=30` + 0.83 分钟/arm，说明单位成本与调用上限强耦合，而**通过率与调用数无关**。
- **最容易被伪造的方式**：把分母换成"完成的 run 数"或"报告的完成数"。N7 的 112/256 假完成就是这条路。

### H5 — "声明上界 ≠ 账单"必须作为一等标签，出现在决策界面上

- **主张**：任何成本数字都必须携带**口径标签**（declared ceiling / reconciled billing / estimated）；缺标签的成本数不得进入晋升或停止决策。N7 的 `usdMicros=9,169,000,000` 是**预留上界**，不是账单。
- **为什么**：N7 §3 的 `durable_budget_proven` 门限**FAIL 有两条独立原因**，其一是 `9,169,000,000 < 9,171 × 1,000,000`（cost journal 9,169 条预留 vs ledger 9,171 次提交，差 2 次）。**同一场运行，两个成本数不相等，且都不是账单**。若把 9,169 当作"已花 9,169 美元"来评估性价比，结论方向都可能反。
- **怎么验证**：`metrics.ts:117-137` 的 `computeCost()`：显式 `payload.usage.cost` 优先，**否则套用 `DEFAULT_COST_PER_INPUT_TOKEN=2/1e6`、`DEFAULT_COST_PER_OUTPUT_TOKEN=8/1e6` 的默认费率估算**。这是一个**可被分辨的近似**，但它目前与显式成本**返回值同形**（都是 `number`）。**判据**：成本必须带 provenance 字段；`usage_unknown`（P20-1：`usage.source==="unknown"` 计数，注释明写"unknown usage 绝不能被误读为免费"）是同一个问题的**已解决先例**，成本应采用同样的 provenance 形态。
- **失败模式**：把上界当账单 → 高估成本而砍掉有效实验；或把估算当账单 → 低估成本而超支。N7 的 `tokens_within_110pct` 门限 FAIL（+14.7%）说明 token 侧同样需要口径纪律。
- **最容易被伪造的方式**：只贴一个大数字，不贴单位与来源。`9,169,000,000 µ$` 与 `$9,169` 是同一个数，**放大 1e6 倍后极容易被误读成"花了 91 亿"**。

### H6 — 可解释性的够用粒度：能回答"哪一步、依据什么证据、为什么停"

- **主张**：够用的粒度是**事件级、可结构化复算**，不是自然语言总结。`agent explain` 的字段集就是答案的形状：目标、当前计划、上下文来源、工具语义、权限结果、恢复原因、验证证据、终止原因。
- **为什么**：`apps/cli/src/explain-command.ts:5-9` 明确只从**可观测的 event/state 证据**重建答案并"Never outputs hidden reasoning"。`--tree` 分支（`:99-110`）输出 `why not complete: <terminationReason> (grade <grade>)`。**人类要的是"为什么停"，不是"模型怎么想"。** 这条与规格 §五-3"不得输出已完成，须提供实际失败证据"是同一件事的两面。
- **怎么验证**：`explainCmd` 对无事件 session 返回 `exitCode 1`（`:25-27`），对正常 session 输出上述字段。**判据**：给定 run_id，`agent explain <sessionId> --tree` 应能指出终止原因与最后一次验证结果，**且不包含 CoT 文本**。
- **失败模式**：解释退化为摘要重述——把 transcript 尾部贴回来当解释。`explain` 依赖具体事件类型（`turn.started`/`tool.completed`/`verification.step_completed`/`security.permission_denied`）；**这些事件缺失时它会安静地少打印几行**（如 `active plan: none recorded`、`tool calls: none executed`），读者无法区分"没有"和"没记录"。
- **最容易被伪造的方式**：EVIDENCE-INDEX §5 的 **DEFECT-1** 就是现成反例——`tool-call-controller.ts:747-757` 的 `recovery.decided` 在 `retryPolicy !== "safe"` 判断**之前**发出，把"拒绝重试"映射成 `action:"retry_safe"`/`"…retrying"`。**trace 会撒谎**：从事件流无法区分"真重试了"和"被拒绝重试"。本仓库选择**只记录不修**，用 `[C2-1]/[C2-3]` 把当前行为 pin 住。**D5 已读原文复核**：`tool-call-controller.ts:747-748` 发出 `action: decision.action === "retry" ? "retry_safe" : …`，而 `:757` 才 `if (retryPolicy !== "safe") break;` —— 事件在闸门**之前**发出，确认无误。→ **可解释性有已入库的已知假阳性来源，任何"看 trace 就懂了"的声明都必须先排除这条。**

### H7 — 失败交接必须是"三件套"：可复现命令、证据包、回滚点

- **主张**：人类接手前必须拿到 (1) **可复现命令**（含记录的 sourceSha、锁文件、预算上限）；(2) **证据包**（原件而非摘要）；(3) **回滚点**（checkpoint id + 已执行副作用清单）。缺任一件，接手成本就从"分钟"跳到"考古"。
- **为什么**：N7 给了**完整的反面教材**：归档只有 9,699–9,701 条原件的**索引（约 460 MB 摘要）**，原件留在本机 scratch（约 460 MB 本体）——§6 明写"第三方仅凭本归档**无法**独立复算历史 tape"。**D5** 进一步：`facts` 是执行身份一部分，并行分支加一个 `armDigestFormat` 字段就导致 `EXPERIMENT_BINDING_DRIFT`，**旧归档在当前 HEAD 上无法原地复算**，严格复算必须回到 `sourceSha=7203a01b`。**D4** 更直接：复算入口 `verify-n7-archive.mjs` 有语法错误、**从未被执行过**——验收记录里声明的校验步骤实际不存在。
- **怎么验证**：(3) 已有 `packages/checkpoint/src/checkpoint-store.ts`（写前校验、回读校验、latest 指针不被污染）+ `apps/cli/src/recover-command.ts`——`recoverListCmd` 扫描未完成 session/待审批/待 ask/孤儿 session/未完成 checkpoint，且注释明写 **"NEVER executes side effects; recovery is the human's call"**（`:9-12`），有未完成 session 时 `exitCode=1`（`:99`）。(1)(2) 见 N7 的 `--historical-source` 与 ERRATA 的"新归档保存完整 gzip 原件"。**判据**：交付包应在**与运行环境无关的机器上**、0 付费调用地复算出同一判定；N7 当前对本机 scratch 有硬依赖 → 未满足。
- **失败模式**：证据包只有摘要 + 一个从未跑通的校验脚本（D4 的形状）。人类以为有复现路径，实际上第一次执行就 `SyntaxError`。
- **最容易被伪造的方式**：在验收清单里写下"归档校验已完成"却没有任何脚本引用它——N7 §4 D4 的原话是"全仓**没有任何**测试或其他脚本引用该入口"。

### H8 — "跑得越久越难停"必须用**预先声明的停止条件**治，不能用意志力治

- **主张**：停止条件必须在**看到任何效果数字之前**冻结，且必须包含"不作废才可推断"的完整性要求；否则运行时间本身成为继续投入的理由（沉没成本）。
- **为什么**：N7 是这条的**教科书案例**。冻结纪律执行得很好（§7：门限/用例/臂/repeat/seed/provider/预算上限**均未因结果改动**；两项修订发生在**看到效果数字之前**，"未把 255/256 当作 256 使用"、"未对作废 pair 做后验修补"），但结果仍然是：**256 个 pair 里任意 1 个 arm 作废即整场不可推断**，7.1 小时与 9,171 次调用换回 `NOT_PROVEN`。**问题不在纪律，在于停止条件没有把"作废概率"变成可提前计算的量。**
- **怎么验证**：`apps/cli/src/release-command.ts` 的 `resolveReleaseVerdict()`/`computeReleaseVerdict()` 实现了 `release-verify.ts:190-198` 的 **"INV-P36-007：stale evidence（不同 SHA）永不可采信"**，`:166` 明写"Any failed/not_run/blocked/stale gate → not ready"。**判据**：同上纪律应扩展到长跑：预算消耗到 X%、或作废单元 ≥1 时，**自动产出"是否继续"的决策点**，而不是等人想起来看。
- **失败模式**：`--resume` 被当作"继续投入"的正当理由。N7 §4 D1 已证伪这条退路：executor 对已进 journal 的 arm 一律跳过、不看 `valid`（`paired-executor.ts:565-575`），`3ba8b5c0…-baseline.json` 的 `valid=false` **已固化**——而"删除 journal 条目重跑"被明确判定为**销毁证据与按结果挑样本**。**即：一旦作废，7 小时的沉没成本不可挽回，且正确的做法就是承认它不可推断。**
- **最容易被伪造的方式**：事后调整预算时长/容量并声称"发生在看到效果数字之前"。N7 靠 `BUDGET-AMENDMENT.md` 的时间证据把这条守住了；**没有该文件的项目无法自证。**

### H9 — 长期维护要有明确 owner 与"漂移检测"，不能靠延期

- **主张**：三类漂移必须各有**可自动发现**的检测手段：依赖升级、门禁漂移、证据过期。当前仓库对三者**都不是空白**，但也**都没有指定责任人与周期**——这是真实缺口。
- **为什么与证据**：
  - **证据过期**：`release-verify.ts:190-198` 已实现 stale 拒绝，`readGateEvidence()` 注释（`release-command.ts:56-58`）明确"A stale or malformed secondary platform must NOT be hidden by a valid first instance"。**这条已经做好了**，是仓库最强的一环。
  - **门禁漂移**：`packages/harness/src/config-drift.ts` / `config-drift-matrix.test.ts` 覆盖配置漂移分级；`apps/cli/src/config-command.ts:24` 输出 config fingerprint，`:52` 的 `configEffectiveCmd` 明写身份"computed from the ACTUAL resolved arm config (E2-08) — never from docs state"。**即"配置身份来自实际构造，不来自文档"已是既有纪律。**
  - **依赖升级**：N7 §4 D5 是**真实事故**——并行提交 `b39cb1c9` 给 `facts` 加了一个格式标记字段，就使旧归档报 `EXPERIMENT_BINDING_DRIFT`；`planDigest`/`candidates`/`armDigests`/`runtimeConfigHashes`/`caseFingerprints` **全部逐字节未变**。**"记录的事实"与"当前代码重算的事实"是两个东西，且没有任何自动检测把它们的分离变成告警。**
- **怎么验证**：**判据**：(1) 仓库应有一个可执行入口，能对**已发布归档**静默检测 `EXPERIMENT_BINDING_DRIFT`（当前需要人工在特定 SHA 上跑 `--historical-source`）；(2) `docs/evidence/**` 应有 `superseded_by`/`valid_until`/`depends_on_sha` 之类的过期元数据——**当前没有**（ERRATA 只能靠"原字节保留 + 就地标注〔勘误〕"的人工纪律，这很好，但**不可自动检测**）。
- **失败模式**：证据"永久有效"的假设。N7 D5 已证明**任何提交都会改变 `sourceSnapshot().sourceSha`，使既有 binding 失效**。→ **证据的半衰期等于下一次提交。**
- **最容易被伪造的方式**：用"我们记录了勘误"代替"我们能自动发现过期"。N7 的勘误文档质量很高（保留原文、就地标注、另附独立复核），但**发现它需要人来写**——`N7-ERRATA-20261007.md` 的第一句话就是"对应原始 N7-RESULT"，对应关系是人写的，不是查出来的。

---

## 2. 我认为被高估的三件事

1. **"Trace 完整率 100%"被高估。**
   规格把它当硬门槛，但**完整 ≠ 正确**。EVIDENCE-INDEX §5 的 **DEFECT-1** 是现成的反例：`recovery.decided` 事件**确实被发出了**（完整率算它满分），内容却是把"拒绝重试"写成 `retry_safe`/`"…retrying"`。**一个 100% 完整但会撒谎的 trace，比一个诚实缺失的 trace 更危险**，因为前者让人停止怀疑。完整率必须配一个"事件宣称的行为 vs 实际执行行为"的一致性检查，否则是**测量覆盖率而非测量真相**。

2. **"加权评分卡"中的成本维度（10%）被高估。**
   10% 的权重意味着一个 10 倍成本劣化可以被 ~10% 的质量提升买平。但在 H4 的口径下（分母=通过任务），成本与通过率是**同一个分数的两个方面**，不该是独立维度。更实际的问题：规格 §六 的权重**没有任何人工时间项**，而 H2 已证明仓库里 `human_interventions` 恒为 0——**一个权重 10%、且分子恒为 0 的维度，等于没有这个维度。**

3. **"能自动恢复"被高估，尤其是在人类不在场的长跑里。**
   规格 §四 让 `Recovery & Adaptation` 是 P1（而非 P0），这暗示"少恢复也能跑"。但 N7 的算术相反：**7.1 小时里 1 个作废 arm 就让 512 arms 全部不可推断**。恢复能力的**真实价值不在于救回单个失败，而在于不让单个失败毁掉整批测量的可比性**。恢复做不好，前面所有指标（成功率、pass^k、成本）都只是**在不可推断的样本上算出来的描述性数字**——N7 §3 那些 143→146 的数字正是如此，文档自己标注"均不构成推断"。

---

## 3. 一句话结论

规格把 Agent 当作**被测对象**来量，本视角要求把它当作**要长期与人共处、要烧真钱、要被人接手**的系统来量。当前仓库在这三面**各有真实强项**（`DurableApprovalStore` 的持久化审批与 append-only 审计、`recover list` 的"绝不产生副作用、恢复是人的决定"、`release verify` 的 stale 证据拒收），但**最薄弱的一环是 H2**：人类成本在指标里恒为 0，导致"自治度"无法被证伪。**没有这一项，"它还活着、值得继续烧钱"就永远只能靠人的直觉回答，而 N7 用 7.1 小时和 9,171 次调用证明了直觉在这个尺度上不够用。**
