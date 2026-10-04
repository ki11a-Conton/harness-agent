# AGENT-TRUST-20261004

用户要求：自主提出下一轮Agent优化，写做什么/怎么做/怎么验收的plan.md并完成实施。

权威实施前方案：[plan(20261004-000000).md](../plan(20261004-000000).md)；当前状态：[plan.md](../plan.md)。基线968544064f43cfc0a876c4e65fcb967cd466c9a2。

范围：T1自动验收完整性，T2记忆可见性/存储合同，T3反思turn隔离/可靠journal，T4独立验收与原生Git发布。均先有真实生产反例，不扩Core、不绕过ToolOrchestrator/PermissionEngine/SandboxManager/Verification，不改变promotion门。相关原契约：P0 TOOL/EXEC/VS、P4 VERIFY/LOOP、P7 MEMORY/REFLECTION/LEARNING、P9 BENCH/EVAL。

必须满足方案中各项验收，最终source/test受测SHA与文档SHA分开记录。真实模型质量和promotion NOT_RUN；上一轮模型pilot BLOCKED保留，不阻塞本轮确定性工程修复。原始证据可移植、完整hash校验、source clean长链验收、任务scope git add与commit -F，用户禁止GitHub连接器。
