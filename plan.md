# Harness Agent：开源 Coding Agent 源码驱动的优化计划

日期：2026-10-02。状态：**源码分析与基线验证已完成；下列生产实现尚未开始。**

本计划先分析用户提供的 Codex、OpenCode、Pi、Hermes、Claude Code fork 档案，再对照当前 Harness 代码制定。目标是让智能体正确处理模型中断、持续遵守用户约束、控制工具数据边界和安全修改代码；保留已有架构，随后用单变量评测验证策略收益。

## 1. 基线、证据与本轮交付

- 当前实现基线：`acf8dcc394de6c6efefed52602e49014b372f372`。合集已克隆到 `/workspace/HARNESS-SRC-FORK`，固定提交 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`。
- 上一份已完成的长会话计划原样归档为 `plan(20261002-message-history).md`；先前安全、工作区知识、上下文压缩、消息完整计量和线性裁剪交付均保留。
- [源码汇总与取舍](docs/research/source-agent-review-20261002.md)；[六份独立对照记录](docs/research/source-agent-review-20261002/README.md)；[来源/指纹/实际反例 JSON](docs/evidence/source-agent-review-20261002.json)；[复现入口](scripts/research/README.md)。每条改进能追溯到上游机制、当前代码、触发场景和验收反例。
- 合集包含的是各项目快照，不等于已核实的 upstream commit。OpenCode 源码为 1.18.16，旧报告的 1.18.18 不作为证据。Claude 档案无开源许可证、构建配置和测试，只作为静态概念参照，独立实现本项目需求。
- 已重新构建当前基线并运行六组离线探针；当前已有能力的 10 个测试文件 / 119 项通过。**探针成功执行证明缺陷可复现，不证明优化完成。** 上游测试、真实模型质量评测、新实现验收均为 NOT_RUN。

## 2. 约束与选择原则

遵守当前 `AGENTS.md`、`HANDOVER.md` 及 TOOL/SEC/CTX/LOOP/VERIFY/RECOVERY/EVAL/BENCH 等任务契约。Core 不依赖 UI/provider/business/plugin；副作用仍走 ToolOrchestrator → PermissionEngine → SandboxManager；完成仍由 Verification 与真实证据判定。

R1–R6 有当前代码确定性反例，允许针对缺陷作局部维护，不重写冻结 Runtime。S1/S2 是策略或范围政策，先通过现有 CandidateRegistry、ArmFactory、paired executor 评测，不能以模型质量假设解冻 Core。

不重复建设现有子智能体、memory/skill、artifact、durable session、停滞检测、验收修复循环或 paired 平台。不给上游语言/框架增加运行依赖；不默认采用 NFKC/模糊首匹配写入，不弱化权限和沙箱。每个工作包先 RED 再实现，分别保留基线/候选证据。

## 3. 第一阶段：P0，先恢复三个关键边界

### R1 — 模型未正常结束时不执行工具、不标记完成

**做什么**：保留 provider 的真实终止语义，修复 length/content_filter 被映射 stop、自然 EOF 推断 tool_calls 的行为。

**依据**：Pi `packages/agent/src/agent-loop.ts:208–214` 及 length 测试拒绝截断工具批次；当前 `packages/model/src/openai.ts:464–489,528–532,587–589` 将缺失终止证据视为正常。离线真实 Runtime 已派发自然 EOF 中的完整 JSON 写调用到 FakeOrchestrator 一次。

**怎么做**：

1. 先写 fake SSE provider 回归和真实 Runtime 派发计数反例，区分正常 stop/tool_calls、length、content_filter、未知 reason、无 body、自然 EOF、显式 DONE 无 reason。
2. 首选在 OpenAI-compatible provider 使用现有 `finishReason:error` 与结构化 protocol error，保留局部文本、原始 reason 与已形成的工具意图供审计，不先扩全局 Runtime 状态机。
3. 利用 ModelCallController 已有错误边界，为未执行调用逐个补合法结果、终结本轮；异常结束不触发实际工具、不触发成功 Verification，不自动重试部分副作用。
4. 明确 DONE-only 的兼容政策：默认不派发无正常终止证据的写调用；若保留文本兼容模式，要显式记录协议证据和完成等级，不能把自然 EOF 同等处理。记录现有文本测试的兼容变更。

**怎么验收**：异常终止 fixture 的工具派发数全部为 0，即使 JSON/schema 完整；正常 tool_calls 控制为 1，正常 stop 行为保持。length/filter 不产生 completed/verified_complete；每个 assistant tool ID 恰好有一个未执行结果，后续 turn/resume wire 检查无 orphan/duplicate。取消、timeout、provider retry 与 usage 归因回归通过。

**改动范围**：`packages/model/src/openai.ts` 与测试；必要的 model/core 集成测试。只有现有 error 接缝确实不足且有反例时才修改 Core/contract。

### R2 — 长会话始终保留当前有效用户约束

**做什么**：把运行中加入的有效 steering 当作当前任务锚点，正常裁剪、reactive compaction、摘要和恢复后均继续可见。

**依据**：Hermes 保留最新 user anchor；当前 `context-controller.ts:439–470` 写入并消费 steer，但 WorkingState/protectedFacts 未保护它。真实六次模型请求的第 3–6 次丢失 `DO_NOT_TOUCH_CONFIG`，transcript 虽保留也不能代替模型实际上下文。

**怎么做**：

1. 将现有端到端反例转成常规回归；新增多条 steer、reactive tail、崩溃 append/consume 间隙和新 turn 场景。
2. 按 turnId/promptId 从 durable 消息/inbox 状态派生本 turn 的有效原始用户输入与 steer，在 ContextController 的 protected facts/summary 和 trim/reactive 路径使用同一集合。
3. 保留原文、顺序与用户信道身份，不靠模型调用 update_plan 才保护约束，不将 tool/memory/子 agent 文字升级为用户指令。
4. 保护期限到当前 turn 结束；没有明确 supersede 元数据时不猜测丢弃用户文本。如新增 supersede，单独审查 additive 契约并验证旧状态兼容。受保护任务无法容纳时走可观察 overflow，不能删除约束来满足预算。

**怎么验收**：原六次请求全部可见有效约束；normal/reactive/auto compaction、custom estimator 和大参数/reasoning 均保持当前任务及完整工具块。inbox exactly-once、原始 transcript、恢复行为不退步；多 steer 按顺序保留，新 turn 不错误重放上轮 steer；伪造 `[steering]` 的工具数据不能受保护或获得权威。

**改动范围**：`packages/core/src/runtime/context-controller.ts`、`turn-helpers.ts`、必要的 reactive 调用点及回归；复用现有持久身份，不另建状态日志。

### R3 — 工具输出安全处理与 UTF-8 预算一致

**做什么**：修复结构化结果/无预算分支跳过安全处理，以及 byte cap 使用字符索引、流 chunk 独立解码损坏 UTF-8。R3a 与 R3b 分别记录验收，不能互相代替。

**依据**：Codex 将结构化结果统一为模型 payload；OpenCode bounded output store 与 Codex UTF-8 helper 提供边界参照。当前 `context-controller.ts:482` 和 `orchestrator.ts:625–632` 只覆盖字符串；executor collect/sandbox drain 把 bytes 当字符数。已复现对象安全 hooks 0 次、8-byte 返回24-byte、emoji跨 chunk 损坏。

**怎么做**：

1. R3a：先构造模型原本会看到的文本，再脱敏、检查、按需生成 artifact/preview；安全 hooks 与是否启用预算分离。保留 ToolResult 原始对象、status、exitCode、evidence 和调用方结构契约，不能粗暴将所有输出改为字符串。
2. artifact 只存脱敏后的完整可捕获数据，字节/SHA/sensitivity 与登记一致；超阈值对象 stdout/stderr 通过头尾预览与引用供模型使用。注入数据沿用现有审计留存与回读检查，不能通过 artifact 回读旁路。
3. R3b：抽小的 byte-aware 输出 collector，复用到普通、argv 和 sandbox prepared-launch 路径；采用增量 UTF-8 解码，预算落在字符中间时退到完整边界，onOutput 事件同样无损。
4. 分开定义进程 stdout/stderr 捕获上限、orchestrator payload 限额、context inline 落盘阈值与 preview/marker 开销。明确 cap=0/小于标记时的口径，不以取消硬上限换取完整 artifact；超限继续 drain，避免管道死锁。

**怎么验收**：

- string/object/未启用预算的安全 hooks 一致；模型文本、preview、artifact 均无测试 secret；注入被阻止且事件关联 toolCallId。真实 exec 对象超阈值不原样进入下一请求。
- 合法捕获范围内的脱敏全量 artifact 字节与 SHA 正确；失败、null/undefined、小对象、序列化失败按明确契约处理；raw result 不被修改。
- ASCII/CJK/emoji/mixed EOL，cap=0/1/2/3/4/8/边界±1，主体 byte 不超声明预算；无因截断新增的 surrogate/replacement。合法 UTF-8 的各字节分割位置，聚合与 streaming events 都保持完整字符。
- stdout/stderr 独立，truncated/status/exitCode、timeout、取消、树清理、callback error、permission/sandbox deny 和 budget settlement 保持。资源占用随配置 cap 有界，不先保留无限 raw 输出。

**改动范围**：`packages/core/src/runtime/context-controller.ts`；`packages/tools/src/orchestrator.ts`、`process/executor.ts` 的局部 helper；相关 unit/integration/security 回归。不修改安全后端或 shell/argv 解释规则。

## 4. 第二阶段：P1，提高代码编辑与知识准备可靠性

### R4 — 协作编辑不丢更新，保留文件格式

**做什么**：修复跨 session 协作 read-modify-write 丢更新；提供显式读版本前置条件；让 CRLF/LF/BOM 和未修改区域不因小编辑漂移。

**依据**：OpenCode canonical lock + expected bytes conditional write；Pi 原始行块与 EOL/BOM 保留。当前 edit-file 两 session 都 success 却丢一项修改；`applyLineRange` 把 CRLF 改成混合换行。

**怎么做**：

1. 在 tools 层按实际规范文件身份共享 keyed lock，锁覆盖协作调用的 read→transform→write，并纳入 write_file/相关 transaction 参与者；不同文件保持独立。锁在原有权限、沙箱、durable intent 边界内使用，异常/取消释放。
2. 增加 `expectedSha256` 前置条件，基于原始 bytes。通过 opt-in 版本化 read_file 模式把 hash 放入模型可见结果，同时保留默认 string 输出兼容。严格编辑 profile 对 range/不明确锚点要求读取版本；旧 API 的显式兼容范围必须记录，不能声称未传版本也能防全部过期编辑。
3. hash 失配明确 stale、零写入并要求重新读/计算，不自动重放原写请求。保留 first/occurrence/replaceAll 及现有 lineEnd clamp 合同。
4. 匹配视图可规范 LF，但 offsets/原始行块用于最小修改；保留 BOM、未触及字节和末尾换行，混合 EOL 不全文件统一。不默认 fuzzy/NFKC/智能引号归一化。

**怎么验收**：两个 session/两个 orchestrator 的 barrier fixture 可两成功合并，或一成功一明确 stale；不能两 success 丢更新。版本不匹配与等锁取消均零写；同内容仅mtime变更不误拒绝；别名同锁、不同文件无全局阻塞、lock entries清理。LF/CRLF/mixed/BOM/无末尾换行/中文/emoji的输出逐字节符合预期。歧义、missing anchor、旧API和越界/symlink/permission deny回归通过。

**保障边界**：进程内协作 mutex + 写前 hash 不承诺任意外部编辑器/跨进程原子 CAS；atomic rename 也不等于 CAS。跨进程保证另行设计。项目支持 Windows，需对应平台实测，Linux证据不能冒充Windows。

### R5 — 技能索引、正文与安全策略按版本刷新

**做什么**：消除上层永久 bodyCache 遮蔽 loader 现有刷新，以及删除技能仍注入的行为。

**依据**：当前 `harness/src/skill-context.ts:89–123` 缓存索引/正文，绕过 `skills/src/skill-loader.ts:119–125` 的最新文件检查；可见档案的 change detector 提醒索引/正文/发送状态需要一致失效。

**怎么做**：先移除或 revision-key 外层无版本正文缓存，让被选技能经过现有 loader 安全检查；在明确的下一 step/turn 刷新索引和 manifest/requiredTools/provenance，保留已经冻结的在途 step。cache key 包含文件身份、revision 和配置，不只名称；删除、重命名、新增和同名不同路径均处理。不新增 watcher 依赖，不每次请求全树重扫，不重复创建 cache 系统。

**怎么验收**：同 provider load→修改→load 读新正文，删除后不再注入；requiredTools 更新超 host policy 则 denied，更新含 secret/injection 则安全拒绝。当前 step 内容/身份仍固定，下一 step采用新版本；缓存/config/workspace隔离保持。不变文件正文read次数保持现有缓存水平；受控revision/fake fs测试证明不新增每次全树扫描。

### R6 — 只读 prefetch 遵守取消和 turn 期限

**做什么**：挂住的 memoryBlocks 不能占住已取消或超过 maxDurationMs 的 turn。

**依据**：Hermes bounded external prefetch；当前 `runtime.ts:869–875` 在预算与取消循环前 await 无信号回调，复现正确 maxDurationMs=5 / abort 后仍pending。

**怎么做**：以turn实际执行起点建立既有期限，不在检索后重置；给只读回调 additive signal/deadline，host停止等待不响应abort的promise，隔离迟到结果并观察迟到rejection。区分hard turn deadline与可选memory检索timeout；限制未结束的外部provider在途数量。保留恢复budgetseed与工作区隔离。只处理只读准备，不提前结算真实写工具或durability fence。

**怎么验收**：callback不settle时，fake Timer触发取消/期限仍得到一次正确终态、model/tool调用0、SESSION_BUSY释放；迟到resolve不污染下轮，迟到reject无unhandled rejection；快速检索、provider reject、提前abort、同边界resolve/abort、并发workspace场景一致。长久卡住的provider不会每次新turn无限增加在途工作。

## 5. 第三阶段：Agent 策略，先实验再决定启用

### S1 — diagnostic_first_repair_v1

**做什么**：让智能体在收到自动验收的 `exit 1` 时取得具体失败诊断，避免猜测修复。当前失败修复循环已存在，不能重新实现。

**怎么做**：基于已复现的 TaskVerifier诊断丢弃轨迹，先注册独立 experimental Agent策略：通过现有exec跑targeted tests、读取脱敏且data-only诊断、定位修改，再由原Verification gate判定完成。复用真实completionGuidance/ArmFactory安装与digest，不只加flag。若将来扩大VerificationResult诊断字段，先定义bounded/redacted数据合同，不能直接拼raw stderr进system。

**怎么验收**：相同模型/初始树/预算/种子/任务的paired fixtures覆盖assertion定位、syntax error、修复后合法同命令重跑、重复同错、假PASS、secret/injection与预算耗尽。观察真实请求/工具轨迹及独立内容verifier；baseline/candidate确有单一语义差异。离线只验接线/安全/内容合同，实际模型收益按现有冻结paired决策报告，不修改truth判定或提前promotion。

### S2 — path_scoped_instructions_v1

**做什么**：探索只载入当前目标适用的root/package/file规则，减少兄弟包规则混入和必要规则漏载。

**怎么做**：先把OpenCode按读取目标找规则的机制与当前discovery合同做monorepo fixtures。明确合法workspace root、缺中间AGENTS是否继续、ancestor顺序、cwd优先级、文档额度和多target并集。通过ContextPipeline已有InstructionDiscovery接口与Harness composition可选适配器做challenger，不给Core引入项目依赖。目标来源使用获准的read/search/plan evidence，纳入现有instructionSources/step snapshot；文档继续untrusted/data-only。

**怎么验收**：三包互斥规则、root→package→cwd、额度1/2/4、目标切换、repeat-read、compaction/resume；检查必要规则可见且兄弟规则不污染，规则来源/版本可审计。..、root-sibling、symlink、workspace外、不可读、注入与多字节反例不扩大权限。paired记录正确内容结果、扫描/读取数、上下文token/bytes、回读次数；少token不能代替任务正确性。已有测试锁定的默认discovery行为不暗改。

**暂缓**：多位置编辑、整批工具结果预算、LLM反思/后台review、压缩anti-thrash等需各自failure cluster与测量。S1/S2也分别实验，不捆成一个不可归因候选。未有证据时保持当前默认策略。

## 6. 执行顺序、验收与交付

| 阶段 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| 研究（已完成） | 识别增量和边界 | 源码/测试调用链对照，固定快照与hash；离线反例 | 6组可重跑观察、119项现有能力回归、构建通过；计划每项有源码与反例 |
| A：R1/R2/R3 | 修关键安全/正确性边界 | 每包独立RED→局部实现→GREEN，保留现有合同 | 各包正反fixture、安全与wire回归；完整验收在冻结干净快照执行 |
| B：R4/R5/R6 | 修编辑与准备阶段可靠性 | 在A结果基础上分别实施；先版本/lock/cache/deadline合同 | 零丢更新、格式不漂移、刷新生效、取消/期限可结束；平台证据真实 |
| C：S1，随后S2 | 验证策略价值 | 失败聚类→单变量experimental候选→既有paired平台 | 真实安装/身份/内容和安全接线；模型收益另列实测，未跑则NOT_RUN |

实现时先创建基线与候选隔离工作树，更新对应tasks与证据；按包分别提交，不修改无关模块。每项证据记录实现SHA、source/schema/prompt/config digest、环境、命令、原始输出、实际通过/失败/跳过；不能借用旧全量验收或旧Windows attestation。

定向验收按本包新增测试及已有同目录unit/integration执行；R1/R2必须覆盖真实Runtime/wire边界，R3/R4必须覆盖Orchestrator与相关security，R5/R6必须覆盖生产组合与恢复/取消。每阶段生产实现冻结后执行：

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:security
corepack pnpm test
git diff --check
```

