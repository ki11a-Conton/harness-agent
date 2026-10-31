# Codex 对照：Coding 任务可靠性优化

## 范围与依据

用户要求继续优化 Harness，使实际 coding 能力更接近 Codex。基线为远端 main `05a7c216a0b152214d7c3108f72c048f66ad575b`，本轮不发布 release，不调用付费模型，不改变默认 Agent 策略。

遵守 AGENTS.md 的 Runtime freeze：先用确定性反例证明基础设施缺陷，再修复，不用提示词或模型质量推测作为重写运行时的理由。所有副作用继续经过 ToolOrchestrator、PermissionEngine、SandboxManager 和 Verification。

对照源码：当前工作区 HARNESS-SRC-FORK `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` 下 `codex-main`。学习其真实上下文超限恢复、文件描述符校验和有界工具执行；保留现有 Harness 架构和第三方许可。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| C1：真实超限后压缩恢复 | 修复本地估算未超阈值时，provider 已返回 overflow 却仍重发更大上下文的问题 | 将已确认的 overflow 接入现有 history checkpoint 压缩路径，一次性强制缩减实际模型历史；保留当前用户约束、修正和合法工具批次；摘要失败使用现有 extractive fallback | 原 main 的真实 Runtime 复现 RED；修复后实际重试输入严格缩小、任务完成；检查少量大消息、已有 checkpoint、摘要失败、用户修正、工具协议、取消和预算；不增加原一次 changed-context 重试次数 |
| C2：文件编辑输入可靠性 | 修复编辑 FIFO 超时后仍阻塞线程池/持锁、无版本写入和追加超时后仍写 FIFO，以及大源码锚点编辑的内存放大 | 使用真实 descriptor 检查与取消边界，写描述符确认 regular file 后才 truncate/write；将编辑的逐字符偏移表改为稀疏换行映射，避免额外业务文件大小限制；保持版本校验、锁及事务语义 | 真实 ToolOrchestrator 不能因四个 FIFO 占满线程池，后续普通读取仍成功；write/append/edit 不能在超时后向 FIFO 写出内容；原 8.6MB 源码/128MiB heap 子进程 OOM 的用例编辑成功；普通 UTF-8、CRLF/BOM、混合 EOL、版本冲突、权限/沙箱和事务回归通过 |
| C3：命令输出事件有界处理 | 修复大量编译/测试日志通过异步事件队列造成的内存放大 | 在现有工具事件边界对排队输出设置明确资源边界，保留前缀/末尾诊断及省略提示；保持真实命令结果、权限、安全处理和取消/超时语义 | 真实进程+生产 JSONL 存储的 0/40/160MiB 对照测量；128B capture 配置下内存和未落盘事件不再随总输出无界增长；小输出不丢、失败尾诊断不丢、落盘失败与取消/超时有回归 |
| C4：集成与交付 | 验证这些修复能在真实宿主完成 coding 工具闭环 | 根类型检查、相关单元/集成/安全测试，干净提交完整源码全量及真实 CLI/Web 本地 HTTP provider 验收；独立审查后提交 | 全部必需断言通过；结果绑定精确源码 SHA；保留失败记录。脚本 provider 只证明工程闭环，不能证明真实模型质量已等同 Codex |

## 执行记录

