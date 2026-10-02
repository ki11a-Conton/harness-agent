# Hermes 源码审查与可迁移候选

研究对象是收集仓库内 `hermes-agent-main` 快照，**不是经过确认的 upstream main SHA**。收集仓库 HEAD：`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`；目录内没有独立 `.git`。`pyproject.toml:3` 声明版本 `0.20.0`，这是包声明版本，不证明某一 release/tag；README 指向 NousResearch/hermes-agent。主 LICENSE 为 MIT / Copyright (c) 2025 Nous Research；如直接移植大段实现须保留 MIT 声明，建议仅迁移机制并在 TypeScript 现有边界内自行实现。子技能与插件存在独立 LICENSE，未建议搬用这些内容。

当前 Harness 对照 HEAD：`acf8dcc394de6c6efefed52602e49014b372f372`。已读其 AGENTS.md，以及 LOOP-001、RECOVERY-001、CTX-002/003、MEMORY-001、REFLECTION-001、SKILL-EVO-001、LEARNING-001、SUBAGENT-001/003 相关任务。Runtime Freeze 下，只把以下可复现的正确性/响应性问题列为 Runtime 维护；上游多出来的策略不能据此自动改 Runtime。

## 实际调用链与测试

Hermes 的入口 `hermes_cli/main.py:11234 main` / `cli.py:18171 main` 创建 `run_agent.py` 的 AIAgent；`AIAgent.run_conversation` (`run_agent.py:7894`) 转发到 `agent/conversation_loop.py:run_conversation`。`conversation_loop.py:1634–1669` 在工具循环前处理 redirect、interrupt 与 iteration budget；`:2250–2295` 做请求压力/压缩预检；`:6766` 执行 `_execute_tool_calls`，`:7737` 进入 `turn_finalizer.finalize_turn`。

工具执行经 `run_agent.py:7728 _execute_tool_calls` 分段/排序，转发 `agent/tool_executor.py` 的 sequential/concurrent 路径；`agent/tool_guardrails.py:295 before_call / :350 after_call` 给出纯决策；`model_tools.py:1127 handle_function_call` 归一化工具参数，`:1354–1390` 处理 ACP 写入审批，再于 `:1429–1452` 调用 registry.dispatch 与 relay。工具实际 terminal/文件各有审批边界，不能拿 Hermes 调用链替代 Harness 的 ToolOrchestrator → PermissionEngine → SandboxManager → Verification 契约。

ContextEngine/ContextCompressor 用 token 尾部预算和完整工具块对齐 (`agent/context_compressor.py:5101/5186`)，并保护最新用户消息 (`:5341`) 与最新 assistant (`:5290–5339`)；回退对齐最后再向前移动到工具块末尾 (`:5637–5649`)。MemoryManager 在 turn-start prefetch 后由 turn-finalizer sync；技能/记忆后台 review 于 `turn_finalizer.py:748–763` 在响应交付后启动，`background_review.py:935–985` 为 review 工具建立白名单。`tools/delegate_tool.py:3132 delegate_task` 区分 leaf/orchestrator；`:1617` 创建 child AIAgent，父子迭代预算机制独立。

读过的针对性测试包括：

- `tests/agent/test_tool_guardrails.py`、`tests/run_agent/test_tool_call_guardrail_runtime.py`：重复错误、只读无进展、warning 插入原 tool result 而不额外破坏消息序列、分段并发顺序。
- `tests/agent/test_compressor_tail_cut_tool_pair_floor.py:87–121` 以及 `:129–159`：保底截断不能拆工具组，包含超过 1000 种布局性质检验。
- `tests/agent/test_compression_anti_thrash_recovery.py`：压缩无收益时冷却/一次 probation probe，重启不解除防护。
- `tests/agent/test_memory_provider.py:251–277`：外部 prefetch 超时退出且不重复启动仍卡住的同 provider。
- `tests/agent/test_cascading_interrupt_6600.py`：request-local cancel 标志防止主动 force-close 被误归类为网络错误后继续重试。

