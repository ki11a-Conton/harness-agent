# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260912-180524).md](plan(20260912-180524).md)
  （E4-R36…E4-R39：首次恢复发现失败后能够重新扫描并自行恢复 / 升级后不再收集旧目录的故意
  失败夹具 / 补齐执行计划边界的有效正例与 promotion-loader 验收 / 同步状态并完成最终门禁，
  2026-09-12）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`（main）
- 比较基线：`bcf3f42ca31fcf91c714c46745a90e7c91245f83`

## 历史计划

上一轮 E4 计划 `plan(20260912-021843).md`（2026-09-12，E4-R32 … E4-R35）已由当前计划接替，
作为历史保留在 git 历史中（其文件已从工作树删除，仅存于历史）；其验证结论与产物见
`docs/E4-R32-report.md` … `docs/E4-R35-report.md`。

更早的 `plan(20260911-072937).md`（E4-R27 … E4-R31）、`plan(20260911-013142).md`
（E4-R21 … E4-R26）与 `plan(20260910-070001).md`（E4-R12 … E4-R20）同样作为历史保留在
git 历史中，产物分别见 `docs/E4-R27-report.md` … `docs/E4-R31-report.md`、
`docs/E4-R21-report.md` … `docs/E4-R26-report.md` 与
`docs/E4-R12-report.md` … `docs/E4-R20-report.md`。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。

## 执行状态（2026-09-12 计划 E4-R36…R39）

- 本轮已完成（本地提交）：
  - R36（J01：首次恢复发现失败后可重扫、可自愈）✅ `docs/E4-R36-report.md`
    （`session-actor.ts`：发现完成态只在完整成功路径提交 + 扫描原子提交 + 失败停住本 pass；
    `recovery-durable.test.ts` 29/29）
  - R37（J02：升级后不再收集旧目录故意失败夹具）✅ `docs/E4-R37-report.md`
    （`vitest.config.ts`：窄范围结构性排除 + 保留框架默认 exclude；
    `e4-r24-final-result-protocol.test.ts` 5/5）
  - R38（J03：执行计划边界的有效正例与 loader 验收）✅ `docs/E4-R38-report.md`
    （新增 `e4-r38-execution-plan-boundary.test.ts` 3/3 + 强化 R33-f 正例；无生产修复）
- R39（状态同步与最终门禁收口）：⚠️ **PARTIAL** `docs/E4-R39-report.md`
  —— 关闭矩阵、干净树门禁实测、远端 CI 只读核实与免责口径均记录于该报告。
  **未通过项**：冻结版本 `01c4ec74` 上的全仓 `pnpm test` 未取得绿
  （`e4-09-production-e2e.test.ts` 的 `buildRealChain` 在全量并发下 3/3 把有效链判
  `INVALID`；隔离 5/5 通过；根因未定），且该 SHA 自身的 Windows CI job 两次尝试均失败。
- 上一轮（2026-09-12 计划 E4-R32…R35）已完成并**已推送** origin/main：
  R32/R33/R34 收口于 `d212d977`，状态与 CI 补记于 `a7950fa1`；CI run `34685604645`
  与 `34685817447` 四个 job 全绿。逐项结论见 `docs/E4-R32-report.md` … `docs/E4-R35-report.md`。
- 更早轮次（E4-R27…R31、E4-R21…R26、E4-R12…R20）已完成并已推送，CI 全绿；详见对应报告。
- 已知未完成/待环境项（不因"计划已执行"而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。
