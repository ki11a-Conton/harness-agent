# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260911-013142).md](plan(20260911-013142).md)
  （bcf34b7 增量审查与下一轮 Agent 执行计划，2026-09-11）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `bcf34b7179152ac2fc24931f268fada8a67f82d9`（main）
- 比较基线：`36c9c267aff5f32a0ccd9364da3306e28114921c`

## 历史计划

上一轮 E4 计划 `plan(20260910-070001).md`（2026-09-10，E4-R12 … E4-R20）已由当前
计划接替，作为历史保留在 git 历史中；其验证结论与产物见
`docs/E4-R12-report.md` … `docs/E4-R20-report.md`。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。
## 修订计划执行状态（2026-09-11 计划）

- 状态：E4-R21 … E4-R26 按 plan(20260911-013142).md 执行中；
  R21（F01 release 证据消费链统一）与 R22（F02 executionPlan 严格解析与
  交叉绑定）已完成，产物见 docs/E4-R21-report.md、docs/E4-R22-report.md。
- 前一轮（2026-09-10 计划）收口结论保留：E4-R12 … E4-R20 已完成、已推送
  origin/main；CI run 34548502173（bcf34b7）四 job 全部成功，
  `runtimeReleaseReady=true`（详见 docs/E4-R20-report.md）。
- 已知未完成/待环境项（不因"计划已执行"而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（本计划只到 attestation，不自动发布）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。