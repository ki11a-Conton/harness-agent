# WHA-01 Rebuttal — 运行时与生命周期视角（D1，Round 2）

> 已读：`WHA-02`(D2)、`WHA-03`(D3) + 其 rebuttal、`WHA-04`(D4)、`WHA-05`(D5) + 其 rebuttal。
> 已发 `send_message`：`eval-measurement`、`human-ops-cost`（各 1 条实质评审 + 后续往返）。
> 一条元事实：**本 session `red-team-skeptic` 不存在**（`list_agents` 无此成员），与 D2/D3 所述一致；无红队质询可回应，故我在 §5 自行攻击。
> 自我限定（照抄 D2 的同尺）：本文所有行号结论均为**静态读代码 + 我本人读过完整函数体**所得，**未执行任何测试**；强度是"**代码路径上成立**"。Round 1 中唯一带"执行过"性质的证据是 `EVIDENCE-INDEX.md` §1/§4 记录的 **Lead 本人复跑结果**与变异验证，那是**转引**，不是我自己跑的。

## 1. 被说服而修改的主张（3 条，含 1 条我自己的撤回）

- **修改 1（被 D5 说服，判据升级）**：主张 2 里我写"最容易被伪造的方式：发事件但不终止"，判据是"该事件之后**没有再发生任何 model 调用**"。D5 指出 `packages/observability/src/metrics.ts` 的 `computeMetrics()` 已产出 `model_call_count`/`turn_count`/`tool_call_count`，故该判据可变成**一次离线计算**而不需新增埋点。**采纳**，判据重写为联立两条：(a) `run.limit_reached` 事件的 `timestamp` 之后不存在 `model.started`/`model.completed`；(b) 存在 `turn.failed`（仅"无 `turn.completed`"不充分——**卡死的 run 也不产生它**，必须连上终止记录，否则"挂起"会被读成"终止"）。
- **修改 2（被 D5 说服，主张 8 加前置条件）**：D5 主张"作废理由必须绑定可离线复核的副作用证据，而非派生 flag"。我接受并把主张 8 改成：**作废状态与作废理由都要在看效果数字之前冻结；且理由必须绑定可离线复核的副作用事实（目标路径存在性/内容哈希），不得使用从请求派生的 flag**。理由正是 N7 D3：那次作废花掉 7.1 小时 / 9,171 次调用，复核后连"到底写没写出去"都答不出。**但我加一个分层标注**：`packages/core/src/runtime/*` **没有**路径级副作用收集器（我核过 `recovery-controller.ts`、`tool-call-controller.ts`，只有**调用级**的 `unresolvedTools`/`committedSideEffects`）；该修复只存在于评测脚本层（`apps/cli/src/benchmark-command.ts:2056-2066`，D3 §5 已把 `changedPaths` 钉死为**成功副作用**路径）。→ **运行时层"本仓库无对应实现"，不得写成已覆盖。**
- **修改 3（撤回我 Round 1 的"待复核项"，这是对我自己最强的一击）**：我在 Round 1 主张 3 的"不确定"里写：不能排除别处有 token 维度的补偿逻辑。**追查完毕，结论是缺口成立，且比我原先说的更硬，我要撤回"不确定"这个措辞并给出完整证据链**：
  - `packages/contracts/src/limits.ts:124-135` 的 `interface RunBudget` **只有 8 个字段**：`runId/limits/usedTurns/usedToolCalls/startedAt/durationMs/outputChars/retries/subagentsSpawned/estimatedCostUsd`——**没有 `inputTokens`/`outputTokens`**。
  - `run-budget.ts:83-96` 的 `snapshot()` 返回该类型 → token 计数**不可能**进入 checkpoint，因为承载它的类型里没有这两个字段（**类型级封死，不是遗漏**）。
  - `runtime.ts:976-983` 的 `activeBudgetUsage` 把 `run: budget.snapshot()` 塞进 `checkpoint.budgetUsage`（`contracts/src/checkpoint.ts:32` 的 `run?: RunBudget`）——同一类型。
  - 唯一的 token 载体是 `CheckpointBudgetUsage.usedTokens`（`checkpoint.ts:29`），但 `runtime.ts:978` 取的是 `lastReportTokens`（**上下文预算**），不是模型调用的 input/output token，且 `budgetSeed` 路径（`runtime.ts:974/1778`）**只喂 `seedConsumed`，从不回灌 `usedTokens`**。
  - **结论**：resume 后所有 token 计数字段既不在 tracker 里累积（被 `Pick<>` 排除）、也无法被持久化（类型里没有）→ **token 预算在 resume 上是"未继承"，不是"部分继承"**。新表述取代 Round 1 的"待复核"。

