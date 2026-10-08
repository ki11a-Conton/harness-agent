# 第一代个人 coding agent

这轮以可持续完成个人编程任务为目标：读取/搜索源码、精确修改、运行命令、审批、实际验证、恢复会话、CLI/Web 持续使用和独立下载运行。版本计划为 `v1.9.0`（已有历史 tag 不覆盖）。工程验收和真实模型质量分别记录；后者仍为 `NOT_PROVEN`。

## 与参考源码的关系

| 来源 | 有价值的能力 | Harness 的处理 |
| --- | --- | --- |
| pi，MIT | 小而完整的 coding 工具、分页/截断、模型错误分类、持续会话 | 借鉴并移植纯工具算法/错误规则；新增多轮 CLI；保持 Harness 已有安全执行边界 |
| Codex，Apache-2.0 | 工程任务持续完成、用户改动保护、审批、协议化会话 | 既有 coding-v1 已采用行为设计；本轮修正公开会话创建/fork/resume 及 SDK 协议接线 |
| Hermes，MIT | 记忆、技能、持续工作和压缩后恢复证据 | 保留现有有界 memory/skills/context 管线，不重复建缓存或绕过权限；本轮加固持久化恢复 |
| DeepSeek Harness，MIT | Web 会话索引、交互生命周期、独立包验收 | UI 既已移植，本轮补后端会话找回和 SSE；采用仓库外真实运行发布包的验收方式 |
| OpenCode，MIT | 工具权限感知、会话交互、模型能力适配 | 保留既有提示词设计；本轮修复实际模型身份和明确错误处理 |

具体源文件、许可、已实现能力和差距见 [模型](gen1-model-comparison.md)、[工具](gen1-tools-comparison.md)、[交互](gen1-interaction-comparison.md)、[发布](gen1-release-comparison.md)、[会话](gen1-session-comparison.md)和[持久化/预算](gen1-independent-audit.md)。复制/改写保留已有 `third_party/` 和 Web vendor 许可，不把其他项目整体 Runtime 拼接进 Core。

工作区 Claude Code 目录自行标注为泄漏源码且无许可证，本轮未移植。通用持续编码行为由有许可项目及本项目的现有接口实现。

## 能力边界

- 模型效果取决于选定模型、项目复杂度、预算与上下文。本轮离线 HTTP 脚本只证明工程闭环，不证明与参考 agent 成功率相同。
- 正式 champion 晋升与 N7 冻结实验维持原门槛。新 chat 入口明确使用 coding-v1，不生成未经测量组合的旧 champion 应用证明。
- 所有读写、执行及校验遵守既有权限和沙箱。个人本机模式不会凭下载包获得强 OS 隔离保证。
- 模型、后台命令管理、桌面/IDE、远程协作等参考项目的全部扩展不是第一代发布承诺，差距清单明确保留。

## 使用入口

独立包解压后只需要 Node >=22.19.0；无需在消费者机器安装 pnpm 或重新构建。配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 后，从自己的项目目录启动：

```sh
node /path/to/harness-agent-1.9.0/agent.mjs chat . --verify "npm test"
```

`chat` 默认使用 coding-v1 和 `~/.harness-agent` 持久目录；`--data-dir` 或 `HARNESS_DATA_DIR` 可覆盖。`/help`、`/status`、`/new`、`/quit` 管理会话；每次写入、执行及校验仍逐次审批，输入 `allow` 仅批准该操作，`deny` 或 EOF 拒绝。Ctrl-C 取消当前任务并保留会话。退出提示给出会话 ID，可重启后继续：

```sh
node /path/to/harness-agent-1.9.0/agent.mjs chat /path/to/project --resume session_ID --verify "npm test"
```

查看 chat 默认目录中的已保存会话时，为通用 `sessions` 命令指定相同目录：

```sh
node /path/to/harness-agent-1.9.0/agent.mjs --data-dir ~/.harness-agent sessions
```

Windows PowerShell 可以用 `$env:OPENAI_API_KEY`、`$env:OPENAI_BASE_URL`、`$env:OPENAI_MODEL` 设置模型配置，再运行同一个 `agent.mjs`。路径有空格时加引号；验证命令使用项目在 Windows 上实际支持的命令。包也提供 `agent.cmd` 和 `agent.ps1`。

恢复必须使用同一项目、模型、提示词和验收配置；不能用新策略悄悄继续旧会话。恢复旧 legacy `run` / Web 会话时，显式设置 `HARNESS_AGENT_PROMPT=legacy`。

Web 从项目目录启动，显式选择持久目录与验收：

```sh
HARNESS_DATA_DIR=/path/to/web-sessions HARNESS_AGENT_PROMPT=coding-v1 HARNESS_VERIFY_COMMAND="npm test" node /path/to/harness-agent-1.9.0/agent.mjs web
```

打开 `http://127.0.0.1:8787`。清空浏览器存储后，后端持久会话仍可在侧栏找回；同一会话可在多个标签页订阅。模型 key 缺失时启动仅为 stub，发送任务会明确失败，不声称完成编码。没有配置 verification 时只得到 unverified 完成，不能当测试通过。

CLI/Web 产品入口会在加载存储前取得数据目录所有权。同一台机器、同一网络命名空间内，一个目录只能由一个宿主进程使用；并行启动可用不同数据目录。占用冲突会在加载审批记录前拒绝，进程崩溃后 OS 自动释放。该本机机制不是跨机器/NFS锁，直接 SDK 宿主须自行保证其 store 的单写者约束。

已有技能发现器可通过 `AR_SKILL_ROOTS` 配置（多个目录以分号隔开），`agent skills` 现在返回真实目录；技能正文继续经过原注入/秘密检查。已有 memory/learning 可通过 CLI 的 `HARNESS_MEMORY=1` 显式启用，要求持久目录；不据此声称模型效果提升或正式 champion 晋升。

大型文件使用 `read_file` 的 1-based `offset` / `limit` / `maxBytes`；分页返回的 SHA256 仍覆盖整个原文件。grep 要用 `includeSummary=true` 检查 `complete` 后才把“没找到”当负证据；字面搜索优先 `literal=true`。正则计算超时/取消明确失败，不伪装成空结果。

## 验收与发布

执行合同：[GEN1-20261008](../tasks/GEN1-20261008.md)。计划：[第一代实施规格](../plan(20261008-024527).md)。第一代必须通过固定源码全量、安全、协议、原生 Windows、CLI/Web 编码闭环和独立产物安装验收；未满足时不宣称 release 可用。

实现和专项审查已收尾；完整工程验收正在执行，发布仍以固定源码的真实结果为准。缺陷及来源见[审查索引](gen1-audit-index.md)，最终命令、源码 SHA、Windows与安装包结果将单独归档，真实模型质量维持 NOT_PROVEN。
