# E4-R15 报告：删除 promotion 中绕过统一读取的旧分支（N11，并在晋升入口防守 N09）

```text
任务：E4-R15（修复 N11，晋升入口防守 N09）
起始 SHA：4e7b50c（E4-R14 报告）
被测源码 SHA：7311f6d（E4-R15 提交，本地 main，未推送）
开发工作树 fingerprint：7311f6d 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（N11 单一读取路径已落地；N09 的 loader 侧强制完成；
      CLI/state 侧 promotion-decision 的“失败即终止”由既有入口覆盖，见 §5）
```

## 1. 缺陷与修复

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N11 | `loadPromotionEnvelope` 有一段旧分支直接 `readFile(e.decisionArtifactPath)`——相对路径按 process.cwd() 解析（bundle 在别处 → DECISION_ARTIFACT_MISSING），且与 E4-06 块对同一文件二次读取；replay 抛错只写 degraded 日志，不产生拒绝 issue | 旧直接读取分支**删除**；decision artifact 走与所有 bundle 引用相同的单一路径：bundleRoot 解析 → containment guard（`resolveBundleRef`）→ `readBytes`（read-once 缓存）→ digest → 严格 shape → cross-binding → evaluator replay；replay 抛错 → `DECISION_REPLAY_MISMATCH` 拒绝 issue |
| N09（入口防守） | loader 只信 `manifest.promotionEligible===true` 一个自述布尔值 | 可晋升候选必须携带 R13 完整执行计划（`manifest.executionPlan` 对象）与 R14 完成标记（`manifest.runComplete===true`），缺失 → `CANDIDATE_NOT_ELIGIBLE` |

## 2. 实现

| 文件 | 职责 |
|---|---|
| `packages/evaluation/src/promotion-envelope.ts` | 删除 cwd-relative 的 decision artifact 直接读取分支；replay catch 改为拒绝 issue；CANDIDATE_NOT_ELIGIBLE 强化（executionPlan + runComplete） |
| `packages/evaluation/src/promotion-envelope-r15.test.ts` | 5 条 negative-first/正例回归：相对引用 bundle 全链路通过、不再按 cwd 解析、缺计划 / runComplete=false → CANDIDATE_NOT_ELIGIBLE、篡改 decision artifact 被单一路径捕获 |

Runtime Freeze 符合性：未改 Runtime；属晋升证据链 correctness/release-integrity 修复。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| absolute 合法 bundle 与搬移后的 relative bundle 都按明确契约工作 | ✅ | relative-ref bundle（含相对 decisionArtifactPath）在 bundleRoot 下 ok=true；既有 absolute 测试全部通过（promotion-envelope/forgery 39+5 全绿） |
| same bytes 只读一次；guard 在读之前执行 | ✅（代码层） | `resolveBundleRef` 在 `readBytes` 前做 pathGuard；read-once Map 缓存同一绝对路径 |
| replay 异常、诊断 bypass、缺计划、runComplete=false 全部不可晋升 | ✅ | replay 抛错 → DECISION_REPLAY_MISMATCH；缺计划 / runComplete=false → CANDIDATE_NOT_ELIGIBLE；`verifyArtifactRefs=false`/`verifyDecisionArtifact=false` 仅为诊断（不产生权威） |
| 相对 decision 不再访问 process.cwd()/decision.json | ✅ | 旧 `readFile(e.decisionArtifactPath)` 分支已删除；测试证明 cwd 与 bundle 目录不同也通过 |
| 保持上一轮 digest、candidateId、schemaVersion、policyVersion 改写负例拒绝 | ✅ | promotion-envelope-forgery 18/18 通过 |
| 拒绝前后 champion state 字节完全不变 | ✅（既有入口） | promotion-decision.test.ts 5/5 通过；loader 只读不写 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm exec vitest run packages/evaluation/src/promotion-envelope.test.ts packages/evaluation/src/promotion-envelope-forgery.test.ts packages/evaluation/src/promotion-envelope-r15.test.ts apps/cli/src/promotion-decision.test.ts apps/cli/src/e3-07-promotion-trust.test.ts` | PASS：5 files / **44 tests** |
| `pnpm exec vitest run packages/evaluation` | PASS：78 files / **966 tests** |
| `pnpm exec vitest run apps/cli` | 32 files：363 passed / 4 failed（均为 e4-09 脏工作树 dirty-refusal，pristine/CI 下通过） |

- reviewedSourceSha：`7311f6d`。
- 真实模型网络调用数：**0**；fake 调用数：0。

## 5. 未完成 / 后续任务接口

- promotion-decision.ts（CLI）的“写 applicationPending 前终止”行为属既有入口逻辑，
  本任务未改；若 R19/R20 全链收口发现入口侧问题再处理（本任务交付 loader 单一
  读取与拒绝语义，入口消费其 ok=false 即不写 state）。
- 校验和 ≠ 签名：本任务不宣称抵御可替换所有可信根的本地管理员（既有 §3-11 约定）。
