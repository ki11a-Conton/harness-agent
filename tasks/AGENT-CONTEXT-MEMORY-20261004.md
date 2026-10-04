# AGENT-CONTEXT-MEMORY-20261004

UI U1–U4 已验收后执行 agent 默认指令与记忆优化。实施前规格：[plan(20261004-065049).md](../plan(20261004-065049).md)。基线17aa6c7。

依赖任务：P3/CTX-001、P3/CTX-002、P7/MEMORY-001；只修复 audit-context/report.json 和 audit-memory/baseline.json 所示确定性读取/身份/召回反例。符合 AGENTS Runtime Freeze correctness/security/performance 例外。Core不改；指纹在 Harness composition 适配，ContextPipeline raw discovery 保留。默认层级顺序不改。

当前硬合同：输出（包括 marker）≤maxBytesPerFile，单次 prefix capture≤cap+4；不跟随 AGENTS 文件符号链接；UTF-8前缀安全，小预算可只返回空正文及truncated元数据。替代 CTX-001 历史首行越预算的已知例外。

记忆检索投影仅 content+合法When/Do/Avoid；保留既有 FTS 排名且补字面匹配，去重。不得绕安全写入门、检索session/生命周期/TopK/注入扫描；不引入schema/dependency/RAG。现有search没有limit，补集只扫描SQL过滤后的rows，报告10krows实际成本，不宣称吞吐优化。

验收按方案 A1–A4：行为RED/GREEN、固定基线成对探针、真实model request/step fingerprints、性能观察、独立审查。UI+agent最终干净源码进行一次具名全仓测试，strict usage-audit/typecheck/build/security/docs通过；portable原始证据哈希通过，再原生Git发布main。scripted≠real model quality，付费0，不声称promotion。

CI Windows 确认 S2 CLI 既有I/O观察器只统计readFile，现改为实际bounded capture计数（每handle首次非零bytesRead），保留4doc/request和原ABBA/独立内容verifier控制。纳入直接相关CLI测试范围；source branch旧失败与local full中断证据保留，最终新clean源码重跑全仓。
