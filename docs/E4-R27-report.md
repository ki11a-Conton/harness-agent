# E4-R27 Report — 晋升隔离资格语义（G01）

- 被测 SHA：`493866f03d942e85870cc658eb721cfbf2389ec2`（reviewedSourceSha，本地 main）
- 审查基线：`bcf34b7179152ac2fc24931f268fada8a67f82d9`
- 状态：PASS（确定性复现 + 共享语义校验 + 三边界接线 + 全回归）
- 真实模型调用：0（全部离线 fixture；fake/scripted provider 不代表真实模型调用）
- 变更文件：`packages/evaluation/src/execution-plan.ts`、`champion-eval-v3.ts`、
  `promotion-envelope.ts`、`paired-v3-builder.ts`、`fixtures.ts` + 新增
  `packages/evaluation/src/e4-r27-promotion-eligibility.test.ts`（18 例）

## 1. 复现（修复前）

G01：计划与 manifest **两处一致**地声明 `isolationStrength="insecure-local"` 且
`promotionEligible=true`，字段自洽 → 既有 cross-binding 全部通过 → 评估器 ACCEPT，
promotion loader `ok=true`。真实调用链（`runV3ChampionEval` + `loadPromotionEnvelope`）：

```json
{"id":"INSECURE_PROMOTION","decision":"ACCEPT","promotion":{"accepted":true,"codes":[],"details":[]}}
```

复现步骤（离线，temp dir）：完整 3 case × 2 rep 计划，两臂计划/manifest 均为
insecure-local，promotionEligible=true，全部摘要按真实 writer 重算，真实 evaluator
决策 + 真实 promotion loader 加载。

- 评估器 decision：`ACCEPT`（协议自相矛盾未被拒绝）
- loader：`ok=true, issues=[]`

这是"字段一致 ≠ 字段组合合法"的证据；不声称能伪造受信 CI 签名，也不证明真实
benchmark 执行过越界操作。`none` 隔离同路径复现。

## 2. 修复

### 2.1 共享语义校验（`execution-plan.ts`）

新增 `validatePromotionEligibility(plan): PromotionEligibilityViolation[]`——promotion
资格的最低**语义**条件（字段一致只是一项条件，不等于组合合法），稳定错误码：

| 条件 | 错误码 | 说明 |
|---|---|---|
| `isolationStrength === "strong"` | `ELIGIBILITY_ISOLATION_NOT_STRONG` | insecure-local/none 永不晋升（对齐 `benchmark-isolation.promotionEligible`） |
| backend 已知（非空、非 `not-probed`/`unknown`） | `ELIGIBILITY_ISOLATION_BACKEND_UNKNOWN` | 未探测后端不能支撑 strong 声明 |
| `sourceSha` 已知（40-hex） | `ELIGIBILITY_SOURCE_SHA_MISSING` | 未知源码无法复现/归属 |
| `treeFingerprint === null`（干净树） | `ELIGIBILITY_SOURCE_TREE_DIRTY` | CLI `probeSourceSnapshot` 仅对 dirty 树记录指纹；非空指纹 = 脏树计划，执行时必被 CLI 拒绝 |
| `candidate` 命名挑战者 | `ELIGIBILITY_CANDIDATE_MISSING` | 无候选无可晋升 |

`promotionEligible=false` 的**诊断记录**豁免（不误伤非晋升制品）。所有缺失/未知
事实 **fail-closed**。

### 2.2 三边界复用同一判断

| 边界 | 位置 | 行为 |
|---|---|---|
| evaluator | `champion-eval-v3.ts` `deriveV3Decision` | 违约 → policyViolations → decision 不可能 ACCEPT |
| promotion loader | `promotion-envelope.ts` `loadPromotionEnvelope` | 违约 → `CANDIDATE_NOT_ELIGIBLE`（即使 replay 关闭也执行） |
| writer | `paired-v3-builder.ts` `buildV3ArtifactsFromPaired` | 违约 → throw，promotion-grade 制品根本不写入 |

### 2.3 真实调用链（不是 helper 测试）

