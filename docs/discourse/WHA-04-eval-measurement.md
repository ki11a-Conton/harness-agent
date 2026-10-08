# WHA-04 · 评测与测量视角：Harness Agent 必须具备什么

> 讨论者 **D4 / eval-measurement**；立场锁定**指标口径、样本量、可复现、回归门禁**。
> 输入：规格 §三/§六/§七；[SPEC-CONFORMANCE.md](../harness-engineering/SPEC-CONFORMANCE.md) §六 10 条未覆盖；[EVIDENCE-INDEX.md](../harness-engineering/EVIDENCE-INDEX.md)；
> 真实证据 [N7-RESULT](../evidence/agent-next7-20261006/N7-RESULT-20261007.md) + [N7-ERRATA](../evidence/agent-next7-20261006/N7-ERRATA-20261007.md)。
> 行号为写作时实测；**本视角 0 次付费调用，本文不含任何新数值。**
>
> 核心立场：**Harness Agent 必须把"每一个数字的口径"当一等公民交付物；不可测的部分必须显式 BLOCKED，而不是被 0 或"全绿"掩盖。**

## 主张清单

### M1（硬门槛）安全、循环防护、Trace 完整率必须是"一例否决"的 100% 门槛

- **主张**：指标 #7/#8/#9 门槛必须是 `failures === 0 && denominator > 0`，**不是** `value >= 1`；**且 100% 门槛必须声明分母与它支撑的置信水平**（见 M6）。
- **为什么**：`0/0` 与 `1/1` 都等于 1.0。门槛若写成比率比较，**零样本**的 strata 会以 100% 通过——最典型的"分母变零式放行"。
- **可观测判据**：`SPEC_HARD_GATE_THRESHOLDS` 三者设为 `1`；`thresholdGate`（`harness-conformance-gate.ts:292`）为 `threshold === 1 ? failures === 0 && denominator > 0 : observed >= threshold`；空样本 `:280 passed:false` + `:284` `detail:"INSUFFICIENT_SAMPLE (an untested risk is not a resolved risk)"`。验证侧同构：`task-verifier.ts:65/68`，空 specs → `level:0, passed:false`（D2 指出，我复核附议）。测试 `harness-conformance-gate.test.ts`（35 例）。
- **失败模式**：把 `INSUFFICIENT_SAMPLE` 读成 pass；"本轮没跑安全用例"被当成"没有违规"。
- **残余风险（经 D1 质疑后修正为可达事实）**：`minStratumRuns` **默认 1**（`harness-metrics.ts:889`）⇒ 只有**空 strata** 被标注，**n=1 也判 `MEASURED`** ⇒ 走到 `:292` 且 `denominator > 0` ⇒ **PASS**。**"用 1 个样本宣称 100%"在默认路径下真实可达**（处方见 M6）。

### M2（硬门槛）完成声明精度 ≥99% 与关键任务回归 = 0 必须是硬门槛；成功率只是"参考+分层"

- **主张**：能一票否决的是 **#6 假完成**、**#12 关键任务回归**、**#8 安全**；`taskSuccessRate >= 0.8` 在单次小样本下**不应**单独决定晋升。
- **为什么**：假完成是**方向性错误**（把失败报成成功，污染下游所有数字），回归是"改进的反证"；80% 成功率在 n=60（20 任务 ×3 次）时 95% 半宽约 **±10pp（正态近似估算，非原文数字）**，把 80% 当精确闸刀是**伪精确**。
- **可观测判据**：`harness-metrics.ts:1033/1060/1078/1088/1104` 分别累计 success/precision/loop/security/trace 分子分母；阈值在 `SPEC_HARD_GATE_THRESHOLDS`（`completionClaimPrecision: 0.99`、`criticalRegressions: 0`、`taskSuccessRate: 0.8`）。
- **失败模式**：把 80% 当硬门槛 → 团队为过线只加容易任务（**稀释分母**）。
- **最容易被伪造**：只上报加权总分（35/25/20/10/10），让安全维度的 20 分"抵掉"违规。已结构性防住：`harness-conformance-gate.ts:22-25` 声明 `verdict` 由硬门槛单独决定、加权分**不是**决策输入。

### M3（真实证据，必读）同一份数据，两种口径读出两个不同数字——口径必须写进报告，而不是靠读者猜

