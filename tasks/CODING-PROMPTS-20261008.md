# 内部 coding 提示词（2026-10-08）

用户要求检查内部提示词能否达到生产 coding agent 标准，并参考当前工作区开源源码进行改进。实施/验收表见 `plan(20261008-coding-prompts).md`。

范围：Agent 策略、Harness 提示词配置和 CLI/Web 加载一致性、会话指纹、相关回归与实测。保持既有 ToolOrchestrator、PermissionEngine、SandboxManager、Verification 和冻结实验的边界。

新版为具备显式版本及正文指纹的 `coding-v1` challenger，通过 `HARNESS_AGENT_PROMPT=coding-v1` 或 SDK 编译配置启用。当前默认保留 legacy；真实模型效果未证明之前不自动替换冻结实验或推广冠军。

状态：进行中。工程证据和真实模型限制将在 `docs/evidence/coding-prompts-20261008/README.md` 归档。
