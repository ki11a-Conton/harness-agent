# Harness Agent：当前执行计划入口 — 实测驱动的技能上下文优化

制定快照：[plan(20261003-000000).md](plan(20261003-000000).md)，包含做什么、怎么做、怎么验收。上一轮完成计划原样归档：[plan(20261003-source-optimization-completed).md](plan(20261003-source-optimization-completed).md)。

日期：2026-10-03；基线 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`。

| 工作包 | 状态 | 验收摘要 |
| --- | --- | --- |
| M1 实际技能 admission 反馈 | IMPLEMENTED_TARGET_PASS | 同一11项基线9FAIL/2PASS；候选39+118PASS；8k实际12份正文/ledger12，原Verification6/6；等待M5整合终验 |
| M2 task_scoped_skills_v1 | IMPLEMENTED_TARGET_PASS | 默认关闭；纯函数/真实Harness 38PASS，CLI与原候选边界86PASS；新候选8k相关9/9、100技能system减少98.62%；等待clean整合终验 |
| M3 provider 参数冻结 | IMPLEMENTED_TARGET_PASS | 原12项10FAIL/2PASS；候选新13+原provider40项共53PASS；实际HTTP1/3与四个独立digest；等待最终clean验收 |
| M4 真实模型 AB/BA pilot | BLOCKED | 当前无模型API凭据；已询问服务/模型和费用上限，尚未收到配置 |
| M5 全仓验收、证据与 main | IN_PROGRESS | 已准备干净验收worktree和八项检查；等待冻结最终实现SHA |

已经实测的工程基线：100技能 system 241065.5→3330.5 bytes；8k相关正文默认0/9、旧固定英文选择9/9；被丢技能仍有3次注入反馈；重试参数不同但dry-run digest相同。以上为离线provider工程反例，真实模型收益 NOT_RUN，promotion NOT_RUN。
