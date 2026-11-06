# 下一轮全面审查

用户要求继续下一场大审查。基线main为3e4f6e734667abb2f77c5023ac128785502799f5，上一轮已完成，不重复认领旧修复。审查运行时/恢复、上下文/记忆、模型协议、工具/进程、Web交互、评测发布边界，只修有复现的新增缺陷。

遵循AGENTS.md Runtime freeze：确定性正确性、安全、发布完整性或已测基础设施/性能问题才改运行时；不重构架构、不改默认策略，不绕过ToolOrchestrator/PermissionEngine/SandboxManager/Verification。保留预算、断言与原失败证据；不付费调用模型、不发release，不手动重跑/取消CI或forcepush，不用GitHub连接器。普通原生git/curl提交交付沿用用户授权。

独立完整检出/tmp/harness-agent-next-audit-20261106，分支fix/next-comprehensive-audit-20261106；证据/dev/shm/harness-next-comprehensive-audit-20261106，临时缓存复用上一轮任务数据盘。原/workspace/harness-agent的未提交工作和上一轮报告/bundle/证据不得删除或改动。每个里程碑保存新的持久恢复bundle与证据摘要，空间不足时明确归档范围。

完成标准：先RED后GREEN、类型检查、相关单元/集成/安全、干净完整pnpm test、真实CLI/Web/必要浏览器及精确SHA的四组CI。区分脚本模型工程验证与真实模型质量；没有零bug或生产质量保证。
