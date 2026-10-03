# 源码对照优化：实施与验收证据

状态：**草案，等待最终冻结快照验收**。本文整理已经执行的基线反例和定向回归。R2 的 steering 原 turn 绑定后、append 前崩溃恢复窗口及 R3 编码输出安全已完成独立局部审查。干净工作树的完整 typecheck/build/security/full suite、新 SHA 的 Windows CI 与远端发布证据均待补充。

执行依据为 [plan.md](../../plan.md) 与 [SOURCE-OPT-20261002](../../tasks/SOURCE-OPT-20261002.md)。源码研究和实施验收分开保存：[原研究证据](source-agent-review-20261002.json) 保持原样，本轮记录见 [验收 JSON 草案](source-optimization-20261002.json)。

## 快照与证据口径

- 合集固定在 `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`；五个项目家族的源码取舍见 [研究报告](../research/source-agent-review-20261002.md)。不将合集 SHA 当作各上游仓库的独立 commit。
- 实现基线为 `acf8dcc394de6c6efefed52602e49014b372f372`。RED 工作树固定在仅增加研究材料的 `6f03bb25ffab0791e292bd888899f925c3d4320a`，生产代码未改变；新增测试作为未跟踪 fixture 放入该工作树。
- 本轮已有代码提交：R1 `dd84bb4763b66d74a6071973828c0a1efb21d1a6`，R3b `b033e6aedbc5b32f1b77b40c849b8ddcb4edaa40`，R4 `9ff841a8f26646d867418c4298b017ea063c3fbe`。R2/R3a/R5/R6 集成为 `caaf566`，S1/S2 策略为 `9700b57`；并发恢复补修为 `78321b7`。定向日志中的 HEAD 与 source SHA 描述当时的工作树，不能代替最终候选 SHA。
- 已执行环境是 Linux x86_64、Node `v24.19.0`、Vitest `4.1.10`。早期包日志使用 pnpm `11.19.0`，后期复查使用 corepack pnpm `11.21.0`；各包原 manifest 保留真实版本。
- [便携证据索引](source-optimization-20261002/index.json) 记录所选文件的原始路径、复制前 SHA-256、复制后 SHA-256 与字节数。文件逐字节复制，未裁剪失败栈或改写退出码。历史 manifest 中没有复制的相对日志路径仍指向其记录的原 evidence root。
- 测试次数有重叠，不将多轮绿色结果相加宣称覆盖量。collection/type 错误、无效 barrier 与 dirty-tree promotion 失败不能作为行为缺陷或模型收益证据。

## R1–R6：确定性维护