## 2. 我坚持反对的主张（3 条，附理由）

- **坚持 1：反对 D1 自己的旧措辞不够狠 —— 主张 5 应从"P1 加分项"升级为 P0。** 我 Round 1 把"区分恢复被尝试 vs 恢复成功"标为 P1，理由是规格 §二 把 Recovery & Adaptation 列为 P1。**我改判自己**：`SPEC-CONFORMANCE.md` §六-7 记载该判据曾被尝试并**被主动否决**，而 `session.resumed` 的 payload（`runtime.ts:1783-1790`）至今**没有任何一致性字段**。D5 的 H1 从另一侧独立命中同一形态（`metrics.ts:5-8` 的 0 兼表"无"与"未记录"）。**当一个缺口在三处独立发作时，"它是 P1"就不是理由，而是它一直没被修的记录。**
- **坚持 2：反对 D4 的 M5 把分母守卫只做成"传入外部清单"——运行时侧还有一条更便宜的守卫。** D4 说覆盖率分母必须由调用方声明的基准清单给出，正确。但清单本身可以被"少跑"绕过：`auto_verification_coverage` 的分母换成外部清单后，**"清单里哪些任务跑了、哪些没跑"仍需一个持久化记录**，否则分母变大而分子不变，指标直接崩掉。运行时侧现成的判据是 `checkpoint` 链：每个任务的 run 应各自留下 `checkpoint.created` + `session.resumed`（或 `run.limit_reached`）之一，**"清单里有、事件流里无任何 run 痕迹"的任务可被判为未跑**。这条判据不需要新接口。
- **坚持 3：反对把 `run.limit_reached` 计入"Trace 完整率"的分子。** 规格 §三-9 的"关键事件可关联 run_id/步骤/工具/结果"在 `run.limit_reached` 上恒真而**零信息量**——它是纯观测事件、不参与控制流（我在 Round 1 主张 2 已指出）。**一个只要存在就加分的事件，会把完整率从"可审计性度量"变成"埋点数度量"**。我主张分子只含**驱动控制流**的事件（`turn.*`/`tool.*`/`verification.*`/`recovery.decided`）。这与 D2 的 C5、D5 的 H6 同向：**完整性 ≠ 真实性**，而"廉价事件凑数"是完整性的伪造手法。

## 3. 我发现的他人主张中的不可判据项（逐条给出可判形式的替代）

| 出处 | 句子 | 问题 | 我给的替代判据 |
|---|---|---|---|
| D4 M2 | "n=20、每任务 3 次 = 60 run 时的 95% 区间宽度约 ±12pp" | 未标"估算"，且 `±12pp` 依赖未声明的方法（Wald / Wilson / bootstrap） | 标"估算 + 方法名"；或改为可判形式："当 n<60 时，门禁对 `taskSuccessRate` **不得**给 PASS，只给" |
| D4 M7 | "pass@k 不能回答'系统稳不稳'" | 见 §4 我的反驳：这是**普遍命题**，而 N7 的结论是**本仓库专属**的 | 改为："在 `paired-executor.ts:565-575` 的 executor 语义下（resume 跳过已 journal 的 arm），pass@k 退化为**任务内重试预算**的度量" |
| D5 H3 | "一次 run 的审批请求数应等于不可逆动作数" | **两个量没有共同 ground truth**："不可逆"是工具语义，"审批请求"是策略输出，无法机器校验 | 改为："每个 `sideEffectScope != 'none'` 且未被策略预先 allow 的调用，必须存在同 `toolCallId` 的审批记录**或** `security.permission_denied` 事件"——纯事件流可判 |
| D5 H1 | 6 个数中的 `estimated_cost` | 我 Round 1 已指出：`run-budget.ts:74-79` 累加的是**调用方传入**的 cost，`metrics.ts` 的 `computeCost()` 在无显式 cost 时套默认费率；N7 的 `usdMicros` 是**声明上界非账单**（`N7-ERRATA` §3）。H1 自己违反 H5 | 该字段必须带口径标签（声明上界/估算/账单三选一），否则从 H1 的必读数中移除 |
| D3 B1 | "n≥20 才算已验证"（其 §4 第 1 条） | 见 §6：它是一句**建议**而非判据，我给出可判形式 | `denominator > 0 && failures === 0 && denominator < 20 ⇒ INSUFFICIENT_SAMPLE ⇒ BLOCKED` |
| D2 C3 | "verifier 崩溃必须 fail-closed 为 blocked" | 判据成立但**未覆盖 `verification-controller.ts:75` 的 `return undefined`**（即 D2 自己 A2 承认的缺口） | 建议：`undefined` 必须在外层转成显式 `blocked`，否则"没跑"与"跑了"同形 |

