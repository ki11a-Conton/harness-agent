# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260910-070001).md](plan(20260910-070001).md)
  （E4 增量审查与 Agent 修订计划，2026-09-10）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `36c9c267aff5f32a0ccd9364da3306e28114921c`（main）
- 比较基线：`016473870c15f123edbbd6c624550b09ee69fe75`

## 历史计划

上一轮 E4 计划 `plan(20260909-011405).md`（2026-09-09，E4-R01 … E4-R11）已由当前
计划接替，作为历史保留在 git 历史中；其验证结论与产物见 `docs/E4-R01-report.md` …
`docs/E4-R11-report.md` 与 `docs/E4-STATUS.md`。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。
## 修订计划执行状态（2026-09-10 计划）

- 状态：E4-R12 … E4-R20 已按本计划完成并提交、**已推送 origin/main**；
  E4-R20 为总验收收口，产出见 docs/E4-R12-report.md … docs/E4-R20-report.md。
- reviewedSourceSha（收口验证所依据的提交）：`9a47e42`（R12–R19 全部
  源码修复所在的固定提交，见 docs/E4-R20-report.md）。
- CI 复核（已推送后执行）：run 34546408621（SHA 9fd0f33e…）Linux/Windows/
  coverage/release attestation **全部成功**，`runtimeReleaseReady=true`
  （详见 docs/E4-R20-report.md §3b）。
- 已知未完成/待环境项（不因“计划已执行”而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（本计划只到 attestation，不自动发布）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。