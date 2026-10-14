# 证据索引 — 本 PR 的新增验收件与复跑方式

> 分支 `pr/harness-engineering-conformance-20261008`；规格输入《Harness_Agent_核心指标与工程验收标准》v1.0
> **付费模型调用：0 次**（全部测试使用 `ScriptedModelProvider` / 内存 store，无网络）
> 复跑人：Lead（下列"Lead 复跑"结果均为我本人在本机独立执行所得，非子代理转述）

## 1. 新增测试件

| 文件 | 用例数 | 覆盖内容 | 命令 | Lead 复跑结果 |
| --- | ---: | --- | --- | --- |
| `packages/evaluation/src/harness-metrics.test.ts` | 41 | 规格 §三 12 指标（正常态 + 空样本态）、5 轴分层样本量、pass@1/pass@k/pass^k 分离、评分卡 | `pnpm exec vitest run packages/evaluation/src/harness-metrics.test.ts` | **76 passed（含下一文件，2 files）** |
| `packages/evaluation/src/harness-conformance-gate.test.ts` | 35 | 规格 §六 硬门槛 fail-closed、加权分不得放行、§七 A/B 与记录字段 | `pnpm exec vitest run packages/evaluation/src/harness-conformance-gate.test.ts` | 同上 **76 passed** |
| `packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts` | 12 | 规格 §五 第 1/2/5 类：上下文耗尽、工具连续报错、崩溃与重复副作用 | `pnpm exec vitest run packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts` | **12 passed** |
| `packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts` | 20 | 规格 §五 第 3/4 类 + §八.4：未验证不得宣称完成、三类注入面、跨工作区与敏感命令越权 | `pnpm exec vitest run packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts` | **20 passed** |

用例数由 `vitest` 输出与文件内 `it(` 计数双向核对一致（41 / 35 / 12 / 20）。

## 2. 一键复跑

```bash
pnpm exec vitest run packages/evaluation/src/harness-metrics.test.ts \
  packages/evaluation/src/harness-conformance-gate.test.ts \
  packages/core/src/runtime/pr-harness-fault-recovery.regressions.test.ts \
  packages/core/src/runtime/pr-harness-security-boundary.regressions.test.ts
pnpm exec tsc -b packages/evaluation packages/core packages/security
pnpm typecheck
pnpm docs:verify
```

## 3. 邻居回归（防"新文件绿、既有变红"）

| 范围 | 结果 | 执行者 |
| --- | --- | --- |
| `packages/context/src/pipeline.test.ts`、`packages/security`、`packages/core/src/runtime/tool-output-boundary.regressions.test.ts` | **21 files / 2190 tests passed** | 子代理（`security-boundary`）自测 |
| `tsc -b packages/core packages/security` | exit 0 | 子代理（`security-boundary`）自测 |
| `tsc -b packages/evaluation`（含 Lead 新加的 `index.ts` 导出） | **exit 0** | Lead |

## 4. 断言非空洞性（变异验证）

两个测试子代理各自做了**变异验证**，证明断言不是"永远绿"：

- `fault-recovery`（3 组）：让 resume 再写一次 → C5-1/C5-3/C5-5 变红；`maxAttempts` 改 25 → C2-1/C2-4 变红；删掉约束 → C1-1 变红。变异副本已全部还原。
- `security-boundary`（7 组）：分别关掉 priorBlocks 注入丢弃 / project 文档扫描 / 工具输出注入拦截 / 失败 gate 阻断 / 沙箱文件包含 / process allowlist / capability 越权检测 → 对应用例变红。**已核实无 `*.mutbak` 残留、无 `if (false)` 残留、`git diff` 为空。**

## 5. 本 PR 发现但**未修**的既有缺陷（附最小复现）

| 编号 | 位置 | 现象 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| DEFECT-1 | `packages/core/src/runtime/tool-call-controller.ts:747-757` | `recovery.decided` 在 `retryPolicy !== "safe"` 判断**之前**发出，且把 `retry` 映射为 `action:"retry_safe"`、`reason:"…retrying"`；非 safe / `retryable:false` 的工具实际一次都没重试 | **trace 撒谎**：无法从事件流区分"真的重试了"与"被拒绝重试"，直接损害规格指标 #9（Trace 完整率）与 §五-2 的可审计性 | 本 PR 不改生产代码；由 `pr-harness-fault-recovery.regressions.test.ts` 的 `[C2-1]/[C2-3]` 把**当前行为 pin 住**，修复者会看到断言主动失败 |
| DEFECT-2 | `packages/core/src/runtime/tool-call-controller.ts:571-578`、`:588-595` | `security.permission_denied` 只在运行时自身闸门（step 工具策略 / hook）发出；orchestrator（真实权限引擎 `@ar/tools`）返回 `status:"denied"` 时只发 `tool.failed` | 工具层权限拒绝在**安全事件流上不可见**，削弱规格指标 #8 的可测性与 §五-4 的可审计性 | 同上，仅记录，不就地修 |

## 6. 集成断层（影响"用真实产物喂这套指标"的路径）

| 断层 | 说明 | 建议 |
| --- | --- | --- |
| `packages/evaluation/src/load-runs.ts:43` `resultToOutcome` | 对 report-object 形态**硬编码 `events: []`**，而同文件的 `verification_passed`/`termination_reason` 并未被搬进 `events`。若用 `loadRunsFromArtifact()` 直接喂本 PR 的门限，会得到 `trace_completeness=0`、验证状态 `null`（**并非既有 bug，而是用法断层**） | 二选一：把 `verification_passed`/`termination_reason` 映射成合成的 `verification.completed`/`turn.*` 事件（改既有文件，需单独评审）；或经 `SpecCaseFacts` 直接注入（本 PR 接口已支持） |
| `auto_verification_coverage` 分母 | 当前分母是"**被观测到的任务数**"；若基准集有 30 个任务只跑了 20 个，覆盖率会被**高估** | 需把基准任务清单传入（接口未含），见 `SPEC-CONFORMANCE.md` §六 |
| 故障注入类指标的 ground truth | 指标 #4/#7/#8 依赖调用方注入 `facts.expect*`（case ABI 无法表达"这个任务应该循环/应该被拒"）；**未标注的真实评测会一律 `BLOCKED`** | 刻意 fail-closed；需在评测规程里要求标注，否则门限永不 PASS |
| `percentile()` 约定不一致 | `packages/learning/src/scorecard.ts:56` 空数组返回 `0`（会显示成"0ms 延迟"），本 PR 的 `percentileOrNull` 返回 `null` | 混用会得到假象；本 PR 不改既有文件，已在注释中写明 |

## 7. 声明

- 本 PR **不产生任何模型质量结论**：所有测试为确定性离线测试，未调用任何付费模型；仓库真实模型质量仍为 `NOT_PROVEN`。
- 本 PR **不触碰** `docs/evidence/**` 冻结证据、`main` 分支、以及既有门限的严格性。