| 工作包 | 最终做法与边界 | 已执行结果 | 原始证据 |
| --- | --- | --- | --- |
| R1 | OpenAI-compatible provider 只将显式 `stop` / `tool_calls` 作为正常结束；保留异常部分响应用于审计，经现有 Core error 接缝结算未执行调用。仅 DONE、EOF、length/filter/未知 reason 不派发工具、不完成 Verification。 | unchanged baseline 30 项：26 FAIL、4 PASS；候选 7 文件 / 139 PASS；model 与 focused Core 类型检查通过。 | [manifest](source-optimization-20261002/r1/result.json)、[RED](source-optimization-20261002/r1/red-baseline-final.log)、[GREEN](source-optimization-20261002/r1/green-targeted-final.log) |
| R2 | 原始 user/steer 由 durable turn 身份派生，保留原文、顺序、用户信道；普通/reactive 裁剪与真实 checkpoint 恢复使用同一保护集合。恢复前先在 original turn 结算已绑定未 append 的 steering，再拼新 turn 的 user channel 恢复输入；不 rebind，ordinary fresh task 不继承旧绑定。无法容纳时显式失败，工具伪 steering 不获得权威。 | 最终正式 fixture 22 项中的新增 5 项：baseline 4 FAIL、1 PASS、17 filtered SKIP；修补前候选 3 FAIL、2 PASS、17 SKIP，同 fixture SHA。最终 related 8 文件 / 108 PASS，包含全部 22 项 active-user 回归；Core 类型检查通过，独立恢复复查关闭。此前 11/15/17 项 fixture 和组合 GREEN 作为历史保留。 | [独立最终 manifest](source-optimization-20261002/r2/independent-bound-before-append/integration-review-manifest.json)、[正式 baseline RED](source-optimization-20261002/r2/independent-bound-before-append/formal-baseline-red.log)、[修补前候选 RED](source-optimization-20261002/r2/independent-bound-before-append/formal-candidate-red.log)、[最终 GREEN](source-optimization-20261002/r2/independent-bound-before-append/final-targeted-green.log) |
| R3a | 实际模型文本的安全处理与预算开关分离，原 ToolResult 保持原结构。编码字符串、重复 JSON key、失败前缀、敏感字段、原始数值 lexeme 与 artifact 预置 symlink 反例已覆盖；按字符串 token 局部重写、不可映射的自定义 hook 改写拒绝输出，artifact 排他创建。 | 最终同 fixture 36 项 baseline：34 FAIL、2 PASS；候选 4 文件 / 85 PASS，其中独立 fixture 36 项。12 项真实 Controller probes 全 PASS，Core 类型检查通过，独立局部审查关闭。之前 28/30/32/34 项候选缺陷分开保留，81 PASS 属历史结果。 | [独立最终 manifest](source-optimization-20261002/r3/encoded-independent-review-manifest.json)、[最终 RED](source-optimization-20261002/r3/encoded-independent-frozen-baseline-red.log)、[最终 GREEN](source-optimization-20261002/r3/encoded-independent-frozen-candidate-green.log)、[真实 Controller probes](source-optimization-20261002/r3/encoded-independent-controller-probes.json) |
| R3b | StringDecoder 增量解码 stdout/stderr；每流捕获主体按 UTF-8 bytes 限制，超过 cap 继续 drain/observer。Orchestrator 字符串主体 cap 与附加 marker 分开，结构化结果不改形状。 | 同 fixture baseline 34 项：26 FAIL、8 PASS；候选 14 文件 / 315 PASS、10 SKIP；tools 类型检查通过。10 项跳过不作为 Windows 执行证据。 | [边界说明](source-optimization-20261002/r3/r3-evidence.json)、[RED](source-optimization-20261002/r3/r3b-red.log)、[GREEN](source-optimization-20261002/r3/r3b-green.log) |
| R4 | 规范路径与可用 dev/ino 协作锁覆盖 read→edit/write 和 transaction；等待后重新解析 inode。opt-in versioned read / expectedSha256 / strict profile；原始 UTF-8 bytes、BOM/EOL/EOF 保留。保证限于进程内协作，不承诺外部编辑器的原子 CAS。 | 有效 barrier baseline 17 项：14 FAIL、3 PASS；候选新增至 41 项，相关 8 文件 / 176 PASS；Core/tools/harness 类型检查与 scoped diff check 通过。候选新增 24 项是补充绿色覆盖。 | [独立复查 manifest](source-optimization-20261002/r4/review-manifest.json)、[有效 RED](source-optimization-20261002/r4/review-red-baseline.log)、[GREEN](source-optimization-20261002/r4/review-green-targeted.log) |
| R5 | 去掉无版本的外层永久索引/正文缓存，按文件身份/revision/配置更新，变动子树才 readdir；普通 load 刷新，step 内 loadSnapshot 拒绝过期记录。实际注入正文与拒绝/预算丢弃反映在 step 身份中。 | 早期 baseline 9 项中筛选 2 FAIL、7 SKIP；最终 20 个新 regression PASS；skills/harness 10 文件 / 97 PASS，安全组合 6 文件 / 49 PASS；harness 类型检查通过。baseline 仍是早期 9 项 fixture。 | [manifest](source-optimization-20261002/r5/manifest.json)、[RED](source-optimization-20261002/r5/baseline-body-delete.log)、[新回归 GREEN](source-optimization-20261002/r5/green-production-final.log)、[相关回归](source-optimization-20261002/r5/green-skills-harness.log) |
| R6 | budget 起点包含只读 memory prefetch；signal/deadline、软 timeout、每 Runtime 一个真实在途槽与迟到隔离。实际 Harness 检索关闭反馈写入；只有当前 turn 接纳后才完整 await retrieved/injected 反馈，再进入终态/fence。 | 初版 baseline 10 项全部 FAIL；候选扩为 15 Core + 4 生产组合 regression，memory 3 文件 / 26 PASS，相关 6 文件 / 52 PASS；Core/tools/harness 类型检查通过。新增生产组合曾复现中间候选迟到反馈写入，并已修复。 | [独立复查 manifest](source-optimization-20261002/r6/review-manifest.json)、[RED](source-optimization-20261002/r6/review-red-baseline.log)、[生产组合 GREEN](source-optimization-20261002/r6/review-memory-targeted.log)、[既有回归](source-optimization-20261002/r6/review-existing.log) |

