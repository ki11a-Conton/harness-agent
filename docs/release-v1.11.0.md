# Harness Agent v1.11.0

[下载页](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.11.0)。这是第一代 CLI/Web 的更新版本；保留 v1.10.0 和其他历史 tag。正式发布状态以该页面的非草稿 release 为准，固定源码和实际验收见随包收据。

## 主要更新

- 会话中切换模型时，旧答案的模型来源保持不变，新请求使用已持久化选择；写入故障后可恢复，并保持原工具与权限策略。
- 补齐新建会话的配置冻结、重启分支、策略漂移报告、敏感信息脱敏、事件尾读和 Windows 命令执行修复。
- 汇总自 v1.10.0 以来的 Web 配置、模型发现、文件、会话及日常交互修复；真实服务重连与右下角连接提示独立验收。
- 发布前重新操作桌面、390px 与320px页面。验收等待实际可见状态、点击完成和实际工具输出，保留原失败证据。

## 安装与启动

需要 Node.js >=22.19.0。下载 `harness-agent-1.11.0-portable.tar.gz` 和 `SHA256SUMS`，核对 SHA-256 后解压。使用安装包启动不需要 pnpm 或源码仓库。

```bash
sha256sum -c SHA256SUMS
tar -xzf harness-agent-1.11.0-portable.tar.gz
node /absolute/path/harness-agent-1.11.0/agent.mjs --version
node /absolute/path/harness-agent-1.11.0/agent.mjs doctor
```

在实际项目目录配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 后运行，验证命令替换为你的项目命令。

```bash
node /absolute/path/harness-agent-1.11.0/agent.mjs chat . --verify "npm test"
HARNESS_DATA_DIR=/absolute/path/web-sessions HARNESS_AGENT_PROMPT=coding-v1 HARNESS_VERIFY_COMMAND="npm test" node /absolute/path/harness-agent-1.11.0/agent.mjs web
```

Windows PowerShell：

```powershell
Get-FileHash .\harness-agent-1.11.0-portable.tar.gz -Algorithm SHA256
tar -xzf .\harness-agent-1.11.0-portable.tar.gz
$harnessEntry = (Resolve-Path .\harness-agent-1.11.0\agent.mjs).Path
$env:OPENAI_API_KEY = "你的模型密钥"
$env:OPENAI_BASE_URL = "你的模型服务 /v1 地址"
$env:OPENAI_MODEL = "你的模型 ID"
$env:HARNESS_AGENT_PROMPT = "coding-v1"
$env:HARNESS_DATA_DIR = Join-Path $env:LOCALAPPDATA "HarnessAgent\v1.11.0-web"
$env:HARNESS_VERIFY_COMMAND = "npm test"
Set-Location "C:\code\your-project"
node $harnessEntry web
```

默认地址 `http://127.0.0.1:8787/`。同一状态目录同时只由一个宿主使用。可先用独立状态目录试运行；恢复已有会话需保留项目、模型、策略和验证配置，不能把兼容性拒绝当作继续原任务成功。

## 固定源码与验收

- `BUILD-RECEIPT.json` 和包内 `PORTABLE-MANIFEST.json`：版本、完整 sourceSha/sourceTree、包哈希及文件清单。
- `SOURCE-ACCEPTANCE.json`：同一 tar.gz 的 Ubuntu/Windows Web/CLI 实际安装验收，含日常按钮与连接恢复结果。
- `ENGINEERING-ACCEPTANCE.json`：同源码主 CI 十项、原生 Windows、安装工作流，以及本地完整、安全和发布复验依据。

只有这些收据和实际 CI 均通过，才从 draft 正式发布。收据生成时的 `ACCEPTED_NOT_PUBLISHED` 保留原件，不改写历史状态。主 CI 的 release attestation 也不等同于已发布产品。

## 已知边界

工程验收使用实际生产工具、权限、存储和本地 HTTP 脚本模型，付费调用为0，真实模型 coding 质量仍需实际模型评测。覆盖的是已列明按钮和 coding 流程；PTY/Cordis、goal/Plan continuation、队列原子编辑等完整 UI 能力不因本次发布自动成立，详见 [交付矩阵](web-deepseek-delivery-matrix.json)。

发布前完整suite另发现测试准备的固定端口冲突：产品正确拒绝占用端口，测试不应假设新目录必有可用端口。已补初始分配、非busy传播与耗尽对照，产品锁语义保持；原始失败和修正见[归档](evidence/release-v111-lease-fixture-20261018/README.md)。最终版本仍须以新固定源码重新完成全部工程与实际安装验收。

Windows主CI另暴露claim锁遗漏EPERM竞争分类，已复用同文件账本锁的既有分类并补拒绝/活owner回归。原一次手机发送未触发请求的现象尚未稳定复现；保留原件，新增原生click及唯一prompt断言，并在新实际包重新验收，详见[追加归档](evidence/release-v111-claim-lock-20261018/README.md)。

发布验收还修正了账本变异测试的重复文字锚点：保持真实 EPERM 故障注入和全部保护断言，仅限定账本上下文，见[原始失败与修复](evidence/release-v111-mutation-scope-20261018/README.md)。
