# N7 证据目录说明 — `context_safe_tool_call_efficiency_v2`（主实验已实测：NOT_PROVEN）

本目录是 N7 轮的证据目录。语料、策略注册与预注册保持冻结；工程执行链已补齐（**55 项新增回归、8967 项全仓测试通过（0 失败，12 项旧 skip）**，见 [完成报告](execution/acceptance/COMPLETION.md)）。**主实验已于 2026-10-07 真实付费执行**：512/512 arms 跑完、9,171 次模型调用、255/256 pairs 定案，判定 `NOT_PROVEN`（基础设施未合格：1 个作废 arm + 对账门限失败；同时描述性 missing 组提升 0.00 pp、token +14.7%）。独立 holdout 未执行，联合判定未执行，**无 promotion、无模型质量推断结论**。结果与六处测量缺陷（D1–D6）见 [N7-RESULT-20261007.md](N7-RESULT-20261007.md)（其中 D1/D2/D3 的原始写法已被 2026-10-07 复核部分推翻，见 [N7-ERRATA-20261007.md](N7-ERRATA-20261007.md)），原始判定与原件见 [execution/main/](execution/main/judge-result.json)。

## 文件

| 文件 | 内容 |
| --- | --- |
| `case-manifest.json` | 主实验 64 用例冻结清单（组成、内容摘要、verifier 摘要、参考修复、资格说明） |
| `holdout-case-manifest.json` | 独立 holdout 24 用例冻结清单 |
| `verifier-discrimination.json` / `.sha256` | 88/88 verifier 判别力证明（未修复失败、参考修复通过） |
| `main-preregistration.json` | 主实验预注册（512 logical arm runs） |
| `holdout-preregistration.json` | 独立 holdout 预注册（192 logical arm runs，对照=运行时解析的 champion） |
| `N7-PROGRESS.md` | 本轮进度、证据与如实记录（含基线对比与已知副作用） |
| `N7-RESULT-20261007.md` | **真实主实验结果记录**：NOT_PROVEN 结论、13 条门限全表、六处测量缺陷（D1–D6，含 2026-10-07 复核修正）、未执行与未声称清单 |
| `N7-ERRATA-20261007.md` | 2026-10-07 独立复核勘误：统计口径、计量缺口归因、D1 执行条件误读、越界判定与安全记录错标；附机器重算结果 [`n7-summary-corrections.json`](../source-audit-round2-20261007/n7-summary-corrections.json) |
| `aborted-runs/summary.json` | 三次基础设施失败运行的已提交记录（含 run3 的作废 arm 归因与计费口径），均排除于推断之外 |
| `execution/README.md` | 独立 N7 prepare/soak/campaign/judge/联合判定/归档入口与运行条件 |
| `execution/main/` | **run3 主实验的判定与原件**：`judge-result.json`（NOT_PROVEN）、`campaign-result.json`、`pairs-summary.json`、binding/identity/header/soak 与 `RAW-MANIFEST.json`、`artifact-index.json` |
| `execution/acceptance/` | 工程完成报告、完整压缩测试原件、source/dist/binding 指纹、冻结原件和 skip 来源、SHA256 索引 |

## 预注册要点

| 项目 | 主实验 | 独立 holdout |
| --- | --- | --- |
| 候选 | `context_safe_tool_call_efficiency_v2`，文本 SHA256 `52a80e9c…9333c` | 同左 |
| 对照臂 | `tool_call_efficiency_v1`，文本 SHA256 `ebddf5eb…9619` | 运行时解析的 champion（`docs/evolution/champion-state.json`，level=C0，candidateId=null，arm `00d2c921…`） |
| 用例 | 64（缺失 48 + 控制 16） | 24（缺失 16 + 控制 8） |
| 重复 | 4 | 4 |
| logical arm runs | **512**（AB 128 / BA 128） | **192**（AB 48 / BA 48） |
| `preregistrationDigest` | `d824d5938e45bf5962b476e76fbfc0ce7f4264475d1c8d9d8afd6907f1330b2c` | `6ef59a6cc2a5687608d25bf182d07aef160f2f4996ac63e4857eeadf122a8258` |
| 用例集摘要 | `03a77f3f…08fa1` | `7e8e42fd…b2a28` |
| 冻结 seed（orderSeed） | 20261007 | 20261008 |
| provider / model | `openai` / `workbuddy-deepseek-v4.1-flash`（端点仅以摘要入库，凭据不落盘） | 同左 |
| 预算 | 每 run ≤30 模型调用；硬上限 $100,000（`maxUsdMicros=100000000000`） | 同左 |
| 门限 | 与 N6 **逐值相同**（8 条，未放宽） | 同左 |
| dry-run | 512 runs、`paidProviderCalls=0`、`modelQuality=NOT_RUN`、`promotion=NOT_RUN` | 192 runs、同样 0 与 NOT_RUN |

