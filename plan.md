# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260911-072937).md](plan(20260911-072937).md)
  （E4-R27…E4-R31：晋升隔离资格 / 执行计划字段 / 二进制源码指纹 /
  恢复存储有限唤醒 / 独立验收收口，2026-09-11）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `493866f03d942e85870cc658eb721cfbf2389ec2`（main）
- 比较基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`

## 历史计划

上一轮 E4 计划 `plan(20260911-013142).md`（2026-09-11，E4-R21 … E4-R26）已由当前
计划接替，作为历史保留在 git 历史中（其文件已从工作树删除，仅存于历史）；其验证结论与
产物见 `docs/E4-R21-report.md` … `docs/E4-R26-report.md`。

再上一轮 `plan(20260910-070001).md`（E4-R12 … E4-R20）同样作为历史保留在 git 历史中，
产物见 `docs/E4-R12-report.md` … `docs/E4-R20-report.md`。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。

## 修订计划执行状态（2026-09-11 计划 E4-R27…R31）

- 状态：E4-R27、E4-R28 已按 plan(20260911-072937).md 完成（本地提交，待推送）：
  - R27（G01 晋升隔离资格语义）✅ docs/E4-R27-report.md（insecure/none 不可晋升，
    evaluator/loader/writer 三边界共享语义校验；18 例离线测试）
  - R28（G02 执行计划字段与规模约束）✅ docs/E4-R28-report.md（四个预算字段真正接入
    validator、整数合同、limit/caseIds 一致性、网格规模上限；14 例离线测试）
- 已完成（工作树改动，尚未提交）：E4-R29、E4-R30（2026-09-12）：
  - R29（G03 二进制源码指纹——UTF-8 解码碰撞 0x80↔0x81）✅ docs/E4-R29-report.md
    （`probeSourceSnapshot` 改原始字节哈希 + 无歧义 JSON 记录 + 不可读→UNKNOWN；
    `benchmark-command.test.ts` 66/66）
  - R30（G04 恢复存储暂时故障的有限唤醒——lease/intent 写失败后无 scheduler 回调）✅
    docs/E4-R30-report.md（`scheduleStoreRecheck()` 有界单 timer + `durableTurnIsTerminal`
    三态 unknown；`recovery-durable.test.ts` 19/19；R25 报告已加 superseded 指引）
- 已完成：R31（独立验收与计划收口 —— G01…G04 关闭矩阵 + 全仓门禁）✅ docs/E4-R31-report.md
  （四类复现 18/14/4/7 全 PASS；typecheck/docs:verify/race/security/protocol/chaos 全绿；
  全量 `pnpm test` 唯一失败 = 4 例干净树门禁，脏工作树下预期、已用生产函数直接证明非回归；
  远端 CI / push / 真实模型质量 = NOT_RUN）。一页最终状态见 docs/E4-STATUS.md 新增段。
- 修正过度关闭：R22「数字边界」声明（→ R28）、R25「有限唤醒已验收」（→ R30）均已加
  superseded 指引，旧证据未改写。
- 上一轮（2026-09-11 计划 E4-R21…R26）收口结论保留：E4-R21 … E4-R26 已完成并已推送
  origin/main；远端 CI run #112（`2b2d3db`）四 job 全绿（含 strict usage-audit
  两平台 success、release attestation READY=true）。
- 再上一轮（2026-09-10 计划）收口结论保留：E4-R12 … E4-R20 已完成、已推送
  origin/main；CI run 34548502173（bcf34b7）四 job 全部成功，`runtimeReleaseReady=true`
  （详见 docs/E4-R20-report.md）。
- 已知未完成/待环境项（不因"计划已执行"而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
  3. E4-R27 / E4-R28 本地提交尚未推送 origin/main；推送后由新 CI run 确认新 SHA
     （testedSourceSha 与 documentationCommitSha 严格区分）。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。