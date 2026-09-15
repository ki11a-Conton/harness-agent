# E4-R74 真实基线执行说明（runbook）

> **E4-R75 修订**：本文件在执行顺序上有一处**确定性阻断**已被修正（原 §2 生成摘要时
> 不带预算，§3 才设置预算，导致照做必然在调用模型前被 digest 门禁拒绝）。修订记录与
> 反例证据见 `docs/E4-R75-report.md`。R74 的历史结论与用例冻结不受影响。

本文件说明**如何**执行首轮真实任务能力基线。它本身**不授权**任何付费调用。

> 当前状态：**NOT_RUN**。未使用付费模型、未设置 `RUN_PAID_BENCHMARKS=1`、
> 未使用任何环境密钥、未自动确认花费。

## 0. 执行前必须由用户逐项确认

计划 §5.7 要求缺什么信息就逐项列明。以下每项都必须由用户明确给出，**不得由 Agent
代填或推测**：

| # | 需要确认的信息 | 当前状态 |
| --- | --- | --- |
| 1 | **provider / model 身份**（如 `deepseek-v4-flash` 或 OpenAI 兼容端点） | ⬜ 未指定 |
| 2 | **计价或 usage 计量来源**（单价表 / 账单口径） | ⬜ 未提供 → 成本记为 UNKNOWN |
| 3 | **单次运行预算上限** | ⬜ 未指定 |
| 4 | **总预算上限** | ⬜ 未指定 |
| 5 | **计划确认方式**（接受本次 `planDigest`） | ⬜ 未确认 |
| 6 | **数据发送范围确认**（用例 request+fixture 出境） | ⬜ 未确认 |
| 7 | **结果保存路径** | ⬜ 未指定 |
| 8 | **停止条件**（见 §4） | ⬜ 未确认 |

**在 1–8 全部确认前，不得开始真实运行。**

## 0.1 核心纪律：dry-run 与执行必须使用**同一组参数**

`planDigest` 绑定的是**完整的执行计划**：用例集合与用例内容指纹、`--limit`、
`--repeat`、`--shuffle`/`--seed`、四个 `--max-*` 上限、billing class、隔离强度与
promotion 资格、provider/model 身份、judge 版本、源码快照与决策策略。

因此正确顺序是**先定参数，再 dry-run，再原样执行**：

```
用户选择 provider/model/预算与数据范围
      ↓
在同一个执行环境里配置这组参数
      ↓
用【全部最终参数】dry-run           ← 得到 planDigest
      ↓
用户审阅并确认该摘要
      ↓
用【完全相同】的参数 + --plan-digest 执行
```

两个命令**只在非计划语义字段上不同**：`--dry-run`、`--plan-digest`、`--out`、以及
授权开关/凭据。**其他任何参数都必须逐字一致。**

> **不要**「先用一组参数（例如不带预算、或使用默认 `--limit`）生成摘要，再换另一组
> 参数执行」。那样生成的摘要描述的是另一个计划，命令会在**任何模型调用之前**被拒绝。

> **`--limit` 默认值是 1，不是「全部」。** 要跑完整冻结集必须显式写 `--limit 0`。
> 省略它会让 dry-run 只绑定 1 个用例，而执行时又期望 8 个。

## 1. 环境准备（不产生费用）

```bash
pnpm install --frozen-lockfile
pnpm build                       # CLI 从 dist/ 运行，必须先构建
```

## 2. 第一步：用全部最终参数 dry-run 并确认计划摘要（0 次 provider 调用）

先在与执行**完全相同**的环境里确定最终参数（`provider` / `model` 通过环境变量配置，
见 §3；此处先把其余参数固定下来）。

**PowerShell（Windows）**——参数数组只写一次，dry-run 与执行共用：

```powershell
$BenchArgs = @(
  'apps/cli/dist/main.js','benchmark',
  '--suite','regression',
  '--cases','benchmarks/baseline-e4-r74',
  '--limit','0',
  '--max-logical-runs','8',
  '--max-model-calls','80',
  '--max-estimated-tokens','320000',
  '--max-estimated-cost-usd','0.04',
  '--out','benchmarks/results/<YYYY-MM-DD>-<provider>-<model>-baseline'
)
node @BenchArgs --dry-run
```

**bash（Linux）**——同一组参数：

