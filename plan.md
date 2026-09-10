# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260909-011405).md](plan(20260909-011405).md)
  （E4 修订执行计划，2026-09-09）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `016473870c15f123edbbd6c624550b09ee69fe75`（main）
- 比较基线：`ad37841dbcbfa1d3553e699ab482e1246a549f48`

## 历史计划

上一轮 E4 计划 `plan(20260907-004430).md`（2026-09-07）已由上述修订计划接替，
不再作为当前入口执行；其任务 E4-00 … E4-10 的产物与报告保留在仓库历史与
`docs/E4-*-report.md`、`docs/E4-STATUS.md` 中。修订计划明确指出：那些进展部分成立，
但其"全部完成"的结论证据不足，需按 E4-R01 … E4-R11 逐项修正并以复现的负例为据。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。
## 修订计划执行状态（2026-09-09 计划）

- 状态：E4-R01 … E4-R09 与 E4-R11 已按本计划完成并提交（本地 main，未推送）；
  E4-R10 为收口任务，其产出见 docs/E4-R10-report.md。
- testedSourceSha（本轮离线验证所依据的提交组，最大祖先）：
  `1347f8d`（E4-R11 收口后；各 R 任务 commit 见 docs/E4-R10-report.md 关闭矩阵）。
- 已知未完成/待环境项（不因“计划已执行”而消失）：
  1. 最新提交组的 Windows CI 需推送后由 GitHub 重新运行确认（无本地推送授权）；
     缺失时 release NOT READY。
  2. release attestation/真实发布证据尚未产生（本计划不自动推送/发布）。
  3. 真实模型 champion 质量：探索性实跑为 INCONCLUSIVE（insecure-local，
     promotionEligible=false），不构成已证实候选提升。
  4. R09 的 CI workflow 侧（.github/workflows）从同一 V2 generator 发证仍待接入。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。
