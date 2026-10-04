# Web 控制台

在项目根目录启动：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
node apps/web/dist/main.js
```

打开 <http://127.0.0.1:8787>。模型配置沿用 CLI 的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和模型配置（见 [README](../README.zh-CN.md#使用真实模型)）；无真实 provider 配置时启动日志会标示 stub。`HARNESS_DATA_DIR` 设置数据目录；默认仅监听本机，端口由 `HARNESS_WEB_PORT` 设置。

执行真实模型任务需要配置有效的 `OPENAI_API_KEY`，并按服务配置 `OPENAI_BASE_URL`、`OPENAI_MODEL`。未配置 key 时页面仍能打开，但发送后回合会明确报告模型未配置，不能完成任务。界面“已连接”表示 Web/SSE 连接就绪；发送接口 HTTP 200 表示消息已接收，实际结果以回合完成、失败或取消状态为准。模型配置目前通过环境变量设置，界面没有模型选择或设置按钮。

界面复用 DeepSeek Harness 的 MIT 主题源码，并移植其侧栏、聊天列、空状态和输入卡片呈现，使用本项目真实 Gateway/RPC 与 HTTP/SSE。来源、冻结提交、文件哈希与完整许可证位于 [source-manifest.json](../apps/web/public/vendor/deepseek/source-manifest.json) 和 [LICENSE](../apps/web/public/vendor/deepseek/LICENSE)。启动不需要上游仓库或远程资源。

支持新建与切换会话、历史消息、浅/深主题、手机侧栏、代码块与回复复制、工具和验收状态、权限审批与取消。Enter 发送，Shift+Enter 换行，中文输入法确认候选时不发送；运行中追加消息沿现有 Gateway followup 队列处理。

模型文本在回合内完整消息落库后显示；SSE 即时传送运行状态。浏览器会话身份与草稿保存在本地；当前服务的身份到会话绑定在进程内，服务重启后的旧身份不自动恢复之前的 durable session。浏览器刷新可恢复同一服务进程的历史。

可重复的离线浏览器验收脚本位于 [scripts/research/web-dsh-20261004](../scripts/research/web-dsh-20261004)，使用生产 Harness 和显式 scripted provider；它验证工程路径，不构成真实模型质量评测。

2026-10-04 再次复验已补齐运行中追加消息后的停止、手机发送/审批/停止、全部控件以及真实 main 的 OpenAI 兼容 HTTP 接线。修复了 queued followup 停止使用旧回合 ID、刷新后空 tool-call assistant 气泡两项问题，完整映射与结果见 [Web 复验报告](evidence/web-recheck-20261004.md)。
