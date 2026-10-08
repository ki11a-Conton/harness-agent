# 第一代交互与会话对比、修复及操作

本轮实际阅读了工作区 pi、Codex、Hermes 和 DeepSeek Harness 的交互/会话实现。参考文件的快照源码 SHA、逐文件 SHA-256、许可和采用方式见 [source manifest](gen1-interaction-source-manifest.json)。既有 coding-v1 和 Web 样式移植的许可及来源继续保留于 `third_party/coding-prompts/` 和 `apps/web/public/vendor/deepseek/`。

这里采用的是经源码比较确认的交互设计，再复用 Harness 自己已有的 Runtime RPC、批准和持久存储接口。参考项目的 TUI、Cordis 容器或整个 Runtime 没有复制进本项目；具体源码算法的移植另见工具/模型对比说明。

## 源码对比

| 参考项目和实读文件 | 原有优势 | Harness 原状与本轮补齐 | 尚未覆盖的差距 |
| --- | --- | --- | --- |
| pi `packages/coding-agent/src/cli/args.ts`、`core/session-manager.ts`、`modes/interactive/interactive-mode.ts`，MIT | 多轮交互；continue/resume；会话保存；同一个 session 的 prompt、取消及 follow-up | 原 CLI 只有一次性 `run`；`resume` 只打印状态。本轮新增 `chat`，同 session 多轮、跨进程继续、持久数据、实际工具批准和取消 | 完整 TUI、交互会话选择器、历史分叉选择器、图片输入、编辑器扩展、热切换模型 |
| Codex `codex-rs/cli/src/main.rs`，Apache-2.0 | 恢复的是继续工作的交互会话，结束时能明确给出继续方式 | `chat --resume <id>` 返回原 id，复用先前对话，拒绝错项目/冻结配置变化；退出显示 resume 指令 | 完整 TUI、桌面和 IDE；跨设备 session 流程 |
| Hermes `hermes_cli/main.py`，MIT | cwd 范围内恢复会话；恢复提示；重复工作不丢失上下文 | CLI 先读原 session 的项目，再通过冻结配置门恢复；不静默创建一个新 session 伪装 resume | latest/模糊 id 会话选择、压缩链交互导航、平台消息入口 |
| DeepSeek Harness `packages/api/session-controller/src/client/sessions/{manager,service}.ts`、`tests/client-apply.client.spec.ts`，MIT | 服务端会话索引；连接/订阅生命周期；重连的 baseline 处理 | 原 Web 只显示浏览器 localStorage 中的 id，后端 `/api/sessions` 只补标题；新增后端索引发现、清空浏览器缓存后找回会话、同 session 多 tab SSE 扇出以及异步关闭清理 | 完整的会话搜索/归档、分支视图、diff inspector、工作区选择、终端面板、声音/文件预览 |

## 本轮缺陷与验收

| 缺陷或第一代必要能力 | 实现与验收 |
| --- | --- |
| CLI 不能持续编码或恢复后继续 | `chat-command.ts` 调用现有 `session.create/resume/send/run`；`runSessionTurn` 与一次性 run 共用审批/取消路径。真实 CLI 子进程完成两轮，fresh CLI 再完成同 id 第三轮，HTTP 请求包含前两轮上下文。 |
| 两个 readline 可能争抢任务与审批 | `terminal-chat-host.ts` 独占一个 stdin 队列，任务输入和一次性允许/拒绝串行消费；真实 stderr 审批提示触发逐项回答，不能仅靠提前塞 allow 测试授权。 |
| Ctrl-C 会让后续任务永远使用已取消 signal；idle 关闭可能继续消费旧任务 | 活动 turn 用独立 AbortController；活动 Ctrl-C 取消当前 turn，结束后重新生成。idle Ctrl-C/显式关闭与 EOF 区分：关闭清空排队任务并拒绝再开始；EOF 保留已输入任务但拒绝无输入的审批。单元反例和真实 POSIX 子进程验证。Windows 的原生取消由独立 Windows gate 验证。 |
| 执行前已取消时 CLI 直接返回，而刚创建的 Turn 永久保留 running | 原生实 runtime 反例先观察到未终结的 Turn；改为通过 `RpcContext.signal` 进入真实 `session.run` 并等待取消终态。回归断言 Turn 为 cancelled 且 provider 调用为 0。 |
| 多轮 chat 的后续取消会显示前一任务的回复和 verification passed | 结果只读取当前 turn 的 messages/events；已经配置但没有执行的验收显示 `not run`。先实际校验通过再取消第二 turn 的反例验证不能冒用旧任务成功证据。 |
| `--data-dir` 缺值/空值/重复时静默丢失持久化请求或吞掉下一 flag | 严格拒绝，在 provider 构造之前退出；`--help` 同样在 provider 构造前处理，即使模型/提示词配置无效也可以查看用法。 |
| 换浏览器/清缓存找不到已有后端会话 | 启动和左栏刷新时合并真实 `/api/sessions`。本地空白会话及草稿保留；左栏保持既有 50 项上限，选中会话不会被裁掉。后端原记录不删除。 |
| 同 session 两个 tab 会互相关闭 SSE，引发反复重连 | Server 按实际连接追踪，Adapter 按 sender 保存多个 sink；每个 tab 关闭仅注销自己的 sink。真实 HTTP 双流反例旧实现失败，新实现均接收到同一 turn 回复。 |
| 创建 SSE 时 await 历史 cursor，浏览器先关闭仍注册死连接 | 在第一次 await 前追踪 response 并注册 close listener，cursor 读完再判断关闭态。受控 store 延迟 + 真实 HTTP 关闭回归验证不会留下 sink。 |
| 恢复错项目或错策略会静默 fork/继续错误上下文 | CLI 先核对 cwd，再由强化的 `session.resume` 执行 actor/config 冻结门；失败必须不调用 provider，也不新建替代 session。 |

