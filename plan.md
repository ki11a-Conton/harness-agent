# 当前执行计划入口（harness-agent）

**当前执行计划入口** — 本文件是唯一的当前计划入口。

- 当前计划：[plan(20260912-144145).md](plan(20260912-144145).md)
  （E4-R40…E4-R44：失败归因诊断包 / 探测错误的显式语义与 fail-closed / 夹具不得进入生产编译
  边界与共享资源互斥 / 执行计划百万样本边界固定合同 / 证据矩阵与静止工作区最终门禁，
  2026-09-13）
- reviewedSourceSha（该计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`

## 历史计划

上一轮 E4 计划 `plan(20260912-180524).md`（2026-09-12，E4-R36 … E4-R39）已由当前计划接替，
作为历史保留在 git 历史中（其文件已从工作树删除，仅存于历史）；其验证结论与产物见
`docs/E4-R36-report.md` … `docs/E4-R39-report.md`。

更早的 `plan(20260912-021843).md`（E4-R32 … E4-R35）、`plan(20260911-072937).md`
（E4-R27 … E4-R31）、`plan(20260911-013142).md`（E4-R21 … E4-R26）与
`plan(20260910-070001).md`（E4-R12 … E4-R20）同样作为历史保留在 git 历史中，产物分别见
`docs/E4-R32-report.md` … `docs/E4-R35-report.md`、`docs/E4-R27-report.md` …
`docs/E4-R31-report.md`、`docs/E4-R21-report.md` … `docs/E4-R26-report.md` 与
`docs/E4-R12-report.md` … `docs/E4-R20-report.md`。

> 执行约定与推荐顺序见当前计划第 3 节。任何后续会话都应以本文件指向的计划为准，
> 不要从历史计划标题推断范围或完成状态。

## 执行状态（2026-09-13 计划 E4-R40…R44）

- R40（K01：E4-09 失败归因诊断包）✅ `docs/E4-R40-report.md`
  （新增 `apps/cli/src/e4-09-diagnostics.ts`；`runner.ts`/`benchmark-isolation.ts`/
  `benchmark-command.ts`：把 E2-09 哨兵自身的 before/after 探测记录随 outcome 写入
  `paired-experiment.json`；`e4-09-production-e2e.test.ts` 接入失败即落盘；
  独立 `e4-r40-forensics.test.ts` + `test:forensics` 证明落盘路径（按设计非零退出，
  已从默认 `pnpm test` 排除）。**实测归因**：E4-09 真实链要求干净可证源树，
  工作树一脏即拒绝运行 ⇒ 决策读作 INVALID。）
- R41（K02：探测/哨兵错误的显式语义与 fail-closed）✅ `docs/E4-R41-report.md`
  （`benchmark-isolation.ts`：`gitOutput`（吞错）→ 结构化 `gitProbe` + `HostProbeError`；
  `HostState`/`HostStateSummary`/`SentinelReport` 携带有效性与失败原因；新增三态
  `compareHostState`（unchanged/changed/unknown）与可注入的 `gitExec` seam；
  `benchmark-command.ts`：promotion-grade 执行前探测不可验证则不启动、执行后不可验证则
  fail-closed。新增 6 例 helper 测试 + 1 例 CLI 路径测试。**K02 与历史 K01 的因果仍需单独证明**。）
- R42（K03：夹具不得进入生产编译边界；共享 src/dist/tsbuildinfo 互斥）✅ `docs/E4-R42-report.md`
  （`apps/cli/tsconfig.json` 窄范围 `exclude`（唯一生产侧改动，一行）；夹具在盘时真实 `tsc -b`
  产出的 dist 孤儿由 4 个/次 → **0**，排除范围足够窄（36 个正式测试 + 业务源码仍在输入内）；
  新增 `e4-r42-gate-isolation.test.ts`：真实 gate 在自有 git 身份/配置/输出缓存的临时 workspace
  执行，green/非零证据自洽且主仓共享 dist+tsbuildinfo 摘要不变；并发跑协议+release+gate 三文件
  29/29、污染 0/0。**历史 INVALID 与 K03 的因果不合并**。）
- R43（K04：执行计划 999999/1000000/1000001 独立固定边界）✅ `docs/E4-R43-report.md`
  （新增 `packages/evaluation/src/e4-r43-execution-plan-capacity.test.ts` 3 例：固定字面量输入
  max−1/max/max+1 → 接受/接受/拒绝；临时副本把常量 mutation 成 2,000,000 / 999,999 后**真实加载**，
  固定输入分别"必失败"⇒ 判别力已证。**生产零改动**（合同仍 1,000,000）；未展开百万网格。
  `docs/E4-R38-report.md` 增 §6.1 修正「断言随常量精确 ≠ 合同锁定」的表述。）
- R44（K05：证据矩阵与静止工作区最终门禁）：⏳ 待做
- 上一轮 R39（状态同步与最终门禁收口）：⚠️ **PARTIAL** `docs/E4-R39-report.md`
  —— 关闭矩阵、干净树门禁实测、远端 CI 只读核实与免责口径均记录于该报告。
  **未通过项**：冻结版本 `01c4ec74` 上的全仓 `pnpm test` 未取得绿
  （`e4-09-production-e2e.test.ts` 的 `buildRealChain` 在全量并发下 3/3 把有效链判
  `INVALID`；隔离 5/5 通过）。**R40 已给出该失败的确定性根因证据**：非干净可证源树
  被 benchmark 在执行前拒绝（见 `docs/E4-R40-report.md` §4）。
- 上一轮（2026-09-12 计划 E4-R32…R35）已完成并**已推送** origin/main：
  R32/R33/R34 收口于 `d212d977`，状态与 CI 补记于 `a7950fa1`。逐项结论见
  `docs/E4-R32-report.md` … `docs/E4-R35-report.md`。
- 更早轮次（E4-R27…R31、E4-R21…R26、E4-R12…R20）已完成并已推送，CI 全绿；详见对应报告。
- 已知未完成/待环境项（不因"计划已执行"而消失）：
  1. 真实模型 champion 质量：attestation 记录 `championPromotion.status=NOT_RUN`
     （付费 benchmark 未请求，不为此造假或付费）。
  2. release 发布动作本身未执行（各轮计划只到 attestation，不自动发布）。
- **运行前置条件（本轮实测确立）**：E4-09 及其对抗链要求**运行期干净可证源树**，
  因此全量门禁必须在 `git status --short` 为空的已提交版本上运行；携带未提交改动运行会
  触发 benchmark 的干净树拒绝（退出 1），这不是被测版本的缺陷。
- docs:verify 指向本文件作为唯一当前计划入口；历史计划与旧状态段保留为
  HISTORICAL，不做删除或改写。
