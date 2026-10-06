# N7 执行链补齐

实施基线 `d92d727689b9a2dc20bd09ea44348403f539def6`；先冻结 [执行补齐计划](../../../../plan(20261006-n7-execution-chain).md)，提交 `c09ea10`。本目录记录工程验收，原 N7 预注册保持原字节；真实模型效果仍为 **NOT_RUN**，候选未晋升。

## 使用入口

所有命令在仓库根目录执行。先提交改动，使源码 clean；构建、端点、模型、价目、隔离模式变化后必须重新绑定，使用新的输出目录。输出目录不可覆盖。

```bash
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --experiment main --dry --out .ci/n7/main-dry
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --experiment holdout --dry --out .ci/n7/holdout-dry
node scripts/research/agent-next7-20261006/prepare-n7-execution.mjs --out .ci/n7/execution-binding
```

前两条分别校验 **512 logical runs / 256 pairs**、**192 / 96**，两者均安装 v2；holdout 对照从冻结 champion provenance 解析。dry-run 为 0 模型调用，不生成可用作真实 qualification 的 soak。

`prepare` 强制重建 dist，再记录 clean HEAD、source/dist 全部文件摘要、原预注册摘要、实际两臂与 case 指纹、完整端点路径摘要、请求/retry 配置、价目和实际隔离自测。原预注册绑定的 `a251af1…` 作为 lineage 保留；执行 identity 使用实际源码 SHA，不冒充旧 SHA。该执行绑定是新确认对象，其 digest 在调用任何模型前冻结。

模型凭据只通过 `OPENAI_API_KEY` 设置；端点和模型使用原冻结配置（`OPENAI_BASE_URL` / `OPENAI_MODEL`）。`PREREG_PRICING_JSON` 使用仓库既有 `prereg-pricing-v2`、USD、有效起止时间、覆盖 64000 tokens 的每次调用上界；缺价目遵守原 `pricingUnknownPolicy=refuse`。准备步骤允许在缺少凭据/价目/隔离时生成 **blocked** 诊断，补齐环境后需重新 prepare。不能把 GitHub token 当模型凭据。

强隔离默认由实际 capability self-test 判断；仅有 bwrap 命令或 Linux 平台不足以合格。若明确选择本地研究模式，在 prepare、soak、campaign 的命令上都加 `--allow-insecure-local-benchmark`，绑定即为 `insecure-local`，永久 promotion-ineligible。

环境就绪后，将 prepare 输出的 digest 填入下方 `DIGEST`（非凭据），并使用既有 `RUN_PAID_BENCHMARKS=1` 开关：

```bash
node scripts/research/agent-next7-20261006/n7-soak.mjs --binding .ci/n7/execution-binding/execution-binding.json --plan-digest DIGEST --out .ci/n7/soak
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --experiment main --binding .ci/n7/execution-binding/execution-binding.json --plan-digest DIGEST --soak .ci/n7/soak --out .ci/n7/main
node scripts/research/agent-next7-20261006/n7-paired-campaign.mjs --experiment holdout --binding .ci/n7/execution-binding/execution-binding.json --plan-digest DIGEST --soak .ci/n7/soak --out .ci/n7/holdout
node scripts/research/agent-next7-20261006/n7-judge.mjs --experiment main --campaign .ci/n7/main --out .ci/n7/main-judge
node scripts/research/agent-next7-20261006/archive-n7-evidence.mjs --experiment main --campaign .ci/n7/main --judge .ci/n7/main-judge --out docs/evidence/agent-next7-20261006/execution/main
node scripts/research/agent-next7-20261006/verify-n7-archive.mjs --experiment main --campaign .ci/n7/main --judge .ci/n7/main-judge --archive docs/evidence/agent-next7-20261006/execution/main
```

holdout 判定/归档/复核同样使用 `--experiment holdout` 和对应路径。judge 的非零 exit 可表示 NOT_PROVEN；失败结果可按原件归档，不能晋升。`--resume` 复用同一 campaign 输出目录、执行 identity、ledger 和 deadline，保留旧 attempt 原件；outstanding/unknown dispatch 必须先人工对账，不能自动退款、重发或续预算。新源码、端点、预算不能复用旧确认。

## 预算与判定

复用 `CostBudget`、R97 ledger、formal provider、durable tool budget 和真实 Harness。逻辑 arm、generate、物理 retry 分计；成功前的 retry 同样算故障。冻结的 token、tool、USD 和 duration 上界全部执行，不自动提高。原预算 duration 是 **1800000 ms（30 分钟）**，工具总额 600；这不是完整 9–10 小时实验的承诺。若实测需要不同预算，须在结果前显式重新预注册，不能通过 deadline 参数偷延长。

ITT 使用所有冻结 case/repetition；未完成和无效 arm 视失败，PP 与实际消息中的行可见性 probe 仅佐证，无法观察到 bite 时标 NOT_OBSERVED。效果门沿用 N6，bootstrap 保留原 N6 seed `20261005`、10000 次，orderSeed 仍为各自冻结的 20261007 / 20261008。完整网格、原件身份、两臂 usage/计数与 durable budget 均需匹配；缺激活字节证明、未知 usage、partial 安全违规、网络故障比例 ≥1% 或完成率 <95% 均阻止 all-gates。

归档不会改 champion。`RAW-MANIFEST.json` 给出带 campaign/judge 命名空间的 hash/bytes，原始大文件保留在本地 raw 根目录；需要移交时应连同这两个目录保存，单独摘要索引无法恢复原始字节。

## 验收状态

工程实现与真实实验分别记录；本地 HTTP 和合成 outcome 仅证明接线、计量及失败门，不证明 Agent 质量。最终验收数字与环境阻塞详见本目录的完成报告。
