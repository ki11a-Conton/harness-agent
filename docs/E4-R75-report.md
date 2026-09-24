# E4-R75 报告：修正真实基线 runbook，并证明摘要配对

## 1. 范围与版本绑定

| 项 | 值 |
|---|---|
| 计划 | `plan(20260915-033502).md` §4（F1 / F4） |
| reviewedSourceSha（计划 §1） | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 本次起点 HEAD | `8337b3e3d56ac78677c7fac7759fa0141d03e8f5` |
| 起点 `git status --short` | 仅 `?? plan(20260915-033502).md`（本任务计划文件，未跟踪） |
| 环境 | Windows (win32)、Node `v24.18.1`、pnpm `11.21.0` |
| 真实模型调用 | **0 次** |
| 产物 | `docs/E4-R74-baseline-runbook.md`（修订）、`apps/cli/src/benchmark-command.test.ts`（新增 13 个用例） |

未设置 `RUN_PAID_BENCHMARKS=1`，未使用任何密钥，未调用远端模型，未推送。

## 2. F1：确定性阻断的**实测复现**

计划 §1 F1 断言「照 runbook 操作会在调用模型前被拒绝」。本轮**实际复现**，不是静态推断。

### 2.1 端到端复现（真实 CLI 入口，0 次 provider 调用）

按 R74 runbook **原文**执行两步：

```
# §2 原文（无任何 --max-* 参数）
node apps/cli/dist/main.js benchmark --suite regression \
  --cases benchmarks/baseline-e4-r74 --dry-run
# → planDigest 396e25f9cc3ad26587a9a7a7be715c24632fd0ab7689ecc9386be6453ff686ab
# → limits {"maxLogicalRuns":null,"maxModelCalls":null,"maxEstimatedTokens":null,"maxEstimatedCostUsd":null}

# §3 原文（同一 digest + 四个预算）
node apps/cli/dist/main.js benchmark --suite regression \
  --cases benchmarks/baseline-e4-r74 \
  --max-logical-runs 8 --max-model-calls 80 \
  --max-estimated-tokens 320000 --max-estimated-cost-usd 0.04 \
  --plan-digest 396e25f9cc3ad26587a9a7a7be715c24632fd0ab7689ecc9386be6453ff686ab \
  --out benchmarks/results/_f1-check
```

**观测结果：退出码 1**

```
agent benchmark: plan digest mismatch — expected 396e25f9cc3ad26587a9a7a7be715c24632fd0ab7689ecc9386be6453ff686ab,
computed 4c48fb380180b79ebe3e0a51405c56534b19c5343fdfbc5b1d1566bffd795651
```

**F1 结论：REPRODUCED（真实 CLI 路径，0 次 provider 调用）。**

### 2.2 第二个独立成因：`--limit` 默认值是 1

复现过程中发现 runbook §2 还遗漏了一项：**`--limit` 默认为 `1`，不是「全部」**
（源码 `parseBenchmarkArgs` 默认 `limit: 1`）。因此即使把预算补齐，只写 §2 原命令
仍然只绑定 **1 个用例**，而执行预期 8 个。两个成因相互独立，都已在本轮修正。

已用受控断言固定该行为（`executionPlan.caseIds` 长度 1 vs 8，摘要不同）。

### 2.3 修复方式

runbook 的执行顺序改为：

```
用户选定 provider/model/预算与数据范围
  → 在同一执行环境配置这组参数
  → 用【全部最终参数】dry-run
  → 用户确认摘要
  → 用【完全相同】的参数执行
```

两个命令只在非计划语义字段（`--dry-run`、`--plan-digest`、`--out`、授权开关/凭据）
上不同。为避免手工复制遗漏预算，PowerShell 与 bash 各自**只写一份参数数组**
（`@BenchArgs` / `BENCH_ARGS`），dry-run 与执行共用。

## 3. F1 验收证据：参数配对与反例

新增 13 个离线用例（`apps/cli/src/benchmark-command.test.ts`，describe
`E4-R75 (F1): a dry-run digest only authorizes a plan with identical parameters`），
全部走**真实 `preflightBenchmark` 路径**，未自建平行判定函数。

| 用例 | 断言 | 结果 |
|---|---|---|
| F1 REPRO | 无预算 dry-run 摘要 → 带预算执行 → 拒绝，且拒绝理由**不是**计费门（显式断言不含 `RUN_PAID_BENCHMARKS`） | **PASS** |
| F1 FIX | 全参数 dry-run 摘要 → 同参数执行 → 接受，且 `planDigest` 相等 | **PASS** |
| `--limit` 默认值 | 8 个用例下 `limit=1` 与 `limit=0` 摘要不同；`caseIds` 长度 1 vs 8 | **PASS** |
| 反例 ×7 | 单独改变 `--max-logical-runs` / `--max-model-calls` / `--max-estimated-tokens` / `--max-estimated-cost-usd` / `--repeat` / `--limit` / `--seed`，每一项都使旧摘要失效 | **PASS** |
| stub→billed | billing class 改变（预算不变）使摘要失效；带授权仍以 digest mismatch 拒绝 | **PASS** |
| 硬拒绝 | digest 不匹配时 `ok=false`，且 `executionPlan`/`planDigest` 均为 `undefined`——**不存在回退到新摘要的路径** | **PASS** |
| 0 次调用 | `--dry-run` 退出码 0、`providerCalls: 0`、provider 未被调用；同参数带 digest 执行时输出**不含** digest mismatch | **PASS** |