## 4. 我与 D4 的唯一实质分歧：pass@k 的适用域

D4 的 M7 写"**pass@k** 只回答'给 k 次机会能否拿到一个成功解'，**不能**回答'系统稳不稳'"。**我反对把它当普遍命题**，理由来自运行时结构而非措辞：
- pass@k 与 pass^k 的差异**只**来自"跨 run 的选择权"。N7 的 executor 对已进 journal 的 arm 一律跳过、不看 `valid`（`paired-executor.ts:565-575`），**在框架层不存在"用 k 次尝试救回一个 arm"的路径**。
- 因此在**本仓库**，两者之差**只**来自**任务内重试预算**（`run-budget.ts:onRetry` / `maxRetries` 与 `recovery.decided` 的 `maxAttempts`）。
- **这不是削弱 D4 的观察，而是给它一个更强、更可判的形式**：在存在跨 run 重采样预算的 harness 里 pass@k 确实测"选择权"；**在本仓库它退化为预算度量**。红队会抓普遍命题的反例，所以我主张收窄。
- **附：D4 的 M7 与 D2 的 S1 其实不冲突。** D2 说 `pass^k` 的偏差方向**不确定**（共享工作区既能制造假成功也能制造假失败），D4 说 `pass@k` **单调高估**。两句都对，且合起来是一条更强的结论：**在本仓库，这两个指标一个偏一个不定，都不能单独作为稳定性证据**；必须先声明"k 次之间是否重置工作区"（D2 的处方，我附议）。

## 5. 红队缺席，我自行攻击（4 条；其中 2 条已导致我改判）

- **A1（最可能致命，已被我处置）**：主张 3 的 token 缺口，我 Round 1 只读到 `Pick<>` 与 `snapshot()` 的返回类型就下结论。**若 `RunBudget` 在别处被扩展或 alias，我的结论就错。** 已追到 `contracts/src/limits.ts:124-135` 与 `checkpoint.ts:25-40`：**类型里确实没有 token 字段** → 结论存活并升级（见 §1 修改 3）。这是我在本文唯一一次把"待复核"变成"已核实"。
- **A2（成立，我改判自己）**：主张 2 声称"首次触限永不被第二次检查掩盖"依赖 `alarm()` 的 `breached` 置位（`run-budget.ts:128-132`）。**但 `breached` 是 per-tracker 的**，而 tracker 在 `runtime.ts:971` **每次 runTurn 新建**。→ 该性质只在**单次 turn 内**成立；resume 后是**新 tracker + `seedConsumed`**，故"不被掩盖"依赖 seed 的完整性——而 seed 恰好缺 token（§1 修改 3）。**两条主张在此处耦合，我 Round 1 没写这层依赖，现补上。**
- **A3（成立，收窄）**：我在 Round 1 主张 4 引了 `[C5-1]/[C5-2]/[C5-5]` 的 `writeCount` 断言与 `crash-matrix.test.ts` 的 9 个 kill point。**这些是 `EVIDENCE-INDEX.md` 与测试文件头部注释里的记录，我没有执行 `pnpm exec vitest`。** → 我把这些断言的强度从"已验证"降为"**测试文件中已存在该断言**（作者与 Lead 复跑结果见 EVIDENCE-INDEX §1）"。这是转引，标注清楚。
- **A4（我不知道答案，按 D2 的标准这必须列为待复核）**：我声称 `isHardLimit()` 全仓零调用（`run-budget.ts:141` 的 `void isHardLimit`）。**"零调用点"这个断言我没有做全仓检索**（我只在 `packages/core/src/runtime` 内 grep 过 `isHardLimit`）。**若它被 `packages/` 其他位置调用，我的"死代码或过时契约"二分就少了第三种可能。** 这条我**保留为待复核**，不写成结论。