R3b 持久占用按每流 cap 有界，decoder 另有最多 3 个待完成 UTF-8 bytes；当前 chunk 的临时解码文本仍按 chunk 大小分配。Context 的 `maxInlineBytes` 是 artifact 阈值，头尾预览各最多 2000 UTF-8 bytes，引用/marker 是额外开销；完整序列化、脱敏与扫描仍需要完整可捕获的模型文本。

R3a 最终 independent fixture SHA 为 `5948c313841c00dc955a4da4d2a7a822fe7d6774bfd7548e34100f4348f1d405`。baseline 的预置 hashed-name symlink 控制因旧实现用原 ID 文件名而通过；它针对中间候选缺陷，不能冒称基线也失败。启用预算时的 numeric custom hook 控制也在旧实现通过，未启用预算时失败。Artifact 根目录仍是受信 host storage；最终文件排他创建不代表跨进程父目录替换的完整 confinement 证明。脱敏计数涵盖编码/解码多个视图，不等于独立原文出现次数。

R6 的被放弃准备回调必须只读，Runtime 无法阻止违反该合同的外部 host 自身副作用。真实反馈写入保持完整 await，可能延迟取消；不能将写入当作只读任务提前结算。

R2 串行恢复阶段 fixture SHA 为 `788896831c87034bbace526ba84ab6919b3d96139aa0425d2ec2ea97d7f909b6`。正式 RED 命令仅执行新增 5 项、过滤先前 17 项，不宣称全部 22 项都在 baseline 失败。该次独立集成复查另保留 R5/R6 的 3 文件 / 39 PASS 窄回归，见同目录 [日志](source-optimization-20261002/r2/independent-bound-before-append/r5-r6-green.log)。

## S1/S2：独立实验策略

两项通过现有 CandidateRegistry、ArmFactory、实际 Harness/model request、activation 与 paired engine 接线，均为独立 experimental 候选，默认关闭。固定脚本 provider 证明离线工程合同；它不证明真实模型改善。

| 策略 | 实际实现和内容验收 | 已执行离线结果 | 身份与证据 |
| --- | --- | --- | --- |
| S1 `diagnostic_first_repair_v1` | versioned completionGuidance 要求用 bounded capture wrapper 取得原命令真实 exit/stdout/stderr，按诊断修复，再跑同一命令；原 TaskVerifier 与独立内容 verifier 保持。wrapper 成功不等于原测试成功，诊断仍是脱敏 untrusted data。 | 同 fixture baseline 10 FAIL；S1 10 + 当时结构安全 26 = 36 PASS；相关 mechanism/paired 9 文件 / 95 PASS。真实 `runPairedExperiment`：2 cases × 2 repetitions，4 finalized pairs、8 logical runs、36 model attempts；AB/BA 各 2，无 partial pair。 | [结果 manifest](source-optimization-20261002/s1/final-result-manifest.json)、[机制身份](source-optimization-20261002/s1/mechanism-identity.json)、[RED](source-optimization-20261002/s1/red-baseline-latest.log)、[GREEN](source-optimization-20261002/s1/green-final.log) |
| S2 `path_scoped_instructions_v1` | opt-in InstructionDiscovery 从固定 workspace root、host initialTargets 与实际成功获准 read/search 的 durable evidence 派生范围；按 ancestor 顺序和 cwd 优先级读文档，缺中间层继续；无兄弟 subtree scan。AsyncLocalStorage 隔离并发 session，已有 step source/snapshot 合同保持，默认 discovery 不变。 | 同 fixture context/harness baseline 26 FAIL、3 PASS；CLI 6 FAIL、1 PASS；eligibility 2 FAIL、1 PASS。最后 4 文件 / 39 PASS；相关默认/step 回归 15 文件 / 215 PASS。paired：1 case × 2 repetitions，2 pairs、4 logical runs、28 model attempts，AB/BA 各 1，无 partial pair。并发 3 sessions / 6 requests 绑定各自 source；无文档时 activation 0。 | [结果与独立审计](source-optimization-20261002/s2/evidence.json)、[context/harness RED](source-optimization-20261002/s2/baseline-red.log)、[CLI RED](source-optimization-20261002/s2/cli-baseline-red.log)、[最后 GREEN](source-optimization-20261002/s2/candidate-final-green.log) |

