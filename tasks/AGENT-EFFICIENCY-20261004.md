# AGENT-EFFICIENCY-20261004

用户授权自主审查、提出优化计划并实现验收。权威实施前规格：[plan(20261004-131935).md](../plan(20261004-131935).md)，基线18f162b。

做什么：R1补齐生产模型wire的system上下文；R2一次检索内缓存去重token，结果策略等价；R3目录/搜索真实深度和数量边界；R4同源码全仓/具名usage、原始证据与原生main发布。

怎么做与怎么验收：严格依计划表，先保存实际RED，再最小实现、定向/生产HTTP/工作量及paired性能验收。Core不动；所有工具仍经Orchestrator/PermissionEngine/Sandbox。默认feature/champion不改，无paid/live模型质量收益宣称。baseline/失败/探索结果不可覆盖，完成源码和报告提交分别标记。

2026-10-05 全仓追加发现：91967f4 的三个既有 Core wire E2E 测试断言将丢失 system 的行为固定为预期，实际完整 wire 仅增加首个 system。只更新该相关集成测试的 exact system 正文、完整 roles 与 assistant/tool 索引及 durable history 正控制；Core 生产保持原字节不变。冻结 runner 增加该文件全部8场景的早期门；首次 full 的3 FAIL/8481 PASS/12 skip原件保留，新 clean SHA 须完整重验，不将首次失败标为通过。

完成：冻结de346b9全18门、8484 PASS/12既有skip、同run strict usage PASS；中文完整检索中位耗时减少84.80%/84.27%。warm15对补测未复现稳定回归且保留原观测。原生main源码已核对，报告/原始索引：[验收记录](../docs/evidence/agent-next-20261004.md)。完成文档随后提交发布，生产与测试保持冻结字节。