全量suite沿用现有Linux subreaper启动器/测试环境，完整命令与退出码记录证据，不并发改tracked source；只报告实际平台。Windows CI在新实现SHA运行后才计入Windows验收。

计划不得预填完成或承诺模型成功率。代码修复的完成条件是对应确定反例已转GREEN且必要回归全过；策略完成条件是候选接线/离线合同和真实paired评测分开报告，默认启用仍沿用现有证据规则。

## 7. 进度

- [x] 终端Git拉取、冻结合集与当前项目快照。
- [x] 分析五个agent家族核心源码/相关测试，核对当前Harness与合集旧快照。
- [x] 运行基线反例、当前119项能力回归，重建后重跑六组探针。
- [x] 保存源码指纹、复现脚本、分阶段取舍和本计划；归档上一份完成计划。
- [ ] R1：模型终止语义与未执行调用结算。
- [ ] R2：当前turn用户约束保护。
- [ ] R3a/R3b：统一输出安全边界与UTF-8预算/解码。
- [ ] R4：协作编辑/读版本/EOL完整性。
- [ ] R5：技能revision与刷新。
- [ ] R6：只读prefetch取消/期限。
- [ ] S1/S2：分开注册、评估并报告策略候选。
- [ ] 各实现阶段的冻结快照全量、安全与对应平台验收。
