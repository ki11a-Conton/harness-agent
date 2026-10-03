# 源码对照驱动的增量优化

执行计划：[plan.md](../plan.md)。研究基线：`6f03bb25ffab0791e292bd888899f925c3d4320a`；源代码合集固定于 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`。

范围为 R1–R6 的确定性缺陷与 S1/S2 的独立实验策略。依旧遵守 Runtime Freeze、ToolOrchestrator → PermissionEngine → SandboxManager、Verification 和既有 paired 决策合同。

| 工作包 | 实现与验收要点 |
| --- | --- |
| R1 | 异常模型终止零工具派发、零成功验收；正常 stop/tool_calls 与 wire 合同保持 |
| R2 | 原始 user/steer 按 turn 身份保护，裁剪/reactive/真实恢复均可见；不升权工具文本 |
| R3a/R3b | 对实际模型文本统一安全处理；分别证明结构契约、脱敏 artifact、UTF-8 byte cap/增量解码 |
| R4 | 规范路径/文件身份协作锁，显式 SHA 前置条件，原始 bytes/EOL/BOM 完整；不虚称跨进程 CAS |
| R5 | 下一 step 更新索引/正文/安全策略；在途记录冻结；未变目录不重复 readdir |
| R6 | 只读检索服从取消/期限，在途工作有界；迟到隔离，反馈写入完整 await 后才 fence |
| S1/S2 | 单一语义差异、实际配置/请求/身份/activation、既有 paired 接线与独立内容验收；默认不启用 |

每项先保留 unchanged baseline 的行为 RED，再记录候选 GREEN。日志失效、fixture 缺陷及中间失败保留并明确标记，不能用 collection/type 错误冒充行为缺陷。长链仅在干净冻结工作树运行，输出留在外部 evidence 目录。

完成条件：各包回归、类型检查、build、安全与全量测试通过；Windows 只接受实际该平台证据。真实模型质量、付费实验和 champion promotion 与离线工程验收分开记录，未运行保持 NOT_RUN。

最终完成：受测提交 `3cdb292efb742c4908e7745b456c6717b212e1d9`，Linux 冻结七命令全部 PASS（8128 测试、安全 2135），同 SHA CI 10/10 job PASS，原生 Git main 发布并核验。源码研究、各阶段 RED/GREEN、真实 Windows 修补与最终验收见 [完整证据](../docs/evidence/source-optimization-20261002.md)。S1/S2 默认关闭，真实模型质量与 promotion NOT_RUN。最终跟进仅文档/证据，与受测代码一致。
