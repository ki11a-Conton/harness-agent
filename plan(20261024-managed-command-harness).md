# 下一轮 coding harness：受管理的长命令会话

状态：H0–H5 已有默认关闭的实验实现及自动验收入口；完成以精确 clean SHA 的实际专项、安全、全量、对照和同包跨平台结果为准，不以实现代替验收。原研究与规划阶段如下保留，实施进度见文末。v1.12.0 已正式发布并通过公开下载包 Web/CLI 复验；研究及实施基线为 `37a16e3d0ac60da12caff5e28c77a20c8a017e2e`，研究期间未修改该发行源码。[发布收尾](plan(20261022-release-v112).md)记录精确版本、归档与验收。

## 为什么选择这一项

当前已具备自动/手动压缩、durable inbox、同任务恢复、预算回放、工具账本、验证失败修复、代码导航和 capability-aware coding 提示词。下一轮保留这些机制，先处理长测试、构建及服务验证期间的执行控制。

| 来源 | 已读源码及可借鉴内容 | 本项目对应事实 |
| --- | --- | --- |
| Codex | `codex-rs/core/src/unified_exec/{mod,process_manager,async_watcher}.rs`：有限 yield、进程句柄、增量输出、退出与排空分离 | `packages/tools/src/tools/exec.ts` 等待 ProcessExecutor 的终态；生产协议没有可轮询句柄 |
| pi | `packages/coding-agent/src/core/tools/bash.ts`：可插拔执行、取消、输出上限与完整日志引用 | 已有 structured argv、进程组清理、live output 与有界诊断尾；后续输出分页应复用既有 artifact 信任边界 |
| DeepSeek Harness | `packages/terminal/terminal/src/index.ts`、`types.ts`、`tool-terminal/src/background.ts`：精确 owner、未完成 spawn 准入、单一操作、单调输出游标与销毁 | 现有 ToolOrchestrator 的取消和超时按一次工具调用管理；后台句柄需要独立、受 owner 约束的生命周期 |

上游版本：收集仓库 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`，DeepSeek `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。实际已读文件的字节 SHA256 及与 HEAD 的一致性记录在本轮研究证据。研究发现的是能力差距，尚无真实模型任务完成率收益结论。

## 做什么、怎么做、怎么验收

| 阶段 | 做什么 | 怎么做 | 验收 |
| --- | --- | --- | --- |
| H0 | 固定能力与生命周期基线 | 复用真实生产宿主、ToolOrchestrator 和 ProcessExecutor，记录长命令、独立读取、取消、失败修复的实际时间线；对照固定相同命令、期限、工作区、模型脚本及预算 | 原始事件、源码/构建/配置指纹、真实退出码和文件效果齐备；所有子进程清理；脚本模型结果只作为工程证据 |
| H1 | 实现默认关闭的非交互命令会话 challenger | 先在工具/研究宿主层提供 exec_start、exec_poll、exec_cancel 和 owner-scoped 查询；复用 argv、cwd containment、sandbox 准备与进程组清理；registry 生命周期由宿主明确持有 | 同一个命令只启动一次；句柄绑定 session/turn/agent/工作区和策略；外部 owner 读、写、取消及猜测句柄均拒绝；拒绝时没有启动副作用或数据泄漏 |
| H2 | 让长命令可观察且有界 | 每次 poll 仅交付游标后的正文，保留 UTF-8 边界；丢弃输出必须显式标记；进程、输出、保留期和绝对期限均有上限 | 大输出内存受限；不重复、不伪造丢失的输出；running、真实退出、失败、超时、取消分别可判定；没有把无输出当成功 |
| H3 | 衔接取消、验证、压缩与恢复 | owner 的取消、终止和宿主关闭负责清理存量进程；原始绝对期限不随 poll/恢复延长；验证前核对所有相关 job；压缩后可按 owner 查询；重启后的失效句柄进入对账 | 被确认取消或公开操作完成后无晚写；未完成/失败 job 不能 verified_complete；有限预算耗尽不能另开 turn 续命；重启不会再次执行未知副作用 |
| H4 | 真实 coding 工程闭环对照 | 在临时真实仓库执行长检查期间读关联代码、poll 失败日志、修改、再验证；另测 HTTP 服务启动→API 验证→关闭。沿用既有安全/验证链 | 最终内容由独立命令验证；记录成功率、启动次数、重复副作用、用户介入、工具调用、时延及输出量；失败保留；不把离线脚本结果推广成模型质量收益 |
| H5 | 再接 CLI/Web/SDK | 前述门禁通过后才设计公开配置与跨平台入口；通过真实 HTTP、浏览器及独立安装归档验收控件和取消 | Ubuntu 与原生 Windows、同一归档、实际按钮和 owner 完成验证；默认关闭时旧生产 profile、提示词、冻结实验和既有执行语义保持 |

## 接线前必须解决的三项约束

