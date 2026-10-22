# Harness Agent v1.12.0

[下载与正式发布状态](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.12.0)。本轮交付 coding 长任务基础设施修复；只有该页面为非草稿 release 且随包验收通过，才代表已经发布。历史 v1.11.0 和其它 tag/资产保留。

## 主要变化

- 压缩/溢出重试保留持久检查点、当前任务及纠正；流中断保留明确不完整的可见正文，不自动重放未知副作用。
- JSONL/SQLite 恢复保留工作状态、账本及已用预算；公开恢复补算检查点水位之后可归属的费用/输出，超限后不再先调用模型。
- 终止与验证边界的已接受纠正留在原任务；后台 goal 轮次不再使刚渲染的人工控制版本失效，旧请求继续兼容。
- POSIX 超时/取消清理普通后代，主进程退出后有界排空并保留真实退出码；可显式配置有限模型轮数，默认仍20轮。
- Web 验收确认实际会话归属，点击标题完成导航；初始化按真实 admission 和 owner 串行操作。历史未复现失败和反证保留，不把验收补强冒充已证实的生产根因。
- 发布导出每次上传前重新确认草稿、源码和资产状态，拒绝已观察到的中途发布、改绑、冲突及历史版本覆盖；正式发布在导出工作流成功结束后进行，不把 GET/POST 检查当作原子事务。

## 安装与使用

需要 Node.js >=22.19.0。下载 `harness-agent-1.12.0-portable.tar.gz` 和 `SHA256SUMS`，校验后解压；安装包运行不需要 pnpm 或源码仓库。

```sh
sha256sum -c SHA256SUMS
tar -xzf harness-agent-1.12.0-portable.tar.gz
node /absolute/path/harness-agent-1.12.0/agent.mjs --version
node /absolute/path/harness-agent-1.12.0/agent.mjs doctor
```

配置模型后，从实际项目目录启动，并把验证命令换成该项目的真实检查：

```sh
node /absolute/path/harness-agent-1.12.0/agent.mjs chat . --verify "npm test"
HARNESS_DATA_DIR=/absolute/path/web-sessions HARNESS_AGENT_PROMPT=coding-v1 HARNESS_VERIFY_COMMAND="npm test" HARNESS_MAX_ITERATIONS_PER_TURN=45 node /absolute/path/harness-agent-1.12.0/agent.mjs web
```

Windows PowerShell：

```powershell
Get-FileHash .\harness-agent-1.12.0-portable.tar.gz -Algorithm SHA256
tar -xzf .\harness-agent-1.12.0-portable.tar.gz
$harnessEntry = (Resolve-Path .\harness-agent-1.12.0\agent.mjs).Path
$env:OPENAI_API_KEY = "你的模型密钥"
$env:OPENAI_BASE_URL = "你的模型服务 /v1 地址"
$env:OPENAI_MODEL = "你的模型 ID"
$env:HARNESS_AGENT_PROMPT = "coding-v1"
$env:HARNESS_DATA_DIR = Join-Path $env:LOCALAPPDATA "HarnessAgent\v1.12.0-web"
$env:HARNESS_VERIFY_COMMAND = "npm test"
$env:HARNESS_MAX_ITERATIONS_PER_TURN = "45"
Set-Location "C:\code\your-project"
node $harnessEntry web
```

默认地址 `http://127.0.0.1:8787/`，一个状态目录只能有一个宿主。省略轮数配置仍为20；提高轮数不提高工具、时间或费用上限，不绕过冻结会话的配置漂移检查。详细合同见 [长任务说明](longrun-harness.md)。

## 随包验收与边界

`BUILD-RECEIPT.json`/包内 `PORTABLE-MANIFEST.json` 绑定版本、sourceSha/sourceTree、文件与归档哈希；`SOURCE-ACCEPTANCE.json` 绑定同一归档的 Ubuntu/Windows Web/CLI；工程收据记录同源码完整测试、四组 CI、真实 Windows 与本地安装复验。发布前的 `ACCEPTED_NOT_PUBLISHED` 保持原始状态，正式发布另由 release 页面证明。

工程门禁使用真实工作区、工具、权限、存储和本地 HTTP 脚本模型，付费调用为0；不证明真实模型能完成任意项目或长摘要没有损失。旧检查点缺少 turnId 时不能精确归属尾账；公开恢复仍是新 turn，不承诺任意手动恢复链的全局预算。进程组不清理主动逃组 daemon，也不代表强 OS 沙箱。可轮询 PTY/后台句柄和全部上游 UI 能力不因本次发布自动具备。
