# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260912-021843).md](plan(20260912-021843).md)
  （E4-R32…E4-R35：恢复存储组合故障与 intent 退避 / execution-plan 规模校验先于危险
  操作 / 隔离故意失败的测试夹具 / 提交后状态更新与最终验收收口，2026-09-12）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `bcf3f42ca31fcf91c714c46745a90e7c91245f83`（main）
- 比较基线：`493866f03d942e85870cc658eb721cfbf2389ec2`

## 历史计划

上一轮 E4 计划 `plan(20260911-072937).md`（2026-09-11，E4-R27 … E4-R31）已由当前
计划接替，作为历史保留在 git 历史中（其文件已从工作树删除，仅存于历史）；其验证结论与
产物见 `docs/E4-R27-report.md` … `docs/E4-R31-report.md`。

更早的 `plan(20260911-013142).md`（E4-R21 … E4-R26）与 `plan(20260910-070001).md`
（E4-R12 … E4-R20）同样作为历史保留在 git 历史中，产物分别见
`docs/E4-R21-report.md` … `docs/E4-R26-report.md` 与
`docs/E4-R12-report.md` … `docs/E4-R20-report.md`。

> 执行约定与推荐顺序见当前计划第 2 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。

## 修订计划执行状态（2026-09-12 计划 E4-R32…R35）

- 已完成（本轮本地提交）：E4-R32、E4-R33、E4-R34（2026-09-12）——
  - R32（H01/H02 恢复存储组合故障 + intent 退避）✅ `docs/E4-R32-report.md`
    （`session-actor.ts`：releaseLease 尽力清理 + 重检入口读取失败仍保留有限唤醒 +
    退避计数在整轮严格持久化成功后重置；`recovery-durable.test.ts` 23/23）
  - R33（H03 execution-plan 规模校验先于危险操作）✅ `docs/E4-R33-report.md`
    （`execution-plan.ts`：消除数组实参展开、Set 成员查询、容量护栏提前并提前返回；
    `e4-r33-execution-plan-scale.test.ts` 7/7）
  - R34（H04 隔离故意失败夹具）✅ `docs/E4-R34-report.md`
    （夹具移出根 include 至 `apps/cli/test-infra/observation-fixtures/` + 子进程专用配置；
    `e4-r24-final-result-protocol.test.ts` 4/4）
- 进行中：R35（提交后状态更新与最终验收收口 —— R32…R34 关闭矩阵 + 全仓门禁）🔄。
- 上一轮（2026-09-11 计划 E4-R27…R31）已完成并**已推送** origin/main：
  R27/R28/R29/R30/R31 收口于 `bcf3f42c`，其 SHA 的 CI run `34666585483` 四个 job 全绿。
  逐项结论见 `docs/E4-R27-report.md` … `docs/E4-R31-report.md`。
- 更早轮次（E4-R21…R26、E4-R12…R20）已完成并已推送，CI 全绿；详见对应报告。
- 已知未完成/待环境项（不因"计划已执行"而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。
