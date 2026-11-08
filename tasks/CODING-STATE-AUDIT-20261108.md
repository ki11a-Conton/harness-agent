# Coding 状态与恢复全面审查

用户要求开始下一轮大审查。基线 main 为 `5f55f1bd4f0dabfdf58f2bccebfd8885d003513c`，上一轮四项 CI 已通过。本轮审查执行/恢复、上下文压缩、工具与文件、持久状态、模型与 Web 交互，先记录可重复的真实缺陷再修复，不重复认领旧修复。

遵守 AGENTS.md：Runtime 仅为确定性正确性、安全、发布完整性或已测基础设施故障修改；保留 ToolOrchestrator、PermissionEngine、SandboxManager、Verification 的边界。不改变默认策略或放宽现有验收预算。只使用原生 git/curl；不使用 GitHub 连接器、不调用付费模型、不发布 release、不 force push、不取消或手动重跑 CI。沿用用户的普通提交推送授权。

新环境的临时目录已清空，本轮从远端完整检出到 `/dev/shm/harness-review-20261108/repo`。旧工作区与持久证据保留。每个交付里程碑向 `/workspace` 保存新的恢复材料；证据带源码 SHA、命令、退出码和日志哈希。

完成标准：对确认缺陷保留旧实现 RED / 新实现 GREEN 与正常行为对照；通过相关单元/集成/安全检查、类型检查、干净源码全量 `pnpm test`、实际 CLI/Web 验收及最终 main 精确 SHA 四项 CI。工程验收与真实模型能力评测分开记录。
