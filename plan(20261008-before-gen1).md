# Harness Agent：当前执行计划入口

> **当前执行计划入口（P 轮 challenger：观测驱动的完成判定）**：2026-10-06 19:14。审查基线 `5340bbcf196f54b283ad4351ef057189a07aca0b`；本轮不可变规格 [plan(20261006-191434).md](plan(20261006-191434).md)。摘要：把"完成"从**意图陈述**变成**观测陈述** —— 新候选 `verified_completion_gate_v1` 要求报告完成前必须复跑任务自带的校验命令并引用观测输出，修不动则逐字报告失败；本轮只做工程实现与离线验收，**无模型效果结论**。

| 项目 | 做什么 | 怎么验收 | 状态 |
| --- | --- | --- | --- |
| P1 策略文本与注册 | 新 id `verified_completion_gate_v1`，经既有 `completionGuidance` 槽位安装，与其它引导机制互斥 | 真实 ModelRequest 含确切文本/digest；既有候选文本与 digest 逐字节不变；默认行为不变 | DONE |
| P2 接线 | registry / arm-factory / mechanism-contract / activation-evidence / 单一提示构建器 / champion 安装与配置 | 全链可解析；激活按本候选版本+digest 钉死（旧注入不算激活）；基线与既有臂身份不受扰动 | DONE |
| P3 工程验收 | 新回归覆盖文本义务与禁止项、digest 绑定、既有候选冻结、互斥、执行身份扰动、真实 Harness 提示注入 | 测试全 PASS；typecheck 干净；docs:verify ALL PASS；0 模型调用、0 付费 | DONE |
| P4 证据与状态 | 进度与证据文件记录 digest、测试计数、诚实边界（效果 NOT_RUN） | 证据入库并注明本轮未运行效果实验 | DONE |
| P5 离线补齐（B 项） | 任务合同、新候选预注册（结果之前冻结）、本机环境差异清单、README 候选登记 | 预注册两件 --check PASS + 12 项回归 PASS；环境差异清单入库；README 候选列表更新 | DONE |

> **P 轮执行完成**：P1–P4 全部完成（离线，0 模型调用）。完成记录与证据 [P-COMPLETION.md](docs/evidence/agent-p-20261006/P-COMPLETION.md)；门文本 SHA256 `7ef38a06…b546`，既有候选 digest 逐字节不变（csafe v1 `ce66f3b0…`、csafe v2 `52a80e9c…`、tool-call `ebddf5eb…`）。验收：新增 7 项回归 + 4 项真实 Harness 集成测试 + 34 项预注册测试通过；typecheck、docs:verify 通过。全仓 `pnpm test`：487 文件 / 8990 用例，8900 PASS、25 FAIL、65 skip —— 25 项失败中 10 个文件在拉取前即已失败（本机环境性），另一项曾因登记新候选移动基线臂快照而使 N7 holdout 预注册报 **`ARM_DIGEST_DRIFT`**（设计内 fail-closed）；已按操作者批准的路径用本轮冻结脚本**重新冻结**该预注册（`967da1dd…` → `7b675621…`）并同步更新 N7 验收记录（`holdout-prereg.log` / `unchanged-originals.json` / `artifact-index.json` / `RAW-MANIFEST.json` 重新自校验通过），该文件 55 项恢复运行，详见证据 §4.1。**效果结论 NOT_RUN**（未运行模型实验，未 promotion）。

> **当前任务：补齐 N7-4 / N7-5 / N7-6 的执行链**（2026-10-06）。做什么、怎么做、怎么验收见 [plan(20261006-n7-execution-chain).md](plan(20261006-n7-execution-chain).md)，任务合同见 [N7-EXECUTION-20261006.md](tasks/N7-EXECUTION-20261006.md)。当前审查基线 `d92d727689b9a2dc20bd09ea44348403f539def6`；工程补齐与真实模型实验分别验收，当前模型效果仍为 NOT_RUN。

> **执行链工程验收完成**：55 项新增回归通过；clean `85564f0` 全仓 8967 PASS、0 FAIL、12 项原有 skip，source/dist 指纹前后一致。24-call soak、512/192-run 执行器、ITT/实测命中 PP、双实验联合判定与归档工具已补齐。[完成报告与原件](docs/evidence/agent-next7-20261006/execution/acceptance/COMPLETION.md)；真实实验因模型凭据、价目、端点与隔离条件不足仍为 BLOCKED/NOT_RUN，候选未晋升。

> **当前入口（N7 challenger）**：2026-10-06 14:49。审查基线 `ea79130902824d73dafd6fd6bf02f8a8e38fe264`；本轮不可变规格 [plan(20261006-144930).md](plan(20261006-144930).md)；任务合同 [AGENT-NEXT7-20261006.md](tasks/AGENT-NEXT7-20261006.md)；上一轮（N6/N5）完成记录 [N5-COMPLETION.md](docs/evidence/agent-next6-20261005/N5-COMPLETION.md)。以下为上一轮（N6）计划正文，保留原字节。