**未**把 digest mismatch 降级为 warning，**未**自动接受新摘要：`preflightBenchmark` 在
不匹配时只返回 `{ ok: false, reason }`，不带 `executionPlan`，因此调用方无法"顺手"用
新算出来的计划继续跑（由上表最后两条正向断言覆盖）。

### 3.1 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm exec vitest run apps/cli/src/benchmark-command.test.ts -t "E4-R75"` | **0** | `Tests 13 passed \| 67 skipped (80)` |

`pnpm build` 与 `pnpm docs:verify` 在 R78 收尾统一执行（见 §6）。

## 4. F4：说明与证据边界的修正

### 4.1 「每次 digest 都变」→ 准确表述

R74 文档写「`planDigest` 每次都变」。源码与实测都表明更准确的表述是：

- **相同语义计划 + 相同源码快照 → 摘要稳定**（同工作树重复 dry-run 输出逐字节相同，
  本轮实测确认；R74 报告 §4.2 也记录了「两次输出逐字节相同」）。
- **任何绑定字段变化都需要重新确认**：预算、`--limit`/`--repeat`/`--seed`、model、
  stub↔billed、以及**审阅摘要后编辑任何文档或源码**（树指纹变化）。

原因是 plan 绑定**内容级**树指纹（`probeSourceSnapshot` 对每个偏差文件按**原始字节**
做 sha256，含未跟踪的非忽略文件）。本轮实测：对一个已跟踪文档追加一个换行 →
摘要改变 → 还原后摘要**恢复原值**，证明指纹是内容决定的、可复现的。

### 4.2 隔离强度 `none` 的正确解释

runbook 原文写「本机没有强 OS 级隔离后端（如 Linux 上的 `bwrap`）」，把
`isolationStrength: "none"` 当成了机器级结论。源码显示：

- `probeIsolationBackend()` **只在 `opts.candidate !== undefined` 的 promotion 路径上
  被调用**（`preflightBenchmark` 第 4 步）；
- 无 `--candidate` 的测量路径上 `isolationStrength` 保持默认 `"none"`、
  `isolationBackendId` 为 `"not-probed"`。

因此该字段的含义是「**这条路径没有建立强隔离资格**」，**不能**推断机器上不存在强后端。
已在本机**独立**探测一次作为对照：`{"id":"win32-none","platform":"win32",
"strongIsolation":false,...}`——但这是独立探测的结论，不是该字段证明的。

同时补充了「真实 adversarial 测量需在独立、无秘密、可丢弃的环境中进行；测量模式不是
安全沙箱」的边界。

### 4.3 四个上限：文档要求 vs CLI 契约

源码显示 CLI 当前**强制**的只有两项：**正 `--max-model-calls`**（计费 provider，
未提供即拒绝）与 **digest 配对**。其余三个 `--max-*` 是「提供了才校验，未提供 = 不限制」。
`--max-logical-runs` 同理。

runbook 已改为：**四项全给是本流程的操作纪律**，并逐项列出 CLI 的实际行为。
**未**为对齐文档而修改 CLI 契约。

### 4.4 成本口径

补充说明 `estimatedModelCalls` / `estimatedTokens` / `estimatedCostUsd` 是规划期估计
（固定系数：每用例 10 次调用 × 4000 token × $0.0005），**不是账单，也不是硬封顶**；
真实费用控制需要用户认可的计价口径 + 供应商侧限制。**未虚构定价。**

## 5. 未做的事（边界）

1. **未**修改 digest 的任何安全语义（未降级为 warning、未允许自动接受新摘要）。
2. **未**修改 CLI 的预算校验契约。
3. **未**调用真实模型、未使用密钥、未设置 `RUN_PAID_BENCHMARKS=1`。
4. **未**修改 holdout，**未**改动 `benchmarks/baseline-e4-r74/` 的任何用例内容
   （冻结集合未变）。
5. **未**新增运行时/框架代码，仅文档 + 测试。
6. **未**删除或重写 R74 的历史记录；R74 报告与用例清单保持原样，修订只在 runbook
   顶部标注并指向本报告。

## 6. 验收对照（计划 §4）

| 计划 §4 验收项 | 结果 |
|---|---|
| 两种 shell 示例所有计划相关参数逐项一致，无「默认预算 → 正预算」切换 | ✅ §0.1 + §2/§3 共用单一参数数组；两处参数逐字一致 |
| 用 fake provider 或纯 preflight identity 验证，不使用真实密钥或网络模型 | ✅ §3，13 用例全离线，providerCalls=0 |
| `pnpm build` / `pnpm exec vitest run apps/cli/src/benchmark-command.test.ts` / `pnpm docs:verify` 退出 0 | ⏳ 目标测试已退出 0；`pnpm build` 与 `docs:verify` 在 R78 收尾执行，见 `docs/E4-R78-report.md` |
| 报告列出参数对照与反例结果 | ✅ §2.3 / §3 |
| 不得把 digest mismatch 修成 warning 或自动接受新摘要 | ✅ §3 末段 + 硬拒绝用例 |

## 7. 结论

- **F1：REPRODUCED → FIXED（文档层）**。反例已由真实 preflight 路径覆盖，最终命令
  参数配对正确。
- **F1 附加成因（`--limit` 默认 1）**：REPRODUCED → 已在文档与测试中固定。
- **F4：FIXED（文档层）**。digest 稳定性表述与隔离强度解释均已按源码事实修正。
- 真实基线仍为 **NOT_RUN**；费用仍为 **UNKNOWN**。
