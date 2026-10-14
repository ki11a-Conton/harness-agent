# Harness Agent v1.10.0

[正式下载](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.10.0)。这是第一代普通编程闭环版本：CLI/Web 可读改文件、运行验证、处理审批、取消和问答恢复。Preview Notice 与首页 Preview 标记已移除；界面名称和图标为 Harness Agent。

## 安装与启动

需要 Node.js >=22.19.0。下载 `harness-agent-1.10.0-portable.tar.gz` 与 `SHA256SUMS`，核对摘要后解压；消费者无需 pnpm 或源码仓库。包内包含生产依赖、CLI 和 Web。

```bash
sha256sum -c SHA256SUMS
tar -xzf harness-agent-1.10.0-portable.tar.gz
node /absolute/path/harness-agent-1.10.0/agent.mjs --version
node /absolute/path/harness-agent-1.10.0/agent.mjs doctor
```

在自己的项目目录配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`（通常含 `/v1`）、`OPENAI_MODEL`。CLI 的新会话默认使用 coding-v1；验证命令替换为项目的真实命令。

```bash
node /absolute/path/harness-agent-1.10.0/agent.mjs chat . --verify "npm test"
```

Web 使用独立状态目录，并明确选择同一编程提示词策略；默认地址为 `http://127.0.0.1:8787`。

```bash
HARNESS_DATA_DIR=/absolute/path/web-sessions HARNESS_AGENT_PROMPT=coding-v1 HARNESS_VERIFY_COMMAND="npm test" node /absolute/path/harness-agent-1.10.0/agent.mjs web
```

Windows PowerShell 示例：

```powershell
Get-FileHash .\harness-agent-1.10.0-portable.tar.gz -Algorithm SHA256
tar -xzf .\harness-agent-1.10.0-portable.tar.gz
$harnessEntry = (Resolve-Path .\harness-agent-1.10.0\agent.mjs).Path
$env:OPENAI_API_KEY = "你的模型密钥"
$env:OPENAI_BASE_URL = "你的模型服务 /v1 地址"
$env:OPENAI_MODEL = "你的模型 ID"
$env:HARNESS_AGENT_PROMPT = "coding-v1"
Set-Location "C:\code\your-project"
node $harnessEntry chat . --verify "npm test"
# 关闭 CLI 后启动 Web；同一状态目录只由一个宿主占用。
$env:HARNESS_DATA_DIR = Join-Path $env:LOCALAPPDATA "HarnessAgent\v1.10.0-web"
$env:HARNESS_VERIFY_COMMAND = "npm test"
node $harnessEntry web
```

CLI 恢复用 `chat . --resume "实际 session id" --verify "npm test"`，保持原项目、模型、策略及验证配置。旧版本缺少问答检查点的暂停任务会拒绝恢复，防止重置预算或遗失已写文件的记录。

## 固定源码与验收

产品源码：`b65801e49a6991853867106c77d968d7dec2c074`；Git tree：`dbd7271348e4bb1852762bd0d1b3081706486dd4`。注解 tag `v1.10.0` 指向此提交。后续文档归档提交不改变已发布产品字节。

安装包 58,158,920 bytes，3,047 个清单文件；SHA-256：

```text
6b27c4643ffd6416cc9960033774657be7e79ac56e64fbf928e80488979928b9
```

| 验收 | 实际结果 | 原件/依据 |
| --- | --- | --- |
| 全仓单元/集成 | 554 文件 PASS、2 文件 SKIP；9,521 PASS / 15 SKIP / 0 FAIL | `logs/release-v110-full-b65801e.log` |
| 类型与生产依赖 | typecheck PASS，14 项生产依赖已知漏洞 0 | `logs/release-v110-final-typecheck.log`、`logs/release-v110-final-audit.json` |
| 发布/资源/传输/导航及发送回归 | 77 PASS / 0 FAIL | `logs/release-v110-b65801e-release-scripts.log` |
| 原生 Windows 专项 | 33 文件，393 PASS / 2 POSIX SKIP；12 项必需实际进程案例 PASS | `native-windows/receipt.json`、`native-windows/case-records.json` |
| 同一包 Ubuntu/Windows Web | 每平台 30 场景 / 75 断言 | `exact-distribution/SOURCE-ACCEPTANCE.json` |
| 同一包 Ubuntu/Windows CLI | 分别 50/49 断言；doctor 无错误、无 workspace links、真实启动拒绝篡改 | 同上，Windows 不执行 POSIX 模式位断言 |
| 下载后本地 Node 24 复验 | CLI 50、Web 75、问答/EOF 恢复/脱敏 15、品牌 96 断言 | `exact-distribution/{cli,ui,questions,brand}/result.json` |
| 完整主 CI | run 38534860525 attempt-3，10/10 SUCCESS，含两平台全量/formal、coverage、closed-loop、cold-start、同 SHA 汇总及发布证明 | `ci/cohort3/run-final.json`、`ci/cohort3/jobs-final.json` |
| 正式公开下载 | 4/4 资产无需登录下载，大小、SHA-256 与已验收字节相同 | `publication/public-download-verification.json` |

表中相对证据路径均位于 [v1.10.0 归档](evidence/v1.10.0/README.md)。运行 `python docs/evidence/v1.10.0/verify.py` 可校验原件 inventory 与压缩保存的全部 fixture，不解出长路径。

[完整 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38534860525)、[同包安装验收](https://github.com/ki11a-Conton/harness-agent/actions/runs/38534860528)、[真实 Windows 专项](https://github.com/ki11a-Conton/harness-agent/actions/runs/38534860621)均绑定上述源码。首次 Windows 完整 CI 的 EPERM 写入拒绝和第二轮局部重跑后正确拒绝混用轮次的失败均保留；第三轮在不改源码或证据规则的情况下完整通过。发布证明的依据是实际 CI 成功 job/steps，未取得 Azure 上该原始 JSON artifact。

发布资产另有 `BUILD-RECEIPT.json`、`SOURCE-ACCEPTANCE.json`；后者的 ACCEPTED_NOT_PUBLISHED 是安装收据生成时状态，保持原件不改写。

## 已知边界

工程验收使用实际生产 Runtime、工具、权限、持久化和本地 HTTP 脚本模型，付费调用为 0。付费模型 coding 质量及完整默认 UI 功能等价仍为 NOT_PROVEN。队列原子编辑/steer-now、Cordis、goal/Plan continuation、可续写子智能体、多模态二进制接入、原生桌面打开器及强沙箱 PTY 等缺口见 [审查报告](final-audit-20261014.md)和[交付矩阵](web-deepseek-delivery-matrix.json)。本次发布不声明已实现 Codex/Claude Code 等产品的全部能力，也不声称不存在所有潜在 bug。
