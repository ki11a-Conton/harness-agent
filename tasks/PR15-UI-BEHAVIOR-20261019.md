# PR #15 十一项用户实测问题

用户明确要求根据PR #15修复对应问题。按根plan.md逐项完成：P0长度截断；六项UI精简；推理档位、三档权限、目标/计划模式、上下文自动/手动压缩。PR原文保留，不将文档合并当修复完成。

Core/Runtime架构冻结，只有确定性正确性反例可做窄修复；其它能力在宿主/工具/受控前端衍生层实现。所有副作用遵守Orchestrator、PermissionEngine、SandboxManager和Verification；计划未确认不允许副作用，完整权限需人确认，会话隔离。原件与许可保留，UI重建可重算，不使用DOM遮挡。

新增恢复反例：先持久入队目标prompt，在drain前关闭宿主并重建，原inbox长期pending且零模型请求。宿主不能通过额外enqueue伪造新prompt唤醒，否则重复执行。允许在SessionActor增加只委托既有requestFollowupWake的wakePending入口；重用原同T恢复/租约/预算/审批/沙箱算法，alias facade保留代际检查。以重启后原prompt ID唯一、原入队记录被消费、实际文件写入为验收。

真实模型无需付费调用；用本地HTTP模型验证真实工具/持久状态/浏览器交互，明确它不能证明模型质量。相关、集成、安全、全量及精确SHA CI验收后交付，保留失败，不强推、不取消旧CI、不发布release，不修改其它工作树或用户数据。禁止子agent/GitHub连接器。
