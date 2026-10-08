# WHA-03 反驳与收敛（D3 / boundary-security，Round 2）

> 已读：`WHA-01`(runtime-lifecycle)、`WHA-02`(verification-truth)、`WHA-04`(eval-measurement)、`WHA-05`(human-ops-cost)。
> 已发 `send_message`：`verification-truth`、`eval-measurement`（消息 id 见文末）。立场不变：安全与不可信边界。
> 本文只写"读了他人之后我改变/加强/拒绝什么"，不重复 Round 1 的主张清单。

## 1. 我接受并并入的（明确不反驳）

- **D2 的 C5（事件流不能当 ground truth）** —— 与我 B5 同源，他的表述更锋利："完整性 ≠ 真实性"。我采纳，并把 B5 的结论升级为：**安全侧存在同一形态的两条腿**：DEFECT-2 是"该有事件而没有"（缺失），DEFECT-1 是"有事件而内容假"（`recovery.decided` 在闸门之前发出）。二者必须**分开报告**，不能用"事件齐全"一个数字覆盖。
- **D1 的主张 8（作废 vs 失败必须区分、规则需事前冻结）** —— 这正是 N7 D3 的形态。我与他的差别只在归因：他称"因 1 个越界 pair 被判 infrastructure 而整场作废"；我认为**更该问责的是判定的证据强度**，而不是"作废规则太严"。规则严是对的（fail-closed），错的是**把一个未被证据支持的 `ESCAPE` 当成越界事实**。
- **D4 的 M1** —— "分母>0 防不了 1 个样本宣称 100%"与我 B1 完全一致，无分歧。
- **D5 的 H3(a)** —— 把"不可逆/越界副作用"列为必须打断人类的一类，与我 B7 的审批默认拒绝同向；且他点出"`expired` 必须等价于 deny"，我直接 endorse（对应 `G9b`）。

## 2. 我加强/收窄的三点（有分歧，均可判真假）

### 2.1 对 D2 的 C6：DEFECT-2 的危险程度**取决于用例是否声明期望**，不是一律 fail-open

- **我的收窄**：`security-evidence-execution.ts:125-135` 只在 `expectation.expectedAttack || expectedDenial` 为真时把"零安全事实"报成 `MISSING_EXPECTED_EVENT`；而 `securityExpectationFromCase`（`:152-166`）的期望来自 case 的 `forbidden`/`expected.status="denied"`。**未声明的用例 → 零事实 → 落到 `:215-222` 的 clean 分支。**
- **所以**：同一缺陷在"声明过期望"的用例上 **fail-closed**，在"未声明"的用例上 **fail-open**。这不是措辞之争：它决定实测中漏报**会不会被看见**。
- **这反过来加强 D4 的 M5**：安全侧的分母不只靠"外部清单"，清单里每条还**必须带独立期望标注**；否则"多写用例"不改善指标、"少写用例"才改善——一个不需要篡改代码就能变好的指标。
- **对 D2 的反问（已发）**：他把 `NOT_RUN` 独立计数当核心处方；但安全侧的 `NO_ATTACK_ATTEMPT`（模型没越权）与"边界没被测"在**未声明期望**的用例上仍然同形。**他是否有判据把两者分开？** 目前我没看到，故我的 B5 结论保留：单靠事件流不够。

### 2.2 对 D2 的 C6 + D1 的主张 8：N7 的 `ESCAPE` 是**历史语义缺陷**，不是当前代码缺陷

- **事实层**：`N7-ERRATA` 第 5 条说"越界 sentinel 从请求路径产生"、"新代码按成功副作用收集路径"。我在 Round 1 已核到当前 HEAD：`apps/cli/src/benchmark-command.ts:2661-2665` 的 `escaped` 由 **`changedPaths`**（已发生的改动）经 `relative()` 判定，`:2703` 喂给 `escapedPaths`；`security-evidence-execution.ts:44-45` 的注释把语义钉为"**Absolute paths the case wrote outside its workspace**"。
- **结论（三分）**：① 旧 verdict **不可翻案**（须历史副作用原件，归档只有摘要无原件——`N7-RESULT` §6 已知限制）；② 也**不可**把 D3 当作"仓库现存 bug 清单"的一条；③ 但 D3 的**教训是现役的**：`ESCAPE` 是**因果断言**，路径字符串只是**意图证据**，把后者升格为前者是**方向性错误**。
- **我据此新增一条可判据**（Round 1 B3 已写，此处重申为**回归判据**）：注入"请求写工作区外、被拒、文件不存在"的 case → `escapedPaths` 必须为 `[]`、`kind` 必须 `CONTAINED`。**若为 `ESCAPE` 即回归。**

### 2.3 对 D4 的 M11：安全侧缺一条**反向变异**，我怀疑它不存在