- 远端 main 原生 git 查询与本地一致，工作树干净后创建 `fix/coding-reliability-20261031`。
- C1 外部真实 Runtime 基线反例已复现：9 条输入、配置 16000 tokens，provider 的确定性 12000 bytes 输入门槛下，两次 coding 请求从 18835 bytes 增至 19785 bytes，无摘要调用，最终 `CONTEXT_OVERFLOW`。原始日志保留于 `/dev/shm/harness-coding-next-20261031/context/`。
- C2 两个基线反例已实测：四个 FIFO 的 edit_file 均 timeout 后仍占四个文件锁，普通文件读取也因线程池耗尽 timeout；8,642,810 bytes 生成源码的单锚点编辑在 128MiB heap 隔离子进程 OOM/SIGABRT，4.3MB 对照成功。救援/清理完整，原始记录在 `/dev/shm/harness-coding-next-20261031/edit/`。
- C3 已通过真实进程、生产 ToolOrchestrator/JSONL/输出保护链复现，无人为存储延迟：capture 固定 128B，0/40/160MiB 原始日志的进程峰值 RSS 约 52/162/387MB，pending 事件约 2/639/2576；GC 后可回收，证实是运行中队列临时占用。原始数据在 `/dev/shm/harness-coding-next-20261031/execution/`，先审查有界设计再实施。
- C1/C2 已进入最小修复；此处尚不宣称整体验收完成。
- C1 独立复核增加反例：约 10KB 当前用户指令可在 provider 12KB 窗口内保留，但最初硬比例目标误拒；保留 RED 后修正 protected-user 余量。最终 9 项新回归与相关旧测试共 10 文件 166 项通过，Core noEmit 通过，独立复核无阻塞。
- C2 扩展同族反例：无版本 write/append FIFO 各自 timeout 后仍持锁，救援打开读端后还实际写出 21 bytes。纳入 owned write descriptor 修复，不仅修 snapshot read。
- Codex 参考机制：`codex-rs/core/src/compact.rs:309` 在真实超限后减少请求，`core/src/context_manager/history.rs:245` 成对处理工具记录；Harness 使用已有 checkpoint/protocol 工具而非替换其架构。具体源码与比较说明随证据交付。
- C2 最小实现及独立复核完成：opened regular descriptor、POSIX nonblocking、读取取消与关闭、写入前真实 descriptor 验证；不可逆写入阶段保持旧行为，避免新增 truncate 后取消留下空文件。新增四份回归，相关 10 文件 167 项通过、tools build 通过。原 snapshot/race 验收门随真实 I/O 从 path read/write 同步至 owned descriptor，未减断言或预算。45,000 组原/新编辑纯函数差分通过。
- C3 实现每 call 最多 8 个、64KiB 待确认原始输出，单帧最多 8KiB，使用独立 UTF-8 字符串并记录 dropped 字节/事件数；canonical result 前缀/末尾诊断不变。正常 drain 处于原工具 timeout race，close 唤醒自身等待，原始 sink 的在途 I/O 不冒称已取消。专项/相关 7 文件 114 项及安全集成 5 文件 43 项通过，独立 3 项复核通过。初测 160MiB 输出 pending 从数千降至 8，RSS 峰值约 387MB 降至 70MB；最终整仓 build 后另测并绑定实际 dist。
- 三条链路独立 review 均无阻塞。根验收进行中：类型检查、相关安全/集成、真实 Provider HTTP、CLI/Web、干净实现提交全量。尚未推送或宣称这些最终门禁通过。
- 根 `pnpm typecheck` 通过；30 文件安全/集成及全部新回归 2228 项通过。真实生产 Provider+Runtime 的本地 HTTP 三场景通过：超限 17351B→3091B，10KB 用户原文保留的 16864B→10964B，摘要实际 HTTP400 后 extractive 重试 3153B；共 9 次 loopback POST、0 付费。这些运行绑定提交前源码/dist hashes，明确不称干净旧 main 的验收。

## 验收边界

- 保持原一次 changed-context retry；不能保证所有实际模型窗口都可恢复，也不丢弃不可缩减的用户输入以强行通过。
- POSIX FIFO 实测不代表已验证 Windows named pipe；本轮将所有新回归加入真实 Windows CI，不能用模拟平台结果冒充原生执行。
- 事件队列修复范围是单次调用的 live output。原终态 sink 永久挂起的整体存储故障未在本轮改写；已发起的异步持久化不宣称被取消。
- 文件写入保持 in-place/硬链接行为与旧不可逆阶段语义；不是跨外部进程 atomic CAS，也不是磁盘故障下的原子事务。
- 本地 scripted HTTP/CLI/Web 验收证明工程执行链路，不证明付费真实模型 coding 质量或等同 Codex。

## 精确提交 CI 复核与后续修正

