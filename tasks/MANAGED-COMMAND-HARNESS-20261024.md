# 发布后的 coding harness 规划

用户要求在收尾并发布第三个 release 后，继续研究 coding harness 的优化方向。本阶段交付源码比较、可执行计划及规划提交；实验实现的状态单独列明。

阅读 [计划](../plan(20261024-managed-command-harness).md)、[源码比较](../docs/research/managed-commands-20261024/README.md) 和根 AGENTS.md。发布基线为 v1.12.0 / `37a16e3d0ac60da12caff5e28c77a20c8a017e2e`，发行标签、资产及工程档案保持。

本阶段只修改计划、研究记录与发布收尾文档，不把 H0 实测或 H1–H5 的新工具、PTY、宿主接线及模型效果标为完成。下一轮先做 H0 基线，再按已列的 owner、预算、输出、取消、验证、压缩/恢复门禁实现默认关闭的工具 challenger。现有 Runtime 冻结；生产副作用继续经过 ToolOrchestrator、PermissionEngine、SandboxManager 和 Verification。付费模型实验继续由用户线下提供，不从本阶段触发。

规划验收：引用的本地源码与固定 HEAD 字节一致；明确做什么、怎么做、怎么验收及未实施项；文档链接与 diff 检查通过；与已发布源码隔离后提交。未来实现需要相应类型、单元/集成、安全、跨平台及同包门禁，不能用本阶段文档检查代替。
