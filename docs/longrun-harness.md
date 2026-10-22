# Coding 长任务 harness

本轮计划：[plan(20261020-161914).md](../plan(20261020-161914).md)。研究基线 main `eafcdb56fd266d6c862b5d3d910fcf5530e10fa0`。本说明描述能力与验收边界，不构成任意任务成功的承诺；最终结果见工作树外 `/workspace/harness-longrun-acceptance-20261020/README.md` 的精确源码 SHA。

## Harness 负责什么

模型提出下一步动作；harness 负责把目标、工作区、指令、工具和真实反馈组织成可持续运行的工程过程。一次模型停止不等于任务完成，摘要也不能代替执行账本。可用的长任务 harness 应能在多轮操作、上下文切换、验证失败、用户纠正和进程重启后，继续遵守同一任务的约束与预算。

因此，“多给 token”“把循环次数调高”和“加一个计划提示词”各自只解决一小部分问题。工程上必须同时回答：下一步依据什么事实、动作是否允许、实际发生了什么、失败如何反馈、完成如何验证、恢复后哪些动作不能重做、何时必须停止。

本轮读了两份公开工程材料，并对照实际源码：

- [Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：跨上下文工作需要可接手的环境、分步进展记录和实际测试；单独依靠 compaction 仍可能留下半成品或过早宣布完成。
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)：把意图、工具、环境和反馈变成模型能找到且工程机制能执行的约束；短入口指向结构化项目知识，避免把所有材料塞进一个大提示词。

原始网页与 SHA256 保存在外部证据目录的 `research/`。以下研究以本地固定源码为准；上游模型能力和产品体验不能由这些实现差异直接推出。

## 能力矩阵与源码依据

| 职责 | 参考源码中的做法 | 本项目已有机制与本轮判断 |
| --- | --- | --- |
| 指令与能力装配 | pi `packages/coding-agent/src/core/system-prompt.ts` 按实际工具组装提示；DeepSeek `packages/core/tools/src/index.ts` 的 register/ScopedLayers 管理工具生命周期 | 已有 capability-aware coding policy、工具 registry、step snapshot、路径指令与插件；不重复建立新 runner，也不默认推广未经真实模型评测的 prompt |
| 执行与观察 | Codex `codex-rs/utils/pty` 创建进程组，`core/src/unified_exec/async_watcher.rs` 分离进程退出与输出排空；pi `core/tools/bash.ts` 配合 `utils/child-process.ts` | 保留生产 ToolOrchestrator；P1 修复 POSIX 后代泄漏和继承管道导致退出码丢失 |
| 上下文与交接 | Codex `core/src/compact.rs` 提交 replacement history；pi `core/compaction/compaction.ts` 先读取 previousSummary 再决定保留范围；DeepSeek compaction-basic 检查配对、视图缩小与持久进展 | 已有自动摘要、手动＋入口、完整记录和检查点；C1 修正 overflow 重试先截尾、后找检查点的顺序错误 |
| 工作状态与持久恢复 | Codex rollout reconstruction 基于存活上下文重建；DeepSeek session-checkpoint-policy 在模型/工具 dispatch 前 flush、repair 区分未知工具结果 | 已有 WorkingState、JSONL/SQLite、checkpoint 与 tool ledger；D1 修正 actor 同一任务自动恢复未接入完整种子的问题，未知副作用继续对账而非重放 |
| 规划、修正与验证 | pi 将工具错误反馈给下一轮；DeepSeek plan-mode 将计划状态与权限状态分开；其 goal wrap-up 本身是模型指令 | 保留本项目更明确的 Verification gate：实际检查失败后有限修复，通过才可 verified_complete。U1 修复继续验证修复时漏记费用/输出和检查点漏预算 |
| 预算与终止 | DeepSeek goal-round-driver 经公共服务和 round cap 有界续跑；Codex 末尾检查 pending input | 已有 Web goal driver，失败不能靠自动换 turn 掩盖。B1 接通既有循环的显式轮数配置；S1 处理末尾纠正与 completion admission 边界 |
| 人类控制与并发 | pi 区分 steer/follow-up 并在停止前再次检查；Codex `session/turn.rs` 把 pending input 纳入后续采样判断 | 已有持久 inbox 和恰好一次消费；本轮补原任务末尾接收、原 turn 绑定，以及旧 drain 不能抢新任务 reservation |
| 安全与可观察性 | 三者都有执行/生命周期事件，但特权与沙箱模型不同 | 不复制其它宿主的授权路径。所有项目副作用仍经过权限、沙箱、编排和验证；预算/终止原因、原始回执与失败必须可审计 |

详细源码路径、符号/行号、已排除的假缺口、反例与许可分别见 [Codex 研究](research/longrun-20261020/codex.md)、[pi 研究](research/longrun-20261020/pi.md)、[DeepSeek Harness 研究](research/longrun-20261020/deepseek.md)。它们是研究阶段快照，不能代替最终验收。Codex/pi 材料来自收集仓库快照 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，DeepSeek 源码版本为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。

## 本轮确定性问题与修复