- **主张**：报告里的任何比率都必须**自带分母定义**，否则数字不可复算。
- **为什么**：这是本仓库已经发生过的真实事故，不是假想。
- **可观测判据（真实证据）**：N7 同一份数据，**255 个定案 pair 口径 143→145；含 partial 的完整 256 网格（ITT）口径 143→146**；`completionRatio=0.99609375`（255/256）。`N7-RESULT:50` 明确"原文把前者标成仅限 255 个定案 pair，标注有误，数值本身与 judge 输出一致"。
- **失败模式 / 最易伪造**：±1.17pp（ITT）与 ±0.78pp（定案）**均系据原文数字换算、非原文记载**，却被当成"候选改进/退步"的证据；或**挑选对自己有利的口径而不声明**。防法：口径是报告必填字段，切换口径须显式标注〔口径〕并保留旧数字。

### M4（真实证据）"计费对账"这类分母不可信的指标，必须拒绝出数而不是给一个近似值

- **主张**：当分子分母来自两个独立账本且不能证明同源时，正确做法是 `FAIL / 拒出数`，不是"取平均"或"取较大值"。
- **为什么**：9,169 vs 9,171 **不是舍入误差，是两个账本的口径差**。
- **可观测判据（真实证据）**：`N7-RESULT:47` `durable_budget_proven: FAIL` — `charged.usdMicros(9,169,000,000) < 9,171 × 1,000,000`（cost journal 9169 条 vs ledger 9171 次提交）。`N7-ERRATA` 第 3 条：该字段**对应 9169 份声明上界，不是实际账单**，历史请求 tape 缺失，最终归因待原件。
- **失败模式 / 最易伪造**：把 `chargedUsdMicros` 当账单，算出"每成功任务成本 = 9.169e9 / 146"写进报告；或只公布 token 之和（与 `costBudget.charged` 一致：43,148,183 / 1,066,263）而**隐瞒请求 tape 侧 +64,765 / +894 的差异**（全部集中在 2 个 arm，原因未定论）。

### M5（分母守卫）防止"分母偷偷变小"必须靠**外部清单**，不能靠被测的运行日志

- **主张**：覆盖率类指标的分母必须由**调用方声明的基准任务清单**给出；用"被观测到的任务数"当分母是可证伪的高估。
- **为什么**：被测系统自己决定"哪些任务被跑"，等于**被测者定义自己的考卷**。少跑的任务既不在分子也不在分母 → 覆盖率单调上升。
- **可观测判据**：`harness-metrics.ts:1134-1146` **逐字写明** `coverageDenominator = tasks.size`（"tasks observed"），`:1146` 空样本仅记 `"no tasks observed"`。`SPEC-CONFORMANCE.md` §六-8 自认"若基准集有 30 个任务只跑了 20 个，覆盖率会被**高估**"，并称"**这是本 PR 最需要评审关注的一条口径缺陷**"；`EVIDENCE-INDEX.md` §6 建议"需把基准任务清单传入（当前接口未含）"。**结论：`auto_verification_coverage >= 90%` 在修好分母前不具备门禁资格。**
- **失败模式**：删掉 10 个跑不通的任务 → 覆盖率从 83% 变 100%（分子可能一点没变）。
- **最容易被伪造**：只要**少跑**，无需篡改代码即可让指标变好——**唯一一条不需要撒谎就能伪造的指标**，故最危险。

### M6（小样本）样本不足时的唯一正确做法是"拒出数 + 标注区间 + 继续跑"，绝不补 0

