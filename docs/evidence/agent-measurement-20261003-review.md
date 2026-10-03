# 2026-10-03 实测优化独立审查

状态：实施中。此文件不是整轮验收通过声明。真实模型质量、付费调用和 promotion 均未执行；缺少模型凭据及费用配置时 M4 必须保留 BLOCKED。

审查基线为 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`。已读取 AGENTS.md、本轮实施前计划与任务，以及 context、evaluation、benchmark、verification 的有关契约。只读审查生产代码，独立小探针写入仓库外证据目录。

## 已核对的工程事实

- 100 技能探针的实际请求记录为默认 system 241032/241099 bytes，选择臂 3297/3364 bytes；平均 241065.5→3330.5，减少约 98.62%。两臂的工具 schema 都为 7400 bytes，用户目标保留。provider 是 scripted 模型，不能据此宣称真实模型成功率提高。
- 21 技能/8k 探针的默认臂相关正文 0/9，选择臂 9/9；每个默认 turn 三次请求只实际保留 12 次无关正文，但账本 injectedCount 合计为 63。未保留的目标技能仍记录 injectedCount=3、tokenCount=3030、completedCount=1。模型请求和 context.selected/context.dropped 支持这些断言。独立内容 checker 两臂均通过，不能据此证明策略带来模型质量收益。
- 原 selectSkills 在长 description 下丢失英文/中文明确技能名称，在 unknown 任务下全部排除。新策略的兼容范围必须是新增 opt-in API；旧 API 本身保持兼容。

原始证据目前位于 `/workspace/harness-agent/.ci/agent-measurement-20261003/skill-context` 与 `opportunities`。交付前须复制为可移植证据并校验哈希，不能只留下机器绝对路径。

## 实施回归审查清单

| 范围 | 必须核对的行为 | 当前审查状态 |
| --- | --- | --- |
| M1 admission | 以最终 built.blocks 的真实正文/token 为准；预算、安全、required-tools、空正文拒绝不产生注入/成功反馈；protected overflow 和 hook 前观察到的取消不调用 admission hook | 代码审查及针对性回归通过 |
| M1 隔离 | session 与 turn 共同绑定使用集合；多 step 注入逐次计量，turn outcome 一次；迟到旧 turn 不污染新 turn | 使用 session→Map(turnId, Set)；对应回归通过 |
| M1 持久化 | 共享 ledger 的首次读取和完整写入串行，错误反馈不丢失，持久化结果与内存一致 | 独立真实 FS 并发探针候选 20/20 完整 |
| M2 默认兼容 | 新候选默认关闭，旧 selectSkills API/工具 schema/Verification 不变，只从安全索引及可信 host task 选择 | 源码审查、实际 Harness 请求及新旧 selector 回归通过；CLI 局部验收待完成 |
| M2 选择 | 中文/英文明确名称与 host requiredNames 不被 top-k 裁掉；稳定排序；unknown/no-overlap 回落；名称边界不误匹配；并发任务互不借用目标 | 新策略代码及实际请求符合要求；独立 unknown+required 负例已变绿 |
| M3 身份 | retry/delay/timeout 的解析、dry-run digest、execution identity 与实际 provider client 一致；旧 digest 拒绝时实际 HTTP=0 | 代码审查通过，53 个有关测试通过 |
| M3 实际请求 | 本地 HTTP 503 反例与环境事后变化证明冻结值生效；generate cap、物理请求数与美元预算分别报告 | 原始 manifest 的 6 checks 通过；三种预算没有混称 |
| Pilot checker | 固定输入、不可写 host argv checker、导入前后非目标 hash、冻结 assert、完整 proof，以及对应实际 negative receipts | 独立核对 43 个固定文件和 20 个原始 receipts 通过 |
| M4/M5 证据 | live/engineering 分开，受测 SHA 与文档 SHA 分开；未完成项保留；完整验收与远端 main 核验独立保留 | 待根代理执行 |

## 当前代码初审

M1 把反馈从 load 移到 awaited admission hook，在 protected overflow 判断后执行，并在 hook 前观察到取消时跳过；这一接缝对应已复现的确定性统计错误，符合 Runtime freeze 的例外条件。指标是一个成功上下文构建的最终 admission，不是物理 provider 调用次数；反馈期间取消也会完整等待已开始的 host 写入。加载集与最终 blocks 交集决定反馈，原技能安全、required-tools、实际 body hash 和 Verification 接缝保留。

独立 cold ledger 探针以真实文件系统、同名 100 次并发 injected 反馈运行 20 轮：原基线 6 轮仅保留 93/97/98/99 次反馈；候选内存与重新读取的持久化内容均为 100，20 轮完整。候选源文件 `skill-context.ts` SHA-256 为 `feeede6c3430ee53154aad9fae2f526a096e119aa56d729bd1cf2d0e3d9627f6`。证据是一次共享 ledger 实例的进程内并发，不证明跨进程 CAS 或 crash 原子写。

M3 使用同一数字参数解析器供计划和客户端，三项数字复制后冻结；effectiveModelParams 同时进入执行计划和 paired execution identity。wrapper 使真实 client 使用计划参数，避免后来环境或显式 client 配置改写已确认的策略。不相关 provider 无该参数，旧 OpenAI 显式覆盖/默认解析行为保留。实际 HTTP 证据记录 retries=0 的一次失败、retries=2 的三次请求成功、冻结 timeout 生效，paid calls 都是 0。

截至本段审查，M1/M2/M3 生产实现及 Pilot checker 未发现剩余阻塞；M2 CLI 局部验收及全仓冻结 SHA 验收仍待完成。

## Pilot checker 独立核对

已逐字节核对当前生成器与准备目录的 43 个 case/request/expected/fixture 文件，固定输入 digest 为 `7742d338bcdcbd65864f36b320e1cc4013d8e1204f1c53656216c1d777ca91a2`。20 个 receipt 的原始文件 SHA-256、实际退出状态、checker argv SHA-256 全部与报告及当前 checker 一致：3 个正确修复 exit 0；17 个破损原始代码、非目标/规则篡改、模块执行期间篡改、assert monkeypatch、提前退出反例 exit 1，无 signal 或基础设施异常。

checker 在宿主中通过固定 argv 运行，不在 agent 可写工作区内；目标模块执行前后核验所有原非目标文件，子进程先冻结 assert 对象再 import，并要求完整 proof 输出。README 准确限定这些是常见绕过反例覆盖，不是任意恶意 JavaScript 的完整安全隔离。三个探索 pilot 各一案例、两次重复，只能用于后续真实模型探索；准备成功与付费模型质量仍是分开的事实。

## 选择负例与修复核对

独立审查发现初版 M2 在 unknown goal 加 host requiredSkillNames 时，只保留 required 技能并排除原其他技能。host 全局要求不能作为任务相关性信号，这违反 unknown/no-overlap 回落完整索引的验收要求。实现者已把相关信号与必需保留集合分开，并增加纯函数及实际 Harness 组合回归。独立使用修复后 dist 复测：`quantum entanglement experiment` + `requiredSkillNames=['global-policy']` 保留 compiler/weather/global-policy 三行、excluded 为空、reason 为 unknown-fallback，该项关闭。

新策略另加入中文无空格句子中的 Latin 名称、UI/db/go 短技能名与长 description/top-k 压力回归；冻结策略数字及 required 名称数组，真实 task 输入按当前 session/turn 的 authoritative user 消息取值。并发不同 task 和实际 SessionActor steering 已覆盖。普通未知任务的完整索引回落是有意兼容行为，不能宣称这种任务也减少提示。

新候选自身的同源码 AB/BA 工程探针平均 system 为 241365.5→3333.5 bytes，减少约 98.62%；两个 arm 的工具 schema 同为 7400 bytes、用户目标保留。报告的五份生产源文件 hash 与独立审查时的当前代码全部一致。这个新候选测量与本文件前述 c31 原基线/旧 selector 测量分开记录，仍是 scripted provider 的工程结果。
