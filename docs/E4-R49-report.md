# E4-R49 报告：统一 release 与计划入口的当前状态

## 1. 做了什么

统一 `plan.md`、`HANDOVER.md`、`docs/E4-STATUS.md`、`docs/E4-R44-report.md` 中关于
release 与计划入口的表述，使「历史执行事实」与「当前仓库状态」分开，并让
R45…R50 成为唯一明确的当前计划入口。

具体改动：

1. **plan.md 入口翻新**：当前计划指向 R45…R50（审查基线 `d201da5e`），
   `reviewedSourceSha`/比较基线与计划一致；执行状态段标题改为 R45…R50，并前置
   R45/R46/R47/R48 的完成条（R49 进行中、R50 待办），R40…R44 保留为历史事实块。
2. **release 状态拆分**（plan.md / HANDOVER / E4-STATUS 三处，口径一致）：
   - 历史计划执行范围：各轮**只到 attestation，不自动发布** —— NOT_RUN；
   - 当前仓库事实：**已存在 v1.8.0**（`gh release`，2026-09-13，源码快照资产，指向
     仅文档提交 `15a02269`，代码与 attestation 的 `34ab9207` 逐字节相同）；
   - 本轮发布完整性复核：**未做**（只核实 job/step 状态与 release 存在，未复核
     发布二进制/签名/供应链证据）。
   三者不再混为一谈，也不再出现「release 发布动作未执行」这种可被误读为
   「仓库没有 release」的残留。
3. **CI 上传接入时序**（`docs/E4-R44-report.md`）补记：矩阵第 29 行「CI 上传未接入」
   是 R44 编写时点的历史事实，第 92 行是补丁 `81205387` 落地后的当前事实；R49 显式
   标注时序，二者不冲突。

## 2. 为什么需要改

计划 §8「做什么」：审查时 v1.8.0 已发布，但 plan.md 仍在「已知未完成」中写
「release 发布动作本身未执行」；同时 R44 报告前面的矩阵写 CI 上传未接入、后面的补记
已写接入完成。需要区分历史执行事实和当前仓库状态。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `plan.md` | 修改：入口翻新为 R45…R50 + 状态拆分 + release 拆分 |
| `HANDOVER.md` | 修改：release 表述拆分 |
| `docs/E4-STATUS.md` | 修改：当前状态表增加 release 存在性/复核两行 + NOT_RUN 段拆分表述 |
| `docs/E4-R44-report.md` | 修改：§6 增 R49 时序补记（区分矩阵历史 vs 补丁当前） |

## 4. 复现方法与修复前结果

**修复前**：`plan.md:74` 写「release 发布动作本身未执行（各轮计划只到 attestation，
不自动发布）」；`docs/E4-STATUS.md:28` 同义；`docs/E4-R44-report.md:29` 矩阵「CI 上传
未接入」而 `:92` 「已接入」。所有这些与「v1.8.0 已发布」的仓库事实并存，构成
「历史执行事实 vs 当前状态」的表述冲突，违反计划 §6 验收第 1/2/3 条。

**修复后**：release 拆成「历史范围 NOT_RUN」「当前存在 v1.8.0」「本轮未复核完整性」
三层；CI 上传矩阵前后矛盾由「时序补记」显式化解；plan.md 成为 R45…R50 唯一当前入口。
`pnpm docs:verify` ALL CHECKS PASS（包数量、计划入口、release gate 命令映射等机器校验
项均不受影响）。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm docs:verify` | 0 | **ALL CHECKS PASS**（含 current plan entry、package count、release gate 映射） |

验收对照（计划 §6）：

- 状态文档对 v1.8.0 是否发布**无冲突**：README 已更新为「v1.8.0 已发布」；plan/HANDOVER/
  E4-STATUS 现一致表达「release 存在 = 事实」「发布动作 = 历史范围 NOT_RUN」。
- 历史「本任务未发布」**不会被理解为「仓库没有 release」**：三处均显式写出 v1.8.0 存在。
- CI 上传接入状态**一致**：R44 报告时序补记 + R46 的 attempt 命名已对齐。
- PASS 可追溯版本与证据：计划 entrance 标注 `reviewedSourceSha=d201da5e`、比较基线
  `67955e06`（R44 审查基线）。
- NOT_RUN 如实保留：真实模型 champion 质量、release 发布动作均保留 NOT_RUN。
- **没有执行新的发布动作**（本轮零发布动作）。

## 6. testedSourceSha 与未提交改动

- `reviewedSourceSha` / `testedSourceSha`：`d201da5e8071e2780a745ffb86ddb31d3cdf547d`
  （R45…R50 计划审查基线）。
- 本任务实现提交后工作树干净（R49 改动 + 报告一并提交）。

## 7. 未执行项与残余限制

- **未做发布完整性复核**：只核实了 `gh release` 存在性、job/step 状态与「仅文档提交」的
  代码等价依据；未下载 release 资产逐字节复核、未验证签名。已在三处状态文档如实标注。
- 保留历史报告原始语境：`docs/E4-STATUS.md` 中历史执行状态段落（如 160-162、
  203-204 的「release 发布动作未执行」）属**历史时点快照**，未篡改其原意；只更新了当前
  状态表与 NOT_RUN 权威段（R49 §5.4 允许「带提交引用的补记」而非伪造历史时点完成状态）。
- README 长度受控：当前状态只写摘要 + 入口，详细证据仍在各报告（R49 §5.6）。