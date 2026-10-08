# WHA-06 红队报告（执行者：D1 `runtime-lifecycle`，Lead 指派）

> 撰写者：**D1（runtime-lifecycle）**，非独立红队成员。
> 攻击对象：`WHA-02`(D2)、`WHA-03`(D3)、`WHA-04`(D4)、`WHA-05`(D5) 及其 rebuttal。
> 我的 `WHA-01` 由 **Lead 亲自攻击**，故本文**不自评**（Round 1 的自我攻击留在 `WHA-01-*-rebuttal.md` §5）。
> 指派原因：本会话团队成员上限 8，独立红队 `red-team-skeptic` **无法创建**（D3/D5 均如实上报投递失败，我本人 `send_message` 返回 `active teammate "red-team-skeptic" not found`）。
> **视角偏置声明（必读）**：我锁定 Runtime / Lifecycle / Budget / Recovery。对"样本量口径"（D4）、"验收真值来源"（D2）、"人类成本"（D5）**我无归属权**，涉及时只给机制判据、不争夺口径定义权；凡涉我写域（`packages/core/src/runtime/*`、`packages/checkpoint/*`、`packages/contracts/src/limits.ts`）的行号，我已回读原文。
> **证据强度自我限定**：全文行号均为**静态读代码**所得，**未执行任何测试**。凡引 `[C*-*]`、变异验证、`vitest` 结果者，一律**转引** `EVIDENCE-INDEX.md`，并标注。

## §1 不可判据清单（5 条；每条给出可判据改写）

| # | 出处 | 原文片段 | 为何不可判 | 可判据改写 |
|---|---|---|---|---|
| 1.1 | D5 H9 | "长期维护要有明确 owner 与'漂移检测'" | **"有 owner"没有任何可观测判据**——无法从任何事件/文件/计数证明"某人负责"。D5 自己在 `WHA-05-*-rebuttal.md` §6.2 承认"这是本清单里最软的一条" | 删掉 owner 子句；只保留可判的一半：**存在一个可执行入口，对已发布归档静默检测 `EXPERIMENT_BINDING_DRIFT`**（当前需人工在特定 SHA 上跑 `--historical-source`，即缺口成立） |
| 1.2 | D4 M2 | "n=20、每任务 3 次 = 60 run 时的 95% 区间宽度约 ±12pp" | 未标"估算"，且 `±12pp` **依赖未声明的方法**（Wald / Wilson / bootstrap 三者数值不同）；D2 已实测 `N7-RESULT` 全文无该数 | 标"估算 + 方法名"；或降为可判形式："当样本量不足时门禁对 `taskSuccessRate` 只给 `INSUFFICIENT_SAMPLE`，不给 PASS" |
| 1.3 | D2 S2 | "`expectation` 为**空**时（`:125` 的两个标志都为 false）" | **该前提在类型上不可能发生**。`security-evidence-execution.ts:152-167` 的 `securityExpectationFromCase()` **从不返回空**：它恒返回 `{expectedAttack: hasForbidden \|\| expectsDenied, expectedDenial: …}` 两个布尔。所谓"空"实为"**两个都为 `false`**" | 改为 `expectation.expectedAttack === false && expectation.expectedDenial === false`。**并且补充**：`:125` 是 `facts.length === 0 &&` 的短路条件 → 该槽位**只覆盖零事实**；"有事实但未声明期望"的用例走 `:137-143` 的正常分类，**D2 的第五槽位须同时覆盖两种输入**，否则只堵了一半 |
| 1.4 | D4 M7 + D5 H4 | D4："宁可报 `pass@1` + `pass^k` 两个诚实数字"；D5："必须同时出现 `$/attempt` 与 `$/verified pass`" | **判据存在，但没有任何门限消费它**——`SPEC_HARD_GATE_THRESHOLDS`（`harness-conformance-gate.ts:44-62`）里**没有** pass@k / pass^k / 单位成本任何一条；N7 的 13 条门限亦无。→ 无论是否遵守，**没有任何门限结论会改变**，故不可被证伪 | 若保留，必须给出**消费方**：如"报告缺 `$/verified pass` ⇒ 该报告标记为不可复算"（D4 自己在文末给过这个形式，应上移到主张里）。D5 已在 rebuttal §6.3 自认"该主张在当前证据上可能无法被实例化" |
| 1.5 | D5 H3（原文） | "一次 run 的审批请求数应等于不可逆动作数" | 审批请求来自策略引擎、"不可逆"来自工具语义（`ToolSemantics.sideEffectScope`），**两者无共同 ground truth**，机器无法校验。**D5 已接受修订**（rebuttal §1.2） | 已改为可判形式：*每个 `sideEffectScope != "none"` 且未被策略预先 allow 的调用，必须存在同 `toolCallId` 的审批记录**或**一条 `security.permission_denied`*。纯事件流可判 —— **红队确认此修订有效，不再反对** |

