# Harness Agent：当前执行计划入口 — 实测驱动的技能上下文优化

制定快照：[plan(20261003-000000).md](plan(20261003-000000).md)，包含做什么、怎么做、怎么验收。上一轮完成计划原样归档：[plan(20261003-source-optimization-completed).md](plan(20261003-source-optimization-completed).md)。

日期：2026-10-03；基线 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`。

| 工作包 | 状态 | 验收摘要 |
| --- | --- | --- |
| M1 实际技能 admission 反馈 | IN_PROGRESS | 预算丢弃不得记 injected/token/outcome；原反例 RED 已实测 |
| M2 task_scoped_skills_v1 | IN_PROGRESS | 默认关闭；8k相关9/9；100技能system减少≥90%；显式/中文/unknown |
| M3 provider 参数冻结 | IN_PROGRESS | retry/timeout变更使digest不同；真实HTTP和事后env变化回归 |
| M4 真实模型 AB/BA pilot | BLOCKED | 当前无模型API凭据；已询问服务/模型和费用上限，尚未收到配置 |
| M5 全仓验收、证据与 main | PENDING | 干净受测SHA、可移植证据、原生Git发布 |

已经实测的工程基线：100技能 system 241065.5→3330.5 bytes；8k相关正文默认0/9、旧固定英文选择9/9；被丢技能仍有3次注入反馈；重试参数不同但dry-run digest相同。以上为离线provider工程反例，真实模型收益 NOT_RUN，promotion NOT_RUN。
