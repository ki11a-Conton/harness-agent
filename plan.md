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

- 状态：E4-R12 … E4-R19 已按本计划完成并提交（本地 main，未推送）；E4-R20 为
  总验收收口，产出见 docs/E4-R12-report.md … docs/E4-R20-report.md。
- reviewedSourceSha（收口验证所依据的提交）：`f134d14`（E4-R19，R12–R19 全部
  源码修复所在的固定提交，见 docs/E4-R20-report.md）。
- 已知未完成/待环境项（不因“计划已执行”而消失）：
  1. 完整提交组的 Windows/Linux CI 需推送后由 GitHub 重新运行确认（无本地推送
     授权）；缺失时 runtimeReleaseReady=false，不伪称 READY。
  2. release attestation/真实发布证据尚未产生（本计划不自动推送/发布）。
  3. 真实模型 champion 质量：不要求为填报告额外付费；paid champion quality 与
     runtime release readiness 分开结论（见 docs/E4-R20-report.md）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。