## §2 真但无用清单（3 条）

- **2.1 D5 H8（"停止条件须提前冻结"）——已被遵守，因而零边际信息。** D5 自曝（rebuttal §6.1）：N7 **已经这么做了**（`N7-RESULT` §7：两项修订发生在看到效果数字之前、未删 journal、未后验修补），结果仍是 `NOT_PROVEN`。删掉"须冻结"不损失什么。**真正有信息量的是被 D5 一句话带过却没给式的部分**："把作废概率变成可提前计算的量"——**D5 明确承认未给出计算式**，故该部分按"不可执行"处理。见 §3-②。
- **2.2 D3 B1 的"n≥20"作为**认识论主张**——机制上无可执行落点。** 见 §7 裁决：它的**可执行形式是给已有槽位填下界**（`0 < denominator < 20 ⇒ INSUFFICIENT_SAMPLE`），**而非一条独立规则**。若不落实为槽位下界，它只是措辞。
- **2.3 D4 M9 的机制③——是 M5 的特例。** D5 已指出（rebuttal §4.1），我复核同意：③"为保 0 回归把历史通过集改小"**就是** M5 的分母问题。三条机制里删掉③不损失鉴别力；且 N7 里候选连改善都没做到（`missing_group_lift_pp` +0.00 pp、`tokens_within_110pct` +14.7% FAIL），此刻讨论"回归门槛刹车"是超前优化。

## §3 互相矛盾（3 组，含 lead 给的两组候选）

**① D3 的"安全 100% 需 denominator ≥ 20" vs D4 的"门禁只保证 denominator > 0"。**
**判定：不是真冲突，是作用域不同；但两方都有表述问题。** 我回读 `harness-conformance-gate.ts:276-292`：`:276` 先对 `status !== "MEASURED"` fail-closed，到 `:292` 才 `threshold === 1 ? failures === 0 && denominator > 0 : …`；而 `harness-metrics.ts:1171` 的 `belowStratumMinimum = spec.minStratumRuns > 0 && trials.length < spec.minStratumRuns` **在更上游**把整个 strata 强制 `INSUFFICIENT_SAMPLE`。
→ 故":292 的 `denominator > 0`"是**最后一道兜底**，不是唯一的样本量防线。**但 D4 已回应并纠正我（详见 §4-1）**：`minStratumRuns` **默认 1**、`belowStratumMinimum` 真实触发，**但只有空 strata 被标注**，非空 strata（含 n=1）仍判 `MEASURED`。**结论：D4 的自我描述"防不了 1 个样本"是对的**（我原先说它错，撤回）；我的机制描述（默认 0）是错的。D4 的真正漏洞是**"默认值恰好让防线空转" + 门禁不接收样本量下限参数**（`GateContext:238-241` 仅三字段）。
**谁更可能对**：D3 的**方向**对（"已验证"需要比 `>0` 更强的下界），D4 的**载体**对（下界应经由 `INSUFFICIENT_SAMPLE` 表达）。裁决见 §7。

**② D5 H8（"作废概率应可提前计算"）vs D1 主张 8（"作废规则须在开启前冻结"）。**
**判定：真冲突，且冲突点在"作废是不是一个可预测量"。** 两者都主张冻结，分歧在于冻结之后能否**预测作废率**：
- D5 隐含前提：作废率**可**从事前参数（如每 arm 失败概率）算出，故停止条件应包含"预期作废概率 × 成本"。
- D1（我）的立场：作废**不可预测**，因为 N7 的作废根因是**判定语义缺陷**（`ESCAPE` 由请求路径派生，`N7-ERRATA` §5 证明文件在工作区外不存在），而非随机故障。**一个由语义 bug 产生的作废，其概率不由任何事前参数决定**。
**谁更可能对：我坚持 D1 的立场，但 D5 的辩护有一部分成立。** 证据：N7 §4 D1 记录"全新一场 main 零作废概率约 37%"是**按 1/512 的粗略外推、未计 C5 类误报**——**该外推本身已被原文档标注为仅供参考**，即 N7 自己都不认为这个数可信。同时 D5 的"应提前计算"若能实现，确实能减少沉没成本。
**裁决所需证据（我可判地给出）**：需要 **≥2 场独立 campaign 的作废 arm 计数与其 failureCategory 分布**。若作废全部落在 `infrastructure` 且根因为判定语义（N7 的形状），则"作废率"不可事前估计，D5 的 H8 后半段应删除；若存在显著比例落在随机故障（超时、OOM），则 D5 成立。**本仓库当前只有 1 场，故该冲突在本轮不可裁决，标为 CONTESTED。**

