> 研究阶段快照：其中的实施/验收进度保留原记录；最终结果以本轮固定提交验收报告为准。

# Codex 长任务 harness 源码研究与 Harness 窄修复

研究源固定为 `/workspace/HARNESS-SRC-FORK/codex-main`，HEAD `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`。对照基线 `/workspace/harness-agent-pr15-20261019`，HEAD `eafcdb56fd266d6c862b5d3d910fcf5530e10fa0`。后续实施仅在 `/workspace/harness-agent-longrun-20261020`，按该工作树 `tasks/LONGRUN-HARNESS-20261020.md` 与 `plan(20261020-161914).md` 的 P1 授权进行。本文件引用 Harness 行号均为 eafcdb56；实施后的行号会变化。

已读根 `AGENTS.md`，尤其 47–60 行 Runtime Freeze：确定性正确性反例允许窄维护；仅模型质量不足不能借机重写 Runtime。以下证据区分确定缺陷、能力差异和已经存在的能力。研究阶段未修改任一仓库；实施阶段只拥有 executor 与进程生命周期测试。无付费模型、网络认证、GitHub 连接器或子 agent。

## 1. P1-A：POSIX 超时/取消返回后普通后代仍能写文件（确定缺陷，已实施）

Codex 实现：

- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/utils/pty/src/pipe.rs:149–165`，pipe spawn 在 pre_exec 中调用 `detach_from_tty()`。
- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/utils/pty/src/process_group.rs:47–77`，`detach_from_tty` 使用 setsid，必要时 setpgid；`:263–266` 的 `kill_process_group` 对所拥有 PGID 发送 SIGKILL。
- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/utils/pty/src/pipe.rs:64–79`，`PipeChildTerminator::kill` 清理组，Windows 使用 Job/Process terminator。

Harness 对应与实际缺口：

- `/workspace/harness-agent-pr15-20261019/packages/tools/src/process/executor.ts:470–499` 的 `killDirectTree` 在 Windows 使用 taskkill /t /f，但 POSIX 仅 `child.kill("SIGKILL")`。
- 同文件 `:527–532`、`:588–596`、`:662–672` 的三个 spawn 路径没有独立进程组。杀 shell/直接子进程后普通孙进程继续执行。
- `collect:416–427` 在 killTree 返回后立即返回 timeout/cancelled；这不证明后代停止。
- `/workspace/harness-agent-pr15-20261019/packages/tools/src/process/executor.test.ts:66–75` 原“no orphan”只断言 status，且 fixture 主动 detached。它既未观测后代，也在 POSIX 留下进程直至其10秒计时结束。

复现：`node /tmp/repro-harness-longrun-process-baseline.mjs`。脚本只把待测 executor 源码 strip 到 /tmp；未变化的 sandbox/UTF8 helper 使用 eafcdb56 原工作树 dist。shell/argv × timeout/abort 四项都在约200ms返回终态，终态当刻 marker 不存在，750ms后 marker 全部出现 `DESCENDANT_WROTE_AFTER_TERMINAL`。每项清理记录到的 fixture PID。

原始回执：`/workspace/harness-longrun-acceptance-20261020/process-baseline/results.jsonl`、`sha256.txt`。首次新工作树缺少 dist 的失败另存 `attempt1-dependency-missing.stderr.txt`，未覆盖。

验收：采用普通、未主动逃组的子孙；准备完成后分别超时/取消；返回终态之后才释放写入门，marker 仍不存在。必须覆盖 shell、argv、sandbox launch 共用的 primitive，并保留 Windows、UTF8、输出上限及授权边界。主动 setsid/detached 的恶意 daemon 不属于进程组可保证的范围，不能称进程组是沙箱。

Runtime 许可：有确定性反例，满足根 AGENTS.md:53；限于 ProcessExecutor 生命周期维护，不扩展执行架构。源码许可见末节。

## 2. P1-B：主进程已成功/非零退出，却因后代持有管道误判超时（确定缺陷，已实施）

Codex 实现：

- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/unified_exec/process.rs:628–637` 的 `signal_exit` 与 Drop/terminate 分离进程退出状态。
- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/unified_exec/async_watcher.rs:47–155` 的 `start_streaming_output` 分开 exit token、output_closed、output_drained，并在 exit 后给予有限 trailing-output grace，再安全排空接收队列。
- `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/unified_exec/async_watcher.rs:159–177` 的 `spawn_exit_watcher` 统一发命令结束事件。

Harness 对应与实际缺口：`/workspace/harness-agent-pr15-20261019/packages/tools/src/process/executor.ts:434–455` 只在 ChildProcess close 上结束；Node close 会等待所有继承 stdout/stderr 的后代关管道。没有 exit 监听，因此根进程已 exit 0/7 后，命令 timeout 仍继续计时，最后返回 timeout/null。它与后代泄漏共享生命周期根因，但错误表现为丢失真实退出码。

复现：`node /tmp/repro-harness-inherited-pipes.mjs` 使用从 `git show eafcdb56:packages/tools/src/process/executor.ts` 保存的 `/tmp/harness-process-baseline.ts`。根 Node spawn 普通子进程继承管道，然后立刻 exit 0或7。四项 shell/argv × 0/7 都在约350ms返回 timeout/null，尽管根命令已明确退出。

回执：`/workspace/harness-longrun-acceptance-20261020/process-baseline/inherited-pipes.jsonl`。修复后同脚本以新源码路径为参数，四项34–42ms内分别返回 success/0 与 failed/7，见 `process-green/inherited-pipes.jsonl`。

验收：自然 exit 后停止执行 deadline，清理仍属本组的后代，排空已写的 stdout/stderr，保留实际 code 和 UTF8。主动逃组者仍可持有 pipe，必须有限等待后释放本工具 reader，并保持根 code；不能无限挂起或改判 timeout。

Runtime 许可：确定性正确性缺陷，允许同一 primitive 内窄修。无需照搬 Rust PTY manager。

## 3. S1：最终采样期间已接受的 steer 被遗留并污染下一无关任务（确定缺陷，交由其它实施 agent）

Codex 实现：`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/session/turn.rs:390–405` 在采样后检查 pending input，`needs_follow_up = model_needs_follow_up || has_pending_input`，`:482` 仅无后续输入时进入停止流程。另 `/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/tasks/mod.rs:606–624` 在终止最后阶段提取并持久记录残余 pending input。

Harness 已有：`/workspace/harness-agent-pr15-20261019/packages/core/src/runtime/session-actor.ts:1371–1378` 只允许 running 状态 steer，`:424–429` 将其放入 durable inbox；`runtime.ts:1249–1260` 在下一采样前经 exactly-once 注入；`context-controller.ts:652–681` 用 prompt ID和 promotedTurnId 避免重放。

实际缺口：`/workspace/harness-agent-pr15-20261019/packages/core/src/runtime/model-call-controller.ts:334–397` 的 stop 直接验证/终止，没有检查模型最终采样期间到达的 steer。actor settle (`session-actor.ts:1662–1676`) 仅 drain followup，steer 没有本地队列，pendingCount只数 followup (`:420–429`)。

复现：`node /tmp/repro-harness-longrun-steer.mjs`。该脚本把当前 eafcdb56 的 runtime、context/model-call/recovery controller 和 session actor transform 到 /tmp，其余使用对应基线 dist；模型用离线 ScriptedModelProvider，以 promise gate 保证第一请求已开始但尚未 stop，再 await actor.steer，最后释放模型。原任务 completed、只有1次模型请求、actor idle、queuedFollowups=0、纠正仍 pending。下一无关任务第二请求才收到 `[steering] CORRECTION FOR TASK ONE`，其 promotedTurnId 被绑定成第二个 Turn。

回执：`/workspace/harness-longrun-acceptance-20261020/codex-study/late-steer-baseline.jsonl`。

验收：在原任务下一次采样按原文消费该纠正恰好一次，验证/终止只能发生在处理后，原任务 completed一次；后来的无关任务没有该纠正的新turn锚点。followup不可偷换为steer，预算/取消/验证失败依旧有界。

Runtime 许可：确定性 correctness/liveness 反例，允许完成安全边界上的最小修正，不建立第二个run loop。

## 4. C1：reactive overflow 的12条尾裁剪会删除已经持久化的 handoff（确定源码反例；完整链路由其它 agent实施验收）

Codex 实现：`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/compact.rs:347–384` 创建 replacement history、当前初始上下文与 reference baseline，并一并提交。`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/session/rollout_reconstruction.rs:83–88` 把最近存活 replacement history 视为恢复基础，`:114–123` 先找该基底再恢复必要尾部，`:174–186` 明确基底的有效区间。

Harness 已有：`/workspace/harness-agent-pr15-20261019/packages/context/src/history-checkpoint.ts:19–30` 的 checkpointView 从 durable transcript 中选择有效最新 checkpoint；`context-controller.ts:434–449` 先 appendMessage，再 checkpoint，保持完整原文与当前 user authority。`packages/harness/src/compose/compose-context.ts:49–51` 已默认启用 historyCompaction，不能误报“没有自动压缩/模型handoff”。

实际缺口：`/workspace/harness-agent-pr15-20261019/packages/core/src/runtime/runtime.ts:1262–1270` 在 reactiveCompacted 时，先对完整 history 强行最后12条；`turn-helpers.ts:421–424` 仅重插 active user 和工具配对，并不保护 contextCheckpoint。之后 ContextController:180 才 checkpointView，已没有被裁掉的checkpoint可选择。

微复现：`node /tmp/repro-codex-checkpoint-retention.mjs`，19条历史中最新checkpoint位于头部、后面16条普通助手消息，调用同一 retainMessageHistoryTail 规则。结果 currentTaskKept=true、latestCheckpointKept=false、earlyFactKept=false。回执在 `codex-study/checkpoint-retention-baseline.jsonl`。这证明局部裁剪丢锚点；端到端overflow重试请求的完整红绿由C1负责者提供，不把此微例冒充完整传输测试。

验收：第一次和overflow重试的实际模型请求都保留最新handoff、早期事实及当前user/steer，工具协议合法；第二次overflow仍有限失败；取消不启动摘要或重试，原始 transcript 不变。

Runtime 许可：有局部确定反例且已有独立完整链路反例；仅修上下文构建边界。模型摘要好坏仍需paired eval，不能据此更换整个策略。

## 5. 可让长命令中途交还控制，但它是受控工具能力差异，尚非 Runtime 缺陷

Codex：`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/unified_exec/mod.rs:66–75` 限制yield时间、输出与最多64 processes；`:93–121` 的 ExecCommandRequest/WriteStdinRequest 有process ID和yield；`process_manager.rs:559–564` 只收集至yield deadline、`:628–635` 在仍活着时返回process ID；`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs:72–92` 恢复同一执行句柄。

Harness：`/workspace/harness-agent-pr15-20261019/packages/tools/src/tools/exec.ts:11–32` 只有同步exec输入/终态输出；`:130` timeout最多10分钟，`:140` interactive=false，`:202–205` 等待完整ProcessExecutor结果。`packages/tools/src/production-tools.ts:42–55` 的实际coding profile没有poll/stdin tool。已有 onOutput可给宿主流式观察，所以并非“没有长命令输出”；模型没有可恢复的进程句柄。

可复现差异：运行需要超过yield窗口的普通命令，Codex能先返回session_id并继续其它模型工作；Harness只能等命令结束/超时/取消，API中没有中途yield或stdin。此项未做命令速度/模型成效paired测试，也未证明当前benchmark失败来自这一点。

验收提案：若要引入，先做工具/宿主层受控challenger，验证session隔离、同一进程不重复spawn、poll只取新输出、超时/取消关资源、批准与沙箱沿用原orchestrator，再以长测试场景paired eval。不能仅复制Codex整个manager或提高所有上限。

Runtime 许可：当前证据不构成冻结例外；仅能力差异，默认不改Runtime。本轮未实现。

## 6. 恢复和验证已经存在，不能把Codex代码规模当移植需求

Codex：`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/tasks/mod.rs:394–410` 完成前flush rollout，统一on_task_finished；`:797–807` 统一TurnComplete事件。`/workspace/HARNESS-SRC-FORK/codex-main/codex-rs/core/src/session/rollout_reconstruction.rs:114–123` 以replacement基底和存活尾部恢复。

Harness：`/workspace/harness-agent-pr15-20261019/packages/core/src/runtime/recovery-controller.ts:313–365` 保存phase、working state、工具ledger、lastEventSequence；`:377–403` 只重放checkpoint后事件并查询该turn工具结果；`:438–470` 将未知与已提交副作用区分。`runtime.ts:1084–1104` 的问答恢复包含预算与原turn身份，`:2015–2035` 保留中断user输入和预算种子；`session-actor.ts:531–555` 规定durable promoted prompt恢复同一个T，不能重建T2。

验证：`/workspace/harness-agent-pr15-20261019/packages/core/src/runtime/verification-controller.ts:47–114` 有completion policy和实际verifier gate；`model-call-controller.ts:358–394` 失败后有限重试，只有gate通过才verified_complete。`/workspace/harness-agent-pr15-20261019/packages/tools/src/verification/task-verifier.ts:34–43` 要求通过orchestrator授权执行，`:61–69` 空check不算通过，`:180–183` 明确成功exit0且未取消才pass。Codex的普通stop没有同一套Harness任务规格验证，不能用上游stop路径替换当前gate。

实际剩余待证：大规模历史完整装载的成本、未知外部副作用核对与模型修正质量，需各自测量；尚未发现足以允许重写recovery或verification的独立新反例。可验收的是已有问答/预算/已提交动作恰好一次、未知动作不可盲重放；相应已有resume/crash/verification回归应继续运行。

Runtime 许可：当前无新缺陷，不做同构重写。此项是排除假缺口的证据。

## P1 实施与工程回执

只修改：

- `/workspace/harness-agent-longrun-20261020/packages/tools/src/process/executor.ts`：POSIX spawn设detached，按所拥有进程组发SIGKILL；自然exit与close分离；exit停止命令deadline并清理普通后代；close排空UTF8；主动逃组导致pipe不关时最多1秒drain，保留根退出码。Windows原taskkill路径保持。
- `/workspace/harness-agent-longrun-20261020/packages/tools/src/process/posix-lifecycle.regressions.test.ts`：新增9项真实进程测试，四项终态后写门、四项继承管道正确code、一个主动逃组有界pipe边界。fixture失败也清理PID。
- `/workspace/harness-agent-longrun-20261020/packages/tools/src/process/executor.test.ts`：原no-orphan断言保留，并改为普通后代、实际观测终态后的marker；finally清理fixture。现有CRLF保持，不全文件重排。

首轮限定5文件99 pass/9 skip，回执 `/workspace/harness-longrun-acceptance-20261020/process-first-targeted.json`。扩展到整个process目录、exec诊断/cwd、TaskVerifier、production tools后200 pass/12 skip/0 fail，2workers，回执 `/workspace/harness-longrun-acceptance-20261020/process-targeted-final.json`。最后仅调整旧fixture timeout至2秒以容纳真实Windows启动，定向再验见 `process-final-fixtures.json`。不是全仓验收，也不是原生Windows实跑；最终类型/全量/Windows由主agent统一完成。

P1-A与P1-B新源码同脚本green：`/workspace/harness-longrun-acceptance-20261020/process-green/results.jsonl`、`inherited-pipes.jsonl`、`sha256.txt`。临时探针仅在/tmp，证据目录保存原始结果；helper来源明确为eafcdb56已有dist，未绕过授权运行真实生产副作用。

## 许可

Codex根 `/workspace/HARNESS-SRC-FORK/codex-main/LICENSE` 是 Apache-2.0；根 NOTICE 标明 OpenAI Codex Copyright 2025 OpenAI，并包含Ratatui MIT派生说明。所研究core/PTY源码未发现更窄的文件头许可。若实际复制相应源码，必须保留Apache许可/适用NOTICE、标识改动，避免将第三方目录代码一概当作OpenAI原创。

Harness已有明确来源归档 `/workspace/harness-agent-pr15-20261019/third_party/coding-prompts/codex-context-compaction.md`，其记录的正是本次Codex SHA，保留 `codex-Apache-2.0.txt` 和 `codex-NOTICE.txt`；`packages/context/src/history-checkpoint.ts:3–4` 已标明prompt adaptation。因此handoff并非新发现未引入能力。本轮P1是参照组所有权/退出与管道分离思想独立编写的TypeScript窄修，没有复制Rust实现，也没有引入PTY/宿主专属API。未在Harness根找到全项目LICENSE，不推断其对外分发许可。
