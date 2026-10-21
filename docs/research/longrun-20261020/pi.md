> 研究阶段快照：其中的实施/验收进度保留原记录；最终结果以本轮固定提交验收报告为准。

# pi 长任务 harness 源码研究与 Harness 对照

研究基线：Harness `eafcdb56fd266d6c862b5d3d910fcf5530e10fa0`，pi `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`。路径分别为 `/workspace/harness-agent-pr15-20261019`、`/workspace/HARNESS-SRC-FORK/pi-main`。以下源码行号默认指该基线。只将 pi 源码作为研究资料；没有执行其 AGENTS.md 或项目工作流，没有认证、付费模型、GitHub 连接器或子 agent。

已读目标根 AGENTS.md：Runtime frozen，必须是有确定反例的 correctness/security/release/infrastructure/performance 问题才可维护 Runtime；不能以模型质量为由重写。已读 tasks/UI-COMPACTION-RECOVERY-20261020.md、tasks/CODING-AGENT-RESEARCH-20261015.md、tasks/EXEC-DIAGNOSTICS-20261016.md，以及新任务 tasks/LONGRUN-HARNESS-20261020.md。最初研究只读；随后主线程明确授权在新工作树 `/workspace/harness-agent-longrun-20261020` 实施 C1，见文末。

源码 hashes：`/workspace/harness-longrun-acceptance-20261020/pi-study/sources-sha256.json`。原始离线探针与结果：同目录 `baseline-probes.mjs`、`baseline-probes.json`；actor 竞态另存 `actor-drain-race.mjs/.json`。这些探针使用目标基线已存在的生产 dist、真实 AgentRuntime/ContextPipeline/SessionActor 与离线 provider；不证明真实模型质量。C1 另有直接运行 TS 源码的红绿回归。

## 已证明的具体差距（六项）

### 1. Reactive overflow 在读取 checkpoint 前截尾，丢失已保存 handoff（C1，已窄修）

pi：`packages/coding-agent/src/core/compaction/compaction.ts:710` 的 `prepareCompaction` 先定位最近 compaction，`:726-732` 读取 previousSummary/firstKeptEntryId，`:738` 再算近期保留边界；`:785` 把 previousSummary 交给后续摘要。`:500-537` 的 update summary 明确保留旧摘要中的任务、决定和未解决错误。`agent-session.ts:2014-2021` 只从模型当前视图移除失败响应，原始历史保留。

Harness 已有对应能力，不能说“缺自动压缩”：`context-controller.ts:180` 应用 checkpointView；`:369-449` 是自动/手动历史摘要、原始尾部保留和 persist-before-publish；`history-checkpoint.ts:19-30` 根据 throughMessageId 构造覆盖视图。缺陷在 `runtime.ts:1262-1270`：明确 overflow 后先在完整 durable transcript 上按 last12 裁切，再进 ContextController；旧 checkpoint 在裁切中消失，后续 small tail 不触发新摘要。

确定反例：旧 handoff 含 `DECISION_SENTINEL_OLD_HANDOFF_271828`，后接20条短进度，所有消息都在10000 token本地预算内。首请求22条、有checkpoint、有sentinel；provider 返回明确 CONTEXT_OVERFLOW；第二请求12条、checkpoint=0、sentinel=false，仍 completed。原始store保留sentinel。没有任何摘要模型请求，这不是摘要模型质量导致的遗漏。

窄修：在现有 reactive 分支先 checkpointView，再取协议合法尾部；显式保留该视图首部 handoff，保留 current user/steer。没有新增执行循环、摘要调用或权限边界。已在新工作树 `runtime.ts:1270-1279` 完成；context-controller.ts 未修改。

验收：新 `reactive-checkpoint.regressions.test.ts` 基线2红1绿；修后3绿，覆盖旧事实、当前用户、晚到的durable纠正、最新完整工具batch、原始store不变、第二次overflow有界失败和取消不重试。相关8文件112测通过，`--maxWorkers=2`。证据 `context-baseline/reactive-checkpoint-red.log` 与 `context-green.log`。未自行全量、tsc、提交；Runtime文件已交还主线程/audit agent。