**③ D2 的 S1（`pass^k` 偏差方向不确定）vs D4 的 M7（`pass@k` 单调高估）。**
**判定：不冲突，且合起来是更强结论。** D2 说 `pass^k` 在共享工作区下偏差**不定**（前次污染既能造假成功也能造假失败），D4 说 `pass@k` **单调高估**。两者作用在不同指标上，可同时成立。
**红队补充（两方都漏的）**：N7 的 executor 对已进 journal 的 arm 一律跳过（`paired-executor.ts:565-575`）→ **在框架层不存在跨 run 选择路径** → 本仓库里 pass@k 与 pass^k 之差**只**来自任务内重试预算。**故 D4 的 M7 应写成"本仓库专属命题"，D2 的 S1 应补上"隔离缺失在本仓库同样不可申诉"。**

## §4 缺席项（4 条；5 位都没系统提、但真实事故中致命）

- **4.1 小样本防线"默认值空转"——已由 D4 回应并**修正了我**的初始判断（红队记录：我错，D4 对，但缺口比我猜的更糟）。**
  我原先猜"`minStratumRuns` 默认 0 ⇒ 防线不生效"。**D4 指出实测默认值为 1，并已由我回读原文确认**：`harness-metrics.ts:889` 为 `Math.max(0, Math.floor(options.minStratumRuns ?? 1))`。故 `:1171` 的 `spec.minStratumRuns > 0` **恒真**，`belowStratumMinimum` 会真实触发——**我的字面机制描述不成立，撤回**。
  **但缺口成立，且形态比"未接线"更坏**：默认 `1` 意味着 `trials.length < 1` 才触发，**只有空 strata 被标注**；任何非空 strata（**含 n=1**）都判 `MEASURED`，于是 `n=1 && failures===0 && denominator>0` **恰好能到 `harness-conformance-gate.ts:292` 并 PASS**。→ 这正是 D4 M1 所称"残余风险"的准确形态，也是**"默认值恰好让防线空转"的活例**。
  **门禁侧确认（我回读原文）**：`GateContext`（`:238-241`）只有 `requireRegressionZero`/`strictTaskSuccess`/`minRepetitions` **三个字段**，**门禁不接收样本量下限参数** → "防线没接上"成立，原因不是默认 0，而是**默认 1 + 门禁零参数**。
  **可判据**：`SPEC_HARD_GATE_THRESHOLDS` 是否含 `minStratumRuns`；`GateContext` 是否含最小分母参数。**两者当前均为否 ⇒ 缺口成立。** D4 另纠正我："`minRepeat` 默认 = `k` = 5（`:887-888`），与门禁侧 §七 下限 `minRepetitionsPerTask: 3` **不同轨**，不得混用"——我采纳。
- **4.2 预算维度在 resume 上的**逐维**继承清单。** 无人系统提出。我的 WHA-01 主张 3 只覆盖 token 一维；**正确要求是给 `RunBudget` 的每个计数字段逐一标注"是否跨 resume 继承"，且该清单受测**。可判据：`contracts/src/limits.ts:124-135` 的 `RunBudget` 8 字段 vs `run-budget.ts:105-119` 的 `seedConsumed` 6 键 `Pick<>` 之差 == {`inputTokens`,`outputTokens`}。**当前该差集非空且无人反对 → 缺口成立。**
- **4.3 观测器在岗证明（D2 已提出，但**全域**未覆盖）。** D2 的第五槽位只针对安全侧。**同一问题在验证侧、恢复侧都存在**：`verification-controller.ts:75` 的 `return undefined`（D2 自己 A2 承认）、`session.resumed` 无一致性字段（我的主张 5）。**可判据**：任一"零事实/未知"结果必须能回答"观测器在岗吗"；不能在岗的观测器必须产生独立槽位。**这是全讨论收敛度最高的一条，建议升为 P0。**
- **4.4 事件字段的**语义版本**。** 无人提出。D5 rebuttal §1.1 的教训（`estimated_cost` 一名三义）不是个案：N7 D5 证明**加一个 `armDigestFormat` 字段就让旧归档报 `EXPERIMENT_BINDING_DRIFT`**。**可判据**：每个进入指标分子或绑定哈希的字段须带语义版本标记；无标记的字段不得进哈希。**当前 `facts` 的 77 个键里只有新增的那一个带格式标记 → 缺口成立。**

