# Harness Agent：当前执行计划入口 — 实测驱动的技能上下文优化

制定快照：[plan(20261003-000000).md](plan(20261003-000000).md)，包含做什么、怎么做、怎么验收。上一轮完成计划原样归档：[plan(20261003-source-optimization-completed).md](plan(20261003-source-optimization-completed).md)。

日期：2026-10-03；基线 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`。

| 工作包 | 状态 | 验收摘要 |
| --- | --- | --- |
| M1 实际技能 admission 反馈 | DONE_ENGINEERING | 同一11项基线9FAIL/2PASS；候选39+118PASS；8k实际12份正文/ledger12，原Verification6/6；clean全仓8193PASS/12SKIP |
| M2 task_scoped_skills_v1 | DONE_ENGINEERING | 默认关闭；纯函数/真实Harness 38PASS，CLI与原候选边界86PASS；新候选8k相关9/9、100技能system减少98.62%；clean完整验收通过 |
| M3 provider 参数冻结 | DONE_ENGINEERING | 原12项10FAIL/2PASS；候选新13+原provider40项共53PASS；实际HTTP1/3与四个独立digest；clean完整验收通过 |
| M4 真实模型 AB/BA pilot | BLOCKED | 当前无模型API凭据；已询问服务/模型和费用上限，尚未收到配置 |
| M5 全仓验收、证据与 main | DONE | clean受测SHA7223295八项检查通过；CI10/10（Ubuntu/Windows、同SHA汇总、发布证明）；证据随本计划原生Git发布main |

已经实测的工程基线：100技能 system 241065.5→3330.5 bytes；8k相关正文默认0/9、旧固定英文选择9/9；被丢技能仍有3次注入反馈；重试参数不同但dry-run digest相同。以上为离线provider工程反例，真实模型收益 NOT_RUN，promotion NOT_RUN。

冻结工程受测SHA：`72232950938fcefa2e0a79c222c177deb79ec200`。本地八项检查全部PASS，全量8193PASS/12SKIP、安全2135PASS。新策略clean AB/BA system 242365.5→3343.5 bytes（−98.620%），默认仍关闭。最终实测报告：[agent-measurement-20261003.md](docs/evidence/agent-measurement-20261003.md)。

双平台CI：[37139937665](https://github.com/ki11a-Conton/harness-agent/actions/runs/37139937665)，固定同一受测源码SHA，10/10成功。M1/M2/M3/M5工程工作已完成；M4缺少模型凭据、服务/模型与费用配置，仍BLOCKED，不标整轮全部完成。最终文档跟进提交不修改受测生产源码、测试及复现脚本。
