# E4-03 报告：收紧 Artifact V3 schema 与 strict loader

## 状态

**DONE**（离线，providerCalls = 0）

- 基线 before：`a682791`（E4-01 part 4）
- 交付 commit 链：
  - `88ba5ed` part 1 — classifyArtifact 仅识别形状、不再凭 schemaVersion 授予 promotion 资格；outcome 数值字段加范围/整数/有限性约束
  - `ef3b07e` part 3 — digest / git-SHA 字段按格式校验（非仅类型）
  - `731e539` part 6 — outcome 引用必须解析到本 artifact 的真实事件；activation 事件 id 唯一
  - `2499bc4` part 7 — summary 逐字段校验（消除 raw cast）
  - `4c16a56` part 4 — 身份/grade 非空；ratio 字段限定 [0,1]
  - `886745d` part 5 — manifest 身份字段按格式条件校验
  - （本报告 commit）part 5b — candidate arm 必须携带 candidateConfigHash

## 目标

让 `ExperimentArtifactV3` 的 `promotionEligible=true` 真正意味着「完整、可验证、可重算」，而不是「schemaVersion 看起来正确」。未新增 V4，在现有 V3 上收紧。

## 交付物

| 交付物 | 位置 |
|---|---|
| V3 字段级 validator | `packages/evaluation/src/artifact-v3/schema.ts`（`parseExperimentArtifactV3` / `parseCaseOutcomeV3` / `parseSummaryV3` / `validateManifestFields` / `findRefAndEventViolations`） |
| strict loader | `packages/evaluation/src/artifact-v3/loader.ts`（`loadExperimentArtifactV3`：解析 + 引用完整性 + digest + summary 重算比对 + provenance 身份） |
| 安全的 classifier | `schema.ts::classifyArtifact`（只返回形状，`promotionEligible` 恒为 false） |
| legacy 兼容测试 | `artifact-v3.test.ts`（legacy 目录发现、`loadLegacyArtifact` 恒 `promotionEligible=false`） |
| 目录 validator | `validate.ts::validateArtifactV3`（新增 DANGLING_REF / DUPLICATE_EVENT 检查） |

## 各部分改动

### part 1 — classifier 形状化 + 数值边界（spec #2、#3）
- `classifyArtifact` 不再凭 `schemaVersion==="3.0.0"` 返回 `promotionEligible:true`。资格只能由一次成功的 strict load 授予。关闭「schemaVersion 看着对 ⇒ 有资格」的洞。
- outcome 数值：`attempt`/`order` 非负整数；`repetition` 正整数（≥1）；`inputTokens`/`outputTokens`/`latencyMs`/`toolCalls` 非负整数；`costUsd` 非负数（可空）。NaN/Infinity 原已被有限性检查拒绝；负值、repetition=0、小数 repetition/attempt 现也被拒绝。

### part 3 — digest / git-SHA 格式（spec #1）
- `expectHexDigest`（精确长度小写 hex）+ `expectGitSha`（40 或 64 hex）。
- 强制：`contentDigest`(64)、`provenance.gitSha`(git SHA)、`provenance.runtimeConfigHash`(64)、`outcome.evaluationContextHash`(64)、`outcome.candidateConfigHash`(64)、`arm.candidateConfigHash`(64)，类型允许处可空。
- `outputDigest`/`workspaceDigest` 保持 string-or-null（真实 paired 执行路径常置 null，格式暂宽松）。

### part 6 — 引用解析 + 事件唯一（spec #2）
- `findRefAndEventViolations`（置于叶子模块 schema.ts，避免 loader↔validate 环）：
  - `outcome.activationRef`（非空）必须匹配某 `activationEvidence[].id`；
  - `outcome.securityOutcomeRef`（非空）必须匹配某 `securityOutcomes[].caseId`；
  - `activationEvidence` 事件 id 唯一（无重复 event seq）。
- strict loader 抛 `DANGLING_REF` / `DUPLICATE_EVENT`；目录 validator 记录同名检查。

