# E4-R22 报告：执行计划严格解析与交叉绑定（F02）

```text
任务：E4-R22（executionPlan 严格解析与交叉绑定）
审查基线（reviewedSourceSha）：bcf34b7179152ac2fc24931f268fada8a67f82d9
被测源码：bcf34b7 之上的本任务工作树（execution-plan.ts 新增；
      champion-eval-v3.ts / promotion-envelope.ts / paired-v3-builder.ts /
      benchmark-command.ts / fixtures.ts / index.ts 修改，未提交）
状态：PASS（本地离线验收全绿；e3-13/e4-09 两个真实 CLI E2E 文件因
      【既有】干净树门禁对脏工作树拒绝 promotion-eligible 运行而无法在
      本地复跑——该门禁是 E4-R13 既有正确行为，提交后干净树复验，见 §6）
真实模型网络调用：0（全部测试为离线 fixture + 真实 writer/evaluator/loader）
```

## 1. 问题（F02）与修复前复现

计划 §2 F02 的最小复现：三个 case、两次重复、baseline 不通过、candidate
通过、完整 security refs 与 activation refs、`runComplete: true`、正确样本
键、`executionPlan: {}`，其余摘要由真实 writer 重算，真实 evaluator 出
decision，再生成 envelope。修复前结果：

```json
{"id":"EMPTY_EXECUTION_PLAN","decision":"ACCEPT","promotion":{"accepted":true,"codes":[],"details":[]}}
```

根因：`deriveV3Decision` 与 promotion loader 的 eligibility 检查对
`manifest.executionPlan` 只检查
`typeof === "object" && !== null && !Array.isArray`——既不重新计算计划
内容与 `manifest.planDigest` 的对应，也不把计划中的网格、policy、source、
isolation、candidate、model 身份与两臂事实绑定。一个空对象即可满足
"携带执行计划"的语义，完成整条 ACCEPT→promote 链。

## 2. 改动（一个共享协议，三个边界共用）

| 文件 | 改动 |
|---|---|
| `packages/evaluation/src/execution-plan.ts`（新增） | 共享、版本化（`e4-01`）的执行计划协议：`ExecutionPlanV1` 类型；`parseExecutionPlan` 严格解析（schemaVersion、必需字段、数字边界、唯一非空 caseIds、caseFingerprint 逐 case 64-hex 且不多不少、decisionPolicy/effectiveModelParams 为对象、sourceSha 40-hex、treeFingerprint/thresholdDigest 64-hex、isolationStrength 枚举、estimateStatus 枚举、candidate string\|null）；`computeExecutionPlanDigest`（与 CLI `computeRuntimeConfigHash` 同一 canonical serializer）；`expectedSampleKeysFromExecutionPlan`（从计划推导 `${suite}\0${caseId}\0${rep}` 网格）；`crossBindExecutionPlan`（六组交叉绑定，见 §3） |
| `packages/evaluation/src/champion-eval-v3.ts` | `deriveV3Decision`：promotion-eligible artifact 的计划经 `parseExecutionPlan` + `computeExecutionPlanDigest` + `crossBindExecutionPlan`（带 appliedThresholdDigest、另一臂 planDigest、candidate arm.candidateId）。解析失败/绑定违规 → policyViolations → INVALID |
| `packages/evaluation/src/promotion-envelope.ts` | loader eligibility：同样的 parse + crossBind（带 candidate arm.candidateId）；失败 → `CANDIDATE_NOT_ELIGIBLE` / `CROSS_BINDING_MISMATCH`，与评估器 replay 共用同一校验（评估器 ACCEPT、loader 才发现缺关键信息的不对称消除） |
| `packages/evaluation/src/paired-v3-builder.ts` | 写入边界：`promotionEligible=true` 时 facts 缺计划、计划不解析、planDigest ≠ 重算摘要、expectedSampleKeys ≠ 计划推导网格 → 拒绝构建（throw），绝不落盘为 promotion-grade；计划缺失的旧产物仍可写为诊断（promotionEligible=false） |
| `apps/cli/src/benchmark-command.ts` | `BenchmarkExecutionPlan` 从本地重复接口改为 `ExecutionPlanV1` 别名；`computeBenchmarkPlanDigest` 委托 `computeExecutionPlanDigest`——CLI、评估器、promotion loader 对同一计划不可能算出不同摘要（evaluation 不依赖 apps/cli，方向正确） |
| `packages/evaluation/src/fixtures.ts` | `fixtureExecutionPlan` / `fixtureExecutionPlanDigest`：协议完整的计划夹具（planDigest 永远是重算值，不是占位符） |
| `packages/evaluation/src/index.ts` | 导出协议类型与函数 |
| 测试 | 新增 `e4-r22-execution-plan.test.ts`（7 用例）与 `paired-v3-identity.test.ts` 写入边界 4 负例；更新 `champion-eval-grid/r14/recovery-security/strict-read`、`promotion-envelope-forgery/r15`、`e2-final-integration`、`paired-v3-identity/security-per-sample` 夹具为协议完整计划 |

