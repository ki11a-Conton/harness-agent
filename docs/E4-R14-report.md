# E4-R14 报告：关闭可选字段绕过，让统计来自完整事实（N06–N10）

```text
任务：E4-R14（修复 N06–N10）
起始 SHA：1780842（E4-R13 报告）
被测源码 SHA：d398482（E4-R14 提交，本地 main，未推送）
开发工作树 fingerprint：d398482 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（两个有界修复组均完成：① 计划/样本绕过关闭；② 事实投影修正。
      recovery 分母的“计划预登记”机制已就绪，真实 writer 的 per-case 恢复
      要求声明待真实契约出现后接线——见“未完成”）
```

## 1. 缺陷与修复

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N06 | 省略/置空 `expectedSampleKeys` 后网格检查整体跳过，两臂共同缺样本仍可 ACCEPT；重复网格键被 Set 静默去重 | 声明为空网格、重复/畸形键、promotion-eligible 缺网格 → 协议违规 → INVALID；网格存在时两臂逐键严格相等（保留既有行为） |
| N07 | `cases` 与 `activationEligibleCases` 按 outcome 计数：1 个 case 重复 3 次被计为 3，可凑满 minActivationEligibleCases=3 | `cases`=去重 (suite,caseId) 数；`activationEligibleCases`=每个 repetition 都携带**可解析** activationRef 的去重 case 数；悬空引用 → INVALID；coverage 分母为唯一 case |
| N08 | `securityOutcomes=[]` 计 0 breach → ACCEPT；缺记录/悬空引用不可见 | promotion-eligible 产物两臂每个样本必须有可解析的 security 记录；缺失/悬空 → INVALID（区分于已观察 breach 的 REJECT） |
| N09 | `runComplete=false`、`expectedSampleKeys=[]`、`promotionEligible=true` 的自洽 fixture 仍 ACCEPT | runComplete=false、缺完整 R13 计划、空网格、缺 runComplete=true → 全部 INVALID；baseline thresholdDigest 与应用策略不一致 → INVALID |
| N10 | verification 用 `some(passed)`（早成功晚失败仍 true）；recovery `budgetExhausted` 固定 false；安全归约在事件裁剪（head+tail）之后 | verification 取**终态**（最后一个 verification 事件）；budgetExhausted 来自真实事件 payload（`ActivationPayloadV2` 新增可选字段）；安全分类在完整事件流上归约后再裁剪 |

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/evaluation/src/champion-eval-v3.ts` | N06/N09 完整性强制（runComplete/网格/计划/policy 一致性）；N07 唯一 case 统计 + 激活 eligibility；N08 安全覆盖检查；`pairComplete` 在所有违规收集完成后判定 |
| `packages/evaluation/src/paired-v3-builder.ts` | N10：verification 终态判定；recovery budgetExhausted 真实化 |
| `packages/evaluation/src/activation-evidence-v2.ts` | `ActivationPayloadV2.budgetExhausted?`（事实位） |
| `apps/cli/src/benchmark-command.ts` | N10：安全归约移到 `boundOutcomeEvents` 之前（完整事件流） |
| 测试 | 新增 `champion-eval-r14.test.ts`（16 条 negative-first）；升级 6 个既有 fixture 文件到 R13/R14 合规形态（计划/网格/runComplete/每样本安全记录） |

Runtime Freeze 符合性：未改 Runtime；属评估/证据链 correctness 修复。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 四个原始负例都不能 ACCEPT；不完整 fixture 也不能被 promotion loader 接受 | ✅ | runComplete=false、空网格、缺计划、security 缺记录/悬空 → INVALID；`champion-eval-r14` 全套通过 |
| 单 case 三次报告 uniqueCases=1、pairedSamples=3，不满足三 case 门槛 | ✅ | `1 case × 3 reps → uniqueCases=1 / activationEligibleCases=1`，activationSatisfied=false |
| 删除计划、置空 grid、重复键、baseline policy 不同、runComplete=false 都拒绝 | ✅ | 五条独立负例全部 INVALID |
| 显式 unknown 与空安全记录均不算 clean；真实 breach 不被 clean repetition 稀释 | ✅ | not_observed/classifier_error → SECURITY_BREACH；escaped+clean 混合仍 REJECT；缺失记录 → INVALID |
| 中间事件有 breach、头尾没有，裁剪后最终判定仍保留 breach | ✅（代码层） | 安全分类现于完整事件流（`rawOutcome.events`）归约后再 `boundOutcomeEvents` |
| 早验证成功晚验证失败不能 verified=true | ✅ | 终态判定：`[completed(passed), failed]` → verificationPassed=false；`[failed, completed(passed)]` → true |
| recovery 分母包含计划要求但没有产出恢复证据的样本 | ⚠️ 机制就绪 | 依赖计划预登记的 recovery eligibility；当前 artifact 契约无 per-case 恢复要求来源（Runtime 冻结），机制（`recoveryEligibleCaseKeys` 语义）留待真实契约出现后接线——诚实保留，不伪造 |
| 无效 activation 不提升 eligibleCases | ✅ | 仅全部 repetition 激活且 ref 可解析的 case 计数；悬空 → INVALID |
| 由真实 paired writer 生成的完整合规产物仍可重放 | ✅ | e2-final-integration（23/23）、promotion-envelope-forgery（18/18）、e3-13（3/3）全绿；evaluation 包 961/961 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| R14 目标集（grid/recovery-security/strict-read/r14/paired-v3-security/artifact-v3/champion-eval-v3） | PASS：8 files / 97 tests |
| `pnpm exec vitest run packages/evaluation` | PASS：77 files / **961 tests** |
| `pnpm exec vitest run apps/cli` | 32 files：363 passed / 4 failed —— 4 个失败均为 e4-09 脏工作树 dirty-refusal（同 R13 说明，pristine/CI 下通过） |

- reviewedSourceSha：`d398482`。
- 真实模型网络调用数：**0**；fake 调用数：0。

## 5. 未完成 / 后续任务接口

- **recovery 分母的计划预登记**：评估器侧已按“计划声明 recovery-eligible 样本”设计
  （分母含未产出恢复证据的样本），但真实 writer 尚无 per-case 恢复要求的来源
  （Runtime 冻结，不新增 case 契约）。若后续出现真实契约，接入 `manifest` 即可，
  机制无需再改。
- **promotion loader 侧强制**：N09 的 “promotion loader accepted=true” 由 R15 在
  晋升入口统一校验（本任务完成评估器 INVALID 判定；loader 读取与拒绝在 R15）。