- **主张**：三选一顺序：**先拒出数**（`value: null` + `INSUFFICIENT_SAMPLE`）→ **能给区间就给区间** → **要么继续跑到样本量达标**。禁止把缺失当 0 或当 100%。
- **为什么**：缺失被填 0 = 假阴性；缺失被当 100% = 假阳性。两者都会让门禁失去意义。
- **可观测判据**：`harness-metrics.ts:31-33`、`:54`、`:283`：缺数据 = `value:null` + `status:"INSUFFICIENT_SAMPLE"` + `excludedReason`；`:721/725` `denominator === 0 → null`；`:1167-1171` `belowStratumMinimum` 把**整个 strata 的每个指标**强制 `INSUFFICIENT_SAMPLE`；`:1183-1187` 重复组不足 `minRequired` 时计入 `excluded` **且**计入 `passAtK.notSatisfied`。门禁侧 `INSUFFICIENT_SAMPLE ⇒ BLOCKED`。**第三态（D3 反问，我接受并补）**：`NO_ATTACK_ATTEMPT` **不是缺数据**而是有效观测，**不得进分子**，故需 `OBSERVED_NO_EVENT`（观测到、无事件、不可作通过证据）。现成正例：`:1100-1112` 把"无事件轨迹"记为**真实 0**（注释 "is a REAL 0"）并**单独**累计 `traceLegacy`——照搬到安全侧即可。
- **失败模式 / 缺口**：用"1 次运行 + 全绿"填满 12 个指标表；把 `n=1` 写进报告但不写分母（表格每格都有数，**没有格子标明 n=1**）。`SPEC-CONFORMANCE.md` §六-6 承认**未实现置信区间**；`minStratumRuns` **默认 1**（`:382/889`）⇒ **默认配置下小样本标注永不触发**，比 D3 主张的 n≥20 更基础。

### M7（pass@1 / pass@k / pass^k）三者回答三个不同问题，混用等于换指标

- **主张**：**pass@1** = 单次尝试质量（成本/延迟的正常分母）；**pass@k** = 有**选择/重采样预算**时的可用性上限（"给 k 次能否拿到一个成功解"，**不回答"稳不稳"**）；**pass^k** = 无人在环时的可靠性（唯一匹配"自主 Agent"叙事的度量）。
- **为什么**：规格 §三 的 `pass@k=1-(1-p)^k`、`pass^k=p^k` 均**假设独立同分布**。真实 run **共享状态**（工作区、缓存、checkpoint、任务顺序）⇒ 重复运行**不独立**，公式会高估 pass@k、低估 pass^k 方差。规格 §三 自己也警告不应以公式代替实测。
- **可观测判据**：`harness-metrics.ts:1173-1192` 三口径**分离计算**：`passPowK` 要求 `every(passed)`，`passAtK` 要求 `some(passed)`，不足 k 次的组 `excluded += 1`（**且**计入 `passAtK.notSatisfied`）。`minRepeat` 默认 = `k` = **5**（`:887-888`）。
- **失败模式**：**用 pass@k 报告稳定性**；或把不同难度任务混池算一个 pass^k（规格 §三 note 1 禁止）。
- **降级说明（D1 质疑后我接受）**：仓库与 N7 的 13 条门限里**都没有 pass@k 门限**，故"该报哪两个数"**不改变任何判定**——本条降为**报告可复算性主张**：必须声明 **`k`** 与 **k 次之间是否重置工作区**，否则不可复算。

### M8（A/B 可比性）不固定这些量，A/B 数字不可比，报告应直接拒答

- **主张**：必须固定的最小集合 = **模型 id（精确版本）+ 任务集与版本 + 任务顺序 + 每任务重复次数 k + 工具权限 + 预算上限 + 环境/依赖版本 + 评测脚本 + 配置哈希 + git sha**；此外**必须显式声明 ITT 还是 PP**（见 M3）。
- **为什么**：只要分母或排除规则在两侧不同，差异就可能是口径造成的。N7 的教训正是如此：**1 个作废 arm 就让整场不可推断**（"256 个 pair 里任意 1 个 arm 作废即整场不可推断"，`N7-RESULT` 第 60 行）。
- **可观测判据**：`SPEC_REQUIRED_RUN_RECORD_FIELDS`（`harness-conformance-gate.ts:65-87`，21 字段，含 `model_id`/`harness_git_sha`/`config_hash`/`environment_id`/`seed`/`verification.*`）是**受测契约**；`:121-123` 明确"未声明则不予比较（**沉默是缺口，不是通过**）"；既有 `paired-executor.ts` 的 `buildExecutionIdentityV1`。**仓库已有正例（D5 补）**：`apps/cli/src/config-command.ts:52` 的 `resolvedConfigDigest` 注释明写身份来自"ACTUAL resolved arm config — **never from docs state**"；`release-verify.ts:190-198`（`INV-P36-007`：不同 SHA 的 stale 证据永不可采信）。
- **失败模式**：候选用了更便宜的模型 / 更多重试预算 / 更宽松的权限，然后报"成功率 +5pp"。
- **最容易被伪造**：**不记录**环境与预算（恰恰是两侧最容易不同的量）。缺口：`SPEC-CONFORMANCE.md` §六-5 承认规格 JSON 与既有产物**逐字段映射未建立**；§六-9 的 `load-runs.ts:43` `events: []` 会让 `trace_completeness` 恒 0——**用现有 artifact 直接喂门禁会得到全 BLOCKED 的假象**。