| 问题 | 修复与验收依据 |
| --- | --- |
| 超时/取消只杀根进程，普通后代仍写文件；继承管道又会丢失真实退出码 | 执行进程组清理、exit/close 分离、有界排空；shell/argv/受控 sandbox wrapper 和终态后写门验证。根已退出后的取消不改写真实 code |
| reactive overflow 的 last12 裁剪丢掉交接摘要 | 先形成检查点视图，再按合法工具边界缩减；旧事实、当前输入、纠正和重复 overflow 有界失败均有回归 |
| 公共宿主无法配置超过默认20轮；异步初始化又会重新读取已被修改的预算 | 显式有限配置、启动时捕获已校验值、冻结指纹与 Runtime 一致；CLI/Web/SDK实际请求、默认及非法输入对照 |
| 最后采样期间纠正留给下一任务，终止 await 窗口也能错误确认接收 | 成功终止前关闭 admission 并检查 pending；原任务内恰好一次消费，迟到请求绑定原任务并明确处理；JSONL/Memory未消费 steer 仍占原容量 |
| 旧 terminal drain 覆盖新任务 starting reservation | 异步发现后重新核验拥有的 actor 状态；双屏障证明新任务不会被旧 drain 抢占 |
| actor 同任务重启未恢复完整工作状态/账本/预算 | 沿既有 checkpoint/reconstruct 恢复种子；真实 JSONL/SQLite关闭重开，已提交写入不重做；缺完整预算或未知副作用明确拒绝，不授予新预算 |
| 全批工具已执行，但首个结果检查点水位覆盖全批而 state/ledger 只含第一个 | 整批 canonical 结果、工作状态、账本完成后才保存安全边界；双写后在首检查点崩溃仍恢复两次已提交动作 |
| 同毫秒 SQLite 检查点可能选中较旧的已花预算 | 保持 created_at 排序，并按插入 rowid 稳定倒序打破平局；重开、跨 session 与固定时钟真实恢复回归 |
| 验证修复漏记模型费用/输出，局部 context 预算覆盖完整 run 预算；部分完成早退也漏观察 | 完成采样先持久正文/usage，再单一记账，最后决定验证/终态；失败次数/反馈与完整预算进入检查点，cap 后不执行工具且协议配对完整 |
| 重放已超预算仍先发一个模型请求；成功验证检查点可能退还最后一轮 | 恢复后先检查已花费用/输出；用同任务非摘要 durable completion 作为采样轮数下界。已耗尽的费用、输出或轮数不再获得额外请求 |
| unsafe 流中断的可见正文只在事件里，会话与下次请求丢失 | C2 保存原字节及 incomplete 标记，failure fence 对齐 Web/SDK；模型视图明确是历史不完整数据。不开工具、不重放请求、不保存私密思考、不制造正常完成 |
| Windows CI 的两个 goal 集成测试整测超时；暂停测试外层20秒小于内部允许的10+15秒，另含初始化/持久写/收尾 | 受控延迟反例中业务等待和原断言均满足，旧外层仍误判超时。保留所有业务时限和断言，外层挂起保护统一120秒，并记录初始化、工具、暂停、终态和收尾阶段。原CI只提供整测超时，实际阻塞await尚不能由该反例反推；必须由新提交完整门禁复核 |
| 浏览器点击暂停时，普通后台轮次递增了目标版本，使刚渲染的按钮返回 goal/conflict | 后台领取轮次只推进 roundsStarted，不改变用户控制版本；保留人工修改与生命周期转换的严格 CAS。新轮次使用独立 round-N 请求编号，兼容旧数字编号/旧 pending，避免升级撞号；真实读轮结算、暂停后写入拒绝、投影水位、旧存储恢复均须回归 |
| todo 时间线验收只用400次×5ms循环等待完整任务结算，会把合法的较慢模型响应判失败 | 3.5秒首响应反例中任务最终完成且 todo 正确；仅该测试改为明确30秒、50ms间隔的终态等待，保留原完成谓词和内容断言。失败先显示缓存的任务状态，不序列化输入；不改变生产模型时限、Runtime预算或其它测试等待 |
| 公开恢复只继承检查点预算，遗漏水位之后原任务已持久化的费用/输出等消耗；其新 turn 又跳过已花预算预检 | 共享同任务恢复的预算回放，严格按原 turn 和检查点水位过滤，预检所有显式预算种子；新 turn、usedTurns 增量和重新开始的时长合同保持。费用0.4+0.8超过上限1及正文6字符超过上限5均须在任何新模型调用前拒绝；其它任务、水位内事件和摘要输出不能误计 |
| 重启 goal inbox 的测试在文件效果出现后，只用默认约1秒等待整个任务的持久消费；合法的后续采样会被误报为 promoted 卡住 | 第二次模型响应延迟3.5秒的反例复现同样错误，随后同一 prompt/turn 正常 consumed/completed、两次采样且仅一次写入。仅该 consumed 等待改为显式15秒，保留文件5秒等待和原身份/数量断言，补同步阶段诊断；不改变生产模型、持久化或消费顺序。反例不证明历史 Windows 的具体延迟位置 |