验收要求"真实 runV3ChampionEval 与 loadPromotionEnvelope 的负例分别执行"。本套件每个
负例都：写真实 V3 制品 → `runV3ChampionEval` 决策 → 写真实 decision artifact →
`buildPromotionEnvelope` → `loadPromotionEnvelope`（bundleRoot 相对路径 + 全部 ref
重新摘要）。

## 3. 验收对照

| 计划验收项 | 结果 | 证据（测试名） |
|---|---|---|
| strong+clean+complete 正常 production fixture 仍通过 | ✅ | `POSITIVE: strong + clean + complete + candidated pair still ACCEPTs and promotes`（decision=ACCEPT，loader ok=true issues=[]） |
| insecure-local 与 none 两处一致且摘要全重算仍不能晋升 | ✅ | `G01 REPRO: insecure-local agreed by BOTH plan and manifest is INVALID and cannot promote`；`G01: isolationStrength="none" ...`（decision=INVALID，loader CANDIDATE_NOT_ELIGIBLE + ELIGIBILITY_ISOLATION_NOT_STRONG） |
| 资格与隔离/clean/source 组合矛盾返回稳定错误 | ✅ | unknown backend、dirty tree（treeFingerprint 非空）、sourceSha=null、candidate=null 各单因素用例，均返回稳定 code |
| 缺失必要资格事实不能通过省略字段绕过 | ✅ | `a MISSING required fact cannot be bypassed by omitting the field`（省略 executionPlan → INVALID） |
| 真实 runV3ChampionEval 与 loadPromotionEnvelope 的负例分别执行 | ✅ | 每个负例均走两条真实生产入口 |
| 部分运行、错网格、错 policy、错 candidate 的既有拒绝仍成立 | ✅ | `REGRESSION: runComplete=false`、`REGRESSION: unplanned sample`、`REGRESSION: manifest isolationStrength disagrees`（均 INVALID / loader 拒绝） |
| 所有测试离线；文档明确 fake 隔离仅证明接线 | ✅ | 本报告第 1/5 节：fixture stand-in 证明资格协议接线，不代表真实 OS 隔离已被执行 |
| writer 边界不写入自相矛盾的晋升制品 | ✅ | `REFUSES to write an insecure-local plan...` / `REFUSES to write a dirty-tree plan...`（throw E4-R27 + code）；`writes a strong+clean promotion-grade pair successfully` 正例 |

`validatePromotionEligibility` 单元：diagnostics 豁免、完全合格无违约、多违约全量
报告（5 个 code 一次返回）各 1 例。

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `vitest run packages/evaluation/src/e4-r27-promotion-eligibility.test.ts` | 18/18 PASS |
| `vitest run packages/evaluation` | 80 files / **998 tests** PASS |
| `pnpm typecheck`（tsc -b 全仓） | exit 0 |

CLI 生产 E2E（`apps/cli/src/e4-09-production-e2e.test.ts`）在**干净工作树**下 5/5 PASS
（本套件在脏树下的失败属既有的"晋升运行要求干净源码树"正确行为，非回归；见第 5 节）。

## 5. 残余限制与诚实边界

- 本任务处理**协议矛盾与必要证据**，不新增签名系统；哈希只证明"记录与文件内容一致"，
  不声称能证明拥有写权限者绝不造假。
- 隔离为 fixture stand-in：证明 evaluator/loader/writer 的**接线**与资格语义，
  不证明真实 OS 隔离被执行。真实隔离证明依赖真实 backend/self-test（计划要求
  "无法证明 OS 隔离的测试标为接线验证"）。
- 历史制品可诊断读取，但不能凭旧格式获得当前晋升资格（executionPlan 缺失 → INVALID）。
- 决策语义保持：ACCEPT 即"可晋升"；insecure 记录 decision=INVALID，promotion 拒绝，
  不静默更改现有 CLI 含义。
- 干净树合同对齐生产：CLI `probeSourceSnapshot` 对 clean 树返回 `treeFingerprint: null`，
  故 `ELIGIBILITY_SOURCE_TREE_DIRTY` 以"非空指纹 = 脏树"为判据，与执行时 CLI 拒绝
  一致（避免 R27 与生产语义冲突）。
