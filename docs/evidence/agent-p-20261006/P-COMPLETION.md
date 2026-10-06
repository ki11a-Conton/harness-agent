# P 轮完成记录 — 观测驱动的完成判定策略 `verified_completion_gate_v1`

不可变规格：[plan(20261006-191434).md](../../../plan(20261006-191434).md)（规格内状态表按惯例保持原字节，进度以下表与本文件为准）。计划入口：[plan.md](../../../plan.md)。审查基线 `5340bbcf196f54b283ad4351ef057189a07aca0b`（含本机 `0d5ef35a`：N7 证据树 LF 规则）。

## 状态

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| P1 策略文本与注册 | **DONE** | §1 |
| P2 接线 | **DONE** | §2 |
| P3 工程验收 | **DONE** | §3 |
| P4 证据与状态 | **DONE** | 本文件 |

## 1. P1 — 策略文本与注册

| 事实 | 值 |
| --- | --- |
| 候选 id | `verified_completion_gate_v1` |
| 版本标识 | `verified-completion-gate:v1` |
| 文本 SHA256 | `7ef38a062ad770f47699ebac90f9cfa02c65758c9f92c1a9298bbc744275b546` |
| 文本长度 | 1009 字节 |
| 既有候选（**逐字节不变**） | csafe v1 `ce66f3b0…56c2`；csafe v2 `52a80e9c…9333c`；tool-call `ebddf5eb…9619` |

文本把"完成"从意图陈述改为观测陈述，四条可观测义务：① 报告完成前、在**最后一次改动之后**复跑任务自带的判定命令；② 只能引用实际观测到的输出（命令、退出码、通过摘要），"我认为没问题"不算完成；③ 修不动就逐字报告失败与阻塞，诚实失败是正确结果；④ 无新信息或同一失败重复时改变方法或停止报告，把剩余迭代留给验证步骤。**不新增工具、不新增参数、不改权限/沙箱/验证**。

## 2. P2 — 接线（全部经既有 `completionGuidance` 槽位）

`mechanism-guidance.ts`（文本+digest）· `candidate-registry.ts`（id 常量 + 登记 `enabledPatch: { verifiedCompletionGate: "v1" }`）· `arm-factory.ts`（`RuntimeMechanisms.verifiedCompletionGate` + arm 分支，`promptAdditionsDigest` 绑定真实字节）· `mechanism-contract.ts`（契约；`requiredActivationEvents: ["verified-completion-gate-guidance-injected"]`）· `activation-evidence-execution.ts`（信号类型与映射）· `activation-evidence.ts`（按**本候选信号 + 版本**判定激活）· `benchmark-command.ts`（单一模型可见提示构建器新增分支；激活信号与执行身份映射按需追加，既有臂 config hash 不变）· `champion-application.ts` / `champion-harness-config.ts`（独立安装要求；与其它引导机制互斥）。

## 3. P3 — 工程验收（离线，0 模型调用、0 付费）

| 验收项 | 结果 |
| --- | --- |
| `packages/evaluation/src/verified-completion-gate.regressions.test.ts` | **7/7 PASS**：文本/digest 自有且不动既有候选；四条义务在场；无新工具/参数/权限措辞；registry+arm+contract+preflight；基线与 v1/v2 臂身份不受扰动（无 `verifiedCompletionGate` 键）；旧分派器按信号+版本钉死（外来注入→`activation_zero`，版本不符→`activation_zero`）；执行绑定证据 digest 取模型实见字节 |
| `apps/cli/src/verified-completion-gate.integration.test.ts` | **4/4 PASS**：真实 Harness 循环中真实 ModelRequest 含**确切**门文本且不含 v1/v2 文本；装 v2 或默认时不含门文本；`runtimeConfigForHash`/`computeRuntimeConfigHash`/单一提示构建器三处身份一致且与 baseline/v1/v2 均不同；champion 安装计划单独安装通过、与任意其它引导机制组合被拒 |
| `candidate-registry.test.ts` | PASS（矩阵/实验/语义增量三个列表补入新 id） |
| N7 v2 + N6 预注册测试 | **34/34 PASS**（含本轮按事实修正的 holdout 复算断言，见 §4.1） |
| `pnpm typecheck` | 通过 |
| `pnpm docs:verify` | ALL CHECKS PASS（E4-00：plan.md 为当前入口并引用存在的 `plan(20261006-191434).md`） |
| 全仓 `pnpm test`（本轮执行） | 487 文件 / 8990 用例：**8900 PASS、25 FAIL、65 skip**。25 项失败分布在 **11** 个文件：其中 **10 个在拉取前的基线提交上同样失败**（symlink 权限、worker 终止计时、平台 argv、host-probe、并发超时等本机环境性）；**第 11 个是本轮改动引起的设计内后果**，见 §4.1。新增的 P 测试 7+4 全 PASS（`verified-completion-gate.regressions.test.ts`、`verified-completion-gate.integration.test.ts`） |
| 效果结论 | **NOT_RUN**：本轮不运行任何模型实验，不宣称效果或 promotion；门限 8 条与数值未改 |