2026-10-05（Asia/Shanghai）。审查基线 `65d8711aa4ffa8401d219fc9f0aef2bca93898d2`。[上一轮完成入口](plan(20261005-agent-next5-entry-before-next6).md)保留原字节；本计划的不可变规格 [plan(20261005-234821).md](plan(20261005-234821).md)；任务合同 [AGENT-NEXT6-20261005.md](tasks/AGENT-NEXT6-20261005.md)。

本次交付为代码审查、下一轮计划及Git提交。N1已完成；N2–N6是后续实施与验收要求，当前未实现、未激活、未promotion。上一轮8800项PASS属于上一轮源码验收，不能作为本候选的验收结果。

## 为什么做这一轮

1. [现有工具效率策略](packages/evaluation/src/mechanism-guidance.ts)的实际版本为 `tool-call-efficiency:v2`，含“do not re-read a file you have already read unless it changed”。它是opt-in候选策略，不能把它的边界问题直接归为默认Agent的已发生故障。
2. [生产压缩器](packages/context/src/compaction.ts)可把源文件tool evidence折叠成状态摘要；[Runtime摘要](packages/core/src/runtime/turn-helpers.ts)明确允许用read_file/search_files取回细节；[rehydration](packages/context/src/pipeline.ts)只恢复有限高价值引用，不保证全部原文仍可见。因此“历史读过且文件没变”不能证明“当前模型仍掌握修改所需原文”。
3. [离线实测原件](docs/evidence/agent-next6-plan-20261005/review-result.json)在clean基线调用实际MultiStageCompactor：原文sentinel从可见变为不可见，摘要仍记录读过文件，效率提示原句仍在；source/dist指纹不变，provider calls=0。这证明策略边界需要评测；夹具是构造的，不证明真实模型已出错或新策略能提高成功率。
4. 已有停滞检测和diagnostic_first_repair_v1，本轮不重复实现。借鉴收集仓库 `HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` 中 Hermes `tools/file_tools.py::reset_file_dedup` 及 `agent/conversation_compression.py` 的压缩后恢复重读原则；本项目已有正常读工具，采用Agent策略实验，无需复制其Runtime缓存/循环实现。

假设：**只在原文或必要证据已不可见时允许补读，能改善压缩后修复准确性，同时保留有完整证据时避免重复调用的收益。** 尚未证明该假设，不申请Runtime Freeze例外，不改Runtime架构。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- | --- |
| N1 审查及边界复现 | 找出已有策略与证据生命周期的缺口 | 阅读策略、压缩、rehydration、读工具与paired executor；离线调用生产压缩器，保留输入、输出、指纹及对照源码 | 原文从可见到不可见、摘要保留读历史、现有规则仍在；4份原件hash/bytes核验，0模型调用 | DONE |
| N2 冻结实验合同 | 防止提示词、case、统计口径随结果变化 | 预注册新ID `context_safe_tool_call_efficiency_v1`、完整英文提示文本及SHA256；冻结24个case、独立holdout、原verifier、AB/BA顺序、provider/model/参数/预算与两臂digest | 预注册在任何模型结果前提交；dry-run准确192个logical arm runs/实验；提示/源码/case/预算变化导致identity变化；未授权外部付费preflight为0 calls | TODO |
| N3 实现单一策略差异 | 区分历史读过与当前证据足够 | 新增独立候选完整文本，复用v2其余句子，只替换重读规则：证据仍可见且版本匹配则复用；压缩/截断/恢复后缺失必要原文则先补读再编辑；文件有更新仍按原规则重读。通过现有completionGuidance安装，不堆叠互斥候选 | 真实ModelRequest中出现确切候选文本/digest；旧v2原字节、digest及默认行为不变；flags-only、未安装或与baseline相同提示不得算激活 | TODO |
| N4 工程与安全验收 | 证明安装、预算与可信边界正确 | 新回归覆盖证据可见/丢失/部分缺失、文件变更、恢复、恶意源文件、无权限、预算耗尽；用真实Harness工具循环采集请求和事件，补读仍经Orchestrator/Permission/Sandbox；CLI/Web显式选择候选与默认对照 | 新测试无skip/todo；原verifier决定完成；缺诊断/读失败不伪报完成；default-off和互斥冲突fail-closed；typecheck/build、安全、集成、27项浏览器及同clean SHA全仓通过 | TODO |
| N5 成对效果评测 | 测真实任务质量及成本，验证假设 | 主实验A=原tool_call_efficiency_v1实际v2，B=新候选，其余配置/预算相同；复用buildPairedPlan与PairedExperimentExecutor，研究适配器显式解析两臂身份，不能将scheduler的baseline标签误当C0。另在独立holdout对当前生产champion进行成对复验 | 24case×4repeat×2arm=192 logical runs/实验，AB/BA平衡；只用完整有效pair统计，未完成/未激活如实报告；达到下述质量/成本门，不能用scripted、模拟effect model或更少token替代真实模型结论 | TODO |
| N6 证据、发布及回退 | 确保获胜策略才进入生产 | 保存raw requests/tool events/verifier/usage、source/dist/策略/case/digest，SHA256索引；既有champion流程正式promotion；关闭候选或回退到先前champion，重跑默认对照 | 两个实验和工程门全部通过才promotion；证据不足则保持candidate/NOT_PROVEN；回退不重置权限或预算；原生非force Git发布、local/Git/API SHA一致 | TODO |

