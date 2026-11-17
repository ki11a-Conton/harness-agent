# 2026-11-17 第二轮全面审查

用户授权继续全面审查并修复发现的bugs。基线main：9f111af91cffcb567fe0030baa62d74e5c324186。审查文件工具/事务、Web工作区读写、模型SSE、持久恢复和资源关闭；问题只有在真实路径复现后才列为确认缺陷。未复现的风险不计为修复。

保持AGENTS.md约束：不绕过ToolOrchestrator、PermissionEngine、SandboxManager、Verification；不修改默认策略或Core Runtime架构。不调用付费模型、不发release、不使用GitHub连接器。沿用普通main提交/推送授权，不forcepush、不手动取消/重跑CI。保留/workspace/harness-agent原WIP及上轮证据。

工作检出/dev/shm/harness-audit-20261117-r2/harness-agent；证据/dev/shm/harness-audit-20261117-r2/evidence。先RED→GREEN，控制正常数据/安全/取消，干净完整类型及测试、真实CLI/Web与安装版、最终精确SHA四条CI完成后报告。大文件/短读实验限制实际分配/子进程堆，避免拖垮共享环境。