pi 研究快照中 C2 曾仅记录为后续候选，本轮后续已纳入上述实现和验收。容量修复沿用 JSONL/Memory 的既有 maxPending 选项；SQLite 原本没有同一容量选项，本轮不宣称其具有该限制。

公开恢复的尾账只包括既有可归属事件中的模型费用、聊天输出、工具请求及重试计数。缺少 turnId 的旧检查点保留原来仅继承检查点预算的兼容行为，不能由会话级记录推断原任务消耗；这类旧数据不具备精确尾账恢复保证。公开恢复仍是新 turn：保留已花计数、额外消耗一次 turn，并重新计时；actor 同任务恢复继续原 run 和已用执行时长。

浏览器草稿验收还必须区分“点击了目标行”与“已经进入目标会话”。9d6a10cf 的 Linux mobile CI 在点击 B 后读到 A 草稿，但原日志没有实际 owner，Chromium151 与 CI 同版本140的同源码安装包重放均通过，不能由此认定或排除生产泄漏。后续验收要求目标行选中、唯一可见目标会话和其输入框就绪后，在该 owner 内检查原草稿断言；未完成导航必须明确失败，不能继续读取旧视图，也不能仅等待草稿变成预期值。失败回执记录 owner 和点击归属。历史失败的具体原因与这一验收前提缺口分别记录，不用本地绿跑代替远端最终门禁。

3deee7dc 的 Windows mobile 验收随后提供了实际点击证据：目标行的 click 命中 SVG path 且位于 button 内，选中行和 owner 仍为原会话；新的归属门禁正确失败。这确认该次测试未完成导航，尚不能区分具体子按钮，也不证明9d6a10cf的原因相同。导航 helper 因而改为在精确 session 行中点击既有可见标题，再执行同一归属与内容检查；行内独立操作按钮继续保持原有语义，生产代码不变。标题点击不增加重试、预期文本等待或超时。

## 配置长任务预算

构建后，CLI/Web 可显式设置一次 turn 的有限采样轮数：

```sh
HARNESS_MAX_ITERATIONS_PER_TURN=45 node apps/cli/dist/main.js chat /path/to/project
HARNESS_MAX_ITERATIONS_PER_TURN=45 node apps/web/dist/main.js
```

PowerShell：先执行 `$env:HARNESS_MAX_ITERATIONS_PER_TURN = '45'`，再启动上述 Node 入口。变量只在进程启动时读取；更新后重启宿主。省略时保留原先的 20 轮，非法数字、零、负值、小数和非有限值在启动时拒绝。

公共宿主配置：

```ts
const harness = await createHarness({
  ...base,
  maxIterationsPerTurn: 80,
  limits: { maxToolCalls: 100, maxDurationMs: 600_000, maxEstimatedCostUsd: 2 },
});
```

轮数不等于工具数、时间或费用。默认工具上限仍为 50；提高轮数不会增加其它预算、放宽权限或在失败后自动开新任务。配置沿用 session_frozen/漂移检查；SDK 使用服务器冻结的预算，客户端不能临时提高服务器额度。

已冻结的会话不能通过重启并提高环境变量来静默扩大预算；需要按现有漂移策略创建新会话。缺少完整预算的旧/手工检查点会明确拒绝安全恢复，应检查实际诊断而非直接重跑未知副作用。

## 如何判断长任务确实可用

本轮确定性验收使用真实工作区、生产宿主、编排/权限/沙箱、真实文件和命令，以及本地 HTTP/脚本模型；没有付费模型请求。

- 超过 40 个有依赖步骤，读取实际文件、修改代码、执行检查；故意错误修改必须产生真实失败，模型实收反馈后修复，重新验证通过。
- 自动/手动压缩及 reactive overflow 后保留早期事实、当前任务与合法工具配对，完整历史不删除。
- JSONL/SQLite 关闭重开后保留同一个任务的工作状态、已用预算和执行账本；不能重复写入已提交动作或盲重放未知副作用。
- 模型最后采样、验证和终止窗口的纠正不能泄漏到下一无关任务；被接受的纠正继续原任务，已关闭 admission 的请求明确拒绝。
- 超时/取消后普通 POSIX 后代不能继续写文件；正常退出与管道排空分开，有界返回真实退出码。
- 类型、相关安全/协议/竞态、固定提交全量、实际 CLI/Web/SDK 入口及精确 SHA CI 统一留档。失败记录不删除，重叠测试不相加计算。

进程组清理不是 OS 沙箱，主动逃组的 daemon 不在其保证范围。Codex 的可轮询 PTY/后台进程句柄与本项目同步 exec 仍有能力差异，不能只靠放宽上限来补齐；引入前需要隔离、取消、恢复、授权和成效对照验收。

基础设施验收不证明真实模型能理解任意仓库、长摘要没有事实损失，或一次运行能完成任意大项目。真实模型任务完成率、摘要质量、缓存与费用收益继续标记 NOT_PROVEN，由线下实验提供证据。
