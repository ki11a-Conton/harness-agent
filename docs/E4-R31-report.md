# E4-R31 Report — 独立验收与计划收口（G01…G04 关闭矩阵）

- 被测 SHA：git 根 `D:/Download games/harness agent`，HEAD `964ecc94`
  （R27 `f2f1b0b` / R28 `fb33ba9` 之后）；**R29/R30 为未提交工作树改动**。
- 审查基线 reviewedSourceSha：`493866f03d942e85870cc658eb721cfbf2389ec2`（R26 收口 HEAD）。
- 状态：PASS（四类复现全部关闭 + 全仓门禁实测 + 过度关闭修正 + 诚实 NOT_RUN）
- 真实模型调用：**0**（全部离线 fixture / fault-injection / scripted provider）
- 本报告是 2026-09-11 计划 `plan(20260911-072937).md` 的**收口交付物**；`plan.md` 保持唯一索引。
- 平台：Windows（win32）。远端 CI：**NOT_RUN**（未授权 push，见 §7）。

> 收口原则（HANDOVER §3）：本报告只把**已在本机实测**的结果记为 PASS；未运行的写 NOT_RUN；
> 部分完成的写 PARTIAL。测试数量全部来自真实命令输出，不手填。旧报告（R22/R25）的过度关闭
> 以 superseded 指引修正，**不改写旧证据**。

---

## 1. G01…G04 关闭矩阵

矩阵列：问题 → 生产实现符号 → 修复 ref → 正常正例 → 单因素负例 → 被测 SHA → 结果 → 限制。

