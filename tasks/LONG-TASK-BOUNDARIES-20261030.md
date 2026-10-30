# 长任务边界缺陷审查

用户要求继续审查和修复。执行 [计划](../plan(20261030-long-task-boundaries).md)：对工具分派截止、Provider 协议及错误体、手动压缩请求、受管理命令持久化边界先复现后修复。

Runtime 只因确定性 correctness/security 反例维护，保持权限、沙箱、ToolOrchestrator、Verification 和原断言/预算。不调用付费模型，不使用 GitHub 连接器，不发布 release。旧失败及上轮证据保持；每项完成以真实红绿、类型检查、相关安全/集成和精确源码 CI 为准。

本地阶段：工具截止、Provider 三项边界、压缩请求身份、受管理命令终态确认及漏写 timed_out 已有实际反例与最小修复，独立复核均无阻塞。根 typecheck 通过，工具/安全/恢复/集成 3097 通过、12 跳过，model 264 项通过，controls 相关 89 项通过；原始失败及中间修复未通过的记录保留。完整源码和精确提交 CI 仍待验收，详见计划执行记录。