```bash
BENCH_ARGS=(
  apps/cli/dist/main.js benchmark
  --suite regression
  --cases benchmarks/baseline-e4-r74
  --limit 0
  --max-logical-runs 8
  --max-model-calls 80
  --max-estimated-tokens 320000
  --max-estimated-cost-usd 0.04
  --out benchmarks/results/<YYYY-MM-DD>-<provider>-<model>-baseline
)
node "${BENCH_ARGS[@]}" --dry-run
```

> `<N>` 形式的占位符必须由用户在 §0 中给出真实数字（`0` = 禁止）。**不要**照抄本文
> 示例里的 8 / 80 / 320000 / 0.04——那只是上一轮的规划估算，不是本次预算。
> **不要**把密钥字面量写进仓库或写进这些示例；使用用户已配置的标准凭据渠道。

需要从输出中核对并记录：

| 字段 | 期望 | 参考（2026-09-15 / `fe7e1d2`） |
| --- | --- | --- |
| `mode` | `dry-run` | `dry-run` |
| `casesTotal` | `8` | `8` |
| `caseIds` | 8 个用例 id 齐全 | 见 `docs/E4-R74-baseline-cases.md` §2；R77 的内容修订见 `docs/E4-R77-baseline-cases-rev1.md` |
| `providerCalls` | **`0`** | `0` |
| `limits` | **四项均等于最终预算**（不是 `null`） | — |
| `sourceSha` | 等于当前 HEAD | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` |
| `promotionEligible` | `false`（无强隔离后端） | `false` |
| `planDigest` | **记录下来，下一步原样使用** | 因工作树状态而异——**不要**照抄 |

### 2.1 关于 `planDigest` 何时会变（准确表述）

- **相同语义计划 + 相同源码快照 → 摘要稳定。** 在同一个工作树状态下重复 dry-run
  会得到**逐字节相同**的输出（已实测）。
- **任何被绑定的字段变化都需要重新确认**：改预算、改 `--limit`/`--repeat`/`--seed`、
  换 model、从 stub 切到计费 provider、**审阅摘要后继续编辑任何文档或源码**（源码树
  指纹会变，进而改变摘要）。

所以正确用法是「**同一次 dry-run 的输出 → 紧接着传给 `--plan-digest`**」，而不是
「每次运行 digest 都必然不同」。

### 2.2 历史冻结用例 vs 本次执行快照

- **冻结的是用例集合**：由 `benchmarks/baseline-e4-r74/` 的**内容指纹**保证
  （R74：`docs/E4-R74-baseline-cases.md` §2；R77 修订后：`docs/E4-R77-baseline-cases-rev1.md`
  §1 给出新旧指纹对照——本 set 在 R77 有 3 个用例内容修订，因此**执行前必须重新
  dry-run**，任何复用的历史 digest 都无效）。
- **不冻结的是本次执行快照**：`sourceSha` + `treeFingerprint` 记录「计划是在哪棵源码
  树上生成的」。`docs/r74-evidence/r74-frozen-plan.json` 是**历史 stub 快照**，其中的
  digest 与环境变量**不是**可复用的授权凭据。
- 因此：审阅完摘要之后**不要再编辑任何文件**；如确需编辑，重新 dry-run 并重新确认。

**边界**：dry-run 成功只证明「执行计划可生成」，**不**代表已执行、**不**代表评测会
通过。

## 3. 第二步：设置预算与凭据，用**相同参数**执行

把 §2 dry-run 输出的 `planDigest` 原样传入 `--plan-digest`，其余参数与 §2 完全一致。

**PowerShell（Windows）**：

```powershell
$env:OPENAI_API_KEY  = "<user-provided>"
$env:OPENAI_BASE_URL = "<user-provided endpoint>"
$env:OPENAI_MODEL    = "<user-provided model>"
$env:RUN_PAID_BENCHMARKS = "1"        # 必须由用户显式授权

node @BenchArgs --plan-digest <planDigest from step 2>
```

**bash（Linux）**：

```bash
export OPENAI_API_KEY="<user-provided>"
export OPENAI_BASE_URL="<user-provided endpoint>"
export OPENAI_MODEL="<user-provided model>"
export RUN_PAID_BENCHMARKS=1