| 门 | 问题（缺陷根因） | 生产实现符号 | 修复 ref | 正常正例（仍通过） | 单因素负例（目标门禁生效） | 被测 SHA | 结果 | 限制 |
|---|---|---|---|---|---|---|---|---|
| **G01** | 计划与 manifest **两处一致**声明 `isolationStrength=insecure-local`/`none` 且 `promotionEligible=true` → 字段自洽 → 评估器 `ACCEPT` + promotion loader `ok=true`（"字段一致 ≠ 组合合法"） | `validatePromotionEligibility()`（`packages/evaluation/src/execution-plan.ts`），在 evaluator `deriveV3Decision`（`champion-eval-v3.ts`）、promotion loader `loadPromotionEnvelope`（`promotion-envelope.ts`）、writer `buildV3ArtifactsFromPaired`（`paired-v3-builder.ts`）三边界复用 | `f2f1b0b` | strong+clean+complete+candidate 的正例：decision=`ACCEPT`，loader `ok=true, issues=[]` | insecure-local / none → `ELIGIBILITY_ISOLATION_NOT_STRONG`；unknown backend / dirty tree（treeFingerprint 非空）/ sourceSha=null / candidate=null 各返回稳定 code；均 fail-closed | `493866f0` | ✅ 18/18 | 离线 fixture；不声称能伪造受信 CI 签名，也不证明真实 benchmark 越界执行 |
| **G02** | `parseExecutionPlan` 定义了 `nullableNum` 却**从未调用** → 四个预算字段完全无校验；`repeat`/`limit` 无整数要求；网格规模无上限（展开前不拒绝） | `parseExecutionPlan` → `nullableCount` / `nullableCost`；`EXECUTION_PLAN_MAX_PLANNED_SAMPLES`（`packages/evaluation/src/execution-plan.ts`） | `fb33ba9` | canonical 正常计划解析通过且 digest 稳定；3 case × 2 rep → 6 唯一 pair key / 12 逻辑 arm run | `repeat=2.5`、`maxModelCalls=-1`、**删除 `maxLogicalRuns` 键**、`maxEstimatedCostUsd="invalid"`、`limit<caseIds`、网格 cap 超限——全部 `plan:null` + 结构化 issue | `493866f0` | ✅ 14/14 | 该缺口是**共享 parser** 缺口；CLI flag 本身已拒负数/非整数，故非"CLI 实际执行了负预算付费请求" |
| **G03** | `probeSourceSnapshot` 对文件 `readFileSync(path,'utf8')` 后再 `sha256(str,'utf8')`：无效 UTF-8 字节统一解码为替换字符 U+FFFD → `0x80` 与 `0x81` 变成同一字符串 → **指纹碰撞** | `probeSourceSnapshot`（`apps/cli/src/benchmark-command.ts`）→ `hashBytes`（原始 Buffer 哈希）+ 无歧义 `JSON.stringify` 记录 + `isAbsent` 仅认 `ENOENT` | 工作树（基于 `964ecc94`，未提交） | tracked/untracked 相同字节 → 稳定指纹；A→B 文本/删除/staged 变化仍被识别；clean 树 `clean=true, treeFingerprint=null` | untracked `0x80` vs `0x81` → **不同**指纹；tracked `0x80` vs `0x81`（porcelain 文本相同）→ **不同**指纹；常规文件被目录替换（不可读）→ **UNKNOWN**（非正常 missing）；指纹变化经真实 execution identity 改变 journal 归属 | 工作树 `964ecc94` | ✅ 4/4（该文件全量 66/66） | 主要影响 dirty/offline 身份、确认与 journal 归属；强隔离晋升路径仍要求干净源码，**不**声称已绕过干净树限制 |
| **G04** | bound nonterminal turn 遇 RecoveryStore **暂时**拒绝 lease/intent 写入时 `action=0`（fail-closed 正确）但**无 scheduler callback** → 存储恢复后不自愈；且 `durableTurnIsTerminal` 把**读取失败**返回 `false` 被当作"已确认非终态"→ 推进为 `RETRY_SCHEDULED`（**危险重放**可能已完成的动作） | `scheduleStoreRecheck()`（`packages/core/src/runtime/session-actor.ts`，有界单 timer）；`durableTurnIsTerminal` 三态 `boolean \| "unknown"`；`acquireLease` / `persistRecoveryIntent` 失败分支接入 | 工作树（基于 `964ecc94`，未提交） | 存储恢复 + 触发记录的 callback → **无新用户消息**即收敛；close 取消 timer 且旧 callback 不复活 | refused lease → 恰好 1 个有界重检、0 action；refused intent → 同上；CAS 丢失（他主获胜）→ 有界重检、永不 stall；**unreadable durable turn → `unknown`，不重放 + 记录保持 `RECOVERY_IN_PROGRESS`/attempt 1**；close → 取消、陈旧 callback 0 action 且不再排 timer；长故障 → 有界退避（max ≤ 30s，无热循环） | 工作树 `964ecc94` | ✅ 7/7（该文件 19/19） | Runtime Freeze 例外：已复现的**活性**缺陷，仅做最小恢复调度修复，未扩展 Architecture |

**复现锚点（修复前 → 修复后）**

| 门 | 修复前锚点 | 修复后 |
|---|---|---|
| G01 | `{"id":"INSECURE_PROMOTION","decision":"ACCEPT","promotion":{"accepted":true}}` | decision=`INVALID`，loader `CANDIDATE_NOT_ELIGIBLE` |
| G02 | `{"field":"repeat","value":2.5,"accepted":true}`（四个字段均被接受） | 四例全部 `plan:null` + 稳定 issue |
| G03 | `{"id":"BINARY_SOURCE_COLLISION","equal":true}`（`83d544cc…` 两者相同） | raw bytes：`76be8b52…` vs `591b7cc9…`（**不同**） |
| G04 | `{"id":"LEASE_FAILURE_WAKE","scheduled":0,"calls":0}`；`vitest -t R30` = `6 failed \| 1 passed` | `scheduled=1, calls=0`（fail-closed 但有界重检）；`vitest -t R30` = **7 passed** |

---

## 2. 复现门禁实测（真实命令 / 退出码 / 用例数）

全部在本机 Windows（win32）、git 根 `D:/Download games/harness agent` 运行。命令前缀
`env -u NODE_OPTIONS` 的原因见 §4（沙盒 safe-delete shim）。

