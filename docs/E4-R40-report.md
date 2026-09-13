# E4-R40 Report — E4-09 失败归因诊断包（K01）

- reviewedSourceSha（本计划审查时所依据的提交）：
  `67955e0652e5ce5127eb4e7e654f4590515a2571`（main）
- 比较基线：`a7950fa1f386b2a1adc9ba35ba84aed0ad9ad50c`
- 被测工作树：本报告所属的 **R40 实现提交**（`E4-R40: …`）。该提交**只在实现落地后**才使
  工作树变干净（见 §4），因此本提交之前的任何一次 E4-09 运行都必然触发干净树拒绝。
- 状态：**RESOLVED（诊断包路径落地）**，且**附带给出 R39 未归因失败的确定性根因**（§4）。
- 真实模型调用：**0**（全部离线；被依赖的是 E2-09 哨兵 / 真实子进程 / 本地 fixture）
- 平台：Windows（win32）

---

## 1. 做了什么

R39 的全量在 `01c4ec74` 上 3/3 把**有效链**判 `INVALID`，但只留下框架行
`expected 'INVALID' to be 'ACCEPT'`：临时目录被 `afterEach` 删除，决策 / 违规 / paired / V3
产物一个都没留，**无法归因**。R40 的目标**不是**修复失败，而是：**在最小改动、不改变决策与
成功路径的前提下，让失败自己在发生时落盘可归因证据**。

本轮落地四件事：

1. **把哨兵自身的探测记录变成产物**：E2-09 host-mutation 哨兵的 `before`/`after` 观测随 case
   outcome 写入 `paired-experiment.json`。事后重读 `git status`（在 case 之后、临时根清理之后）
   与 case 期间的观测不是同一个观测，不能还原判定依据。
2. **失败即落盘的最小诊断包**（`apps/cli/src/e4-09-diagnostics.ts`）：在 `afterEach` 删临时根
   **之前**，把测试身份、OS/Node/pnpm、干净性、真实 V3/paired/decision **字节副本 + 归约摘要**、
   真实子进程 gate 的 exit/stderr、以及 benchmark 的真实 CLI exit+输出行写入独立目录（不污染源树、
   不覆盖、不打印凭据）。
3. **把 E4-09 主链与对抗链都接入**：任一 stage 失败都会落盘（成功路径完全无副作用）。
4. **确定性失败取证证明**（独立文件 `apps/cli/src/e4-r40-forensics.test.ts` + `pnpm test:forensics`）：
   一个**按设计失败**的用例证明「失败 → 落盘 → 清理后仍可读 → 两次 attempt 不覆盖」。

---

## 2. K01 要求 → 实现对照

| 计划要求（R40 提示词） | 实现落点 | 证据 |
|---|---|---|
| 失败时保存**决策 / 违规原因** | `e4-09-diagnostics.ts` 的 `summarizeDecisionArtifact`（decision/reasonCodes/gates/statistics）随包落盘 | §5 包内 `summary.decision-artifact.decision = "ACCEPT"` |
| 保存 **paired + V3 产物** | `summarizePairedArtifact` / `summarizeV3Artifact`；产物**字节副本**进 `artifacts/`，含 sha256 与字节数 | §5 三角色 `captured=true` 且附 `digest` |
| 保存**执行阶段事实** | `E4DiagnosticRecorder.stage()` 时间线 + `mark()` + `addFact()`；`buildRealChain` 记录 `benchmarkCli = { exitCode, lines }` | §4 的真实 CLI 行；§5 `stages` |
| release gate 子进程失败时保存**真实 stderr/exit/signal** | `recordGate()` 保留 `stderrExcerpt`/`stdoutExcerpt`/`exitCode`/`failure`（E4-R12 分类） | §5 `gateEvidence[0].exitCode=2`、`stderrExcerpt="gate-budget-exceeded"` |
| 建立**最小可归因诊断包**，不改决策与成功路径 | 新增独立模块；生产侧只**附加**字段（`hostMutation`）与**透传**，无判定变更 | `pnpm typecheck` PASS；主链/对抗链断言逐字节未改 |
| 交付 `docs/E4-R40-report.md` | 本文件 | — |
| 无历史失败原因证据时**停止归因猜测** | 本轮**拿到了**原因证据（§4），不再猜测 | — |

---

## 3. 改动清单

**新增**

- `apps/cli/src/e4-09-diagnostics.ts` —— 诊断记录器（落盘根：`E4_09_DIAG_DIR`，否则
  `<tmpdir>/harness-agent-e4-09-diagnostics`；每次 attempt 独立子目录）。
- `apps/cli/src/e4-r40-forensics.test.ts` —— 确定性失败取证（**按设计失败**，从默认
  `pnpm test` 排除，见下）。
- 本报告。