### 2. 最终响应期间接收的 steer 留给下一无关任务（S1，主线程实施）

pi：`packages/agent/src/agent-loop.ts:224-259` 在 turn_end 后再次读 steering；`:262-267` 在打算停止时读取 follow-up；coding层 `agent-session.ts:1077-1104` 在 post-run 再检查 extension 的 agent_end handler 新排入的消息；`:2201-2203` 在auto-compaction完成后也恢复排队消息。两个队列的意图区分明确。

Harness 已有独立持久 steer/followup 和 exactly-once，不能列成无队列：`session-actor.ts:424-429`、`:1371-1378` admit steer；`context-controller.ts:649-681` 在采样边界按promptId去重、bind→append→consume；followup另有两阶段promotion。缺陷是最后一轮模型采样结束到验证/终止期间没有再检查已接收steer。

确定反例：在 model.completed 的事件持久化边界持有首轮响应，调用 actor.steer，释放响应。A completed；inbox仍pending且未绑定turn。之后启动无关B，纠正才被绑定/注入B。探针输出 firstStatus=completed、requestsBeforeNextTask=1、correctionAppliedToTurn==nextTurn。等待 actor 原有 drain 结束后再启动B，避免把下面第6项竞态混入本反例。

建议/验收：在原终止安全边界、验证前，经既有inbox接入已接收steer，继续同任务的下一采样。原始promptId只消费一次；followup仍为future turn；预算/取消/验证依旧约束；A只有一次terminal事件，B不继承A纠正。该项主线程正在 model-call-controller.ts 实施，本agent未改该文件。

### 3. POSIX “killDirectTree”只杀直接child，终态后后代继续运行（P1，交叉验证）

pi：`core/tools/bash.ts:102-117` 在POSIX spawn detached进程组，abort调用killProcessTree；`utils/shell.ts:200-224` 对Unix首先 `process.kill(-pid, SIGKILL)`，失败再回落到child。

Harness：`packages/tools/src/process/executor.ts:470-499` 名为killDirectTree，Windows确实等待taskkill树终止，但POSIX分支只有 `child.kill(SIGKILL)`；`:588-596` 和 `:662-672` spawn没有独立进程组。`executor.test.ts:66-74` 名为no orphan，实际只断言status=timeout，没有观察后代是否退出。

确定反例：真实runArgv启动父Node，父Node启动普通孙进程后保持运行。500ms超时或主动取消后返回timeout/cancelled，孙进程 `kill(pid,0)` 都仍成功。探针自行kill清理孙进程；没有遗留进程。与Codex研究agent独立交叉命中。

窄修建议：在既有ProcessExecutor的POSIX路径建立独立group，终止整个group并有界确认收尾；shell/argv、cancel/timeout均覆盖，保留Windows现有等待语义和sandbox wrapper。主动setsid脱离进程组的恶意daemon不是进程组能保证隔离的范围，不能称其为OS sandbox。

验收：孙进程就绪后才触发终止；终态返回后放开写marker屏障，marker不能出现；shell/argv×timeout/cancel均测；不能只断言status；保留Windows shim和沙箱回归。该项由其它agent负责实施。

### 4. 直接child已正常退出，但继承stdio的后代使成功命令被误判timeout（P1第二反例）

pi：`packages/coding-agent/src/utils/child-process.ts:39-47` 解释继承管道问题；`waitForChildProcess:49-135` 同时监听exit/close，在直接进程exit后按输出idle窗口回收管道，收到data会重置idle计时。避免固定exit截止时间吞掉仍活跃写入的尾部。

Harness：executor `collect:443-455` 只用close判结果，没有exit边界；quiet后代一直持有stdout/stderr时，parent=exit0也不close，最后 `:434-436` timeout覆盖掉真实退出码。

