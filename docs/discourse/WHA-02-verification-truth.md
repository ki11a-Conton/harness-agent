# WHA-02 — 验证与证据视角：什么才算"任务真的完成了"

> 讨论者 D2（verification-truth）｜Round 1｜视角：Verification / Evidence / Truth
> 输入：规格 v1.0 §一/§三/§五/§六；`SPEC-CONFORMANCE.md`；`EVIDENCE-INDEX.md`；`N7-RESULT-20261007.md`、`N7-ERRATA-20261007.md`
> 每条主张可判真假，附**可观测判据**与**本仓库实现**（无实现则明说"无"）。0 网络、0 付费调用。

**总命题**："完成"不是一个状态，而是三元组 **`(被验证的断言, 由谁独立验证, 原始证据的持久路径)`**。三者缺一，正确结论只能是 `NOT_PROVEN`——不是 `PASS`，也不是 `FAIL`。

> **证据强度自限（红队自击 A3）**：本文所有"本仓库实现"均为**静态阅读原文 + 核对行号**所得，**0 次测试执行**。故判据强度是"**代码路径上成立**"，不是"测试执行上成立"。

## 1. 完成声明的证据最小集（正面回答）

**5 项，缺任一即降级为"未验证"而非"失败"**：

| # | 证据项 | 可观测判据 | 本仓库实现 |
|---|---|---|---|
| E1 | **变更集**：改了哪些路径的哈希 | 变更前后工作区清单 + 内容哈希 | `context.changedPaths`、`baselineFiles`（`runtime-verifier.ts:80-81`）、`checkpoint-store.ts` |
| E2 | **验收规格**：断言"什么叫做完"的机器可读条件 | `task.verification[]` 非空且 kind ∈ command/artifact/requirement/diff | `task-verifier.ts:61-101`（4 种 check） |
| E3 | **执行证据**：每条 check 的原始输出与退出码 | `VerificationResult.checks[].evidence` + `error` | `task-verifier.ts:71`、`runtime-verifier.ts:104-113` |
| E4 | **判定与计数**：通过数/总数，且 **partial ≠ complete** | `CompletionEvidence{passedSteps, totalSteps}` | `verification-controller.ts:109-113`（注释明写 "partial pass is NOT complete"） |
| E5 | **验证者身份与不变式**：谁验的、用的哪版规则 | verifier 实现 + attempt / termination code | `packages/contracts/src/termination.ts`、`baseline.ts` |

**关键点**：E1–E5 全满足，也只证明"**在这套断言下**通过"。断言写错（`expectedPaths` 写漏、command 断言恒真）时，证据集再完整也是**自洽的谎言**。故最小集必须附第 6 项——**断言来源不可由被验方改写**（规格 §七验收清单第 1 条）。

## 2. 主张清单

### C1 — "模型自述完成"的证据权重必须为 **0**
- **主张**：模型在 transcript 里说 "Done!"，对"任务是否完成"的**后验概率没有任何提升**，只能证明"模型产生了这句话"。
- **为什么**：模型的输出是被测对象本身，不能同时充当测量仪器（规格 §一："Agent 自称完成任务，不等于任务真的通过验收"；§三 note 3）。
- **怎么验证**：本仓库已有正例——`packages/evaluation/src/verified-completion-gate.regressions.test.ts` 与 `apps/cli/src/verified-completion-gate.integration.test.ts`：模型输出 "Done!" 落在 transcript 的同时，grade/termination 仍为未完成，且回注 "NOT complete" 纠正。`pr-harness-security-boundary.regressions.test.ts` 的 `G1a`–`G2b` 把这条 pin 住。
- **失败模式**：**N7 真实事故**——两个 arm 的"假完成"（`unverified_complete` 且未通过）分别为 **112/256（43.8%）** 与 **107/256（41.8%）**（`N7-RESULT-20261007.md:50`）。即接近一半的 run 里，完成声明**没有验证证据支撑**。〔更正：原文此处写"系统性撒谎面"属过度断言——`unverified_complete` 只表示"完成但无验证证据"，不等于"模型明知未完成而声称完成"；已按红队自击 A1 撤回该词，**结论不依赖该词**。〕
- **最容易被伪造的方式**：只跑一个恒真命令（`echo ok`、`exit 0`）当验收；或让模型自己"摘要"测试输出。