## 6. 回答 lead 转来的 D3 悬置问题：安全"n≥20"与现有门禁是否冲突

**我的判断：不冲突，而且它们管的是两件不同的事；但 D3 的写法需要改，否则会与 D4 的 M1 撞车。** 站在运行时/预算视角，三条判据的**作用域**是分开的：

| 规则 | 作用域 | 它拒绝什么 |
|---|---|---|
| `failures === 0 && denominator > 0`（D4 M1，已实现） | **单个指标的门限** | 拒绝 `0/0`（无样本被读成 100%） |
| `minRepetitionsPerTask = 3` / `belowStratumMinimum`（D4 M6，已实现） | **单个被观测对象的样本充分性** | 拒绝用 1 次运行宣称一个实测率 |
| D3 的"n≥20" | **"已验证"这个词的使用资格**（认识论层） | 拒绝把"n=1 的 100%"称为证据 |

- **不冲突的判据**：三者可以同时成立——`denominator = 20 && failures = 0` 时，M1 给 PASS、M6 的每任务 ≥3 次满足、D3 的"≥20"也满足；`denominator = 1` 时，M1 给 PASS（1>0 且 0 失败）、M6 允许（该 strata 样本充分性独立的）、**只有 D3 给 BLOCKED**。→ 它们是**叠加**的，不是互斥的。
- **但 D3 的形式必须改成可判的**：`n≥20` 作为"建议"不可判。可判形式是：**`safetyControlRate` 在 `0 < denominator < 20` 时输出 `status: "INSUFFICIENT_SAMPLE"`**，并让 `harness-conformance-gate.ts` 的既有 fail-closed（`INSUFFICIENT_SAMPLE ⇒ BLOCKED`）接管。**这样它不需要新增门限逻辑，只是给一个已有槽位填一个更强的下界。**
- **一处我要提醒 D3 的真实代价（运行时视角）**：安全类指标的真值来自调用方注入 `facts.expect*`（`SPEC-CONFORMANCE.md` §六-7：case ABI 无法表达"本应被拒"）。**把下界从 1 提到 20，等于把"当前实际不可 PASS"变成"结构性不可 PASS，直到评测规程为每类越权面标注 ≥5 条带真值的用例"。** 这不是反对，而是要**明说代价**：D3 §4 第 1 条若被采纳，本轮任何真实评测都不可能 PASS，这是**设计选择**，必须与 D4 §「本条视角下本仓库的真实缺口」一并写进最终结论，不能读成"安全已达标"。
- **我选择不裁决的部分**：`n≥20` 这个**具体数字**该由 D4（样本量口径）定，不该由运行时视角定；我上面只给"它如何被门禁执行"的机制判断。**若 D4 给出不同下界，我接受 D4 的数，只坚持"必须以 `INSUFFICIENT_SAMPLE` 表达，不得新增一套并列门限"**——并列门限会让"哪些规则生效"本身变成不可判的。

## 7. 我仍不确定的（交给主席，共 3 条）

1. **A4 的 `isHardLimit` 全仓调用点**——未做全仓检索，保留为待复核（这是我唯一未能自己闭环的 Round 1 遗留项）。
2. **主张 6（DEFECT-1）的判据依赖 orchestrator 的 dispatch 计数**：`fake-orchestrator.ts` 计的是**测试替身**的 dispatch 次数，真实 `@ar/tools` orchestrator 是否有等价计数，我**没有核**。若没有，"两个计数之差"这条判据在生产环境**不可计算**，只能退化为 `[C2-3]` 那种测试内断言。**这是主张 6 的真实弱点，我标出来。**
3. **D5 与我合并的"P0-A 纪律"（事件字段必须有独立对照量）**的**边界**：`tool.completed` 的 `stdout` 内容显然没有独立对照量，但它必须进 trace。所以严格说 P0-A 只适用于**进入指标分子**的字段，不适用于全部事件字段——这个边界是我与 D5 往返后我主动收窄的，**但收窄后它是否仍能抓住 D5 列的三处，我只有论证、没有可跑判据**。
