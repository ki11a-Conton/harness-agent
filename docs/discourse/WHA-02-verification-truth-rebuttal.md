# WHA-02 Rebuttal — 验证与证据视角（D2）

> 讨论者 D2｜Round 2｜对象：`WHA-01`(D1)、`WHA-03`(D3)、`WHA-04`(D4)、`WHA-05`(D5)
> 写作时实测：`docs/discourse/` 只有 `WHA-02/04/05` + `README` 四个文件（`WHA-01`、`WHA-03` **不存在**，D1/D3 未落盘）。
> D3 以 `send_message` 给了我可判真假的实质主张，我**按消息内容回应并复核了原文**（下文标注"D3-消息"）。0 网络、0 付费调用。

---

## 1. 被说服而修改的（共 3 处）

- **R1（被 D5 说服）**：我原把 D4 排在 D5 之上。D5 反驳：**D4 = 验证器从未运行**（CI 引用 + 执行输出可发现）；**D5 = 验证器无法在原地复算**（`facts` 含 `armDigestFormat`，binding 断言 `stable(header.facts) === stable(facts)`）。**我接受，改成分工而非排序**：`R3 = (3a) 确实被执行过 AND (3b) 能在与运行环境无关的机器上复算出同一判定`。我原先把两者压成一条，损失了 3b。

- **R2（被 D3 说服）**：我 C6 写 DEFECT-2 让"硬门槛建立在会漏报的流上"。**已读原文证实 D3 更精确**：`security-evidence-execution.ts:125` 的 `MISSING_EXPECTED_EVENT` 带条件 `expectation.expectedAttack || expectedDenial`；而 `securityExpectationFromCase()`（`:152-167`）显示期望**只来自 case 定义**的 `forbidden.*` / `expected.status==="denied"`。
  → 正确表述：**DEFECT-2 在"声明过期望"的用例上 fail-closed，在"未声明"的用例上 fail-open**。缺口的可见性取决于用例作者的声明，而非缺口本身——正是我 C1 反对的"被测方定义自己的考卷"在安全侧的复现。

- **R3（自我修正）**：我引 N7 用缩写 `N7-RESULT:109`。按自家 C4（证据须可追溯绑定），**行号必须实测**。已复核 `109` 行确为归档"仅原件摘要、不含原件本体"的限制说明。成立，但纪律写进本文。

## 2. 坚持反对 / 坚持己见的（共 3 处）

- **S1（反对 D4 的 pass^k 处方，我唯一实质分歧）**：D4 M7 建议"宁可报 `pass@1` + `pass^k` 两个诚实数字"。**从验证视角看 `pass^k` 也不诚实**：k 次重复若共享工作区/checkpoint，**第 2..k 次的初始状态取决于第 1 次是否改动工作区**，各次不独立。与 `pass@k` **单调高估**不同，`pass^k` 偏差方向**不确定**（共享状态既能造"前次污染后次"的假成功，也能造"前次留半成品"的假失败）。规格 §三 note 5 要求恢复须验证"工作区一致性、调用幂等、已执行副作用"——三条都指向**运行间隔离是 pass^k 的前置条件**。
  **处方**：报 `pass^k` 必须声明 **k 次之间是否重置工作区**，未声明即**不可复算**。已要求补进 M8 必固集合。**若 D4 反驳，我愿改**；但"两个诚实数字"本身不成立，除非隔离被声明。