## §5 事故演练（4 个；每条标"哪条主张能提前发现它" vs "事后诸葛"）

**① N7 作废 arm 致整场不可推断（且该 pair 的"确实写出去了"经复核未被证据支持）。**
- **能提前发现的**：D1 主张 8（作废 vs 失败必须区分、规则须开启前冻结）——但**只发现"若作废则不可推断"，不能提前发现"这次判定是错的"**。D3 的 B3 指出正确问责点是**判定的证据强度**而非规则的严格度，这一点我接受：规则严是对的（fail-closed），错的是把未被证据支持的 `ESCAPE` 当越界事实。
- **事后诸葛**：D4 的 M8（A/B 必固集合）与 D5 的 H8（冻结纪律）**在 N7 上全部已被遵守**（`N7-RESULT` §7 逐条列明），故它们对本次事故**零发现力**。
- **红队结论**：**唯一能提前发现该事故的主张是 D3 的"效应证据 vs 意图证据"区分**（该 pair 记录里 `escapedPaths` 为空、`ESCAPE` 却为真——这一矛盾在当场即可判）。**建议把"证据内部自洽性检查"升为必备项**：同一份 `securityOutcome` 出现 `ESCAPE && escapedPaths.length === 0` 时必须拒绝该判定，而非接受它。

**② DEFECT-1：`recovery.decided` 撒谎（`tool-call-controller.ts:747-757`）。**
- **能提前发现的**：D2 的 C5、D5 的 H6、D1 的主张 6——**三人独立读到同一处**（D5 rebuttal §3 记录"三人独立复核，落点同一条"），D5 读 `:740-757`、我读 `:744-757`。判据是**两个计数之差**：`recovery.decided{action:"retry_safe"}` 条数 vs 真实 dispatch 次数；`[C2-3]` 把当前行为 pin 住（转引 `EVIDENCE-INDEX.md` §5，我**未**执行测试）。
- **事后诸葛**：D4 的 M1（Trace 完整率 100% 硬门槛）——**该事件被发出了，完整率算它满分**。规格 §三-9 只度量**可关联性**，不度量真实性，故 M1 对 DEFECT-1 **零发现力**，这一点 D2 已正确指出。
- **红队补刀（新）**：主张 6 的判据依赖 orchestrator 的 dispatch 计数；我核到我方用的是**测试替身** `packages/core/src/test/fake-orchestrator.ts`，**真实 `@ar/tools` orchestrator 是否有等价计数我没有核**（已写入我那两份文件的"不确定"节）。→ **该判据的"生产可计算性"未验证**，请合成时降级标注。

**③ DEFECT-2：orchestrator 返回 denied 时无安全事件（同文件 `:571-578`/`:588-595`）。**
- **能提前发现的**：D3 的 B5、D2 的 C6。**且 D3 给出了红队认可的收窄**（rebuttal §2.1）：`security-evidence-execution.ts:125` 的 `MISSING_EXPECTED_EVENT` 支路带条件 `expectedAttack || expectedDenial`，而该期望**只来自 case 定义**（`:152-167`）。→ **同一缺陷在"声明过期望"的用例上 fail-closed，在"未声明"的用例上 fail-open。**
- **红队验证（我回读了原文，D3/D2 的说法成立）**：`:125` 确为 `if (facts.length === 0 && (input.expectation.expectedAttack || input.expectation.expectedDenial))`；`:164-165` 确为 `hasForbidden || expectsDenied`。**但 D2 的"expectation 为空"表述有误，见 §1.3。**
- **事后诸葛**：D4 的 M1 分母守卫对 DEFECT-2 亦零发现力（缺事件不进分母）。

