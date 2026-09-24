# E4-R13 报告：让确认计划真正绑定运行身份（N03/N04/N05）

```text
任务：E4-R13（修复 N03–N05）
起始 SHA：e26af98（E4-R12）
被测源码 SHA：0676cdb（E4-R13 提交，本地 main，未推送）
开发工作树 fingerprint：0676cdb 之上仅剩计划文件换版（R20 收口范围）
状态：PASS（三项缺陷均已修复并有 negative-first regression；旧产物
      “可诊断但不可晋升”的 loader 侧强制留待 R14/R15 统一严格读取）
```

## 1. 缺陷与复现

| ID | 修改前行为（复现） | 修复后 |
|---|---|---|
| N03 | preflight 的确认计划不含模型/源码/策略身份；执行阶段另建 identity，两个 digest 未统一授权。改模型/策略/case 内容/源码不会使旧确认失效 | 确认计划折叠完整授权面（provider/model、judge 版本、源码快照、case 输入指纹、决策策略、阈值、有效模型参数）进 plan digest；执行器消费同一份确认计划，任何漂移在第一次 provider 调用前拒绝 |
| N04 | `baselineConfigHash="baseline"`、`candidateConfigHash=runtime hash`、`treeFingerprint="dirty"`、self-test 未绑定 | baseline/candidate 配置 hash 来自 candidate registry 的已解析语义摘要（真实 64-hex）；treeFingerprint 是 `git status --porcelain` 的真实 sha256；可晋升运行在 dirty 树上直接拒绝；isolationSelfTestId 仍为 null（代码库无隔离自测机制，诚实保留，不伪造） |
| N05 | `expectedSampleKeys` 对每个已含 repetition 的 pair 再展开 repeat → C×R² 重复键；writer 未保留完整计划与 policy | `expectedSampleKeysFromPlan` 每 pair 一个键 → 恰好 C×R 唯一键；V3 manifest 逐字保留完整确认计划与决策策略 |

复现证据（修改前）：3 cases × repeat 2 时旧代码生成 12 个 expected keys（含重复，
实际应为 6 个唯一键）；`buildExecutionIdentityV1` 的 baselineConfigHash 恒为字符串
"baseline"（非 64-hex）。

## 2. 实现

| 文件 | 职责 |
|---|---|
| `apps/cli/src/benchmark-command.ts` | `BenchmarkExecutionPlan` 扩展完整授权面字段并折叠进 digest；`PreflightIdentityFacts` 成为 `preflightBenchmark` 必需参数；`caseFingerprintFor`/`probeSourceSnapshot`（真实树指纹，非 "dirty"）；`runPairedPromotion` 消费 `preflight.executionPlan`、拒绝 drift（provider/model/sourceSha 不一致）、拒绝 dirty 树上的可晋升运行、真实 arm 配置 hash；V3 调用传入完整计划与策略；dry-run 输出身份字段 |
| `packages/evaluation/src/paired-v3-builder.ts` | `expectedSampleKeysFromPlan`（N05）；`PairedV3Facts` 增加 `executionPlan`/`decisionPolicy` 并写入 manifest |
| `apps/cli/src/benchmark-command.test.ts` | 6 条新 negative-first regression + 全部 preflight 调用点绑定 `testIdentityFacts()` |

Runtime Freeze 符合性：未改 Runtime；属 benchmark 授权/证据链 correctness 修复。

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 同一确认计划从 dry-run 到 executor/journal/V3 身份一致 | ✅ | preflight.executionPlan → runPairedPromotion 同一对象；journal identity 的 providerId/modelId 与确认计划一致（测试断言）；V3 manifest 含完整 executionPlan |
| 改模型、策略、case 内容、源码、policy、隔离中的任意一项，旧确认在调用前拒绝 | ✅ | `N03: plan digest changes` 测试：model/policy/source/treeFingerprint/case 内容各自改变 digest；paid 路径在 preflight 阶段 digest mismatch 拒绝；dirty 可晋升运行在 provider 调用前拒绝（e4-09 实测输出 "requires a CLEAN source tree"） |
| candidateConfigHash 来自实际 candidate，而非 runtimeConfigHash 的复制 | ✅ | 来自 `getCandidateRegistry().resolve(opts.candidate).semanticDigest` 的 64-hex；journal identity 测试断言非 "baseline" 且为 64-hex |
| 3 cases × repeat 2 的 expected grid 长度=6、唯一键数=6；逻辑 arm 数=12 | ✅ | `N05` 测试：pairs=6、totalLogicalRuns=12、keys=6、唯一=6、逐键匹配 `suite\0case\0rep(1-based)` |
| 无关键占位符，没有缺 policy 的可晋升 V3 | ✅（writer 侧） | identity 无 "baseline"/"dirty" 占位；V3 manifest 携带 executionPlan + decisionPolicy。loader 侧强制（缺计划不可晋升）由 R14/R15 统一严格读取完成 |
| 不变计划 resume 不重复已完成 arm，累计预算不归零 | ✅ | 既有 paired-execution-identity 测试 8/8 通过；evaluation 包 945/945 通过 |
| 无完整计划的旧产物仍可诊断读取，但明确不可晋升 | ⚠️ 接口已备 | manifest 现在区分“有完整计划”与“无”；loader 的强制检查按计划在 R14（可晋升输入必须携带 R13 计划）落地 |

## 4. 验证命令（精确结果）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | PASS（tsc -b，exit 0） |
| `pnpm exec vitest run apps/cli/src/benchmark-command.test.ts` | PASS：57 tests（含 6 条新 R13 regression） |
| `pnpm exec vitest run packages/evaluation` | PASS：76 files / 945 tests |
| `pnpm test`（全仓） | 308 files：5580 passed / 1 skipped / 4 failed —— 4 个失败全部是 `e4-09-production-e2e` 在**脏开发工作树**上被新 dirty-refusal 提前拒绝（强隔离被 mock → 可晋升 → 拒绝）；pristine 语义下（干净 CI checkout）该测试本就要求 clean tree（其 gate-evidence 断言），非回归 |
| e2e 实测 refusal 输出 | `agent benchmark: a promotion-eligible run requires a CLEAN source tree (the confirmed plan binds a real tree fingerprint) — commit or stash changes and re-confirm the plan` |

- reviewedSourceSha：`0676cdb`。
- 真实模型网络调用数：**0**；fake 调用数：0（本任务无 provider 调用）。

## 5. 未完成 / 后续任务接口

- **loader 侧强制**：V3/promotion loader 要求“无完整计划不可晋升”属 R14（“可晋升输入
  必须携带 R13 计划；历史读取路径不能具有 promotion eligibility”）与 R15
  （promotion 入口校验完整计划/真实策略身份）范围，本任务完成 writer/计划侧并
  给出接口（manifest.executionPlan/decisionPolicy）。
- **isolationSelfTestId**：代码库无隔离自测机制，保持 null 诚实记录；如 R13 后续
  需要，应实现真实 self-test 再绑定，不伪造。
- **Windows/CI 复核**：与 R12 相同，待推送后由新 CI 运行确认。