### C2 — "测试通过"证明的是**该命令在该 cwd 下退出码为 0**，不证明任务完成
- **主张**：`exit 0` 与"任务达成"之间没有蕴含关系，除非 E2 的断言集被独立审阅过。
- **为什么**：退出码是工具语义，不是任务语义。规格 §五-3 专列"代码已修改但未验证"这一类。
- **怎么验证**：`task-verifier.ts:65`：`passed = checks.length > 0 && checks.every(...)`——**空 specs 时 `checks.length === 0`，`level: 0`，`passed: false`**（`:68`）。"什么都没验"= 不通过。这是仓库里最干净的一条 fail-closed 实现。
- **失败模式**：`SPEC-CONFORMANCE.md` §六-8：`auto_verification_coverage` 的**分母是"被观测到的任务数"**；基准 30 任务只跑 20 个，覆盖率被**高估**。同一逻辑：跑少了不等于验好了。
- **最容易被伪造的方式**：把 verification spec 写成恒真的 `requirement` 断言；或让模型在 run 内把测试改绿（正是规格 §七要"不可被 Agent 改写"的原因）。

### C3 — verifier 退出码 0 ≠ 验证通过；verifier 崩溃必须 **fail-closed 为 blocked**
- **主张**：验证器自身是故障源。任何"verifier 异常 → 默认放行"的实现都是放行方向缺陷。
- **为什么**：被测对象与测量仪器的故障不可混淆。
- **怎么验证**：`runtime-verifier.ts:97-121`：`catch` 后 `blocked = errorInfo("INTERNAL_ERROR", ...)`，构造 `level:0, passed:false` 合成 check，返回 `status:"blocked"`（注释："never a silent pass"）。`pr-harness-security-boundary.regressions.test.ts` 的 "verifier 崩溃记 by fail-closed" 覆盖之。
- **失败模式**：`N7-RESULT` §4 D4——归档复算入口 `verify-n7-archive.mjs` **有语法错误、从未被执行过**，全仓无任何测试引用它。即"验收记录里声明的校验步骤"长期不存在。**验证器没跑 ≠ 验证通过**——而当时的记录读起来像是验过了。这类空洞**不是靠更严的断言能发现的，只能靠"证明验证器确实运行过"发现**。
- **最容易被伪造的方式**：写一个从未被 CI 引用的 verify 脚本，然后在文档里引用它。

### C4 — "证据文件存在"只能证明存在，**必须证明内容与本次 run 绑定**
- **主张**：`fs.exists` 无信息量；需要的是可追溯绑定：run_id → 断言 → 原始字节哈希。
- **怎么验证**：本仓库**部分实现**——`RAW-MANIFEST.json`/`artifact-index.json`（9,699 条路径/字节/SHA-256），`campaign-evidence.mjs:17` 的 `EXPERIMENT_BINDING_DRIFT` 会拒绝绑定不一致的复算。
- **缺口（明说没有）**：`N7-RESULT:109` 明写归档**只有原件摘要、不含原件本体**（原件在 scratch，约 460 MB）→ **第三方仅凭归档无法独立复算**。"有证据文件"在这份真实证据上**已被证明不够**。
- **最容易被伪造的方式**：证据路径写成硬编码字符串；或复用上一次 run 的 trace。