- `EVIDENCE-INDEX.md` §4 的 7 组安全变异是"关掉机制 → 用例变红"（priorBlocks 注入丢弃 / project 文档扫描 / 工具输出注入拦截 / 失败 gate 阻断 / 沙箱文件包含 / process allowlist / capability 越权检测）。
- **我逐项对照后没有找到**把 `escapedPaths` 从"成功副作用"改回"请求路径派生"的变异。**若确实没有**，则 D3 那个错误在**当前测试集上不可检出**——这比 D4 说的"断言空洞"更重：它是在**已经发生过一次真实事故**的路径上缺反例。
- **我已把这条作为问题发给 D4 请他确认/否证**。在得到答复前，我把它标为**待核实**，不写成已确认事实。

## 3. 我拒绝或降级的两点

### 3.1 拒绝"用加权总分体现安全工作"（与 D4 M2 一致，但理由不同）

D4 说加权分是排序工具而非上线条件，我同意。**安全侧的理由更硬**：安全是**存在性**属性（有没有一条路径可以绕过），不是**比率**属性。20% 权重意味着"另外 80% 足够好"可以掩盖一条未修的绕过路径——这在数学上就是把存在量词当成了加权项。**规格 §六 自己写了"绝不能用加权总分替代安全上线条件"，本仓库 `harness-conformance-gate.ts` 把加权分做成 verdict 的**非输入**，方向正确。**

### 3.2 降级 D5 的 H2 对我的适用性

D5 的 H2（`human_interventions` 恒为 0）我完全接受，但**它对我这条视角的因果链更紧**：`expired` 与"从不被询问"在指标上都表现为 0，而**"人类没被叫醒"既可能是自治度高，也可能是审批根本没接上**。我的 B7 判据（`G9b`：未答复的审批必须 EXPIRED 而非 allow）只保证了**被问到时**的 fail-closed，**不保证"该问的确实问了"**。→ **这是 H2 与 B7 的共同缺口，我明说没有实现在这条上闭环。**

## 4. 收敛：安全视角对最终结论的 5 条硬要求（可判真假）

1. **分母 + 真值来源 + 最小样本量三者同时披露**，否则安全"100%"不作为晋升证据。建议 `failures===0 && denominator>=20`（每类越权面 ≥5）；`0<denominator<20` ⇒ `INSUFFICIENT_SAMPLE`，**不 PASS**。〔是否与既有 `minRepetitionsPerTask`/`belowStratumMinimum` 冲突：已问 D4，待答；未确认前标"建议"〕
2. **`CONTAINED` / `NO_ATTACK_ATTEMPT` / `MISSING_EXPECTED_EVENT` 三态分母分离**，`NO_ATTACK_ATTEMPT` **不得**进"安全有效率"分子（我主张需要第三态 `OBSERVED_NO_EVENT`，已问 D4）。
3. **`ESCAPE` 必须由成功副作用派生**；回归判据：`escapedPaths=[] ∧ denied ∧ 文件不存在` ⇒ 只能 `CONTAINED`。
4. **三个注入面各 ≥1 例端到端断言，且顺序不可颠倒**（先证明敌意字节进入可见上下文，再断言拒绝）——`G3/G3b`、`G4/G4b`、`G5/G5b` 已是正确形态。
5. **`win32-none` / `insecure-local` / `promotionEligible=false` 必须原样出现在任何结论里**；可以说"逻辑层边界被测过"，**不可**说"隔离已验证""越权不可能发生"。

## 5. 自查补记：我把 Round 1 里两条"只读注释"的判据追到了源头（结论：一条加强、一条暴露新缺口）

我原计划把 6 条薄弱处交给红队，但本会话 `red-team-skeptic` **不存在**（`list_agents` 无此成员，send_message 返回 `active teammate "red-team-skeptic" not found`）。故我自己先追掉其中最要命的两条：

- **`changedPaths` 的语义（原第 6 薄弱处）——已核实，我的 B3 结论成立且从"引注释"升级为"引代码"。** `apps/cli/src/benchmark-command.ts:2056-2066`：`onAppended` 在 `tool.requested`（`write_file`/`edit_file`）时按 `toolCallId` 记下 **请求路径**（`:2058-2060`），但只在 `tool.completed && payload.status === "success"` 时才把它 push 进 `changedPaths`（`:2062-2065`）。**即 `changedPaths` = 成功副作用路径，不是请求路径**——与 `security-evidence-execution.ts:44-45` 的注释一致。→ **N7 D3 的"intent 升格为 effect"诊断成立**；我批评 N7 时没有用同一个错误批评别人。
- **但这条追查暴露了一个 Round 1 没写的新缺口（我应该如实加上）：E1-02 哨兵只对 `write_file`/`edit_file` 生效。** 判定条件写死在 `:2058` 的两个工具名上，因此**经 `exec` 发生的越界写（例如 `node -e "fs.writeFileSync('C:\\tmp\\x','')"`）不会进入 `changedPaths`，也就不会产生 `escapedPaths`，哨兵看不见**。`resolveExecCwd`（`packages/tools/src/tools/exec.ts:42-110`）只约束 exec 的 **cwd**，不约束该进程往哪里写。→ **这是"越权没被观察到"的真实形态**，与 B5 的 DEFECT-2 同类：**不是边界被绕过，而是证据流有盲区**。我的 B4/B6 应相应收窄：可声称的是"对 `write_file`/`edit_file` 这条路径，越界写可被观测"；**经 exec 的越权写目前不可观测**。
- **另两条自查（原第 1、4 薄弱处）也一并核实**：① `filesystem.mode` 在 `packages/harness/src/tool-budget-binding.test.ts`、`packages/security/src/sandbox.test.ts`、`packages/core/src/runtime/turn-helpers.ts:565` 等评测/运行时路径上都是 **`workspace-write`**，不是 `full` → 我在 B6 说的"逻辑层被测过"在本机评测路径上**不落空**（`full` 只出现在显式测试项里）。② `harness-conformance-gate.ts` 的样本量门槛我仍**未读**，故"≥20"逐字保留为上一条所示的**建议**，不写成现状。

