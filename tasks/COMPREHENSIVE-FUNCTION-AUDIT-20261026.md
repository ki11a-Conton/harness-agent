# 全面功能审查与缺陷修复

用户要求对当前 Harness Agent 做全面优化，找出实际有 bug 的功能并修复。本轮从最新 main `dfa09106bbc1ce2b8521c8d98df3aadecdcb3b2f` 建隔离工作树，按 [计划](../plan(20261026-comprehensive-function-audit).md) 执行。

审查范围包括 Web 日常点击与组件后端接线、模型配置及真实 HTTP/SSE、coding 文件/检索/命令工具、权限与沙箱、上下文压缩/恢复、计划目标/审批/停止、工作区及会话隔离、记忆及交付物。用明确反例区分实际缺陷、已提示的未支持能力和未验证项，不能把静态怀疑直接写成已确认 bug，也不能因已有测试通过便声称没有缺陷。

每项生产修复先复现，记录根因、做什么/怎么做/验收，再编码。Runtime 冻结继续生效：不因模型策略猜测改写 Core，不绕过 ToolOrchestrator、PermissionEngine、SandboxManager 或验证器，不扩大预算或隐藏失败。必要的工具边界维护必须有确定性正确性/安全反例。

只使用原生 Git/HTTP，不使用 GitHub 连接器，不打印或持久化 token，不调用付费模型，不修改旧 release/tag/assets，不影响其他工作树。完成本地类型/专项/安全/真实交互/完整测试后提交推送 main，等待精确提交的四条 CI 自然终态，再归档完整记录。