- 实现 `c1a7a74d2ff6c69d72c41f7b281fc2cc00342775` 已推至工作分支，尚未更新 main。Gen1 安装、双平台安装 UI 通过；综合 CI 与原生 Windows 失败，原始 run/job/annotation 回执完整保留，不能将局部 GREEN 当作整体验收通过。
- 综合双平台及 formal 暴露遗漏的旧 `reactive-checkpoint.regressions.test.ts`：两个真实保留契约失败。已有小 checkpoint 不应被无摘要的 extractive 新 checkpoint 替换；原 handoff 身份、原字节、用户修正和完整工具批次需要保留。修复方向为小有效 handoff 的确定性缩减及本 turn 投影水位，避免下一工具轮恢复刚移出的原始 progress；旧断言/预算不改。
- 原生 Windows paired 48 arms 的 candidatePass=24，但实际 candidateOverlap=15，原断言要求16。失败 arm 的真实 read 比首命令 exit 晚256ms；observer 正确拒绝，不用模型意图或扩大时间窗口重标成功。确认验收固定2秒时窗是否存在竞态后，仅以真实 read 完成 barrier 改善工程因果探针，原执行预算/16重叠断言及清理保持；不能将有条件 barrier 说成相同工作负载性能或模型质量对比。
- 原本地完整源码 `pnpm test` 进程已不存在，日志无终态 summary、无退出码，精确终止原因未知，记录为 `INCOMPLETE_NO_EXIT_RECEIPT`，不算 PASS 或 FAIL。原日志/收据保留，借用完整 clone 已恢复原 `66a9238c` 分支并强制构建通过；修正后以新 prefix、干净精确提交另行运行全量。
- 后续 C1 修正保留小有效 handoff 的原 id/内容，以 turn-local 水位防止后续两轮工具恢复旧 progress；新 durable checkpoint 可接管，人工压缩继续走原持久化流程。独立复核发现仅检查摘要输出额度仍不足，28/72 等消息的 framing 会耗尽请求输入；已按实际保护后摘要请求是否可构造判断，单次构造复用，不扩大预算。原 3 项与新 15 项共 18 通过，独立原 11 组 framing 反例全部通过。72 条的后续真实第二次超限按原重试上限停止，同时保留用户、handoff 和两次工具证据。
- Windows 验收 fixture 修正为 native work 与实际 read-completed barrier 同时完成才退出；baseline 明确预释放，candidate 只按本 session/turn/source 的真实成功 read 证据释放，repair 复用。原 2 秒 work、5000/15000ms 预算和 48/24/16 断言不变，缺 read 的真实进程仍原 5 秒超时且清理。47 项 Node 验收及独立 4 项通过；这是工程因果验收，不作相同负载性能或模型质量比较，尚需新精确 SHA 原生 CI。
- 根最终类型检查通过；全部 context 及相关运行时/安全/恢复共 28 文件 465 项通过；原 observer 与新 barrier 的 47 项再次通过。扩大至整个 core/context 的早先稀疏目录运行有 1230 项通过但 4 文件缺少已跟踪的 docs/evidence 归档夹具，原 FAIL 原样保留；不跳过这些用例，后续在完整 clone 原 `pnpm test` 中验收。
- 完成时补记确切修改、红绿结果、源码版本、未验收边界和交付状态。

## 完整验收与 main 交付

- 干净实现 `4b28f6437303e5f551f9760645eb2b3ba9ecbea5` 在完整 clone 原 `pnpm test` 实际 exit0：685 文件通过/2 跳过，10610 项通过/16 跳过，990.07 秒。原日志 185350 bytes、SHA256 `b88b5e6f3f85404054ea12e9ccb4b436f71fcbaba680904964ec84ace44fa0a8`，前后源码均同 SHA 且 clean。完整 clone 已恢复原 `66a9238c` 分支并 force build 通过。
- 同干净 4b 实际 CLI/Web：50 项工程断言+8 项提示词安装断言、19 次 loopback HTTP，通过；真实 Provider 超限三场景9 POST通过；真实48臂工程验收 candidatePass24/overlap16/duplicate0/failures[]，原断言与预算保持。
- 四项 topic CI 均首 attempt success：综合 `41177912841` 十 job、原生 Windows `41177912840`、安装 UI `41177912769` 三 job、Gen1 `41177912779` 三实际执行腿及原条件 draft 导出跳过。Windows 实际90文件、930通过/0失败/12平台跳过，原46必需项各一次通过。root 于13:42 UTC重新通过原生 REST回执独立核对。
- Windows 原始 report/case hash 为 CI 回执值；本地未下载原文件，不冒称独立复算其原 bytes。所有 c1 CI 失败、原本地失联全量、稀疏目录缺夹具失败、补丁中间失败均保留，不覆盖为成功。
- 本次只补记三份 Markdown，生产与测试/CI代码保持 4b 不变，做静态树证明后普通快进 main。main 精确 SHA 的新四项自动 CI 另行核对，最终外部审查报告记录真实结果，不能把 4b 本地全量冒称后续文档提交的重跑。未发布 release、未调用付费模型、未提升默认 Agent 策略。