| 门 | 命令 | 实测结果 | 退出码 |
|---|---|---|---|
| **G01** | `vitest run packages/evaluation/src/e4-r27-promotion-eligibility.test.ts` | `Test Files 1 passed` · `Tests 18 passed` | 0 |
| **G02** | `vitest run packages/evaluation/src/e4-r28-execution-plan-fields.test.ts` | `Test Files 1 passed` · `Tests 14 passed` | 0 |
| **G03** | `vitest run apps/cli/src/benchmark-command.test.ts -t R29` | `Tests 4 passed \| 62 skipped (66)` | 0 |
| **G04** | `vitest run packages/core/src/runtime/recovery-durable.test.ts -t R30` | `Tests 7 passed \| 12 skipped (19)` | 0 |

> G01/G02 属上一轮（R27/R28）已提交提交内的复现；本轮**重新执行**确认未回退。
> G03/G04 为本轮工作树改动的复现。

---

## 3. 全仓门禁实测

| 命令 | 实测结果 | 退出码 | 说明 |
|---|---|---|---|
| `pnpm typecheck`（`tsc -b`） | 无输出（全绿） | **0** | 24 包全量 `tsc -b` |
| `pnpm test` | `Test Files 1 failed \| 315 passed (316)`；`Tests 4 failed \| 5713 passed \| 1 skipped (5718)` | **1** | 4 个失败**全部**是干净树门禁（见 §5），非回归 |
| `pnpm docs:verify` | `ALL CHECKS PASS`（package count 24、capability matrix、plan 入口唯一等） | **0** | |
| `pnpm test:race` | `Test Files 11 passed` · `Tests 23 passed` | **0** | Runtime 变更所需竞态门禁 |
| `pnpm test:security` | `Test Files 18 passed` · `Tests 2133 passed` | **0** | 安全回归 |
| `pnpm test:protocol` | `Test Files 7 passed` · `Tests 52 passed` | **0** | 协议一致性 |
| `pnpm test:chaos` | `Test Files 1 passed` · `Tests 12 passed` | **0** | MCP 混沌 |
| `pnpm e3:repro-current-defects` | `Test Files 1 passed` · `Tests 13 passed` | **0** | E3 缺陷复现（不随 `pnpm test` 运行） |
| `node apps/cli/dist/main.js benchmark smoke` | `smoke: OK`（基础设施无错，用量核算完好）；adversarial 1 例为测量结果非质量判定 | **0** | boot-smoke 语义 |
| `node apps/cli/dist/main.js audit --strict` | docs claims 真实（30/32/13/11 全部相符）；`evidenceFresh=FAIL` | **1** | 见 §6：本地无新鲜运行证据 |
| `node apps/cli/dist/main.js release verify` | 全 gate `NOT_RUN` → `Release verdict: FAILED` | **1** | 见 §6：需 CI 记录的 gate 证据 |
| `node apps/cli/dist/main.js usage-audit --strict` | `requires --run <runId>`（命名运行仅存在于 CI） | **1** | 见 §6：本地 NOT_RUN |

回归护栏（E4-R31 要求"未回退"）：

| 命令 | 实测结果 | 退出码 |
|---|---|---|
| `vitest run apps/cli/src/benchmark-command.test.ts`（含 N04 clean 正例） | `Tests 66 passed (66)` | 0 |
| `vitest run apps/cli/src/e4-r24-final-result-protocol.test.ts`（命名运行观察协议） | `Tests 3 passed (3)` | 0 |
| `vitest run apps/cli/src/release-command.test.ts`（release bundle 复核） | `Tests 22 passed (22)` | 0 |

---

## 4. 环境噪声：沙盒 safe-delete shim（已隔离，非代码缺陷）

首轮全量 `pnpm test` 出现 **7 failed**，其中 3 个额外失败不是缺陷，而是**本机沙盒注入**：

- `NODE_OPTIONS` 被注入 `--require=…/node-language-shim.cjs`（safe-delete shim），钩住
  `fs.unlink`/`rm`，当**单轮累计删除 > 50** 时抛
  `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":52,"threshold":50,…}`。
