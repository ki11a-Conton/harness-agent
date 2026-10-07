# AGENT-TRUST-20261004

用户要求：自主提出下一轮Agent优化，写做什么/怎么做/怎么验收的plan.md并完成实施。

权威实施前方案：[plan(20261004-000000).md](https://github.com/ki11a-Conton/harness-agent/blob/965da0bb123fbdd9b61bded6bc345b767ad0c48f/plan(20261004-000000).md)；当前状态：[plan.md](../plan.md)。基线968544064f43cfc0a876c4e65fcb967cd466c9a2。

范围：T1自动验收完整性，T2记忆可见性/存储合同，T3反思turn隔离/可靠journal，T4独立验收与原生Git发布。均先有真实生产反例，不扩Core、不绕过ToolOrchestrator/PermissionEngine/SandboxManager/Verification，不改变promotion门。相关原契约：P0 TOOL/EXEC/VS、P4 VERIFY/LOOP、P7 MEMORY/REFLECTION/LEARNING、P9 BENCH/EVAL。

必须满足方案中各项验收，最终source/test受测SHA与文档SHA分开记录。真实模型质量和promotion NOT_RUN；上一轮模型pilot BLOCKED保留，不阻塞本轮确定性工程修复。原始证据可移植、完整hash校验、source clean长链验收、任务scope git add与commit -F，用户禁止GitHub连接器。

T1 执行发现：基线命令缓存可跨进程保留错误的子包入口。实施包含旧无版本缓存定向失效和新版暖缓存控制，保证修复适用于升级后的实际启动路径；不扩大命令缓存的通用刷新政策。

T3 独立审查实测追加：候选文件写失败会留下内存ghost，纳入最小copy-on-write持久化事务修复。验收要求add/update/remove失败保持原Map、实际list/get不暴露未落盘变更、恢复后重试正常；反思candidate写失败仍journal1、candidates0且实际queue0。不改变schema、promotion或独立store缓存协调。

完成：受测源码d01df59f31b156f7c8622ae6c926ce99bc751400，clean本地8项检查通过，8295 PASS/12 SKIP，source CI37167480007同SHA10/10通过；3组冻结实测12/12、32/32、23/23通过。main原生发布后的API/ref/本地核对见ignored发布收据，源码与文档收尾SHA分开，原计划/pilot阻塞原样保留。