1. `orchestrator.ts:runBounded` 配置了单次 timeout 的路径，在调用结束的 finally 解除该次 signal 联动。新工具需要证明 owner 生命周期里的取消与绝对期限；一次 start 的成功回执不能承担这些保证。
2. 宿主可通过 `HarnessConfig.verification.verifier` 装配研究用 verifier；它必须委托原 TaskVerifier，检查存量 job，并保留真实检查。无可靠完成门禁的宿主不开放 challenger。
3. 插件可注册工具和 hook，但资源仍需明确销毁。模型提供的 sessionId/路径不能授予 owner 权限。后台 command 的未知副作用、失联和清理错误都需要保留诊断。

Runtime 架构冻结。先在已有 Agent/tool/host 扩展点完成实验；需要修改 Runtime 时，必须先提交符合 AGENTS.md 的独立确定性缺陷、基础设施失败或性能反例。上游的授权、降级和全局进程逻辑不能直接替换本项目权限/沙箱合同。

## 初始实验的硬门槛

- 基线/候选各执行 3 类工程任务，每类 8 对，共 24 对、48 个逻辑臂；真实仓库、相同命令和冻结预算，固定交错顺序，付费模型调用为0。脚本自行后台化的能力单独记录，对照统计只覆盖受管理工具协议。
- 同一命令启动次数为1；跨 owner 泄露、重复副作用、取消后的晚写、未完成 job 被验证成功均为0。失败臂纳入完整统计，不能只分析成功臂。
- 研究初始限额：每 owner 的 pending+running 最多4、全局最多16；单次增量保留最多64KiB；已有 prefix/输出策略保持。绝对截止时间不超过 sandbox 进程上限、原 turn 剩余时间与实验上限的最小值；缺少可信 owner/预算绑定时拒绝启动。
- 正确性与安全门禁须全部通过，最终独立检查通过率不得低于 baseline；可重叠案例必须记录进程仍存活时后续独立读取实际发生的时间线。时延、输出和调用数逐臂公开，工程重叠不等于模型质量收益。
- 活跃 job 期间通过已有 narrowing hook 阻止同工作区的其它写入/新命令；poll/cancel 也沿原权限和沙箱入口。先验证旧调用结束后的 owner 取消、挂起 spawn 和 host-close 屏障，再开放宿主接线。

直接复用源码时保留相应 MIT/Apache-2.0 许可和 NOTICE，并记录改动；优先复用本项目已有 executor、UTF-8 collector、sandbox 准备及 verifier。

## 执行与交付顺序

- H0 先保存不可覆盖的 baseline，再预注册 H1–H4 的配置、案例、指标和门槛。
- H1–H3 每阶段做必要的正确性、安全与真实副作用回归；H4 使用同条件 paired 对照，并保留全部失败。
- H5 接入前固定 clean SHA，执行 typecheck、全量、相关安全/协议、CLI/Web/SDK 和原生 Windows 同包门禁。
- 每次只推广通过当前门禁的范围；真实模型能力、摘要质量、缓存/费用收益由独立线下实验验证。保持 v1.12.0 标签、资产、工程档案和历史失败不变。

本阶段交付为已固定源码的比较结论和可执行计划；H1–H5 尚未实现，不标记完成或默认启用。首个实施任务是 H0 的真实时间线及 H1 的受控研究工具；完整 PTY/stdin 和输出 artifact 分页分别后续立项。

## 2026-10-25 实施进度

- 实施基线更新到 main `f8db83fd315fd5b692c5c30aad07c6ed1f4cf352`；原发布与历史档案保持。H0 已保存生产 host 的 blocking、真实失败修复和取消时间线。
- H1–H3 已有默认关闭实现及真实副作用专项测试：复用原 execTool/ProcessExecutor，无 Core/contract 修改；严格 owner、共享宿主容量、规范/嵌套工作区锁、增量输出、绝对期限、关闭屏障、原 verifier、持久 unknown 对账。
- H4 的24对/48臂协议、固定预算和全部失败保留已预注册；正式运行输出 clean SHA、脚本指纹、逐臂事件/文件/退出码和总表。HTTP 本地权限与外部拒绝在首个臂前实际预检；保留曾因授权冲突和路径 glob 不覆盖子路径而失败的完整臂，不把修正前或调试结果冒充最终门禁。
- H5 的 CLI/Web 环境入口及 SDK 服务端配置已实现为显式 opt-in；没有可信期限或真实命令 verifier 就拒绝启动。验收接入官方同包 Ubuntu/原生 Windows workflow，包含实际发送、权限确认、Stop 后无晚写、原 verifier 及真实 CLI stdin 审批和 verified_complete。Windows workflow 另执行完整48臂；只有 H4、全量和这些跨平台门禁实际成功才算完成。
- [使用与边界](docs/managed-commands.md)记录 API、预算、失败替换、取消、重启和不支持的 PTY/stdin；真实模型质量仍为 NOT_PROVEN。

收尾兼容性门禁：保留普通 ToolExecutionContext 的 optional turn 合同，owner/绝对预算能力仅用于四个新增工具。已保存 original orchestrator 实际读取成功、包装器拒绝的独立反例；修复后 legacy 路径的原权限/沙箱/预算/工作区锁仍执行，不能因此创建无 owner 的新命令。Windows 时序回归采用受控真实命令及实际增量/查询回执，不用墙钟猜测轮询次数。所有旧失败保持，并在新的 clean SHA 上重新验收。
