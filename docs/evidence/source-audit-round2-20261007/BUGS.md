# 第二轮全面审查：确认问题与修复（2026-10-07，Asia/Shanghai）

基线 `21fa7436b1abdcbc0dcd4f8a300f171b1a35f8e0`。按 Runtime、工具/沙箱、provider、CLI/Web、存储恢复、记忆/MCP、评测、研究归档及 CI 检查。
这是本轮已确认的15类问题；静态审查与测试不能证明所有未知缺陷都不存在。原工作区未提交文件保留。

| ID | 问题及触发条件 | 修复 | 验收 |
| --- | --- | --- | --- |
| R2-01 P1 | N7 case允许64k输入，却固定预留32k；32258/376的usage导致结算失败、漏费用记录 | 可声明实际输入/输出上界；N7按64k/32k预留，发送前校验96k价目覆盖，不增加总预算 | >32k真实 CostBudget/R97 scripted反例；不足价目0发送 |
| R2-02 P1 | completed在结算前交付；结算失败仍是committed且所谓“冻结”未持久化；崩溃窗口可能已扣费但缺明细 | 完成事件在结算后交付；费用和归属同事务；故障持久化冻结，未完成ledger标unknown，恢复也拒绝新发送 | 在completed处停止消费即已落盘；超界、不足费用、重开后拒绝、ledger/journal对账 |
| R2-03 P1 | 仅final result携带usage时费用为0；没有usage也被记成MEASURED零费用 | 合并final usage；缺usage按预留上界标UNKNOWN，不能用于MEASURED结论 | final-only真实包装；无usage上界记录；N3明确给出合成usage |
| R2-04 P2 | 取usage快照最大值而非最后值，与累计快照合同及Runtime计量不一致 | 最终累计快照覆盖已有值 | 100/50→42/7，费用49，非150 |
| R2-05 P1 | 负数/坏预算状态可重开；不完整reserve生成NaN；外部可修改view/journal引用；打开后换caps未经验证 | 校验计数/预留合计及每次读取的身份/caps；完整维度；深复制只读视图 | 负数、缺维度、换caps拒绝；改返回对象不改变权威状态 |
| R2-06 P1 | tool.requested路径被当成真实写入；POLICY_DENIED且文件不存在仍标ESCAPE/infrastructure | 成功写入才进入changedPaths；保留尝试和拒绝事实 | 真实runOneCase三种arm拒绝外部文件：CONTAINED、文件不存在、无infrastructure误判；原有真实逃逸正例仍通过 |
| R2-07 P1 | opt-in v1 baseline安全证据标candidate，256份历史记录受影响；事实缺rep/attempt且judge不拒错标签 | 使用实际arm/rep/attempt；judge校验外层arm与安全事实身份 | baseline-v1、C0、candidate-v2逐条一致；错arm拒绝 |
| R2-08 P1 | 缺toolCallId被补成虚构ID；不同调用/规则/身份的尝试与拒绝也可判CONTAINED | 保留缺失ID，按真实关联判INVALID | 无ID/关联不匹配反例；有效拒绝及真实逃逸原回归 |
| R2-09 P1 | OpenAI-compatible provider丢掉temperature/maxTokens，实际HTTP没有输出上限 | 保留0温度、发送max_tokens；无效参数在fetch前拒绝 | 实际请求体spy、0/-1/NaN/小数/Infinity及原SSE/retry测试 |
| R2-10 P2 | verify-n7-archive入口缺右括号，helper测试未覆盖CLI | 修语法；实际执行CLI纳入集成 | node --check；合成完整归档命令正例、缺失/篡改拒绝 |
| R2-11 P2 | 当前facts漂移后无法方便地按历史sourceSha严格复算 | 隔离检出记录SHA，离线锁文件安装、重建、核对source/build原字节，调用历史自身helper | 小型合成Git仓库完整重建正例、构建字节改动拒绝；真实旧付费原件缺失仍明确阻塞 |
| R2-12 P2 | RAW-MANIFEST只存摘要，原始campaign/judge留在私人目录，无法移交复算 | 流式gzip完整原件+双重摘要；限定命名空间/大小/数量、拒绝symlink/覆盖/路径逃逸；秘密原件拒绝发布 | 删除私人roots后独立解压与复核；二进制/空文件、篡改/截断/坏gzip/路径反例；原件不改 |
| R2-13 P2 | N7说明把255定案计为143→146、两条异常说成同一终态、USD算式及D1/D3因果不准确 | 机器从原件汇总并追加勘误，保持原判定及冻结数据 | 每个输入长度/SHA256；255为143→145，完整256为143→146；9171调用/9169费用记录 |
| R2-14 P2 | 真实Windows run37615393968的N2 afterEach删除两份完整编译检出超出默认10s，导致formal和dual失败 | 异步await清理，显式有界120s专用hook，失败不吞；保存实际清理耗时 | 取回原失败commands/log片段并核对hash；junction不删除原依赖；Linux/Windows opt-in完整release链 |
| R2-15 P1 | formal/dual已失败，release-attestation仍可独立给出绿色release状态 | 发布证明等待dual-platform-acceptance成功 | workflow依赖合同测试及真实两平台CI，不放松formal/dual门禁 |

另补formal失败公开诊断，保留原退出码；通过原生GitHub Actions取回既有失败包，未重跑付费实验。
基线反例：4文件28项，**18 failed / 10 passed**；另实际node --check复现归档语法错误。
回归结果、最终源码SHA、完整Linux/浏览器/Windows证据会在 [COMPLETION.md](COMPLETION.md) 汇总。

## 原件与限制

旧N7付费归档约460MB原始tape/journal未发布，不能补造；新代码支持保存/移交，历史严格重算仍需原件和匹配构建缓存。
当前源码独立复现旧计量故障类别，不能代替旧请求的完整因果归因。
无付费调用、无候选晋升、无门限调整；归档正例为显式合成工程验收，不代表模型质量提高。