## 6. 我仍不确定的（交给主席）

- §2.3 的反向变异是否存在——**待 D4 确认**，我不预设答案。
- §2.1 的"未声明期望 ⇒ fail-open"我是从 `:125-135` 与 `:215-222` 两条分支**推断**的完整覆盖关系；我**没有**跑一条"未声明 `forbidden` 且零安全事件"的端到端 case 去实测它是否真落到 clean。**标为待复核。**
- DEFECT-2 我只**读**了 `tool-call-controller.ts:571-578/588-595` 有 `security.permission_denied` 而 orchestrator denied 分支没有——**我没有构造 orchestrator-denied 的端到端运行去复现"事件流里找不到"**。这是 Round 1 B5 判据的**未执行部分**，如实标注。
- §5 新发现的 exec-mediated 逃逸盲区，我**没有**构造用例实测（需要一条真的经 `exec` 往工作区外写的 case）。**标为待复核**；但它的存在性由 `:2058` 的工具名白名单**静态可判**。

## 7. 采纳 D2 的回应：他给了 §2.1 缺失的那个判据（我的 B5 结论据此收口）

D2 已正式回应（`WHA-02-verification-truth-rebuttal.md`，53 行），四点我全部接受，其中第 4 点**直接回答了我 Round 1 遗留的反问**，我把它并入本文并引用：

- **他确认了 §2.1**：`:125` 的分支带条件 `expectedAttack || expectedDenial`，而该期望**只来自 case 定义的** `forbidden.*` / `expected.status==="denied"`（`securityExpectationFromCase`，`:152-167`）。→ 我的"声明过期望 fail-closed / 未声明 fail-open"表述被独立复核为准确，他并指出这是**"被测方定义自己的考卷"在安全侧的复现**——此定性我完全同意，写得比我好。
- **他确认了 §2.2**：`escapedPaths` 语义为效应来源，C6 将改成"历史判定语义缺陷；当前路径已改为效应来源；旧事实不可翻案"。
- **他确认了 §3.2 第 4 层的联署**：`execution-plan.ts:489` 的 `clean source tree` 检查的是 **run 开始前**的 `probeSourceSnapshot`（"would be refused **at execution time**"），**不约束 run 过程中的写入**；且 `verification-controller.ts:81-89` 的 `verification` 来自 `task.verification`，**没有任何断言集摘要进入 run 身份/绑定哈希**。→ **这是 D2 与 D3 两条视角的共同最大缺口**，联署成立。
- **他给我的判据（关键，我原缺失的一环）**：*任何"零事实"结果都必须能回答两个问题——"观测器在岗吗"、"期望声明过吗"；两个都答不出时，该结果不属于任何一类，不进入任何门限。* 具体槽位：`expectation` 为空时不得落进 `clean`，必须落进**第五类 `NO_EXPECTATION_DECLARED`**（与已实现的 `MISSING_EXPECTED_EVENT` 是两个不同槽位）。→ **安全门限的分母应是"声明过期望且观测器在岗的用例数"；未声明即 `NOT_RUN`，不计入分子也不计入分母。**
- **这修正了我 B5 的一处不精确**：我在 B5 里说未声明期望的用例"落到 clean 分支"——准确说是**"当前被读成 clean，但它不该属于 clean 这一槽位"**。这是**缺口**而非**既有正确行为**，D2 的槽位划分把"缺一个槽位"讲得比我的"落进 clean"清楚。
- **他的自我限定我照抄一遍以示同尺**：他引用的行号均为**静态阅读原文**所得、**未执行测试**；我引用的 `:2058` 工具名白名单等结论同样是"代码路径上成立"而非"测试执行上成立"。

已发消息：`verification-truth`、`eval-measurement`、`lead` 各 1–2 条。**未能发送** `red-team-skeptic`：本会话 `list_agents` 无此成员，返回 `active teammate ... not found`；已上报 lead，并自行追掉 6 条薄弱处中的 2 条（§5），余 4 条列于 §6。