S1 记录 actual prompt/config/mechanism/schema digest，S2 记录 config、case、verifier、schedule 与 activation 身份。离线 paired executor 的 sourceSha/treeFingerprint 字段为 null，执行时的未提交源文件另有 SHA 指纹；isolation 为显式 `insecure-local` fixture，promotionEligible 为 false。这些材料不能作为 promotion-grade 的完整冻结身份。

S2 的候选 instruction discovery 在 retained paired observation 中为 0 subtree listings，但整个 benchmark 每臂另有 5 次既有行为的目录列表，不能把前者描述成全程序零扫描。token、bytes 或请求数降低也不能代替独立内容验收。

大体积 offline/paired JSON 未全部提交；原始字节 SHA 与概要保留在各 manifest 及本轮 JSON 的 externalArtifacts 中。所选小日志与 fixture 源码可以独立复查，缺失完整请求的 summary artifact 不提供其未保留内容的重新计算能力。

## 最终验收待补

| 验收项 | 本草案状态 | 补证要求 |
| --- | --- | --- |
| R2 原 turn 绑定、append 前崩溃恢复 | PASS_TARGETED | 已保留正式反例 RED/GREEN、turn/inbox/wire 回归与源指纹；后续完整冻结验收仍待补 |
| R3 独立编码输出/Artifact 安全复查 | PASS_TARGETED | 已保留最终同 fixture RED/GREEN、production/source SHA 与独立关闭结论；后续完整冻结验收仍待补 |
| 冻结实现 SHA、clean tree | PENDING | 提交所有生产代码，在无并发 tracked edits 的独立工作树冻结 |
| `corepack pnpm typecheck` / `build` | PENDING | 完整命令、环境、退出码、原始日志、受测 SHA |
| `corepack pnpm test:security` / 全量 `test` | PENDING | 完整计数、skip 解释与原始日志；Linux 使用既有 subreaper，不能借用先前轮次全量结果 |
| 新候选 Windows CI | NOT_RUN | 实际 workflow/run/job URL、受测 SHA、Windows 退出码和结果 |
| 远端 main 发布 | PENDING | 原生终端 Git 实际 push 输出和远端 ref；先前 `acf8dcc` 发布不能代替本轮 |
| 真实模型质量 / 付费实验 / champion promotion | NOT_RUN | 付费调用目前为 0；默认策略继续保持，后续按既有 paired 决策合同另行取证 |

本草案只整理现有执行材料，未额外运行测试；主线程后续补充最终受测 SHA 和完整验收结果。

冻结前并发补审：同 Runtime 的两个 resume 会在既有 SESSION_BUSY guard 生效前重复 append/consume 已绑定 steer。`78321b7` 对同 session 的注入过程串行处理，等待后重读 durable history，finally 释放；其他 sessions 独立。最终 active-user fixture 为 24 项，SHA `8a3c237d96309e4046ae53c41b4a130265f6a08d3af3ba5447c465a2897f1053`；同 fixture 修补前新增 2 项为 1 FAIL/1 PASS，8 文件相关回归为 110 PASS。独立实际 Runtime probe 的写入/消费各从 2 变为 1，原 promotedTurnId 不变；不承诺跨进程 CAS。见 [正式证据](source-optimization-20261002/r2/independent-bound-before-append/concurrency-review-manifest.json) 与 [独立复审](source-optimization-20261002/r2/concurrent-resume-independent-review.json)。