## 4. 如实记录的两个副作用

1. **登记新候选会移动"基线臂快照"摘要**（`arm-factory buildSnapshot` 在 baseline 臂上把每个已注册候选列为 OFF）：N7 **holdout** 预注册的对照臂是运行时解析的 champion（C0/`null` → baseline 臂），因此其 `baselineArmDigest` 由 `ee589c7e…` 变为新值，根身份随之变化。处理：**不改写已冻结的 N7 产物**，改为断言"除该臂摘要与其派生的根身份外逐字节一致"，显式记录冻结值，并断言冻结产物自身 dry-run 仍为 192 runs / 0 付费。**若将来要真跑 N7 holdout，必须先重新 prepare 并重新冻结/批准**（执行链文档本身即要求重新确认 binding digest）。N7 **main** 预注册两臂均为候选臂，不受登记影响，仍逐字节可复算。

   **连带后果（本轮实测，已计入 §3 的全仓数字）**：并入的 `apps/cli/src/n7-execution-chain.regressions.test.ts` 在 `beforeAll` 里调用 `scripts/research/agent-next7-20261006/execution-common.mjs` 的 `loadExperiment("holdout")`，其完整性断言要求"基线臂摘要 == 预注册记录值"。登记新候选后该断言以 **`ARM_DIGEST_DRIFT`** 失败，导致该文件 55 项测试全部 **skipped**（Vitest 报告文件 FAIL，不是静默跳过）。

   这是**设计内的 fail-closed 行为**，也是本机唯一可行的诚实处理：本轮计划明确承诺"不动 N7 预注册与语料"，而该预注册同时被 N7 验收证据的 `unchanged-originals.json` 以固定 SHA256 保护（494 项，当前 494/494 与 HEAD 一致）。因此**没有改写**它。要让 N7 holdout 执行链在本树重新可跑，二选一：
   - **（推荐，等真要跑时再做）** 运行 `scripts/research/agent-next7-20261006/freeze-n7-holdout-preregistration.mjs` 重新冻结（24 用例 / 192 runs / 门限 / provider / 预算均不变，仅基线臂摘要与根身份更新），并在同一提交里更新 `unchanged-originals.json`/`artifact-index.json`/`RAW-MANIFEST.json` 的记录与 N7 README/PROGRESS 中的旧 digest；当前**没有任何模型结果**，因此重新冻结在时间上仍是"结果之前"。
   - 或保持冻结不动，接受该 55 项在本树持续以 `ARM_DIGEST_DRIFT` fail-closed，直到真正准备运行 N7 holdout 时再重新冻结。
2. `apps/cli/src/benchmark-command.test.ts > E4-R41 …captureHostState UNVERIFIED` 在本机隔离复跑仍失败（102 通过 / 1 失败），且**在拉取前的基线提交上同样失败**，属本机 host-probe 环境性失败，非本轮引入。

## 5. 本机环境修复（同轮一并完成）

`.gitattributes` 增加 N7 证据树 LF 规则（`0d5ef35a`）：`docs/evidence/agent-next7-20261006/** text eol=lf`、`**/*.gz -text`、`scripts/research/agent-next7-20261006/* text eol=lf`。修复前实测：索引 33/33 与 LF blob 一致，但工作树仅 23/33（每行差 1 字节），`verifyIndex` 报 `ARTIFACT_DRIFT`；修复后工作树 `verifyIndex` 33 files OK、`RAW-MANIFEST` 28 files OK。`git add --renormalize` 未产生任何内容改动（blob 本就是 LF），故不影响任何已记录摘要。
