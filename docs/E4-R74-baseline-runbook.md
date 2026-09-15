# E4-R74 真实基线执行说明（runbook）

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

## 1. 环境准备（不产生费用）

```bash
pnpm install --frozen-lockfile
pnpm build                       # CLI 从 dist/ 运行，必须先构建
```

## 2. 第一步：生成并确认计划摘要（0 次 provider 调用）

**每次执行前都必须重新 dry-run**——`planDigest` 绑定内容与源码树，用例文件或源码
一旦改动 digest 即失效。

```bash
node apps/cli/dist/main.js benchmark \
  --suite regression \
  --cases benchmarks/baseline-e4-r74 \
  --dry-run
```

> 为什么用 `--suite regression`：`--suite` 是闭合枚举
> （`regression|holdout|adversarial|stress`），而 `--cases <dir>` 独立地指定**用例
> 目录**。冻结集混合了三个 suite 的用例，因此用 `regression` 作为标签、用 `--cases`
> 指向冻结目录。这是当前 parser 的既定行为，不是绕过校验。

需要从输出中核对并记录：

| 字段 | 期望 | 参考（2026-09-15 / `fe7e1d2`） |
| --- | --- | --- |
| `mode` | `dry-run` | `dry-run` |
| `casesTotal` | `8` | `8` |
| `caseIds` | 8 个用例 id 齐全 | 见 `docs/E4-R74-baseline-cases.md` §2 |
| `providerCalls` | **`0`** | `0` |
| `sourceSha` | 等于当前 HEAD | `fe7e1d29a9545ffd784e8a3e88e118fce670d81b` |
| `promotionEligible` | `false`（无强隔离后端） | `false` |
| `planDigest` | **记录下来，下一步原样使用** | 每次运行都不同——**不要**照抄 |

> **`planDigest` 每次都变。** 它绑定整棵源码树的指纹，任何文件编辑（包括改动文档）
> 都会改变它。实测同一冻结集在三次不同工作树状态下得到 `f0bd02cc…`、`4b367659…`、
> `2cbcb639…`。**只有「同一次 dry-run 的输出 → 紧接着传给 `--plan-digest`」才是
> 有效配对。** 这符合 E4-01 的意图：digest 的作用是确认「即将执行的就是刚刚被审阅
> 的那个计划」，而不是作为一个可长期复用的常量。

**边界**：dry-run 成功只证明「执行计划可生成」，**不**代表已执行、**不**代表评测会
通过。

## 3. 第二步：设置硬上限并执行

把 dry-run 输出的 `planDigest` 原样传入 `--plan-digest`，并设置**全部四个**硬上限
（`0` = 禁止）：

```bash
# PowerShell (Windows)
$env:OPENAI_API_KEY  = "<user-provided>"
$env:OPENAI_BASE_URL = "<user-provided endpoint>"
$env:OPENAI_MODEL    = "<user-provided model>"
$env:RUN_PAID_BENCHMARKS = "1"        # 必须由用户显式授权

node apps/cli/dist/main.js benchmark `
  --suite regression `
  --cases benchmarks/baseline-e4-r74 `
  --max-logical-runs 8 `
  --max-model-calls <N> `
  --max-estimated-tokens <N> `
  --max-estimated-cost-usd <N> `
  --plan-digest <planDigest from step 2> `
  --out benchmarks/results/<YYYY-MM-DD>-<provider>-<model>-baseline
```

```bash
# bash (Linux)
export OPENAI_API_KEY="<user-provided>"
export OPENAI_BASE_URL="<user-provided endpoint>"
export OPENAI_MODEL="<user-provided model>"
export RUN_PAID_BENCHMARKS=1

node apps/cli/dist/main.js benchmark \
  --suite regression \
  --cases benchmarks/baseline-e4-r74 \
  --max-logical-runs 8 \
  --max-model-calls <N> \
  --max-estimated-tokens <N> \
  --max-estimated-cost-usd <N> \
  --plan-digest <planDigest from step 2> \
  --out benchmarks/results/<YYYY-MM-DD>-<provider>-<model>-baseline
```

**两个硬性前置条件**（E4-01）：

1. `planDigest` 必须与本次实跑计划一致，否则命令拒绝执行；
2. 计费 provider **必须**同时具备 digest 与显式花费上限，否则拒绝执行。

`RUN_PAID_BENCHMARKS=1` 是授权开关；**仅有 API key 不构成授权**。

### 3.1 关于隔离强度（必须如实记录）

dry-run 报 `isolationStrength: "none"`、`promotionEligible: false`——本机没有强 OS
级隔离后端（如 Linux 上的 `bwrap`）。因此本次运行：

- 属于**测量运行**，**不是** promotion 级证据；
- 不得据此晋升 champion；
- 不要通过 `--allow-insecure-local-benchmark` 把它包装成 promotion 运行来「补齐」资格。

## 4. 停止条件

出现以下任一情况立即停止，不要重试到绿：

1. 实际消耗达到任一 `--max-*` 上限；
2. 出现 `failure_category: infrastructure` 或 `harness` 的系统性集中失败
   （说明是环境/框架问题，不是模型能力问题，此时结果不能作为能力基线）；
3. 出现 `security_violations > 0`（需先按安全问题处理，不得当作分数继续跑）；
4. `planDigest` 不匹配；
5. 用户撤回授权或预算。

## 5. 结果记录

运行后应写入 `docs/E4-R74-report.md` 或独立的基线结果文件，**逐项注明**：

- `testedSourceSha`（来自 manifest 的 `git` 字段）；
- 实际命令与退出码；
- `planDigest`；
- 真实 provider/model 与 `judgeVersion`；
- 指标：成功率、工具/验证失败数、模型调用数、token、耗时、权限违规数；
- **成本**：有计量来源才填数字；否则显式 `UNKNOWN`（**不得**虚构金额）；
- 失败用例的 `failure_category` 分布；

**stub 成绩与真实模型成绩必须分表**，不得混在一张表中比较。

## 6. 清理

- 本次运行的产物在 `--out` 指定目录内，只清理该目录；
- 不要删除 `benchmarks/<suite>/` 下的用例 fixture；
- 不要清理他人或其他进程的目录。
