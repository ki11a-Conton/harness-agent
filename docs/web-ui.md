# Web 控制台

在项目根目录启动：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
node apps/web/dist/main.js
```

打开 <http://127.0.0.1:8787>。模型配置沿用 CLI 的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和模型配置（见 [README](../README.zh-CN.md#使用真实模型)）；无真实 provider 配置时启动日志会标示 stub。`HARNESS_DATA_DIR` 设置数据目录；默认仅监听本机，端口由 `HARNESS_WEB_PORT` 设置。

界面复用 DeepSeek Harness 的 MIT 主题源码，并移植其侧栏、聊天列、空状态和输入卡片呈现，使用本项目真实 Gateway/RPC 与 HTTP/SSE。来源、冻结提交、文件哈希与完整许可证位于 [source-manifest.json](../apps/web/public/vendor/deepseek/source-manifest.json) 和 [LICENSE](../apps/web/public/vendor/deepseek/LICENSE)。启动不需要上游仓库或远程资源。

支持新建与切换会话、历史消息、浅/深主题、手机侧栏、代码块与回复复制、工具和验收状态、权限审批与取消。Enter 发送，Shift+Enter 换行，中文输入法确认候选时不发送；运行中追加消息沿现有 Gateway followup 队列处理。

模型文本在回合内完整消息落库后显示；SSE 即时传送运行状态。浏览器会话身份与草稿保存在本地；当前服务的身份到会话绑定在进程内，服务重启后的旧身份不自动恢复之前的 durable session。浏览器刷新可恢复同一服务进程的历史。

可重复的离线浏览器验收脚本位于 [scripts/research/web-dsh-20261004](../scripts/research/web-dsh-20261004)，使用生产 Harness 和显式 scripted provider；它验证工程路径，不构成真实模型质量评测。