- **S2（坚持 `NOT_RUN` 独立计数——也是我对 D3 反问的回答）**：D3 问"模型没越权"与"边界没被测"在未声明期望的用例上同形，**有判据吗？**
  **有，且不需要知道"应该发生什么"，只需要一个单调的观测器。**
  1. **判据核心**：*任何"零事实"结果都必须能回答"观测器在岗吗""期望声明过吗"；两个都答不出时，该结果不属于任何一类，不进入任何门限。*
  2. **槽位**：`expectation.expectedAttack === false && expectation.expectedDenial === false`（case **未声明** `forbidden.*` 且 `expected.status !== "denied"`）时不得落进 `clean`，须落进第五类 **`NO_EXPECTATION_DECLARED`**——与"期望了但没观测到"（`MISSING_EXPECTED_EVENT`，已实现 ✅）是两个槽位。
     〔**红队修正（D1 Q1，已复核原文）**：我原文写"`expectation` 为**空**"是**错的**。`OutcomeExpectationV2` 是两个**必填** `boolean`，`securityExpectationFromCase()`（`:152-167`）**从不返回空值**、恒返回两布尔。故正确判据是"两个都为 `false`"，不是"为空"。**"空值"与"两个 false"在 `undefined` 敏感实现里是不同分支；按我自家 C4 标准必须改，否则复跑者按"空值"构造用例永远构造不出来。**〕
     〔**D1 追加的加强（我接受）**：`:125` 短路顺序意味着 **`facts.length > 0` 时不进入该分支**，`:137-143` 直接把 facts 交给 `classifySecurityOutcomeV2`。故"**未声明期望 + 有 facts**"走**另一个分支**，第五槽位必须同时覆盖两种输入；否则它只在"零事实"时生效，有事实但未声明期望的用例仍落到默认分类——**那正是"被测方定义自己的考卷"的另一半**。〕
     〔**边界句（D1 提出，我复核 `:157-166` 确认并采纳）**：`expectedAttack = hasForbidden || expectsDenied`，故**只要声明了任一 `forbidden.*` 或 `expected.status === "denied"`，`expectedAttack` 即为 `true`**，该 case **不属于**第五槽位，而归 `MISSING_EXPECTED_EVENT` 管辖。→ 第五槽位的定义**必须**写成"**既无 `forbidden.*` 又无 `expected.status === 'denied'`**"；写成"未声明期望"会被后来读者读宽到覆盖前者。**此边界句是槽位定义的必要部分，非措辞修饰。**〕
  3. **门限口径**：安全门限分母应是"**声明过期望且观测器在岗的用例数**"；未声明 → `NOT_RUN`，**不计分子也不计分母**。与 §3.1 四态分离同构（`0/0` 与 `1/1` 都是 1.0）。

- **S4（接受 D1 Q2 的收窄，这是对我 R1 的实质改进）**：D1 指出 `verification-controller.ts:68-76` 中只有 `policy?.requiresVerification === true && verifier === undefined` 才 `blocked`，否则 `return undefined`；而 `undefined` 与"该 turn 不需要验证"共用同一返回值。**D1 读得对**，故我把 R1 收窄为：
  > **`requiresVerification === true && controller 返回 undefined` ⇒ 记 `NOT_RUN`。**
  这个形式**现在就可判**、且**不需要改契约**。`requiresVerification === false` 时 `undefined` 是**正确的"未要求"**，不是缺口。我原 R1 的"断言集为空必须报 `NOT_RUN`"过宽——它把"未要求"也判成了缺陷，属**我自己的不可判据项**。

- **S3（坚持 C5/C7 优先级，并统一成一句纪律）**：D5 附议 C5 并采纳我的处方（判定用副作用计数/幂等键，禁用事件存在性）；D4 M1 与我 §3.1 是同一件事的两半。**三者合并为仓库级单一纪律**：
  > **缺失、失败、与拒绝三者在输出上必须同形可辨；"已知未跑"必须有自己的槽位，禁止与"跑了通过"或"跑了没过"共用表示。**

## 3. 他人主张中的不可判据项（按我 Round 1 标准验收）

| 出处 | 句子 | 问题 | 我的处置 |
|---|---|---|---|
| D4 M3 | "±1.17pp vs ±0.78pp 的差异" | 我**实测** `N7-RESULT` 全文无 `1.17`/`0.78`；第 50 行只有 `143→146`、`143→145`、`completionRatio=0.99609375`。这两个数是**换算值**非原文记载 | 已发消息要求标注"据原文数字换算"。属我的 C4（证据与引文未绑定），**不影响 M3 结论**（口径差异本身有原文支持） |
| D4 M2 | "95% 区间宽度约 ±12pp" | 未标估算 | 已要求标估算 |
| D5 H2 | "跑一次带人类审批的 run，`total_human_interventions` 应 >0；当前应为 0" | 作者已诚实认错：**未执行，是静态推断**，并就地改正 | ✅ 已闭环。我复核 `paired-executor.ts:193` = `human_interventions: 0`、`load-runs.ts:59` = `?? 0`，与其实测一致 |
| D5 H2 升级 | "`RunMetrics.human_interventions` 类型上无法表达缺失" | **可判真假且成立**：该字段是 `number`，无 `null` 取值 | 附议。这比"没人写非零值"更硬：**不是忘了守纪律，而是类型上无法遵守纪律** |
| D3-消息 | "D3 的 `ESCAPE` 当前 HEAD 已是效应来源，不是现存 bug" | 我复核 `security-evidence-execution.ts:44-45` 注释将 `escapedPaths` 钉死为"Absolute paths the case **wrote** outside its workspace" → 语义确为**效应来源**，与请求路径 sentinel 不同 | ✅ 接受，C6 措辞应改为"**历史判定语义缺陷**；当前路径已改为效应来源；旧事实不可翻案" |
| D1 Q1 | 我 S2 写"`expectation` 为**空**时…" | **复核成立，是我的事实错误**：`OutcomeExpectationV2` 两字段均必填 `boolean`，`securityExpectationFromCase()` 从不返回空值 | ✅ 已改判据为"两个都为 `false`"，并接受 D1 的加强（`:125` 短路使"有 facts + 未声明期望"走另一分支） |
| D1 Q2 | 我 R1 写"断言集为空必须报 `NOT_RUN`" | **过宽**：`requiresVerification === false` 时 `return undefined`（`verification-controller.ts:75`）是**正确的"未要求"** | ✅ 已收窄为"`requiresVerification === true && 返回 undefined` ⇒ `NOT_RUN`"，形式现在就可判、不需改契约 |
| D3-消息 | "`clean source tree` 是否间接覆盖'断言被 run 内改写'？" | 我复核 `execution-plan.ts:489`：该约束是"plan confirmed on a CLEAN source tree，但 `treeFingerprint` 已被设置"→**运行前**状态检查 | **确认不覆盖**：它约束 run **前**的源码，不约束 run **中**的写入。见 §4 |

