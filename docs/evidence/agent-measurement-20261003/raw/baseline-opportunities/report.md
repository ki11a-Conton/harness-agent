# Agent 层独立实测：技能预算和效果归因

基线：`c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`。所有探针从已构建的生产 `createHarness` 导入，使用真实文件、真实 JSONL event/ledger、实际 `read_file` / `write_file` dispatch 和既有 `TaskVerifier`。离线确定性 ModelProvider 仅用于控制调用顺序；paid calls = 0，真实模型质量 = NOT_RUN。

## 实测反例

21 个本地技能：20 个无关天气技能按路径在前，相关 `zz-port-config` 在后。每个 body 约 4 KB。设置真实 8k context budget，3 个步骤（read、write、stop），3 次重复按 AB/BA 顺序对照默认 identity 和既有 `selectSkills(entries, hostGoal)` closure。宿主 goal 固定为 `repair port config`；原独立内容 checker 位于 agent 可写 workspace 外，实际验证 `config.cjs` 端口 8080。

|事实|默认|现有固定英文 goal selector|
|---|---:|---:|
|实际完整 turn/独立验证通过|3/3|3/3|
|模型请求总数|9|9|
|包含相关 body 的请求|0/9|9/9|
|每请求无关 body 数|4|0|
|每 turn 3 请求的 system 字节合计|56,277|15,720|
|每请求完整工具 schema 字节|7,400|7,400|
|每 turn ledger 总 `loadedCount` / `injectedCount`|63 / 63|3 / 3|

相关 body 每步都有 `context.dropped`，reason=`budget`；原目标和原 Verification 没有被改写，两臂实际行为结果相同。此测量证明选择和上下文工程事实，不证明真实模型收益。

系统字节减少 72.07%。默认三次本地总耗时 200.45/180.40/289.76 ms，对照 81.67/92.33/147.97 ms；这是本机观测，包括文件 I/O，不作为稳定性能阈值或统计显著性声明。

## 已确定的效果归因错误

默认相关技能完全未出现在三次实际模型请求中，ledger 却写入 `injectedCount=3`、`tokenCount=3030`、`completedCount=1`。21 个技能合计标记 63 次注入，但实际仅 12 个 body（4 × 3）出现在这些请求中。

原因在 `packages/harness/src/skill-context.ts:143` 至后续语句：body 加载阶段同时记 loaded、injected 和 tokens；发生在预算 admission 前。`packages/harness/src/create-harness.ts:497` 把全部 selected names 归为 turn used，随后在完成阶段记成功，未限制为实际 admitted names。既有 Core 能正确发出 budget drop，故不需要修改冻结 Core 来重排其逻辑。

## 既有 selector 的负例

实际 Harness 搭建长描述 `port-config` 技能，80 个额外 reference token，分别输入 `Use skill port-config` 和 `帮我使用 port-config 技能`。两例中，旧 Jaccard selector 因描述稀释低于固定 0.2 分数而剔除显式命名技能，真实模型请求中 index 和 body 均不存在。这不是纯中文 token 问题；纯英文也复现。

第三例 `Do the unspecified task` 没有相关 signal，旧 selector 也剔除全部技能。这个事实只能要求候选明确 unknown-goal fallback，不应直接假定全加载正确或错误。

## 建议落地及验收

1. 添加独立、默认关闭的 Harness / agent 层 goal-bound 技能选择 challenger：保留用户显式命名技能，支持 Unicode/CJK 匹配，约束 k 和 body 预算；未知目标保留可发现 metadata 的 fallback，不能靠固定英文 host goal 静默绑定后续会话。生产默认不凭离线结果切换。
2. 修正 loaded/selected 与实际 admitted/injected 的效果归因，在真实 admission 事件及实际 model request 上核对；预算丢弃、required-tools denial、secret/injection denial 不得算注入或成功使用。所有反馈写入仍须完整 await，不能增加终态之后后台写入；限制变更在 Harness / skills。
3. 候选复跑这个真实 8k 反例，要求目标 9/9 body admitted、无关 0、原工具和独立验证不变；显式命名英文和中文两负例必须保留；未知目标须测声明的 fallback。已被丢弃目标必须 injected/tokens/success 归因 0，实际被采用的 body 必须可逐请求匹配正确计数。
4. 所有 paired 实测保留 source/config/prompt/checker fingerprints 和完整原始事件。真实模型 trial 若没有 provider/key 或任务授权，必须报告 NOT_RUN；不得把离线成功率当作模型成功率或 promotion 依据。

文件：`skills-measurement.json`、六个 `*-events.json`、`selector-negatives.json`、两个可重跑 `.mjs`、原日志和 `artifact-index.json`。主 repo tracked 内容未改变。