### M9（回归=0 的坏指标化）"回归数为 0"会从护栏变成刹车

- **主张**："关键任务回归 = 0"只在**关键任务集冻结且被评判**时是好门槛；一旦扩展为"任何历史通过任务都不许回归"，它就开始**阻止改进**。
- **为什么**（三种具体机制）：① **交叉修复**——修 A 任务会破坏 B 任务，历史通过集越大越必然；② **改善即破坏**——收紧安全策略/降低 token 预算会"故意"让原先通过的宽松用例失败；③ **橡皮图章**——为保 0 回归，最省事的做法是把历史通过集**改小**（回到 M5 的分母问题）。
- **可观测判据**：`harness-metrics.ts:1148-1165` 把回归做成**任务级比率**（一任务**任意一次**运行失败即算该任务回归），且**关键任务回归只在该 stratum 真评估过它时才计数**（`:1162 if (allPassed === undefined) continue;`）——注释明确"未被评估的关键任务是门禁**单独暴露的缺口，绝不是静默通过**"。门禁 `:374-375`：`requireRegressionZero=false` 时也不给 pass，而是"声明关闭 ≠ 通过"。
- **失败模式 / 最易伪造**：为保 0 回归而**不敢改任何共享代码**，只加新分支 → 技术债；或删测试/删任务"达成"0；或只统计"本轮真的跑过的"历史任务（分母变小时回归天然为 0）。
- **D5 的反驳与我的裁定**：D5 主张机制③ 只是 M5 的特例、应合并。**我部分接受**：③ 与 M5 **同源**，但**污染对象不同**——M5 让**读数**变假（高估覆盖率），③ 让**决策**变假（回归 0 ⇒ 门禁放行）。故保留为 M9 机制但**标注"系 M5 在回归维度上的实例"**。D5 的"成本-回归联合门槛"我**改口径**：成本与通过率在 `$/passed task` 下是同一分数的两面，应写成"**通过率不下降前提下**的边际成本"，不与回归数做联合判定（否则不同起点的版本被同一个 X% 误杀）。

### M10（披露义务）报告必须披露六件事，缺一件即视为不可复算

- **主张（⑥ 项经 D1 补，我接受）**：必填 **① 分母（含口径 ITT/PP）② 样本量（run/任务/重复组数）③ 排除项与理由 ④ 失败分类 ⑤ 环境身份（git sha、config hash、环境 id、`promotionEligible`）⑥ 该 run 是否含 resume，以及 resume 是否继承全部预算维度**。
- **为什么**：没有 ③ 无法区分"没跑"与"跑了通过"；没有 ④ 只看到"成功率下降"而不知是模型/Harness/工具/环境错；没有 ⑤ 无法复跑。
- **⑥ 的实测依据**：`run-budget.ts:105-119` `seedConsumed()` 的 `Pick<>` 仅 6 键（turns/toolCalls/outputChars/retries/subagents/cost），**不含 `inputTokens`/`outputTokens`**；`snapshot()`（`:83-96`）不返回 token。→ **发生过 resume 的 run，token/成本分母偏小**，污染 #10 与 `tokens_within_110pct` 类门限。判据：`resume.test.ts:330-424` 只断言 `usedToolCalls >= 1`，**无 token 断言**。
- **可观测判据**：`SpecMetricSample` 带 `numerator`/`denominator`/`sampleSize`/`status`/`excludedReasons`（`harness-metrics.ts:269-292`）；`SpecStratum` 带 `runs`/`tasks`/`evidenceCompleteRuns`/`repeatGroups`（`:233-258`、`:1194-1210`）；失败分类见 `attribution.ts` + `contracts/src/termination.ts`；环境资格 `insecure-local ⇒ promotionEligible=false`（`N7-RESULT:102`）。
- **失败模式 / 最易伪造**：报 84.6% 而不说分母是 26 还是 256；把排除项写成一句"排除了异常运行"——**异常的定义权在作者手里**。防法：排除逐条给 id + 理由（抄 N7：255 finalized / 1 partial / 0 absent 逐项列出）。
### M11（诚实性）**"不可测"必须是一等公民输出**，并且要能证明门禁真的会红