主实验与 holdout 的 `preregistrationDigest` 不同、用例集摘要不同、调度摘要不同：两个实验互相独立，互不借用身份。

## 数字口径（如实说明）

N7 计划文本写作"每实验 512 runs"。算术上 512 = 2 × 64 × 4，是**主实验（64 用例）**的数字；独立 holdout 的语料是它自己冻结的 24 用例，因此是 2 × 24 × 4 = **192**。本轮**没有**把 holdout 的重复次数抬高去凑"512"这个口号数字，两个数字都在代码与产物中显式冻结（`CONTEXT_SAFE_V2_LOGICAL_RUNS_PER_EXPERIMENT=512`、`CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS=192`）。

## 未执行与资格限制

- **主实验已实测、独立 holdout 未执行**：主实验 512/512 arms 跑完（9,171 次调用、255/256 pairs），因基础设施未合格判 `NOT_PROVEN`；holdout 未跑，故联合判定未执行。**没有**任何模型质量或成本的推断性结论；合成的 localhost 证据始终不作为模型证据。
- **当前隔离不具备 promotion 资格**：Windows 本机无 OS 级写隔离后端（`win32-none`），实测一律 `insecure-local`、`promotionEligible=false`。只有实际强隔离自测合格、两个真实实验与工程门全部通过后，才可进入既有 champion 流程；显式 insecure-local 实测永久不具备资格。
- **预算修订只发生在结果之前**：duration（30 分钟 → 12 小时）与四个容量维度（工具 600 → 32,000 等）的两次修订都发生在**看到任何效果数字之前**（campaign #1 中断、campaign #2 撞顶），门限/用例/臂/重复/seed 全程未改；run3 的声明上界计费 9,169,000,000 µ$ 对硬上限 100,000,000,000 µ$（9.2%）。
- v1 候选 `context_safe_tool_call_efficiency_v1` 仍为 `candidate` / **NOT_PROVEN**，其文本与 digest 未被本轮修改，也不因本轮结果被追认。

> **P 轮重新冻结（2026-10-06）**：登记 `verified_completion_gate_v1` 后，baseline 臂快照（枚举全部已注册候选为 OFF）使 champion 解析出的对照臂摘要移动，故 holdout 预注册按本轮冻结脚本重新冻结：`preregistrationDigest` `967da1dd…5664` → `7b675621…7321`，对照臂 `ee589c7e…` → `00d2c921…`；**24 用例 / 192 runs / 门限 / provider / 预算 / provenance 均不变**，且重新冻结发生在任何 N7 模型结果之前（paid calls = 0）。验收记录（`holdout-prereg.log`、`unchanged-originals.json`、`artifact-index.json`、`RAW-MANIFEST.json`）已同步更新并重新自校验通过。

> **N7 预算修订（2026-10-07）**：实测吞吐约 0.83 分钟/arm，512 arms 需约 7.1 小时，故按操作者批准**只把 `budget.maxDurationMs` 由 30 分钟改为 12 小时**（门限／用例／臂／重复／seed／provider／token·工具·USD 上限均未改），两件预注册重新冻结：主 `7c7d0b56…` → `3aef9df0…`、holdout `7b675621…` → `49fea730…`。修订发生在一次基础设施中断、未做效果判定的运行之后；该运行标记 infrastructure-failed、不用于推断。详见 [BUDGET-AMENDMENT.md](BUDGET-AMENDMENT.md)。

> **N7 容量上限修订（修订 #2，2026-10-07）**：campaign #2 跑满 512/512 arms 但 `INFRASTRUCTURE_FAILED, 36/256 pairs` —— `maxToolCalls` 600、`maxInputTokens` 3,000,000 在约 72 arms 处即撞顶，之后每个 arm 被预算拒绝（`TOOL_BUDGET_EXHAUSTED` / `model_error`）而判 `invalid-arm`。按批准只放大四个容量维度（工具 32,000／输入 80,000,000／输出 4,000,000／总量 90,000,000），门限与设计全部不变；两件预注册重新冻结：主 `3aef9df0…` → `d824d593…`、holdout `49fea730…` → `6ef59a6c…`。详见 [BUDGET-AMENDMENT.md](BUDGET-AMENDMENT.md)。