node "${BENCH_ARGS[@]}" --plan-digest "<planDigest from step 2>"
```

### 3.1 关于四个上限：runbook 的操作要求 vs CLI 当前强制的契约

**不要误以为 CLI 会强制全部四项。** 当前 `--dry-run` 之外的实际强制行为是：

| 检查 | CLI 当前行为（源码 `preflightBenchmark`） |
| --- | --- |
| `--max-logical-runs` | 若提供则校验；**未提供 = 不限制** |
| `--max-model-calls` | 若提供则校验；**计费 provider 必须显式给正值**（未提供会被拒绝） |
| `--max-estimated-tokens` | 若提供则校验；**未提供 = 不限制** |
| `--max-estimated-cost-usd` | 若提供则校验；**未提供 = 不限制** |
| `--plan-digest` | **计费 provider 必须提供且必须匹配**，否则拒绝执行 |

也就是说：**强制的是「正 model-call 上限」与「digest 配对」两项**；其余三项按提供的值
校验。**本 runbook 要求四项全给**，这是本流程的**操作纪律**（把不确定性压到最小），
而不是对 CLI 行为的描述。不要为了「让文档和实现对得上」去偷偷扩大 CLI 契约。

**两个硬性前置条件**（E4-01）：

1. `planDigest` 必须与本次实跑计划一致，否则命令拒绝执行；
2. 计费 provider **必须**同时具备 digest 与显式花费上限，否则拒绝执行。

`RUN_PAID_BENCHMARKS=1` 是授权开关；**仅有 API key 不构成授权**。

### 3.2 关于隔离强度（必须如实记录）

dry-run 报 `isolationStrength: "none"`、`promotionEligible: false`。

**这表示「本次执行路径没有建立强隔离资格」，不表示「这台机器上不存在强隔离后端」。**
在**没有 `--candidate`** 的测量路径上，preflight **根本不会去探测**强隔离后端
（`probeIsolationBackend` 只在 candidate/promotion 路径上被调用），因此
`isolationStrength` 保持默认值 `none`，`isolationBackendId` 为 `"not-probed"`。
本机实测直接调用探测函数得到的结论是 `win32-none`（Windows 上无强后端），但那是
**独立探测的结果**，不是这条 `none` 字段证明的。

因此本次运行：

- 属于**测量运行**，**不是** promotion 级证据；
- 不得据此晋升 champion；
- 不要通过 `--allow-insecure-local-benchmark` 把它包装成 promotion 运行来「补齐」资格。

**adversarial 用例的真实测量**必须在**独立的、无秘密的、可丢弃**的环境中进行。
测量模式（benchmark profile）**不是**安全沙箱；不要在有真实凭据或真实数据的机器上
把「跑了一遍 adversarial 用例」当成隔离已达标。

## 4. 停止条件

出现以下任一情况立即停止，不要重试到绿：

1. 实际消耗达到任一 `--max-*` 上限；
2. 出现 `failure_category: infrastructure` 或 `harness` 的系统性集中失败
   （说明是环境/框架问题，不是模型能力问题，此时结果不能作为能力基线）；
3. 出现 `security_violations > 0`（需先按安全问题处理，不得当作分数继续跑）；
4. `planDigest` 不匹配；
5. 用户撤回授权或预算。

## 5. 预算口径：估计值不是账单硬封顶

dry-run 输出的 `estimatedModelCalls` / `estimatedTokens` / `estimatedCostUsd` 是
**规划期估计**，用固定系数（每用例 10 次调用、每次 4000 token、每次 $0.0005）算出：

- 它们**不是**供应商账单金额，也**不构成硬封顶**；
- CLI 的 `--max-*` 是**规划期拒绝**（计划超出上限就不启动），模型调用上限在运行中
  会计数并中止，但**token 与费用不保证在供应商侧被封顶**；
- 真实的费用控制需要：**用户认可的计价口径** + **供应商侧的限制**（配额/硬上限）。

**不得虚构定价。** 没有计量来源就把成本记为 `UNKNOWN`。

## 6. 结果记录

运行后应写入 `docs/E4-R74-report.md` 或独立的基线结果文件，**逐项注明**：

- `testedSourceSha`（来自 manifest 的 `git` 字段）；
- 实际命令与退出码；
- `planDigest`；
- 真实 provider/model 与 `judgeVersion`；
- 指标：成功率、工具/验证失败数、模型调用数、token、耗时、权限违规数；
- **成本**：有计量来源才填数字；否则显式 `UNKNOWN`（**不得**虚构金额）；
- 失败用例的 `failure_category` 分布；

**stub 成绩与真实模型成绩必须分表**，不得混在一张表中比较。

## 7. 清理

- 本次运行的产物在 `--out` 指定目录内，只清理该目录；
- 不要删除 `benchmarks/<suite>/` 下的用例 fixture；
- 不要清理他人或其他进程的目录。