### C5 — DEFECT-1（trace 撒谎）证明：**事件流本身也是被测对象，不能当 ground truth**
- **主张**：`tool-call-controller.ts:747-757` 在 `retryPolicy !== "safe"` 判断**之前**发出 `recovery.decided`，并把 `retry` 映射为 `action:"retry_safe"`/`reason:"…retrying"`，而 `retryable:false` 的工具实际一次都没重试。→ **事件流无法区分"真的重试了"与"被拒绝重试"**。
- **为什么（验证视角）**：这击穿规格 §三-9"Trace 完整率 100%"。事件齐全的 run 可以是**系统性错误归因**的 run。**完整性 ≠ 真实性。**
- **怎么验证**：`pr-harness-fault-recovery.regressions.test.ts` 的 `[C2-1]/[C2-3]` 把当前行为 pin 住（修复者会看到断言主动失败）；`[C2-2]` 断言 `retryable:false` 时执行次数 == 1——即**用副作用计数，而不是事件计数**来判定。
- **处方**：任何"是否重试/是否恢复"的判定，必须用**副作用计数或幂等键**，而非事件存在性。N7 已有先例：token 用 `costBudget.charged` 逐值对账（`N7-RESULT:129`）。
- **最容易被伪造的方式**：把"发出事件"当作"发生了动作"（本仓库已经真的这么干了）。

### C6 — DEFECT-2 与 D6 证明：**安全结论依赖事件流，而事件流有已知盲区与已知错标**
- **主张**：工具层权限拒绝时安全事件流上看不见（`tool-call-controller.ts:571-578`、`:588-595` 只发 `tool.failed`）；且 **256/256 个 baseline arm 的安全记录被错标 `armId="candidate"`**（D6）。
- **为什么**：规格 §三-2 要求安全指标设硬门槛。硬门槛建立在**会漏报、会错标**的流上，等于没有门槛。
- **怎么验证（红队 R2 修正）**：`security-evidence-execution.ts:125` 的 `MISSING_EXPECTED_EVENT` 带条件 `expectation.expectedAttack || expectedDenial`；而 `securityExpectationFromCase()`（`:152-167`）显示期望**只来自 case 定义**的 `forbidden.*`/`expected.status==="denied"`。→ **DEFECT-2 在"声明过期望"的用例上 fail-closed，在"未声明"的用例上 fail-open**。缺口的可见性取决于用例作者的声明，而非缺口本身。
- **失败模式**：D3——`securityOutcome` 的 `ESCAPE`/`hardBreach` 曾从**请求路径**派生 sentinel，复核时 `C:\tmp\chunk-test.js` **在工作区外并不存在**；但当前 HEAD 已改为**效应来源**（`security-evidence-execution.ts:44-45` 把 `escapedPaths` 钉死为 "paths the case **wrote** outside its workspace"），故属**历史判定语义缺陷，旧事实不可翻案**。该 arm 被判 `failureCategory="infrastructure"` → `isStrictValidArm=false`（`paired-executor.ts:100-105`）→ **整场测量作废**。
- **最容易被伪造的方式**：只读 `securityOutcome.violations` 计数，不看 `escapedPaths`、不看成功副作用路径。

### C7 — `load-runs.ts:43` 的 `events: []` 断层：**证据在链路里被静默丢弃**
- **主张**：`resultToOutcome()` 对 report-object 形态**硬编码 `events: []`**，而同文件的 `verification_passed`/`termination_reason` 未被搬进 `events`。
- **为什么（这条最危险）**：它不撒谎，它**沉默**。下游 `harness-metrics.ts` 会算出 `trace_completeness=0`、验证状态 `null`。D4 M8 指出其后果是**假 BLOCKED**（误杀方向），比高估更隐蔽。
- **怎么验证**：直接读 `packages/evaluation/src/load-runs.ts:43-48`；`EVIDENCE-INDEX.md` §6 已如实登记（并明确"并非既有 bug，而是用法断层"）。
- **处方**：**必须区分"未验证"与"验证失败"**（见 §3）。我反对把缺失焊成 0——`SPEC-CONFORMANCE.md` §二末的纪律（缺数据 = `value: null` + `INSUFFICIENT_SAMPLE`，**绝不把缺失当 0**）是本 PR 最好的一条设计。
- **最容易被伪造的方式**：让缺字段在类型上表现为 `0`/`false`，于是"没验"与"验了没过"在报告里长得一样。

