# N7 证据目录说明 — `context_safe_tool_call_efficiency_v2`（预注册已冻结，未执行）

本目录是 N7 轮的证据目录。**本轮只做了语料、策略注册与预注册冻结；N7-4 的 campaign 按操作者决定不执行**，因此这里没有任何模型质量、效果或 promotion 结论。

## 文件

| 文件 | 内容 |
| --- | --- |
| `case-manifest.json` | 主实验 64 用例冻结清单（组成、内容摘要、verifier 摘要、参考修复、资格说明） |
| `holdout-case-manifest.json` | 独立 holdout 24 用例冻结清单 |
| `verifier-discrimination.json` / `.sha256` | 88/88 verifier 判别力证明（未修复失败、参考修复通过） |
| `main-preregistration.json` | 主实验预注册（512 logical arm runs） |
| `holdout-preregistration.json` | 独立 holdout 预注册（192 logical arm runs，对照=运行时解析的 champion） |
| `N7-PROGRESS.md` | 本轮进度、证据与如实记录（含基线对比与已知副作用） |

## 预注册要点

| 项目 | 主实验 | 独立 holdout |
| --- | --- | --- |
| 候选 | `context_safe_tool_call_efficiency_v2`，文本 SHA256 `52a80e9c…9333c` | 同左 |
| 对照臂 | `tool_call_efficiency_v1`，文本 SHA256 `ebddf5eb…9619` | 运行时解析的 champion（`docs/evolution/champion-state.json`，level=C0，candidateId=null，arm `ee589c7e…`） |
| 用例 | 64（缺失 48 + 控制 16） | 24（缺失 16 + 控制 8） |
| 重复 | 4 | 4 |
| logical arm runs | **512**（AB 128 / BA 128） | **192**（AB 48 / BA 48） |
| `preregistrationDigest` | `7c7d0b56ce6e22446fc7e1262dbb68b5310d3bd998eeb75c9f5b399c401f5b9b` | `967da1dd37a438cfdbc804c7cf7985fb9a787777c5c7e9bd801f211183055664` |
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

- **campaign 未执行**：按操作者决定，不做 N7-4（两个 512/192-run 实验，实测约 9–10 小时）。因此本目录不包含 raw request/tool event/usage，也不包含任何 judged 结果。
- **promotion 不可能在本机发生**：win32 无 OS 级写隔离后端，所有运行都是 `insecure-local`、`promotionEligible: false`；即使将来全部门限通过，也只能得到"效果已测、隔离资格不足"的结论，除非在强隔离（Linux）环境按同一预注册复跑。
- v1 候选 `context_safe_tool_call_efficiency_v1` 仍为 `candidate` / **NOT_PROVEN**，其文本与 digest 未被本轮修改，也不因本轮结果被追认。