**生产侧（只附加/透传，不改判定）**

- `packages/evaluation/src/benchmark-isolation.ts`：新增 `HostStateSummary` 与
  `hostStateSummary(state)`（归约 headSha/statusPorcelain/treeDigest）。
- `packages/evaluation/src/runner.ts`：`EvalOutcome` 新增可选 `hostMutation`
  （`checked/mutated/before/after`）。
- `apps/cli/src/benchmark-command.ts`：`runOneCase` 在判定**之前**构造 `hostMutation`，
  mutated 失败路径与成功路径都随 outcome 透传 ⇒ 写进 `paired-experiment.json`。

**测试侧**

- `apps/cli/src/e4-09-production-e2e.test.ts`：接入 `activeDiag` + 失败即落盘的 `afterEach`；
  主链登记 paired/v3/decision/envelope 产物与 `benchmarkCli` 事实；`buildRealChain` 登记
  paired/v3/decision。**所有既有断言未改**（成功路径零副作用）。
- `package.json`：默认 `test` / `test:coverage` 排除 `**/e4-r40-forensics.test.ts`；新增
  `test:forensics`。
- `plan.md`：指向当前计划 `plan(20260912-144145).md`（此前该文件在工作树被删除，本身即一处
  未提交脏状态）。

---

## 4. 归因结果：R39「有效链被判 INVALID」的确定性根因

**结论：E4-09 的真实 benchmark 链在**执行前**要求「干净、可证的源树」；工作树只要不是干净的
已提交版本，benchmark 就拒绝运行（退出 1），链根本不会建立，于是决策按 `runComplete=false`
被无差别判 `INVALID`。**

诊断包捕获到的**原始 CLI 行**（`e4-09-main` 包 `extra.benchmarkCli`，`exitCode=1`）：

```
agent benchmark: a promotion-eligible run requires a CLEAN, PROVABLE source tree at execution time — commit or stash changes and re-confirm the plan
  - source tree is not provably clean
  - the confirmed plan was made against a dirty tree — re-confirm on a clean tree
```

对应生产代码：`apps/cli/src/benchmark-command.ts`

- `:645` `const executionSource = await probeSourceSnapshot(process.cwd());`
- `:649-651` `promotionEligibleRun && !executionSource.clean ⇒ "source tree is not provably clean"`
- `:669-673` 命中 `sourceFacts.length > 0` ⇒ `return { exitCode: 1, lines: [ "… CLEAN, PROVABLE source tree …", … ] }`

因此该失败**不是**被测版本的缺陷，而是**运行前置条件**：门禁必须在 `git status --short`
为空的已提交版本上运行。这解释并**收口**了 R39 报告 §4.1/§4.2 的「全量并发下工作树瞬时变脏
⇒ `buildRealChain` 把有效链判 INVALID」这一未归因项：所谓「瞬时脏状态」并非来自某个用例，
而是**运行期间工作树里存在未提交改动**（R39 当时的文档改动 / 本轮之前的 R40 未提交实现）。

**证伪实验（排除本轮改动引入）**：把 R40 的生产与测试改动 `git stash` 后，在同一工作树上
运行 e4-09 —— 4 个对抗链仍**同样** `buildRealChain → expect(res.exitCode).toBe(0)` 失败
（`expected 1 to be +0`），与带 R40 改动时一致。说明该失败**先于** R40 存在，R40 既未引入、
也未掩盖它。

**旁证**：本计划的审查记录（`plan(20260912-144145).md` §1.2）在**干净工作树**上跑全量
`pnpm test` 为 **PASS（318 files / 5740 tests）**——与「干净树才可运行」一致。

---

## 5. 确定性失败取证证据（`pnpm test:forensics`）

`pnpm test:forensics` **按设计非零退出**（`Tests 1 failed | 1 passed`，`ELIFECYCLE … exit 1`）。
失败用例落盘的包（`E4_09_DIAG_DIR` 下 `e4-r40__windows__…__attempt-1/diagnostic.json`）实测内容：

| 字段 | 值 |
|---|---|
| `schemaVersion` / `kind` | `1.0.0` / `e4-09-diagnostic` |
| `test.name` | `R40 decision-stage gate failure` |
| `failure.stage` / `name` / `message` | `decision-stage-gate` / `AssertionError` / `expected 2 to be +0 // Object.is equality` |
| `source.headSha` | `67955e06…`（与运行期 HEAD 一致；`dirty=true`） |
| `summary.decision-artifact.decision` | `ACCEPT`（与落盘产物一致） |
| `summary.paired-experiment.complete` | `true` |
| `summary.v3-candidate.promotionEligible` | `true` |
| `gateEvidence[0]` | `exitCode=2`、`passed=false`、`stderrExcerpt="gate-budget-exceeded"` |
| `artifacts`（三角色） | 均 `captured=true`，附 `digest`/`bytes`，副本在 `artifacts/` |
| 两次 attempt | `e4-r40-nooverwrite__…__attempt-2` 与 `…__attempt-3` **目录不同** |

