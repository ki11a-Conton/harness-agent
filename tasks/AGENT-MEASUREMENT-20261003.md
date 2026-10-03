# AGENT-MEASUREMENT-20261003

用户要求：实际测量后自主提出优化，写包含做什么/怎么做/怎么验收的 plan.md 并完成实施。

权威实施前计划：[plan(20261003-000000).md](../plan(20261003-000000).md)；状态入口：[plan.md](../plan.md)。M1确定性反馈错误、M2默认关闭策略challenger、M3评测身份错误、M4真实模型pilot、M5独立验收交付。

读取相关 skills/context/runtime/evaluation/verification 任务，遵守AGENTS.md与HANDOVER.md。模型质量假设不解冻Core；只允许M1确定性反例所需的最小additive接缝。禁止绕过ToolOrchestrator/PermissionEngine/SandboxManager/Verification。不得将scripted provider工程测量宣称真实模型收益，promotion保持NOT_RUN。

工程验收：新增针对真实反例的回归、typecheck/build/full test/security/docs verify/strict usage audit/diff check，在干净隔离受测SHA上运行。真实pilot缺凭据/费用配置时准确保留BLOCKED，不能以全仓green证明质量收益。原生Git发布；用户明确禁止GitHub连接器。

执行结果：M1/M2/M3/M5工程完成；受测实现 `72232950938fcefa2e0a79c222c177deb79ec200` clean八项验收PASS（8193PASS/12SKIP、安全2135PASS），同SHA CI37139937665十项jobs全部PASS。实施前spec不改写，当前plan和证据报告列出实际验收。M4因缺模型凭据及服务/模型/费用配置仍BLOCKED，质量/promotion NOT_RUN。最后文档跟进commit不改变已受测代码。
