# N7-4 / N7-5 / N7-6 执行链补齐计划

2026-10-06（Asia/Shanghai）；审查基线 `d92d727689b9a2dc20bd09ea44348403f539def6`。用户要求补齐未执行部分。本计划是 [N7 不可变规格](plan(20261006-144930).md) 的工程执行补充，不改策略、语料、原预注册、verifier 或效果门限。任务合同见 [N7-EXECUTION-20261006.md](tasks/N7-EXECUTION-20261006.md)。

## 已复现的问题

- N6 runner 接收 N7 主预注册后拒绝 512 runs；接收 holdout 后仍安装 v1。
- N6 judge 固定 N6 数据与 v1 激活版本，不能直接判定 N7。
- 冻结源码 SHA 为 `a251af1…`，当前执行源码不同；不能照抄旧 SHA 来宣称身份一致。
- 本环境没有模型凭据，8317 端点不可达；bwrap 存在但实际 namespace 启动失败。
- 预注册 `pricingUnknownPolicy=refuse`，不能把未知价格当零费用。冻结预算包括 30 分钟 duration，执行时必须尊重，不能为了预计 9–10 小时的完整实验自动提高。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| E1 执行身份 | 绑定实际源码、构建和预注册 | 新增研究适配器，复用 N7 dry-run、ArmFactory、CLI 配置与 case fingerprint；保留原预注册，生成不可覆盖的执行绑定，含 clean HEAD、source/dist 文件摘要、完整 endpoint 摘要、请求/retry 配置、可执行价目、隔离自测与两个实验身份 | 未改动时可重算；旧 SHA、dirty tree、case/构建/端点/臂/价目漂移均在模型调用前拒绝；主实验 512、holdout 192，候选均 v2，对照实际解析 |
| E2 基础设施资格 | 24-call soak 与失败计量 | 同一真实 provider 接口进行 24 个独立 generate，保留逐调用 usage 与脱敏错误类别；计入成功前内部 retry 的失败；复用现有预算账本与 cost/tool budget；失败即停 | 0 transport failure、0 model_not_found、24 次完成且 usage 完整才通过；超时、错误事件、流中断、未知 usage 不可伪通过；真实模型未配置时零付费调用 |
| E3 成对执行 | N7 正式主/holdout 入口 | 复用 buildPairedPlan、runPairedExperiment、runOneCase、预算包装、原工具与 command verifier；执行前要求绑定 digest、付费开关、有效价目和本次 soak；安全边界走现有 Orchestrator/Permission/Sandbox | dry-run 精确 256/96 pairs、AB/BA 平衡；调用/重试/逻辑 arm 分计；所有预算维度和 deadline 不增；中断原件可归档，缺 pair 不可晋升；无强隔离必须显式 opt-in 且永久 promotion-ineligible |
| E4 判定 | 使用 N7 数据与 v2 字节证明判定 | 读取实际绑定的预注册与完整计划；按完整 case/repetition 网格做 ITT（无效/未完成视未通过）；per-protocol 仅佐证；保留 N6 冻结 bootstrap seed 20261005、10000 次、原质量/成本/安全门；额外检查 coverage、基础设施、usage 与激活 lineage | 重复/删除/额外 pair、v1 激活、只带版本无文本摘要、unknown-as-zero、partial 安全违规、transport 比例 ≥1%、完成率 <95% 均不能 all-gates；holdout 总体成功率不可下降 |
| E5 原件归档 | 可复核的结果与失败档案 | hash/bytes 递归索引 campaign、journal、soak、judge，命名空间区分；判定重新计算后归档；输出目录不可覆盖，拒绝 symlink/path escape；不自动修改 champion | 改原件/hash、错实验、错 identity、未判定和 forged verdict 拒绝；离线合成仅用于工程验收，明确 SYNTHETIC / modelQuality=NOT_RUN / promotion 不可用 |
| E6 工程验收及发布 | 将执行工具提交至 main | 新回归、localhost HTTP 故障注入、两实验完整 dry-run、typecheck、docs、相关集成/安全、全仓 pnpm test；更新进度与证据；原生非 force Git 推送及原生远端复核 | 测试与原件 SHA256 可复算；原 N6 脚本、N7 策略/语料/预注册字节不变；真实 soak/campaign/效果/promotion 未完成时明确 BLOCKED/NOT_RUN |

## 实施范围与执行顺序

先提交本计划，再写 `scripts/research/agent-next7-20261006/` 的研究适配器、`apps/cli/src/n7-execution-chain*.test.ts` 的回归，以及 docs/tasks。不修改生产 Runtime、权限、沙箱、工具、verifier、策略注册、依赖或旧测试。复用既有预算、隔离自测和统计算法。

工程测试使用本地 HTTP 夹具与 scripted provider，不能据此得出模型效果结论。24-call soak 是模型端点可用性资格，不证明 Agent 质量。补齐后分别记录“执行器已验收”和“真实实验已完成”；前者不使 N7-4 / N7-5 的实测自动变成 DONE。候选仍为 NOT_PROVEN，只有两实验、所有原门限、原件与强隔离资格齐备，才可进入既有 champion 流程。

状态更新记录于 [执行补齐记录](docs/evidence/agent-next7-20261006/execution/README.md)，本规格不事后改写。凭据仅从环境读取，不落盘，不使用 GitHub 连接器。