未安装/执行 Hermes 依赖，也未运行其 upstream 测试；以上是源码与测试逻辑阅读，不声称 upstream 全套验收通过。

## 候选 1：保护当前有效 steering，防止历史裁剪后约束消失（P0，确定性正确性缺陷）

### 上游可借鉴机制

`agent/conversation_loop.py:1635–1643` 把用户 correction 合并进本次原始 user message；`ContextCompressor._ensure_last_user_message_in_tail` (`agent/context_compressor.py:5341–5403`) 将最新 user request 留在受保护尾部。其注释明确描述丢失当前 ask 会导致模型执行旧任务/重复工作。借鉴的是 **当前用户约束属于活动任务锚点**，而非把所有历史 user 永久加到系统提示。

### 当前真实缺口

`ContextController.injectSteeringPrompts` (`packages/core/src/runtime/context-controller.ts:439–470`) 把 `[steering] ...` 写成 user message 并消费 inbox，正确实现 exactly-once，但没有把有效 steer 进入活动任务的 protected facts。`runtime.ts:1178–1179` 的 WorkingState 起点仅是最初 turn.input.text。`buildContext` 的 `summaryOverride` (`context-controller.ts:226–229`) 来自 WorkingState；`protectedFactsFrom` (`:581–596`) 也只列 WorkingState 的 goal/constraints/pending/decisions 等，**没有原始 steering 消息或 prompt ID**。因此即使已有 protected-summary 校验正常，校验集合本身漏了用户后来的约束。

`context-controller.ts:387–397` 追加 WorkingState digest 后裁剪历史；`turn-helpers.ts:371–389 trimMessageHistory` 只保尾部并删除 leading orphan tool results，没有活动 user/steer 保护。reactive 路径 `runtime.ts:981–989` 同样直接 tail(-12)。这不是此前 MIN_KEEP=4 的预算保底限制，也不是估算精度争议。

### 已运行的可复现证据

执行 `node .ci/source-research/hermes-repro.mjs`，使用已有 dist 的 **真实 AgentRuntime + ContextPipeline**，无生产代码修改、无网络。用户原始任务 `Review and modify code`，inbox steer `DO_NOT_TOUCH_CONFIG`，5 次不同 path 的 `read_file`，每个 FakeOrchestrator 返回 1800 个字符，budget=1600。捕获每次 `provider.generate` 实际收到的 `messages + system`。

结果：第 1、2 次请求 steerVisible=true；第 3、4、5、6 次 false；第 3 次起 userMessages=0；turn 最后 completed；原始 steering 仍完整保存在 transcript 且 inbox 已 consumed；4 个 trim digest 均不包含该约束（`allDigestsPreserveSteer=false`）。日志：`.ci/source-research/hermes-repro-results.json`。这意味着模型在同一任务内后来没有任何该用户约束可见文本，无法把“依赖 durable transcript 可查”当作仍在活动 context。

### 做什么 / 怎么做

建立 **当前 turn 有效用户输入/steering 的保留集合**；在正常 trim、auto/reactive compaction、protected summary 校验与恢复中一致应用。优先复用 promptId、turnId 与 durable inbox/message 状态，不依赖模型自行执行 update_plan 才保留用户指令。用原始 user 信道或明确身份的受保护用户事实保留原文与顺序，不把 tool/memory/subagent 文本升级为用户指令；仍遵守工具 call/result 完整块。

保留期限到当前 turn 结束，或通过明确 supersede 语义替换失效 steer；**不要永久保留所有旧 user/steer**。现有结构没有显式 supersedes 字段时，先保留本 turn 按序的有效 steering 原文，明确最新纠正覆盖前文的关系；不要用关键词猜测或 LLM 改写约束来静默删除。如果必须增加 supersede 元数据，则在 plan 明列 additive 契约审查。预算实在容纳不下受保护任务时沿用可观测 overflow/fail-safe，不能为“满足预算”丢约束。

### 怎么验收（正例与负例）