## 3. 协议字段交叉绑定表

计划是"被确认的实验"的唯一载体；读取边界的每个字段绑定到**运行时记录
的事实**（manifest/provenance/评估器 applied policy），不是自声明：

| 计划字段 | 绑定对象（读取边界重算/比对） | 违规输出（稳定字符串） |
|---|---|---|
| 整个计划内容 | `sha256(stableStringify(plan))` = `manifest.planDigest`（两臂一致：另一臂 planDigest 也必须等于同一重算值） | `manifest.planDigest … != recomputed execution plan digest …` |
| `schemaVersion` | `parseExecutionPlan` 只接受 `e4-01` | `… != supported e4-01 (unknown protocol version)` |
| `suite`+`caseIds`+`repeat` | 计划推导网格 = `manifest.expectedSampleKeys`（集合相等，重复即不合格）；实际两臂 outcomes 与网格互相覆盖（多/少都违规） | `manifest.expectedSampleKeys does not equal the grid derived from the confirmed plan` / `… missing confirmed sample …` / `… UNPLANNED sample …` |
| `decisionPolicy`+`thresholdDigest` | `computeRuntimeConfigHash(policy)` = `plan.thresholdDigest` = `manifest.thresholdDigest` = 评估器 applied thresholdDigest | `… != applied policy digest …`（预注册策略 ≠ 实际应用策略） |
| `judgeVersion` / `isolationStrength` / `promotionEligible` | `manifest.judgeVersion` / `manifest.isolationStrength` / `manifest.promotionEligible` 逐一相等 | `manifest.X … != plan.X …` |
| `providerId` / `modelId` | `provenance.provider` / `provenance.model`（运行时记录，非自声明） | `provenance.provider … != plan.providerId` 等 |
| `sourceSha`（非 null 时） | `manifest.gitSha` | `manifest.gitSha … != plan.sourceSha …` |
| `candidate` | candidate artifact 的 `arm.candidateId`（两侧都 null 视为一致；任一非 null 且不等即违规） | `executionPlan.candidate … != candidate artifact candidateId …` |
| `limit`/`seed`/`max*`/`effectiveModelParams`/`interleave`/`shuffle`/`billingClass`/`isolationBackendId` | 无独立外部事实可比对 → 纳入计划内容摘要：任何改动都改变 planDigest，与确认摘要（manifest.planDigest / `--plan-digest`）失配即拒绝 | 同第一行 |

## 4. 一次一字段的负例矩阵（全部从同一正例派生）

正例（control）：完整 `e4-01` 计划（3 case × 2 rep，security/activation/
grid/runComplete 完整，真实 writer 重算全部摘要）→ evaluator **ACCEPT**、
envelope **加载成功**、两边界零违规。

| # | 唯一变更（相对正例） | 结果 |
|---|---|---|
| 1 | `executionPlan: {}` | evaluator INVALID（`executionPlan…` 违规）+ loader `CANDIDATE_NOT_ELIGIBLE` |
| 2 | `executionPlan: []`（数组） | INVALID + 拒绝 |
| 3 | `schemaVersion: "e4-99"` | INVALID + 拒绝（未知协议版本） |
| 4 | 计划 `seed` 改 999，两臂 manifest 保留**旧** planDigest（其余摘要已重算以隔离单一差异） | INVALID + `planDigest` 违规（内容↔摘要失配） |
| 5 | `decisionPolicy.minConclusiveNetDelta` 改 9（thresholdDigest 同步改为该 policy 的摘要） | INVALID（applied policy ≠ 计划预注册 policy）+ 拒绝 |
| 6 | `judgeVersion: "9.9.9"` | INVALID（`/judge/` 稳定原因）+ 拒绝 |
| 7 | `modelId: "other-model"` | INVALID（`/model/`）+ 拒绝 |
| 8 | `providerId: "other-provider"` | INVALID（`/provider/`）+ 拒绝 |
| 9 | `isolationStrength: "none"` | INVALID（`/isolation/`）+ 拒绝 |
| 10 | `sourceSha: d…40` | INVALID（`/source/`）+ 拒绝 |
| 11 | `candidate: "impostor-candidate"` | INVALID（`/candidate/`）+ 拒绝 |
| 12 | 计划 `caseIds` 收窄为 2 个（outcomes 仍 3 case） | INVALID（网格冲突：计划推导网格 ≠ manifest 网格/outcomes）+ 拒绝 |