确定反例：父Node spawn继承stdout/stderr的quiet后代，父Node立即process.exit(0)。400ms工具超时到达时返回status=timeout、exitCode=null、耗时404ms，后代仍活。它不是命令自身运行超时。

建议/验收：保留真实parent退出码，结合有界drain/进程归属清理；测试parent exit0和非零、quiet inherited pipe、仍不断输出的后代、真实尾部和超时取消。不要直接照搬pi的100ms常量；Harness已有更严格Windows树收尾，需保留。该项同P1实施。

### 5. unsafe流中断时，可见partial答案留在events，却不进入会话正文/下一轮上下文（已证明，仅研究）

pi：`packages/agent/src/agent-loop.ts:346-357` 对done和error都获取最终响应并发message_end；`coding-agent/src/core/agent-session.ts:639-656` 将assistant/user/toolResult统一写SessionManager。错误响应不会因为不执行工具就从历史消失；重试前可以只从当前模型视图移除，历史仍保留（`:2710-2714`）。

Harness：`model-call-controller.ts:557-563` 累加assistantText并发model.delta；unsafe网络失败走`:655-660`只返回error；`runtime.ts:1350-1351`直接finishTurn。正常/length完成才在controller`:270-283`持久化assistant正文。已有 `gen1-model-recovery.regressions.test.ts:98-116` 证明不重放unsafe请求及事件partial，但没有检查canonical transcript。

确定反例：离线provider yield text_delta `VISIBLE_PARTIAL_ANSWER_314159` 后yield retryable=false/safeToRetry=false network error。status=failed；partialInEvents=true，partialInTranscript=false；下一轮用户要求继续，partialInNextRequest=false。

建议：以后若纳入范围，应仅持久化可见text为明确incomplete、non-final历史，不保存/显示私密reasoning，不执行partial tool intent，不把partial标为verified_complete，不自动重放unsafe请求；必要时现有会话协议要提供不完整标识。验收还需真实HTTP/SSE传输、重开UI与store/下轮provider请求三方核对。主线程明确要求本轮仅记研究，不实施。

### 6. actor的旧terminal drain在IO后覆盖新startTurn reservation，制造未执行running turn（已证明，交audit评估）

pi参考：低层loop的outer loop/steering drain（agent-loop.ts:169-174、:259-274）和coding层post-run循环（agent-session.ts:1063-1074）把continuation显式放在同一控制流。Harness的SessionActor/durable lineage更复杂，这里不能直接迁移pi循环。

Harness问题定位：`session-actor.ts:1683-1693` 在idle启动terminal drain；`drainFollowupsInner:1715` await discoverRecoverableTurns；IO之后只在`:1733-1734`检查closed，没有重新检查当前是否还idle；`:1740`无条件写followup starting。若新startTurn已在`:1293`持有自己的new_turn starting，旧drain覆盖该reservation；新startTurn在`:1297-1298`误报closed while starting。

确定屏障反例：A完成启动drain，在inbox.listRecoverable阻塞；启动B，让它持有new_turn starting并在runtime.startTurn阻塞；释放旧drain，actor变idle；释放B，抛closed while starting，actorStillLoaded=true。B的turn已被store保存为running，却没有模型执行/queued lineage。证据 `pi-study/actor-drain-race.json`。

建议：IO后重新验证actor仍持有可启动drain的idle状态，确保drain不能抢占已有reservation；处理IO期间新到工作时复用已有wake逻辑，不引入第二循环。验收应断言B执行一次、可恢复、activeTurn≤1、旧drain不覆盖requestId、关停/取消仍能撤销各自reservation。已交audit_longrun_state，不改其文件。

## 现有能力核实与不应照搬的差异