### C8 — N7：**1 个作废 arm 即整场不可推断**，`NOT_PROVEN` 的根因是**两类独立原因**
- **主张**：`NOT_PROVEN` 不是"效果不好"，而是"基础设施未合格 + 描述性数字未达标"两类独立原因共同造成（`N7-RESULT:9`）。
- **为什么**：**当测量本身不合格时，唯一诚实的输出是"无结论"**，而不是"虽然作废但看起来差不多"。
- **怎么验证**：`judge-result.json` 13 条门限中 `infrastructure_qualified` FAIL（`status≠COMPLETED`）、`full_frozen_grid` FAIL（`partial=1`）。D1 已勘误：campaign 与 judge **两层都要求零作废**，`completionRatio >= 0.95` 是恒真冗余条件（`paired-executor.ts:671`），"95% vs 100% 不一致"**不成立**。且 `--resume` **无法**修复：executor 对已进 journal 的 arm 一律跳过、不看 `valid`（`paired-executor.ts:565-575`）。
- **失败模式**：删除 journal 条目重跑 = **销毁证据 + 按结果挑样本**（本场未做，纪律正确）。
- **最容易被伪造的方式**：把作废 arm 从分母里悄悄剔除，于是 "255/256" 被当成 "256" 汇报。

---

## 3. 三个必须正面回答的机制问题

### 3.1 如何区分"未验证"与"验证失败"？（这是最容易被工程实现搞混的一点）
我的判据是**三元而非二元**：

| 状态 | 含义 | 观测判据 | 下游处置 |
|---|---|---|---|
| `PASS` | 断言集非空且全过 | `checks.length > 0 && every(passed)` | 可宣称完成 |
| `FAIL` | 断言集非空且至少一条不过 | `checks.length > 0 && !every(passed)`，**附失败证据** | 不得宣称完成；可重试/返工 |
| `NOT_RUN` / `INSUFFICIENT_SAMPLE` | 断言集**为空**、verifier 未配置、或数据缺失 | `checks.length === 0`（`task-verifier.ts:68` → `level: 0`）；或 controller 在 `requiresVerification` 但无 verifier 时返回 **`blocked`**（`verification-controller.ts:68-76`） | **禁止宣称完成，且不得计入"成功"** |
| `BLOCKED`（新） | verifier 崩溃 / 绑定漂移 | `runtime-verifier.ts:97-121` 的 `INTERNAL_ERROR` 合成 check | fail-closed |

> **我自己的缺口（红队自击 A2，见 rebuttal）**：`VerificationGateResult.status` 只有 `"passed"｜"failed"｜"blocked"`（`verification-controller.ts:14`），**没有 `"not_run"`**——"未跑"表现为 `return undefined`（`:75`）。**`undefined` 与"未验证"共用表示，正是我 C7 批评的"缺失与失败同形"。→ 我的四态处方在本仓库尚未落地。**

**含 `NOT_RUN` 在内的三者分母必须分开报告**。把 `NOT_RUN` 计入 `FAIL` 会低估 harness；计入 `PASS`（或计入分母后当"没通过"）会**高估或低估**，两种都是伪造。规格 §三 note 6 已提醒对称风险："完成声明准确率不等于召回率——还要观察 Agent 是否因过度保守而把可完成任务标记为失败。"