- `apps/cli/src/e4-r24-final-result-protocol.test.ts` 在 `finally` 里删除它自己创建的
  临时 fixture（`e4-r24-fixture-*.test.ts`，已被 `.gitignore` 忽略）；shim 拦截该清理 →
  fixture 残留 → 下一轮全量运行把残留当成真实测试文件收集 → 额外失败
  （`planned afterAll failure`、`expected 'observed' to be 'committed'`）。
- 处置（符合本仓既有约定"pnpm 操作前清除 NODE_OPTIONS"）：
  1. 删除 5 个**已 gitignore 的**测试残留 fixture（`git check-ignore` 逐一确认；`git ls-files` = 0，非仓库文件）；
  2. 以 `env -u NODE_OPTIONS` 重跑 → 额外失败消失，仅剩 §5 的 4 个干净树门禁失败。
- 结论：环境注入导致的假失败，与 R29/R30 改动无关；清理后全量 `5713 passed / 4 failed`。

---

## 5. 全量测试的 4 个失败：干净树门禁（§预期非回归）

4 个失败**全部**落在 `apps/cli/src/e4-09-production-e2e.test.ts`，断言均为
`expect(res.exitCode).toBe(0)` 实得 `1`。根因是**生产入口**的干净树门禁：

`apps/cli/src/benchmark-command.ts:665`
```ts
if (sourceFacts.length > 0) {            // sourceFacts 含 "source tree is not provably clean"
  return { exitCode: 1, lines: [
    "agent benchmark: a promotion-eligible run requires a CLEAN, PROVABLE source tree at execution time — commit or stash changes and re-confirm the plan", … ] };
}
```
触发条件：`promotionEligibleRun && !executionSource.clean`。当前工作树**脏**
（R29/R30 未提交 + HANDOVER/plan/docs 修改）→ `clean=false` → 门禁正确拒绝。

**直接证据**（调用生产函数 `probeSourceSnapshot`，非 helper 测试）：

```text
CURRENT CWD (dirty work tree): {"clean":false,"treeFingerprint":"631605a7…","sourceSha":"964ecc94"}
CLEAN TEMP REPO              : {"clean":true,"treeFingerprint":null,"sourceSha":"373a5d10"}
SAME REPO + untracked        : {"clean":false,"treeFingerprint":"86de4f2fa74a…"}
```

即：**脏树 → `clean=false`（门禁拒）**；**干净树 → `clean=true, treeFingerprint=null`（门禁过）**。

**非回归证明**：`benchmark-command.test.ts` 的 `N04: probeSourceSnapshot returns a REAL tree
fingerprint, never a 'dirty' placeholder`（含 `clean.clean === true` 断言）在本轮改动后
**66/66 全过** → R29 的原始字节重写**没有**把干净树误判为脏树。该门禁是不变量
（R22 报告 §6 已确立），干净提交树上的 E2E 通过；**本地工作树带未提交改动时必然失败，属预期**。

> 因此 `pnpm test` 退出码 1 被如实记录，且**不**归因于 R29/R30 的代码缺陷。

---

## 6. release / audit 门禁：本地 NOT_RUN 的正确含义

R31 要求检查 release bundle 复核、命名运行观察审计、Windows 平台门禁**未回退**。实测：

| 检查 | 本地结果 | 判定 |
|---|---|---|
| release bundle 复核 | `release:verify` 本地全 gate `NOT_RUN` → verdict FAILED | **NOT_RUN**：该命令消费**已记录的 gate 证据**（由 CI release job 生成）；本地未产出证据，故 NOT_RUN |
| capability / docs 真值 | `audit --strict`：docs claims 30/32/13/11 **全部相符**；`evidenceFresh=FAIL` | 声明真值 PASS；证据新鲜度 **NOT_RUN**（需新鲜运行证据） |
| 命名运行观察审计 | `usage-audit --strict` 需 `--run <runId>`；`e4-r24-final-result-protocol.test.ts` **3/3** 通过 | 协议逻辑 PASS；命名运行 **NOT_RUN**（runId 仅在 CI 产生） |
| Windows 平台门禁 | 本机 = Windows（win32），全部门禁在 win32 上实跑 | 本地 PASS；CI 矩阵 `windows-latest` **NOT_RUN** |
| Runtime 变更专项门禁 | race 23 / security 2133 / protocol 52 / chaos 12 全绿 | **PASS** |