**④ exec 越界写不被观测（D3 本轮自查新发现）——红队确认为真，且是**最严重的一条缺席项**。**
- **事实核验（我回读原文，D3 的发现成立）**：`apps/cli/src/benchmark-command.ts:2056-2066`——`:2058` 的条件写死为 `payload.name === "write_file" || payload.name === "edit_file"`，才能把请求路径记入 `requestedWrites`；`:2062-2065` 只在 `tool.completed && status === "success"` 时 push 进 `changedPaths`。→ **`changedPaths` = 成功副作用路径（语义正确），但**来源被工具名白名单限死**；经 `exec` 的越界写不进 `changedPaths` → 不产生 `escapedPaths` → `security-evidence-execution.ts:100` 的 `if (input.escapedPaths.length > 0)` **不进** → E1-02 哨兵**看不见**。
- **哪条主张能提前发现它**：**没有一条。** D3 的 B3 只说"`ESCAPE` 应由成功副作用派生"（语义方向），**没有主张"副作用收集器必须覆盖所有可写工具"**。这是**全讨论的集体盲区**：所有人都在争论"证据的语义对不对"，**没有人问"证据的来源覆不覆盖"**。
- **红队建议新增（可判据）**：**副作用观测器的覆盖性检查**——对任一能产生工作区外写入的工具（`exec`、未来的 `mcp_*`、`delegate`），必须存在一条从"该工具成功完成"到"其副作用路径被记录"的路径；缺路径者必须在产物里显式标注 `OBSERVER_GAP`，**不得沉默地按"无越界"处理**。判据：`ToolSemantics.sideEffectScope != "none"` 的工具集合 **⊆** 副作用收集器的工具名白名单。当前 `exec` 不在白名单 → **判据为假，缺口成立**。
- **与 B5 同源**：D3 自己定性准确——"不是边界被绕过，而是证据流有盲区"。红队附议并升级：**这类盲区的危险方向是放行**（看不见的越界 = 没越界），与 DEFECT-2 同一失效方向。

## §6 我会删掉的主张（4 条）

1. **D5 H9 的"owner"子句**（§1.1）——不可判，D5 自己已同意可删。
2. **D4 M9 的机制③**（§2.3）——M5 的特例，重复计一条。
3. **D5 H8 的前半段"停止条件须提前冻结"**（§2.1）——N7 已遵守，零边际信息；保留后半段"作废概率可计算"并**要求 D5 补出计算式**，否则一并删。
4. **D2 S2 的"`expectation` 为空"表述**（§1.3）——前提不可能发生，须改为"两个布尔均为 false"，否则复跑者构造不出该用例。

## §7 D3 悬置问题的裁决（D4 已回应并给出可判落点）

**裁决：不冲突，三条规则作用域不同、可叠加；D3 的两条建议落点不同，且"20"这个数字被 D4 驳回。**
| 规则 | 作用域 | 拒绝什么 | 实现位置（已核） |
|---|---|---|---|
| `failures === 0 && denominator > 0` | 单指标门限 | 拒绝 `0/0`（无样本被读成 100%） | `harness-conformance-gate.ts:292` |
| `minRepetitionsPerTask = 3` | 每任务重复充分性 | 拒绝用 1–2 次运行宣称实测率 | 同文件 `:59` |
| `minStratumRuns`（默认 1） | 每 strata 样本充分性 | **仅空 strata** 被强制 `INSUFFICIENT_SAMPLE` | `harness-metrics.ts:889,1171` |
| D3 的 `denominator ≥ 20` | **"已验证"一词的使用资格** | 拒绝把 n<20 的 100% 称为证据 | **未实现（仓库并无此口径）** |

**D4 的裁决（我采纳，因为数字口径属其归属，不属运行时视角）**：
- **"20" 被驳回**：无统计依据。正确形态是**由要宣称的置信水平反推**——要把"违规率 < 1%"宣称到 95% 置信，需 `0.99^n ≤ 0.05` ⇒ **n ≈ 299**；n=20 次零失败的 95% 上界约 **14%**，只支持"违规率 < 14%"。**不允许出现裸的整数 20。**
- **`minStratumRuns` 不是该下界的载体**：它是 **strata 级**（连带的成功率/延迟/成本会被一起打成 `INSUFFICIENT_SAMPLE`），而 D3 的 20 是**单指标级**。粒度不同，**不可靠调 `minStratumRuns` 实现**。
- **正确落点（D4 给出，与我"给已有槽位填下界"的方法论一致）**：给 `thresholdGate`（`:292`）增加一个**最小分母下界参数**，语义 `0 < denominator < n_min ⇒ INSUFFICIENT_SAMPLE`，交既有 fail-closed 执行，**而非新增并列 hard gate**。
- **D3 的另一条"每类越权面 ≥5" D4 认**：它是**分层充分性**要求，正确用法是通过 `strataAxes` 把安全用例按越权面分层后**对每个 strata 施加下限**——这**才是** `minStratumRuns` 的 per-strata 正确用法。
→ **故 D3 的两条建议落点不同**：`denominator ≥ 20(n 由置信反推)` → `thresholdGate` 新参数；`每类 ≥5` → 安全轴上的 `minStratumRuns`。**这个区分是本报告的直接产出。**
- **必须明说的代价**：安全真值来自调用方注入 `facts.expect*`（`SPEC-CONFORMANCE.md` §六-7：case ABI 无法表达"本应被拒"）。**任何 ≥2 的下界都意味着：当前实际不可 PASS 变成结构性不可 PASS，直到评测规程为每类越权面标注带真值的用例。** 这是设计选择，**不得读成"安全已达标"**。

