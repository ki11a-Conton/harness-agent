# Coding 数据与文件边界审查

基线 main：a8596ed09a7186ad8118c264ff5c9edab99579b3。用户要求继续审查并修复 harness agent；上一轮已交付，不重复认领旧修复。

本轮先复现 JSONL 记忆损坏对检索/安全扫描的影响、技能持久化并发、文件创建及取消和符号链接边界。只有确定性正确性、安全或实测基础设施故障允许改 Runtime；遵守 AGENTS.md，不改变策略、不绕过 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。

工作区 /tmp/harness-agent-coding-integrity-20261106；证据 /dev/shm/harness-coding-integrity-audit-20261106。保留原工作区、旧报告和失败日志。不用 GitHub 连接器，不付费调用模型，不发 release。原生 git/curl 普通提交推送沿用既有授权；不 force push，不取消/手动重跑失败 CI。

完成条件：同一回归在旧实现 RED、新实现 GREEN；保留有效数据、权限、取消和历史兼容对照；相关单元/集成/安全测试、干净源码强制构建与 pnpm test；真实 CLI/Web 工程验收和精确 main SHA 四项 CI。证据明确区分工程链路与付费模型质量，不声称零 bug。每个交付里程碑另存持久恢复材料。