写入边界（`buildV3ArtifactsFromPaired`，promotionEligible=true）另有一组
负例：缺 `executionPlan` / `{}` / planDigest 失配 / expectedSampleKeys 失配
→ 全部 throw，不产出 promotion-grade 产物（`paired-v3-identity.test.ts`）。

既有回归确认的相邻语义（非本轮新增，用于验收交叉引用）：

- 两臂一起删样本（重算摘要）→ `champion-eval-grid.test.ts` F05"both arms
  equal each other but missing half the confirmed grid -> INVALID"。
- promotion-eligible 缺计划 → `champion-eval-r14.test.ts` N09
  "promotion-eligible WITHOUT the full execution plan is INVALID"。
- 单 case 三次重复不能冒充多 case → `champion-eval-r14.test.ts`
  "1 case × 3 reps → uniqueCases=1"。
- 旧产物诊断读取（无计划、非 promotion-grade）→
  `champion-eval-v3.test.ts` 全组用例未携带计划仍可评估（INVALID/REJECT
  路径，非晋升）。
- 相对路径 bundle 仍通过 → `promotion-envelope-r15.test.ts` 正例
  （N11：全部 ref 为相对路径）。

## 5. 验证命令与退出码

```text
pnpm typecheck → tsc -b 无错误（exit 0）

pnpm exec vitest run packages/evaluation/src/e4-r22-execution-plan.test.ts \
  packages/evaluation/src/e2-final-integration.test.ts \
  packages/evaluation/src/promotion-envelope-forgery.test.ts \
  packages/evaluation/src/promotion-envelope-r15.test.ts \
  packages/evaluation/src/champion-eval-grid.test.ts \
  packages/evaluation/src/champion-eval-r14.test.ts \
  packages/evaluation/src/champion-eval-recovery-security.test.ts \
  packages/evaluation/src/champion-eval-strict-read.test.ts \
  packages/evaluation/src/paired-v3-identity.test.ts \
  packages/evaluation/src/paired-v3-security-per-sample.test.ts
→ 10 files / 73 tests passed（exit 0）

pnpm exec vitest run apps/cli/src/benchmark-command.test.ts \
  apps/cli/src/e4-r21-release-reverify.test.ts \
  apps/cli/src/release-command.test.ts apps/cli/src/release-verify.test.ts
→ 4 files / 136 tests passed（exit 0）
```

修复前基线：`EMPTY_EXECUTION_PLAN` 复现为 ACCEPT + promotion accepted
（计划 §2 记录的矛盾）；修复后同一夹具 INVALID + `CANDIDATE_NOT_ELIGIBLE`。

## 6. 残余限制

1. **e3-13 / e4-09 两个真实 CLI E2E 文件无法在本地脏工作树复跑**：两者
   走真实 `runBenchmarkCommand`（strong isolation mock），而 E4-R13 既有
   门禁"promotion-eligible run 需要干净源码树"会在 `git status --porcelain`
   非空时拒绝（exit 1：`a promotion-eligible run requires a CLEAN source
   tree…`）。该门禁**非本轮引入**（E4-R13 提交已存在），且是对的行为。
   bc…34b7 的 CI（run 34548502173，四 job 全绿）证明两个文件在干净检出
   上通过；本轮改动提交后将在干净树上本地复跑确认（R26 收口时记录）。
2. planDigest 重算证明的是"manifest 记录的摘要 ↔ 计划内容"一致；对能
   重写全部产物与摘要的攻击者不设防（计划 §2 F02 边界声明）。
3. `plan.candidate` 绑定的是 candidate artifact 的 `arm.candidateId`；
   envelope 的 candidateId ↔ arm.candidateId 一致性由既有 F10 检查
   （`promotion-envelope-forgery.test.ts`）覆盖，不重复实现。
4. 旧历史产物（无计划）可诊断读取的前提是 `promotionEligible=false`；
   `promotionEligible=true` 且缺计划在写入、评估、加载三边界均为明确
   ineligible/INVALID。
