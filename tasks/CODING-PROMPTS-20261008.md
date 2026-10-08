# 内部 coding 提示词（2026-10-08）

用户要求检查内部提示词能否达到生产 coding agent 标准，并参考当前工作区开源源码进行改进。实施/验收表见 `plan(20261008-coding-prompts).md`。

范围：Agent 策略、Harness 提示词配置和 CLI/Web 加载一致性、会话指纹、相关回归与实测。保持既有 ToolOrchestrator、PermissionEngine、SandboxManager、Verification 和冻结实验的边界。

新版为具备显式版本及正文指纹的 `coding-v1` challenger，通过 `HARNESS_AGENT_PROMPT=coding-v1` 或 SDK 编译配置启用。当前默认保留 legacy；真实模型效果未证明之前不自动替换冻结实验或推广冠军。

状态：工程验收完成。最终源码 `6814ead2906f719a3a8e591d2ef73d8d37d529c2`：全量 9099、安全 2135、协议 52、针对性 48 通过；原生 Windows 253 通过；实际 CLI/Web 新策略 Linux 58、Windows 57 条断言通过。官方完整 CI 十个 job 全部 success。

P07 组合反例另已修复：新策略独立运行，保留原冠军状态且不生成未评估组合的 AppliedProof。来源、原件、明确 skip/失败记录及离线复核见 `docs/evidence/coding-prompts-20261008/README.md`。

真实模型质量与相对提升仍为 NOT_PROVEN。线下对照需 C0 启动目录、独立项目/数据目录及相同配置；具体启用/回退与比较步骤见 `docs/coding-prompts.md`。
