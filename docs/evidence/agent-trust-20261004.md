# 自动验收与经验学习可信性优化（2026-10-04）

状态：计划已先提交，T1–T3定向验收通过，正准备冻结代码并执行干净工作树全仓验收。基线968544064f43cfc0a876c4e65fcb967cd466c9a2，当前入口[plan.md](../../plan.md)。

已运行真实built Harness/文件系统/子进程/JSONL/SQLite工程审计，发现自动验收假完成、跨session/退役记忆注入、SQLite字段损失、跨turn反思重标quarantine与并发journal丢失。原始基线按审计组完整索引收集，不重写内容。

基线工程事实：退出7/9/11的必测任务仍verified_complete；两个后端的10个禁止记忆请求全部注入；显式turnId的旧MCP候选在新clean turn由quarantined变成同证据pending，无turnId的legacy案例则重标新turn但仍quarantined；200个反思输出仅10条journal。详见[原始证据索引](agent-trust-20261004/artifact-index.json)。

定向实施结果：T1测试89 PASS/3 SKIP，12份生产路径收据全部通过；T2测试209 PASS，实际Harness的禁止正文10/10→0/10，8个允许控制通过，32项实测全部通过；T3测试45 PASS，23项实际存储实测全部通过，journal由10/200→200/200，同进程多个reflector共享candidateStore的20条控制完整。原始收据在最终验收时归档，当前定向结果不替代全仓或双平台CI。

真实模型质量、付费实验与promotion均NOT_RUN，paid=0。上述是确定性工程修复，不宣称真实模型收益。最终干净SHA验收待补。

T3追加故障合同：独立实际文件系统审查发现候选写失败会留下内存ghost，已修复为持久化成功后发布新Map；首次读取失败也保持可重试。新增11项同字节回归基线9 FAIL/2 PASS、候选11 PASS；强化后的23项实测通过，候选写失败时journal1、计数0且实际list/get均无候选，恢复后fresh store为空，重试后fresh store有1条。原T3第一阶段证据保持原字节，最终范围以新增故障合同与干净SHA收据为准。