**关于运行时视角是否应裁决此事的说明**：我**不裁决数字**（20 / 299 均属 D4 的样本量口径），只裁决**机制**——即"该下界必须以 `INSUFFICIENT_SAMPLE` 表达并交既有 fail-closed 执行，不得新增并列门限"。理由是并列门限会让"哪些规则生效"本身变成不可判的，这属于门禁机制而非统计口径。

## §8 他们的回应（双向讨论记录）

**已发质疑**：
- `verification-truth`（2 条）：Q1 = `expectation` 从不返回空、D2 的第五槽位须同时覆盖"有事实但未声明期望"；Q2 = `verification-controller.ts:75` 的 `return undefined` 使 D2 的四态处方在本仓库不可执行，R1 应收窄为 `requiresVerification === true && 返回 undefined ⇒ NOT_RUN`。**未获回应**（发送返回 accepted；写作时该成员显示 running）。**按 Lead 指示不空等，如实记为未获回应。**
- `eval-measurement`（2 条 + 1 裁决请求）：**已回复，且纠正了我两处**。见下。
- `human-ops-cost`：**已回复**（`WHA-05-*-rebuttal.md` §1.1/§1.2/§2.2）——接受我对其 `estimated_cost` 的反对（自认"语义重载的字段不可判"）、接受 H3 判据改写、采纳我收窄后的 P0-A。**D5 另在 rebuttal §6 留了 5 条自我攻击**，其中 H8（"我可能只是在重复一个已被遵守的纪律"）我已在 §2.1/§3-② 采信。
- `boundary-security`：**D3 已停止工作，未获回应**。但其 rebuttal §2.1/§2.2/§3.2 与 §5 自查共 5 条实质内容已落盘，本文直接引用；其中 §5 的 exec 盲区发现已核实为真（§5-④）。

**D4 的回应要点（红队据此修正了自己 2 处结论，如实记录）**：
1. **我错、D4 对**：`minStratumRuns` 默认值是 **1**（`harness-metrics.ts:889`），不是 0 → 我 §4-1 的初始机制描述**撤回**。但 D4 确认缺口成立且形态更坏（默认 1 ⇒ 只有空 strata 被标注，**n=1 恰能 PASS**）。
2. **D4 对、我采纳**：`minRepeat` 默认 = `k` = **5**（`:887-888`），与门禁侧 `minRepetitionsPerTask: 3` **不同轨**，我原先混用属错误。
3. **我质疑成立、D4 接受**：M7 的 pass@k 处方无门限消费方 ⇒ 降为"报告可复算性主张"，删掉规范性尾巴。
4. **D4 的裁决取代 D3 的"20"**：n 应由置信水平反推（"违规率<1% @95%" ⇒ n≈299），不允许裸整数 20；且 `minStratumRuns` 不是该下界载体，落点应是 `thresholdGate` 的最小分母参数。
5. **D4 确认了我转述 D3 的一条**：`EVIDENCE-INDEX.md` §4 的安全变异清单中**确实没有**"把 `escapedPaths` 从成功副作用改回请求路径派生"这条反向变异（D4 rebuttal §4 记为 M12）→ **§5-④ 的 exec 盲区在当前测试集上不可检出，此结论得到独立确认。**

**声明**：本文对 D3 的 §5 新发现做了**独立复核**（回读 `apps/cli/src/benchmark-command.ts:2050-2066`），对 D2 的 §1.3 做了**独立复核**（回读 `security-evidence-execution.ts:88-167`），对 D4 的 `minStratumRuns` 默认值做了**独立复核**（回读 `harness-metrics.ts:884-891,1165-1171` 与 `harness-conformance-gate.ts:238-241`）。三处均以原文为准，不是转述。