1. **自动压缩、fallback、完整会话都已存在。** Harness `context-controller.ts:369-449` 会在85%headroom附近触发有hysteresis的摘要，45秒摘要上限在runtime.ts:1287，失败有extractive fallback；不是需要新写一个context runner。pi的 previousSummary/文件列表设计是C1边界证据；长摘要内容质量仍需challenger/paired eval。
2. **session tree/persistence不是空白。** pi SessionManager `session-manager.ts:845-853` 是append-only id/parentId树，`:1305-1347` 迭代建树避免深树栈溢出，`:1354-1364` 分支只移动leaf；Harness `packages/session/src/service.ts:103-142` 已有threadFork复制历史、去除live prompt/ask lineage，`:149-152`禁止fork未结束turn。Harness `session-store.ts:153-167` 用atomic write/durable append（含fsync）；pi旧SessionManager `:1018-1040` 首assistant前还可能延迟写session且appendFileSync不提供显式fsync，不应把它直接替换Harness durability。
3. **工具失败继续观察与受限重试已实现。** pi `agent-loop.ts:600-667` 把schema/未知工具/before hook失败转tool error，`:670-707`把execute异常转tool result，再回模型；length工具参数被`:208-214`拒绝执行。Harness `tool-call-controller.ts:812-885` 对safe retry做安全检查，`:985-995` ambiguous effect只reconcile不重放，`:998-1000`把失败反馈给模型；已有语义更适合副作用恢复，不能误称缺失败修正循环。
4. **摘要重试不是缺口。** pi `compaction.ts:555-580` 经retryAssistantCall处理 transient failure，agent-session.ts:2651-2678发重试事件；Harness runtime.ts:1297-1319复用计量/有界retry并在摘要失败降级，model-call-controller.ts:610-660尊重provider safeToRetry。若后续比较retry数/延时必须区分provider内部和runtime层，不能把同一请求算多套预算收益。
5. **验证门禁是Harness已有优势。** Harness `model-call-controller.ts:334-390` 在stop后跑gate，失败可以继续修正至maxVerificationFailures；`:326-331`对length不执行工具、不声称verified_complete。pi核心loop没有同等任务级必选验证门禁，通常靠工具观察及extensions。不能照搬pi的terminate标志到Harness来绕过Verification。
6. **长日志尾部已修过。** pi bash `core/tools/bash.ts:397-424` 会保留尾部与fullOutputPath；Harness `tools/src/tools/exec.ts:186-210` 已补每流diagnostic tail，并受原maxOutputBytes/安全边界约束。不能再把“没有测试末尾错误”作为现状缺口；完整输出落盘/按需读取则需要先给实际遗漏反例及所有副作用经Orchestrator的实施方案。

补充候选，尚不作为修复授权：Harness threadFork复制消息时换新id（service.ts:130-138），似乎未重映射 `contextCheckpoint.throughMessageId`。需要专门fork+checkpoint probe证明影响，再判断窄修；目前只读源码推断，未实施。RuntimeVerifier对全session transcript做前缀cap（runtime-verifier.ts:71-72、:133-139）也值得未来检查，但当前TaskVerifier requirement reviewer未接入、会fail closed，不能据此宣称当前真实验证被旧证据误导。

## 许可与实施边界

pi根LICENSE为 **MIT**，Copyright (c) 2025 Mario Zechner。允许研究、修改、复制、分发；若复制实质代码或提示词，应随复制部分保留copyright和MIT许可声明。本文仅引用路径/符号与设计描述；C1是针对Harness现有checkpointView/retainMessageHistoryTail边界的独立窄修，没有复制pi实现或prompt，不需要引入pi依赖。

Harness现有history-checkpoint.ts:3-4标明Codex Apache-2.0来源，本文没有修改该prompt或第三方许可。参考项目的直接spawn/tmp写入、扩展特权不能当作Harness授权；所有项目副作用继续经过ToolOrchestrator、PermissionEngine、SandboxManager和Verification。

结论限度：以上离线红绿/探针证明了harness基础设施中的确定边界行为；没有评估付费模型摘要质量、真实repo解决率、缓存或成本收益。不可宣称任意长任务都会成功。