### part 7 — summary 逐字段（spec #4）
- `parseSummaryV3` 取代 `record.summary as SummaryV3` raw cast：计数为非负整数、`passRate`/`recoveryRate` 为 [0,1] 有限数、`terminationReasons`/`failureCategories` 为非负整数映射、`totalCostUsd` 非负可空、`medianLatencyMs` 非负。
- 值与 outcomes 的一致性仍由 loader/validator 重算比对（SUMMARY_MISMATCH）；本部分关闭类型/范围洞。

### part 4 — 非空身份 + ratio 范围（spec #2）
- `caseId`/`suite`/`armId` 非空；`grade` 若存在则非空白。
- **grade 不强制固定枚举**：代码库将其建模为自由文本 `string|null`，由 judge 版本决定（每 outcome 携带 `judgeVersion`），源码中不存在规范 grade 词表；硬枚举会误拒合法 grade。spec 的「ratio 类字段限制在定义范围」由 `passRate`/`recoveryRate` 的 [0,1] 边界满足。

### part 5 — manifest 身份字段（spec #1）
- `validateManifestFields`（存在即校验，前向兼容 E4-04/E4-05 才接入的字段）：`gitSha`/`sourceSha` 为 git SHA；`planDigest`/`runtimeConfigHash`/`thresholdDigest` 为 64-hex；`model`/`provider`/`decisionPolicyVersion` 非空；`isolationStrength` ∈ {strong, insecure-local, none}；`promotionEligible` 为 boolean；`repeat` 正整数；`caseCount`/`outcomeCount` 非负整数。
- part 5b：candidate arm（`candidateId` 非空）必须携带 `candidateConfigHash`，否则 `MISSING_REQUIRED_FIELD`。

## 负向测试覆盖（table-driven）

| spec 要求 | 测试 | 状态 |
|---|---|---|
| NaN / Infinity | `rejects invalid inputTokens = NaN/Infinity` | ✓ |
| 负 token / 负 duration | `rejects invalid inputTokens/latencyMs/toolCalls = 负值` | ✓ |
| repetition=0 / 浮点 | `rejects invalid repetition = 0 / 1.5` | ✓ |
| grade 超范围 | `rejects empty caseId/suite/armId and blank grade`（自由文本，非空约束；见 part 4 说明） | ✓（按非空） |
| 空 manifest | 既有 `2. empty manifest → strict loader rejects` | ✓ |
| 非法 SHA/digest | `rejects illegal git SHA / digest formats` | ✓ |
| 丢失 config hash | `rejects a candidate arm with a missing candidateConfigHash` | ✓ |
| 不存在的 activation/security ref | `strict load rejects dangling outcome refs` | ✓ |
| 重复 event seq | `... duplicate activation event ids` | ✓ |
| summary tamper | 既有 `1. tamper ANY summary field` + 新 `rejects a malformed summary` | ✓ |
| schemaVersion=3.0.0 但内容无效 | `a schemaVersion=3.0.0 document with invalid content ... fails strict parse` | ✓ |
| legacy 冒充 promotion eligible | `classifyArtifact` 恒 false + 既有 legacy `promotionEligible=false` | ✓ |

## 验收证据

- `tsc -b`：exit 0（全仓）
- `pnpm test`（全量，排除 perf/soak/e3-repro）：**5379 passed + 1 skipped，exit 0**（E4-01 为 5362，E4-03 净增 17 个测试）
- `pnpm test -- artifact-v3`：39 passed
- evaluation + apps/cli：1134 passed
- `git status --short`：空
- providerCalls = 0（全程离线，无计费 provider）

## 延后 / 说明

- **grade 固定枚举**：不实施（无规范词表，见 part 4）。若未来 judge 定义封闭 grade 集，可在 `parseCaseOutcomeV3` 收紧。
- **manifest 强制存在字段**（decisionPolicyVersion / thresholdDigest / isolationStrength / promotionEligible）：当前为「存在即校验」的条件式；这些字段由 E4-04（activation/isolation 入 manifest）与 E4-05（decision policy）正式写入后，可升级为强制存在校验。
- **outputDigest / workspaceDigest 格式**：暂宽松（真实路径多为 null）；待 E4-02 确认执行器产出格式后收紧。
- **V3-writer 保留 promotionEligible / loader 拒绝**（E4-01 负向清单）：属 E4-02（paired→canonical V3）与 E4-06（promotion loader）职责，本任务已在 classifier/strict-load 层关闭「形状即资格」。