即：**退出非零**、**包在 `afterEach` 清理后仍可读**、**含匹配的真实原因与 V3/paired/decision
数据**、**两次 attempt 不覆盖**——四条验收全部满足。

> 该用例被**刻意排除**在默认 `pnpm test` 之外（否则全量必然长期为红）；它以显式 `test:forensics`
> 运行。这与 `perf`/`soak`/`e3-repro-current-defects` 的处理方式一致。

---

## 6. 门禁实测（R40 自身范围）

| 项目 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | **PASS**（退出 0） | `tsc -b`；R40 全部改动类型正确 |
| `pnpm test:forensics` | **按设计非零**（1 failed / 1 passed） | 取证路径证明；落盘包条目见 §5 |
| `pnpm test` 是否含取证文件 | **已排除** | 保证默认全量不因「按设计失败」而长期为红 |
| E4-09 干净树运行 | **PASS 5/5** | 见附录 A —— 同一代码在干净树上全绿，反证根因是干净树前置条件 |

> 全量 `pnpm test`/`docs:verify`/`security`/`protocol`/`race`/`chaos` 属 **R44** 的静止工作区
> 最终门禁范围，本报告不代其结论。

---

## 附录 A — 干净树运行（根因的决定性反证）

在 R40 实现提交（本报告所属提交，工作树 `git status --short` 为空）上运行：

```
$ env -u NODE_OPTIONS pnpm vitest run apps/cli/src/e4-09-production-e2e.test.ts
 ✓ benchmark -> V3 -> evaluator -> promote -> createHarness -> applied, all real stages
 ✓ editing a real V3 artifact's outcomes while only updating the file SHA breaks the chain
 ✓ a forged decision field (digest recomputed) is caught by the evaluator replay
 ✓ a candidate ref pointing outside the bundle root is rejected
 ✓ provider over-call guard halts the paired run before it can finalize a promotable artifact
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**同一份代码、同一个测试文件**，唯一变量是工作树干净与否：

| 工作树 | E4-09 结果 | benchmark 行为 |
|---|---|---|
| 有未提交改动（脏） | **5 failed / 0 passed**（`buildRealChain` 的 `expect(res.exitCode).toBe(0)` 失败，实测 `1`） | 执行前拒绝，退出 1，链不建立 |
| 已提交（干净） | **5 passed / 5** | 正常运行，ACCEPT |

这把 R39 §4.1/§4.2 的「全量并发下有效链被判 INVALID、根因未定」从**未归因**变为**已归因的
运行前置条件**：失败源于运行期工作树非干净，而非某个用例的瞬时副作用，也非被测版本的缺陷。

（运行日志中的 `[degraded] store-integrity.syncDir: EPERM … fsync` 为 Windows 环境既有噪声，
不影响任何断言，与本轮改动无关。）

---

## 7. 一页结论

1. **R40 交付**：E2-09 哨兵探测记录进入 `paired-experiment.json`；新增最小诊断包模块、E4-09
   失败即落盘接入、以及显式运行的确定性失败取证。**未改变任何决策与成功路径**。
2. **根因归因（超出 R40 最低要求，但正是 R40 的目的）**：R39 的「有效链被判 INVALID」是
   **干净树前置条件未满足**所致——benchmark 在执行前拒绝，链未建立，决策无差别 INVALID。
   证据是诊断包捕获的**原始 CLI 行**，而非猜测。
3. **可操作结论**：门禁必须在已提交的干净工作树上运行；携带未提交改动运行会得到退出 1 与
   INVALID，这是**前置条件**而非缺陷。该结论已被「R40 改动 stash 后同样失败」的证伪实验，
   以及计划自身在干净树上的全量 PASS 双向印证。
4. **限制**：R40 只做归因与落盘，**不修复**任何 E4-09 行为；失败包默认不参与判定。

---

## 8. 残余限制

- 诊断包默认落在本机临时目录（CI 用 `E4_09_DIAG_DIR` 指向可上传位置）；本轮**未**改 CI 上传，
  CI 侧接入留待需要时（R44 可评估）。
- `recordGate` 的 `stderrExcerpt` 依赖调用方传入原始输出；`runGateV2` 自身只回 `logRef`/
  `errorSummary`，本轮测试用自采子进程输出演示，未改 `runGateV2` 的返回契约。
- 诊断包为 best-effort：捕获失败只写 `[degraded]` 到 stderr 并记入 `notes`，**绝不**替换原始失败。
- 本轮**没有**修复 E4-09 在脏树上的拒绝行为——那是有意的生产策略（`promotionEligibleRun`）。