所有副作用仍通过 ToolOrchestrator、PermissionEngine、SandboxManager 和 Verification。`chat` 不自动允许写入/执行，不依赖另一进程偷偷修改审批文件。

## CLI 使用

先配置兼容 OpenAI Chat Completions 的模型，例如在 POSIX shell 设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`（自定义服务需要时）和 `OPENAI_MODEL`；PowerShell 使用对应的 `$env:...` 环境变量。不要将真实 key 放入提交、验收输出或命令历史。

```text
agent chat /path/to/project
agent chat /path/to/project --verify "node --test test/math.test.cjs"
agent chat /path/to/project --resume session_... --verify "node --test test/math.test.cjs"
agent chat /path/to/project --data-dir /path/to/persistent-agent-data
```

从源码构建后可将上面的 `agent` 换成 `node /absolute/path/to/apps/cli/dist/main.js`。cwd 含空格应按当前 shell 的方式引用。`--verify` 是项目中的真实校验命令，执行前仍会请求批准；失败会反馈诊断并进入既有有界修复流程，不能以模型文字宣布“通过”。

`chat` 的默认数据目录是用户 home 下 `.harness-agent`；显式 `--data-dir` 优先于 `HARNESS_DATA_DIR`，后者优先于默认。恢复时使用同一数据目录、原项目和原模型/提示词/校验配置。首次启动路径已显示在交互输出中，可通过 `agent sessions --data-dir ...` 查看真实记录。

新 chat 默认选择 `coding-v1`。`HARNESS_AGENT_PROMPT=legacy` 可显式选择旧策略，以恢复使用旧策略创建的会话；旧 `run`/SDK 的默认策略和冻结实验不变。新策略不会生成一个未经配对测量的旧 champion 应用证明。

输入 `/status` 查看当前 session/model/project，`/new` 在同一项目新建会话，`/help` 查看操作，`/quit` 或 `/exit` 退出并显示恢复指令。每行是一个任务；等待当前任务完成或在出现审批提示时输入恰好 `allow`/`deny`。Ctrl-C 在任务执行中仅取消当前任务，回到同一会话；空闲时退出。CLI 当前提供简洁行交互和阶段状态，并不声称实现完整 TUI/逐 token 渲染。

## Web 使用

在项目目录启动 `node /absolute/path/to/apps/web/dist/main.js`。`HARNESS_DATA_DIR` 必须指向持久数据目录才能在重启后保存会话，`HARNESS_AGENT_PROMPT=coding-v1` 选择新策略，`HARNESS_VERIFY_COMMAND` 配置实际校验命令。服务默认仅监听 `127.0.0.1:8787`。

发送、停止、允许/拒绝继续沿既有 Gateway/RPC 调用路径工作；会话按钮加载真实历史并订阅该 sender。新浏览器通过后端索引找回已存会话，同一个 session 的多个 tab 不会相互踢掉。主题、侧栏、复制回复/代码属于浏览器功能，没有伪造后端编码能力。后端索引失败时现有本地导航仍可使用并会在后续侧栏刷新重试。

## 可重跑验收

```text
pnpm typecheck
pnpm build
pnpm exec vitest run apps/cli/src/gen1-chat.test.ts apps/cli/src/coding-host.regressions.test.ts apps/cli/src/default-harness.integration.test.ts apps/cli/src/coding-prompt.integration.test.ts apps/web/src/server.test.ts apps/web/src/harness.integration.test.ts apps/web/src/source-audit-restoration.regressions.test.ts apps/web/src/gen1-session-sidebar.test.ts
node scripts/research/gen1-20261008/interaction-acceptance.mjs --out .ci/gen1/interaction
```

脚本调用真正编译的 CLI/Web，通过仅监听 loopback 的 HTTP fixture 提供模型响应；工具、进程、工作区、校验、持久存储、批准、取消、重启和 SSE 均为真实执行。独立临时启动目录不加载仓库旧 champion state。receipt 包含 source SHA、platform、Node、逐项断言、HTTP 请求和实际 stdout/stderr/会话资产。发布必须在固定提交重新跑，不能以当前 dirty 工作区的首次结果替代固定源码验收。

真实模型质量与参考 agent 的成功率仍为 `NOT_PROVEN`；离线 fixture 的 0 付费调用只证明工程接线和行为门。没有执行的优势明确列为差距，UI 不展示一个不能调用后端的假按钮。