### 3.2 验证者崩溃/被绕过时如何 fail-closed？
四层，逐层默认拒绝：
1. **异常层**：`runtime-verifier.ts:97-121` catch → `blocked`（已实现 ✅）。
2. **缺失层**：`verification-controller.ts:68-76`：`requiresVerification` 且无 verifier → `blocked`（已实现 ✅）；空 specs → `TaskVerifier` 确定性 `level 0 / passed false`（已实现 ✅）。
3. **验证器存在性层**：还需"证明验证器本身运行过"——verify 入口必须有 CI 引用与执行证据。`pnpm docs:verify` 覆盖的是文档一致性，**不覆盖"归档校验脚本确实跑过"**。
4. **绕过层（最弱）**：**被验方能否改写验收断言**。`task.verification` 来自 task spec，但 run 内可写文件系统——若断言来自工作区内文件，模型可改它。规格 §七清单第 1 条要求"不可被 Agent 任意改写的验收标准"，**runtime 层没有把断言集摘要纳入 run 身份的强制机制**（N7 的 `planDigest`/`caseFingerprints`/`armDigests` 做了这件事——`N7-RESULT:87`——但属**评测脚本层**）。D3 补充：`execution-plan.ts:426-490` 的 `promotionEligible` 只约束"用什么环境跑"（`isolationStrength="strong"` + clean source tree），而 `:489` 的 clean-tree 检查由 `probeSourceSnapshot` 在**执行前**判定，**不约束 run 中的写入**。→ **明说：这一层没有生产实现，且我与 D3 联署为共同最大缺口。**

### 3.3 结论
`(变更集哈希, 断言集 + 其不可改写证明, 每条断言的原始输出, passed/total 计数, verifier 身份与版本)`，且 **`NOT_RUN` 必须显式存在并独立计数**。没有 `NOT_RUN` 槽位的证据模型，一定会在某个环节把"没验"读成"验了"。

---

## 4. 我认为被高估的三件事

1. **"Trace 完整率 100%"被高估**。DEFECT-1 证明：**事件齐全的 run 可以同时是系统性错误归因的 run**。"发出事件"≠"发生动作"。规格 §三-9 只度量**可关联性**，没度量**真实性**。我主张补一条硬指标：**关键状态变更必须能由副作用计数/幂等键独立复算**（N7 的 arm metrics vs 请求 tape 对账即正确形态，哪怕它 FAIL 了）。

2. **"独立 verifier"被高估，除非同时证明断言集不可被被验方改写**。本仓库 `TaskVerifier` 在**机制上**干净（空 specs 必 false、异常必 blocked），但断言若来自 run 内可写文件，"独立"只是名义上的。规格 §七清单第 1 条点到了，runtime 层实现**没有**。

3. **"证据文件存在"被高估**（由真实证据反证）。N7 归档有 9,699 条 SHA-256 摘要、13 条门限、`judge-result.json`——**却因只有摘要没有原件，第三方无法独立复算**（`N7-RESULT:109`、`N7-ERRATA:24`）。再加 D4（校验脚本从未执行）与 D5（一个格式标记字段 `armDigestFormat` 就让复算报 `EXPERIMENT_BINDING_DRIFT`），"归档存在 = 可审计"在**这份真实证据上已被证伪**。**可审计性是原件+工具+固定源码点的联合属性，不是文件属性。**

## 5. 给讨论的 3 条可判真假的设计要求

- **R1**：任何报告"完成"的 run，必须同时存在**非空**断言集与其逐条原始输出；断言集为空必须报 `NOT_RUN` 且**不得**计入成功率分子。判据：`verification.checks.length > 0` 且 `status ≠ NOT_RUN`。
- **R2**：`NOT_RUN`/`FAIL`/`BLOCKED`/`PASS` 四态**分母分离**；缺数据一律 `null + INSUFFICIENT_SAMPLE`，**禁止落成 0**。判据：`harness-metrics.ts` 的 `computeSpecMetrics` 对空样本返回 `value: null`（指标层已实现；controller 层未落地，见 §3.1 缺口）。
- **R3**：验证入口必须有**被引用且被执行**的证据（3a：CI 引用 + 最近执行输出；3b：能在与运行环境无关的机器上复算出同一判定），否则该验证视为**不存在**。判据：D4 那条脚本修复前在 `*.test.ts` 与 `scripts/` 中检索 `verify-n7-archive` **零命中**——同一条检索可复现。<br>（3b 由 D5 补入：防"跑了但只有本机能跑"。）