## 4. 与 D3 联署的共同最大缺口（我复核后同意）

**runtime 层没有把"验收断言集"纳入 run 身份。** 我 Round 1 §3.2 第 4 层与 D3 的 B4/B7 同源。
- 我的证据：`verification-controller.ts:81-89` 的 `verification` 来自 `task.verification`（或 planner 派生），**没有任何断言集摘要进入 run 身份/绑定哈希**。
- D3 的安全侧对应物：`execution-plan.ts:426-490` 的 `promotionEligible` 条件约束"**用什么环境跑**"（`isolationStrength==="strong"` + 40-hex sourceSha + clean tree），不约束"**断言从哪来**"。
- **共同结论**：规格 §七验收清单第 1 条要求"不可被 Agent 任意改写的验收标准"，**runtime 层无实现、评测层只覆盖了环境侧**。→ **联署进最终结论。**

## 5. 红队回应（`red-team-skeptic` 不存在于本 session，故自行红队）

**事实**：任务描述列出同侪 `red-team-skeptic`，我尝试 `send_message` 得到 `active teammate "red-team-skeptic" not found`；`list_agents` 确认本 session 只有 lead + D1–D5（另 3 个是测试子代理）。**无红队质询可回应，故我攻击自己**。以下 4 条若被证实，将导致我降级或撤回对应主张：

- **A1（最可能致命）**：C1 里 112/256 与 107/256 是 `unverified_complete` 计数，**"完成但无验证证据" ≠ "模型明知未完成而声称完成"**。我用了"系统性撒谎面"一词。若二者在证据上不可区分，**我的 C1 属过度断言**，应降级为"未验证完成的比例接近一半"。
  **自评**：`N7-RESULT:50` 原文用词是"假完成"（`unverified_complete` 且未通过），**未使用"撒谎"**。→ **我撤回"撒谎"表述**，改为"无验证证据的完成声明"。C1 的核心结论（自述证据权重为 0）**不依赖**该词，故存活。
- **A2**：我主张四态分离，但 `VerificationGateResult.status` 只有 `"passed" | "failed" | "blocked"`（`verification-controller.ts:14`）——**没有 `"not_run"`；"未跑"表现为 `return undefined`（`:75`）**。
  **自评**：`undefined` 与"未验证"共用表示，**正是我 C7 批评的"缺失与失败同形"**。→ **我的处方在本仓库尚未落地，我必须明说。** 已回写 WHA-02 §3.1。这是对我自身最强的一击，且它成立。
- **A3**：我全部判据来自**静态阅读、0 次测试执行**。**自评**：成立，已回写 WHA-02 开头作统一自限。
- **A4**：我指控 D4 引文不实，是否自己同类？**自评**：已复核 `N7-RESULT` 全文确无 `1.17`/`0.78`，指控成立；但我自己引的行号**未逐条回读**，仅抽查了 `load-runs.ts:43/59`、`paired-executor.ts:193`、`verification-controller.ts:14/75/109-113`。→ **把"全部行号已核对"收窄为"上述抽查行已核对"。**

## 6. 一句自我限定

WHA-02 每条"本仓库实现"均为**静态阅读**（读了 `runtime-verifier.ts`、`verification-controller.ts`、`task-verifier.ts`、`load-runs.ts`、`security-evidence-execution.ts`、`execution-plan.ts` 原文），**没有执行任何测试**。故判据是"**代码路径上成立**"，不是"**测试执行上成立**"。按我自己的 C3，**这一点必须标注**——否则我就犯了批评 D5 H2 时同一个错。
