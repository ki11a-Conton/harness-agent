# Coding 长任务 harness 能力

用户要求研究 harness 职责及 pi、Codex、DeepSeek Harness 源码，然后实际优化本项目。基线为 main `eafcdb56fd266d6c862b5d3d910fcf5530e10fa0`，独立工作树 `harness-agent-longrun-20261020`。允许并行源码研究和限定文件的实施/复核。

按根 plan.md 的研究矩阵、反例、实施、验收执行。Runtime 架构冻结：只对已复现的上下文溢出丢检查点、终止边界遗漏 steer 等问题做窄修复；宿主预算接入复用现有 maxIterationsPerTurn，不建立第二条执行循环，不自动越过失败/预算。所有副作用保留 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。

仅在临时目录和本地模型传输运行确定性验收，禁止付费模型请求、GitHub 连接器、读取/打印凭据、变动既有 release/tag/assets。保留失败结果，完成类型、相关单元/集成/安全、固定提交全量及实际长任务验收。原生 git 提交；沿用既有 main 推送授权，先过本地门禁再推送，随后复核精确 SHA CI。不能将脚本模型结果当作真实模型质量证明，不能保证任意长任务成功。

补查 R2：公开 resumeTurn 的检查点后费用/输出漏算已由内存红例证明，符合 Runtime 冻结的确定性正确性例外。复用现有同任务预算回放和已花预算预检；不更改公开恢复的新 turn/时长合同。验收须证明原任务、水位、工具/重试、摘要费用与正文边界，以及超限零模型请求；最终源码重新跑完整门禁。