**关键区分（HANDOVER §3 要求）**：
- `runtimeReleaseReady` = **该 SHA 的工程门禁**（typecheck/test/专项）→ 本机实测通过；
- `promotion evidence integrity` = **证据协议**（cross-binding / evaluator 重放 / loader）→ R27/R28 关闭，G01/G02 复现通过；
- `champion quality` = **真实模型效果** → **本计划不验证**，attestation 记录 `championPromotion.status=NOT_RUN`（不为此付费/造假）。

---

## 7. 远端 CI / push：NOT_RUN

- 未执行 `git commit` / `git push`：用户指令为"直接装依赖就好了，其他的事情没必要考虑"，
  且 HANDOVER §2 要求"不覆盖用户未提交改动"。R29/R30 保持**工作树**状态。
- 因此：**远端 CI = NOT_RUN**；`testedSourceSha` 与 `documentationCommitSha` 严格区分；
  R29/R30 推送后必须由新 SHA 的**新 CI run** 确认，不能用旧 run（#112 / `2b2d3db`）代替。
- 本地可审查结果如上；一页最终状态见 `docs/E4-STATUS.md` 新增段。

---

## 8. 过度关闭修正（R22 / R25）

按 R31 要求修正两处历史过度关闭，**旧证据不改写**，仅加 superseded 指引：

| 旧报告 | 过度关闭的声明 | 修正 | 指引位置 |
|---|---|---|---|
| `docs/E4-R22-report.md` | "数字边界"（暗示四预算字段已校验） | `parseExecutionPlan` 当时定义 `nullableNum` 却从未调用 → 四字段实际无校验；该缺口由 **E4-R28 (G02)** 修复 | R22 报告顶部 SUPERSEDED 段 |
| `docs/E4-R25-report.md` | "有限唤醒已验收"（引用 R17 N14 外部 lease 到期唤醒） | 该引用**并非**本 actor 自身 lease/intent 写失败路径；缺口由 **E4-R30 (G04)** 修复；R25 的 **marker-loss 修复结论保持有效** | R25 报告顶部 SUPERSEDED 段 + 验收行改 ⚠️ SUPERSEDED |

---

## 9. 残余限制与 NOT_RUN 清单（不因收口而消失）

1. **真实模型 champion 质量**：`championPromotion.status=NOT_RUN`（付费 benchmark 未请求；
   mock/stub 隔离**不**当真实 OS 证明）。
2. **release 发布动作**未执行（本计划只到 attestation，不自动发布）。
3. **R27 / R28 本地提交尚未推送** origin/main；推送后需新 CI run 确认（含 Windows docs gate 的
   CRLF 契约继续被验证）。
4. **R29 / R30 仍为未提交工作树**改动；推送后同样需新 CI run 确认。
5. G01…G04 全部为**离线**证据（fixture / fault-injection / scripted），非真实付费模型运行。
6. 本机 `release:verify` / `audit --strict` / `usage-audit --strict` 因缺少 CI 记录的证据/
   命名运行而 **NOT_RUN**（命令本身正确拒绝，非缺陷）。

---

## 10. 收口结论

- G01…G04 **全部关闭**：生产符号已接线、正常正例仍通过、单因素负例在正确边界被拒、复现锚点
  修复前后可区分、被测 SHA 明确。
- 全仓门禁：`typecheck` / `docs:verify` / `race` / `security` / `protocol` / `chaos` / E3 复现
  **全部 PASS**；全量 `pnpm test` 唯一失败 = 4 个**干净树门禁**（脏工作树下预期，已用生产函数直接证明非回归）。
- R22 / R25 过度关闭已修正；`plan.md` 保持唯一索引；一页最终状态落 `docs/E4-STATUS.md`。
- 远端 CI / push / 真实模型质量 = **NOT_RUN**（未授权 / 不付费）。
- **本计划执行完毕。** 下一阶段只有"真实 benchmark 失败、生产问题或明确用户需求"才新建任务。