- **主张**：一个只会在数据齐全时说话的门禁是**未经验证**的；必须存在"让它变红"的变异证据。
- **为什么**：永远绿的门禁 = 没有门禁。这与"分母问题"是同一类病：**看起来有覆盖，实际没覆盖**。
- **可观测判据**：`EVIDENCE-INDEX.md` §4 记录 10 组**变异验证**（关掉 priorBlocks 注入丢弃 / 失败 gate 阻断 / 沙箱文件包含 / capability 越权检测等 → 对应用例变红），并核实无 `*.mutbak`、无 `if (false)` 残留、`git diff` 为空。**但缺反向变异**：我逐条核对 §4 的 7 组安全变异，**确无**"把 `escapedPaths` 从成功副作用改回请求路径派生"这条（D3 问，我确认）——**本仓库缺失，明说没有**。
- **失败模式 / 最易伪造**：断言太弱（只断言"没抛异常"），覆盖好看但零鉴别力；声称做过变异验证却**不留下副本与还原证据**。防法：变异清单 + 还原后 `git diff` 为空必须可复跑。

---

## 我认为被高估的三件事

1. **被高估：加权总分（35/25/20/10/10）**。它是**排序工具**，不是上线条件；规格 §六 自己说"绝不能用加权总分替代安全上线条件"。本 PR 把加权分做成 `verdict` 的**非输入**（`harness-conformance-gate.ts` 第 22-25、208 行"§六 weighted score — SUPPLEMENTARY. Never an input to verdict"）是对的，但**讨论中仍有人拿"总分提高"当改进证据**——硬门槛未过时总分毫无信息量。

2. **被高估：`auto_verification_coverage` 的 90% 目标，以及一切"覆盖率"指标**。分母是"被观测到的任务数"时它**能靠少跑任务单调上升**，且这是**本 PR 自认的最需评审缺陷**（`SPEC-CONFORMANCE.md` §六-8）。同理"测试覆盖率""Trace 完整率"在分母可信前都不该进门禁——**一个能被被测者扩缩的分母，测的从来不是被测者**。

3. **被高估：pass@k 作为"能力"证据**。k 次里中一次，在有重试预算时只是**预算的度量**，却最常被拿来替代 pass^k 讲"稳定性"。规格公式假设 i.i.d.，而真实重复运行共享工作区与 checkpoint，**公式与实测都不该混用**（本仓库与 N7 的 13 条门限里都没有 pass@k 门限，故这条是口径/可复算性主张，不是门禁建议）。

---

## 本条视角下本仓库的真实缺口（不粉饰）

| 缺口 | 状态 | 后果 |
| --- | --- | --- |
| 置信区间 | `SPEC-CONFORMANCE.md` §六-6：**未实现**，只做样本量披露 + `INSUFFICIENT_SAMPLE` 阻断 | 只能"拒出数"，不能给"±多少"；小样本比较只能定性 |
| `auto_verification_coverage` 分母 | §六-8 自认高估风险，接口未含基准清单 | **该指标当前不应作硬门槛** |
| `load-runs.ts:43` `events: []` | §六-9 用法断层 | 直接喂 artifact ⇒ `trace_completeness` 恒 0、验证状态恒 `null`（**假 BLOCKED**） |
| `percentile()` 双约定 | `scorecard.ts:56` 空数组返回 `0`（呈现"0ms 延迟"）vs 本 PR `percentileOrNull` 返回 `null`（§六-10） | 混用产生假象；**"披露分母"也应覆盖"空样本"** |
| #4/#7/#8 的 ground truth | §六-7：依赖调用方注入 `facts.expect*`，case ABI 无法表达 | **未标注的真实评测一律 BLOCKED**（刻意 fail-closed）；`SPEC-CONFORMANCE` 记录曾尝试用事件轨迹自动判定 #4 并**否决**（"只能证明恢复被尝试过"，会把未完成的恢复计成成功） |
| 真实数值 | §六-1：本 PR **0 次付费调用**，12 指标**全部无真实数值**，仍 `NOT_PROVEN` | 本文所有主张都是**口径主张，不是效果结论** |

> **可判真假的承诺**：本分支评测报告里任何一个比率若**无分母、无样本量、无排除理由、无 ITT/PP 口径声明**，该报告**不可复算**，应**拒绝作为晋升证据**——无论那个数字多好看。