## 策略实现边界

- 候选是soft guidance，不拦截或缓存读工具，不新增Core事件类型、不改变compaction/rehydration/Permission/Sandbox/Verification，不改变默认提示或历史候选digest，不提高迭代/工具/retry上限。
- 当前read_file只支持path与versioned，**不支持offset/limit**。需要源文件及条件编辑版本时调用read_file(versioned=true)，少量定位信息可使用既有grep_search；不能设计不存在的行读取参数。读取范围和输出必须遵守原工具、redaction和context预算。
- 文件/日志/摘要始终是data-only，不把正文或恶意“指令”升为system规则；提示词只能来自版本化常量。不得把“记得读过”、摘要或缺失原文当作当前文件的验证证据。
- 拟改路径限Agent策略注册/安装/实验：packages/evaluation/src/mechanism-guidance.ts、candidate-registry.ts、mechanism-contract.ts、arm-factory.ts、champion-harness-config.ts、index.ts，apps/cli/src/benchmark-command.ts、champion-application.ts，以及对应新增回归、研究适配器/夹具、docs/tasks。若发现需要其他生产路径，先记录理由并更新计划；不得为模型效果重写Runtime或改既有测试。

## 冻结case和量化验收

主实验24case：16个证据缺失case（压缩丢原文6、长输出preview/截断4、恢复后只有摘要/引用4、局部证据不足2）；8个控制case（原文仍可见且未变4、文件已变更2、诊断已知且合法重跑2）。每个case有独立fixture与原command verifier，避免同一模板换名字冒充独立样本。case顺序与4次重复在预注册固定，orderSeed只调顺序，不冒充model seed。实际请求必须展示缺失状态；未发生缺失或候选未安装要标为未激活，不能事后删case或选择有利结果。

独立holdout另24case、相同4重复，case仓库/具体任务不同且不能参与调prompt。baseline为执行时解析并冻结的实际生产champion，不能默认认定C0；其权限、原verifier及预算与候选一致。两个实验分别192 logical runs，共384；model-call attempts、transport retries、tool calls分别计量，不能将192当模型调用次数。

预注册以下门槛：主实验缺失证据组verified pass rate至少提升5个百分点；按case聚合、冻结seed的10000次paired bootstrap计算其95%单侧差值下界≥0；控制组成功数不下降，新增安全违规/false-complete为0。整体实际token总量≤baseline的110%，模型调用attempt总量≤110%，重复无进展工具调用不增长。baseline为0时用绝对非增长规则；usage unknown不可当0。holdout总体verified pass rate不下降、证据缺失组仍≥5个百分点提升，沿用相同成本/安全门。失败、预算中止、缺pair或缺激活证明均不能promotion，不放宽门槛来宣称完成。

预算、价目表、campaign费用硬上限、截止时间和已批准模型配置须在执行前绑定；全部沿用仓库现有付费preflight与budget ledger。本次没有模型凭据或付费实验预算配置，真实模型评测/promotion/Windows native均NOT_RUN，paid0。后续未具备这些执行条件时先完成离线安装与工程验证，保留明确NOT_RUN，不假造效果。

未来工程验收基线为472 PASS文件/8800 PASS测试和12个旧skip；要求全仓至少基线+新增，旧skip来源原字节不变，same-run严格usage7能力observed，source/dist逐文件hash前后一致。当前计划提交只执行docs:verify、证据校验与git diff --check，不声称本候选已通过全仓或浏览器。

## 本次计划交付的验收

计划包含问题依据、做什么/怎么做/怎么验收、实现范围、阶段依赖、效果门及回退；N1 DONE、N2–N6 TODO可区分。旧计划原字节保留，不可变规格与plan入口一致；[审查原件索引](docs/evidence/agent-next6-plan-20261005/artifact-index.json)校验通过；docs:verify和diff检查PASS。仅计划/任务/审查证据commit并原生Git推送main，禁用GitHub连接器；本地clean与原生Git/API远端SHA一致后交付commit号。
