# 长任务边界缺陷审查

用户要求继续审查和修复。执行 [计划](../plan(20261030-long-task-boundaries).md)：对工具分派截止、Provider 协议及错误体、手动压缩请求、受管理命令持久化边界先复现后修复。

Runtime 只因确定性 correctness/security 反例维护，保持权限、沙箱、ToolOrchestrator、Verification 和原断言/预算。不调用付费模型，不使用 GitHub 连接器，不发布 release。旧失败及上轮证据保持；每项完成以真实红绿、类型检查、相关安全/集成和精确源码 CI 为准。

本地阶段：工具截止、Provider 三项边界、压缩请求身份、受管理命令终态确认及漏写 timed_out 已有实际反例与最小修复，独立复核均无阻塞。根 typecheck 通过，工具/安全/恢复/集成 3097 通过、12 跳过，model 264 项通过，controls 相关 89 项通过；原始失败及中间修复未通过的记录保留。完整源码和精确提交 CI 仍待验收，详见计划执行记录。

干净实现 27bc9bc3 完整源码全量已 PASS（10537/16），CLI/Web 50+8、真实 Windows 836/2、安装 UI 与 Gen1 均 PASS。其综合 Windows 的旧 PR15 测试出现准备阶段计时竞态，失败原样保留；只修测试同步真实 create 边界和任务 teardown，保留原默认 1 秒及全部断言，49 相关测试和根 typecheck 通过。后续不同分支做新 SHA CI，产品代码不变，不能将旧失败重标为通过或将实现 SHA 的本地全量冒称后续提交结果。

修正 3d1609d4 四项 CI 已实际全部首 attempt success：综合 10 job、安装 UI 三 job、Gen1 三执行腿及真实 Windows 864/0/2、原 46 必需项均通过。仅补记 3 份验收文档后快进 main；main 的精确 SHA 自动 CI 另行核对，最终外部审查报告记录其真实结果。原计划里的阶段“待验收”保留为历史，不把旧失败覆写为成功。
