# Coding 链全面审查、修复与验收（2026-10-07）

基线 `33eb6438130956be51706bb523071f7550ba83ab`；用户要求再审查所有残留 bug、修复并达到可执行 coding 任务的工程可用水平。

## 做什么

审查 CLI/Web/SDK 到 Harness、Runtime、provider、工具、权限/沙箱、验证、持久恢复和发布链；重点核查真实项目 cwd、读写编辑、进程 argv/输出/取消、编程任务验证与失败修复、多轮和恢复。列出所有本轮确认问题及明确未验证的边界。

## 怎么做

独立 worktree；先给实际触发条件和失败反例，再修实现。产品副作用继续通过 ToolOrchestrator、PermissionEngine、SandboxManager 和 Verification，遵守 Runtime freeze。保留原计划、未提交工作、冻结实验、门限、champion 和已有证据；不启动子智能体，GitHub 仅用原生 Git/HTTP。
编程验收使用真实临时 Git 仓库、真实文件与进程、明确标记的 scripted OpenAI-compatible 本地 HTTP 服务，不调用付费模型。模型编码质量不能用工程脚本代替。

## 怎么验收

相关回归先 red 后 green；类型检查和全仓 unit/integration、安全/协议边界。通过实际 CLI/Web 的读代码→编辑→运行失败测试→反馈诊断→修复→测试通过，核对实际 repo diff、最终状态和验证日志；审批拒绝/允许、取消、重启与多轮逐项验证。
保持验收期间源码固定；真实 Windows 与最终发布门禁通过原生 Actions 验收。保存清单、命令、原件摘要、测试 skip 原因与产品 SHA，提交并非强制推送。未配置付费模型、旧原件缺失和无法验证的能力明确列出，不伪造通过。