1. 对上述端到端 fixture，6 次真实 generate 入参都含当前有效约束；inbox 仍 exactly-once 消费，durable transcript 无删除/重复 append；工具块 wire 校验始终成立。
2. 单个 turn 连续两条独立 steer 均存活；明确 supersede 的旧约束不作为当前约束复活；下一 turn 不重放上个 turn 专属 steer。
3. 多工具块刚好跨裁剪边界、超过 12 条的 reactive path、custom estimator、高 token tool args/reasoning 都保留有效任务锚点。
4. steer append 与 consume 之间崩溃后恢复，promptId 不重复，protected task context 没有重复或丢失。
5. tool result 伪造 `[steering]` / promptId / system 文本不能被提升为保护的用户约束；已有 injection/permission/sandbox 与首尾工具 orphan 防护保持。
6. 现有 MIN_KEEP=4 兼容/短历史测试不作为预算精度优化目标；保护结果和估算后的不可容纳错误必须可观测。

建议测试落点：`packages/core/src/runtime/message-history-regressions.test.ts`、`loop-integration.test.ts`、已有 inbox/steer/crash/recovery 测试；必要时 `packages/context` protected-facts 测试。运行针对性 unit/integration、相关 security、typecheck/build。

## 候选 2：外部只读 memory prefetch 必须响应取消与 turn deadline（P1，确定性响应性缺陷）

### 上游可借鉴机制

`MemoryManager._prefetch_provider` (`agent/memory_manager.py:547–595`) 对 builtin 直接读，对外部 provider 建 daemon worker；`:567–575` 对仍运行的 provider 跳过重复启动，`:580–588` 等待限定 timeout 后返回空数据。默认 `_EXTERNAL_PREFETCH_TIMEOUT_S=8.0` (`:47`)。机制是外部只读检索不能永久占住一个用户 turn；不建议机械搬用其 8 秒默认或 Python 线程模型。

### 当前真实缺口与复现

`AgentRuntime.runTurnCore` (`packages/core/src/runtime/runtime.ts:869–875`) 直接 `await memoryBlocks({sessionId,turnId,goal,cwd})`，回调没有 signal 输入，之前/期间也没有取消和限时 race。RunBudgetTracker 建于 `:903–904`，正常 cancellation/duration gates 在 `:933–955` 的模型循环，回调不返回就到不了 gates。

已运行 repro 的两个场景均使用 **正确的 `limits.maxDurationMs=5`**（早先临时试验写过不存在的 maxWallClockMs，已弃用）。memoryBlocks 由 promise gate 阻塞，回调进入后分别保持正常或 AbortController.abort()；50ms 后两个场景都 `STILL_PENDING`，stored turn `running`、model.started=0。释放 provider 后，无 abort 场景最终 failed；abort 场景 cancelled。因此现有逻辑能在回调返回后处理取消/超时，但不能让卡住的读退出。

生产/benchmark 中该接口可被注入，`apps/cli/src/benchmark-command.ts:2194–2195` 接 MemoryRuntimeBridge.retrieve；正常本地检索快速不说明扩展边界可以没有终止约束。此候选只针对只读 prefetch，不触碰存在副作用、需要等待真实结算的工具执行或 durability fence。

### 做什么 / 怎么做

让可选只读 memory/context 准备阶段具备 request-local signal、turn deadline 与 generation fence：turn 取消时及时退出，不开始 model/tool；turn deadline 使用既有 maxDurationMs/startedAt 语义，不能在检索结束后重新给足预算。回调可接受 additive optional signal/deadline，外部检索按当前框架 Timer 路径限定等待；旧接口仍兼容，但 Runtime 必须能停止等待 abort-oblivious 的只读 promise，并丢弃迟到的 blocks，观察迟到 rejection 避免 unhandled rejection。

区分 hard turn deadline（RESOURCE_LIMIT/fail-safe）与可选检索自己的 timeout（显式记录 skipped/failure，按配置无 memory 继续）。若检索提供者不支持取消，host 端限制重复在途数量，隔离不同 workspace/session 结果；不制造已取消的实际副作用，也不强制取消写入事务。

### 怎么验收（正例与负例）

