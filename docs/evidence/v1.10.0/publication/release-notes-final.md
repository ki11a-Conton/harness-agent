Harness Agent v1.10.0 是第一代可用的普通编程闭环版本。

移除全新启动时的 Preview Notice 和首页 Preview 标记，界面使用 Harness Agent 品牌。修复工作区切换中编辑器提前解锁及旧初始化覆盖新选择的问题，并包含本轮 CLI/Web/SDK 问答、取消、恢复、路径、输出脱敏和预算边界修复。

安装包从固定 clean 源码构建，包含 CLI、Web 和生产依赖；无需在源码仓库内运行。需要 Node.js >= 22.19.0。

```bash
tar -xzf harness-agent-1.10.0-portable.tar.gz
cd harness-agent-1.10.0
node agent.mjs --version
node agent.mjs doctor
```

在待编码项目目录中调用解压后的 agent.mjs，配置 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL；使用 node /path/to/agent.mjs chat 进入 CLI，或 node /path/to/agent.mjs web 启动 Web。

验收使用真实工具执行、持久化、审批及本地 HTTP 脚本模型，付费模型质量保持 NOT_PROVEN。完整默认 UI 功能等价、PTY/Cordis/goal/queue-edit/持续子 agent 等能力按审查报告中的已声明边界处理。

源码：b65801e49a6991853867106c77d968d7dec2c074。
安装包 SHA-256：6b27c4643ffd6416cc9960033774657be7e79ac56e64fbf928e80488979928b9。
发布包是同一份在 Ubuntu 与真实 Windows 上验收的字节，四份平台安装收据见 SOURCE-ACCEPTANCE.json。第一轮完整 Windows CI 的 EPERM 写入拒绝原件保留；局部重跑后，同轮收据规则正确拒绝混用旧产物。相同源码的第三轮完整 CI 已全部通过（10/10），包括真实 Ubuntu/Windows、同 SHA 双平台验收及发布证明。

验收：全仓 9,521 PASS / 15 SKIP / 0 FAIL；原生 Windows 专项 393 PASS / 2 POSIX SKIP；同一安装包 Ubuntu/Windows Web 均 30 场景 / 75 断言，CLI 分别 50/49 断言。中英文首次启动、刷新及重启品牌回归 96 断言通过。

[完整 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38534860525) · [工程审查](https://github.com/ki11a-Conton/harness-agent/blob/main/docs/final-audit-20261014.md)
