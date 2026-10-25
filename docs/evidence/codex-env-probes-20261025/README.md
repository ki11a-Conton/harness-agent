# Codex 对照与异步环境探测

实际读取的 Codex 固定源文件、原始长度及 SHA256 见 sources.json，来源 collection commit 1a46ea13。学习内容是 environment_context 的数据边界、compact 的 initial context 重注入、HeadTailBuffer 的 bounded 首尾、process_manager 的异步 deadline/cancellation，以及 get_context_remaining 对 unknown 的明确处理。现有 Harness 的压缩和首尾输出已存在，没有重复造工具或复制另一套 Rust Runtime。

选定优化是已测的 env_snapshot 宿主阻塞、取消和实际 child cwd 缺陷。baseline.json 是 clean 0085ec4c 经真实 Harness ToolOrchestrator 调起750ms本地版本子进程的 Linux 控制：心跳停顿约787ms；取消到约783ms才处理且仍success；子进程cwd为网关宿主。不是付费模型或 Windows 计时实验。候选先登记在 registration.json，再使用已有 ProcessExecutor.runArgv 做逐项异步探测，版本1500ms/Git2000ms、1MiB上限不扩大，传入会话cwd与原signal。遇到取消返回cancelled，截断或失败版本仍null/false。

75项本地专项通过；真实argv握手证明父事件循环可以回调后释放子进程，取消会回收子进程且不执行后续探测。普通字段、git状态、lockfile、网络与环境值隐藏合同保留。类型检查通过；新测试首次曾漏写mock函数this类型注解，类型失败原日志保留，随后只补注解修正，未放松门槛。下一步在固定提交复跑同一独立750ms对照，并用最终clean SHA全量、CLI/Web和四项main CI判定交付；完整原始日志位于外部任务证据目录 /tmp/harness-v113-release-20261025。