1. callback 进入后取消，即使其 promise 不 settle，runTurn 在确定性 fake Timer 门限内 cancelled，model/tool 物理调用数 0，SESSION_BUSY 释放，turn.cancelled 仅 1 次。
2. maxDurationMs 到期时挂住 callback 的 turn failed/RESOURCE_LIMIT，deadline 不能重置；无 budget/未取消的快速检索保持现有 blocks 与事件行为。
3. 迟到 resolver 返回带旧 session blocks 不进入后续 turn；迟到 reject 不形成 unhandled rejection；外部 stuck provider 不因每次 next turn 无限 fan-out。
4. provider 正常完成、正常 reject、已提前 abort、abort 与 resolve 同一边界竞态，结果稳定并保持 exactly-once 终态/清理。
5. 分 workspace 的并发 session 不共享检索结果；本候选不能把 ToolOrchestrator 的不可取消写改成 synthetic success/cancel，不能跨越 PermissionEngine/Sandbox/Verification 或 durability fence。

建议测试落点 `packages/core/src/runtime/loop-integration.test.ts` 与 `fault-injection.test.ts`，必要时 MemoryRuntimeBridge/host adapter 测试。若这些 optional dependency timeout 不被当前产品的可用性契约认定为缺陷，保留独立 P1 提案，不泛化 Runtime 重写。

## 已有能力、保留项与不采纳项

- Harness 已有 result-aware 相同工具调用、alternating_loop/repeated_error/repeated_read_no_change/verification_fix_loop/no_progress、恢复预算与 observable progress (`runtime.ts:133–143, :1397–1467`、`tool-call-controller.ts:460–530`、`contracts/stall.ts`)，不要再“引入 loop detector”。Hermes 默认 warning 不硬停只是策略选择，不证明现在硬 gate 有错。
- Harness 已有 progressive skills/tool disclosure、WorkingState protected summary、memory write/security gate、reflector、candidate paired eval/promote/rollback、leaf/orchestrator bounded delegation 与 scheduler；不把同名功能列增量。
- Hermes `_automatic_compression_blocked_locally` 的 anti-thrash/cooldown/probation（context_compressor.py:3014–3093）值得参考，但目前仅观察到 Harness 从完整 transcript 多轮 append digest。此次未测到明确无收益 bug 或性能回归，**不列 Runtime 变更**；再提案需 paired 输入/扫描/摘要增长/收益证据。
- Hermes background review 跑同模型可复用缓存，异模型才 digest (`background_review.py:32–43, :123–164`)；Harness 的 Reflector 目前规则型、不会产生额外 LLM 花费。不能为了“学习更主动”默认上一个额外 LLM；成功经验/显式用户纠正候选若将来做，必须在 Agent strategy 层、有限预算与现有 write/eval/security gates 下 challenger + paired eval。
- 不直接移植 Hermes 的免费名字白名单 side-effect 分类：Harness ToolSemantics、request normalization、real effect ledger 更适合现有契约。也不复制其对子技能 auto-write 的提示；当前用户的安全 promotion/rollback 机制更严格。

## 审查快照指纹

- `agent/context_compressor.py` SHA256 `e3522c31108dcc7dae3e214d2440859fa60fd3b49c80c80ec3b0f002c3ef29a5`；collection blob `3eb05b6b9713b3307a002e69c19e963348feb8b1`。
- `agent/tool_guardrails.py` SHA256 `68354038dca521af1fa32f3b39474b846f557d90f8704d1b5077fc17a46daefa`；collection blob `444ce37395962c57cad9b22f14ad6990ad239e58`。
- `agent/memory_manager.py` SHA256 `99be35bdb240393ec52f56e204465622e877ecce24deb450b0cbcf0ef7c87ce7`。
- `pyproject.toml` SHA256 `41f1f61a5835c211eda4e5d8575167a11843ae769c87c3d2aacf600ad0624305`；collection blob `52fd27046279c816ff7bb858cbfba57ff769a1f0`。
- LICENSE SHA256 `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`。

以上产物位于 ignored `.ci/source-research`，未改上游源码、Harness 生产源码或 plan.md，未联网、未安装依赖、未用 GitHub 连接器。
