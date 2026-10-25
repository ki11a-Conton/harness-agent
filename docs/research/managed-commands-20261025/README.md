# 受管理命令实施的冻结输入

H0 在 main `f8db83fd` 的生产宿主执行后原样保存。`preregistration.json` 在 challenger 实现前记录了24对/48臂、预算和零泄露/重复/晚写/错误验证门槛。正式 H4 在最终 clean 候选同一源码上比较默认关闭与显式开启：真实 Git 仓库、真实进程/HTTP/独立命令检查，全部逻辑臂保留。

实现及验收入口见 [使用说明](../../managed-commands.md) 和 [计划](../../../plan(20261024-managed-command-harness).md)。原始失败、最终 SHA 和跨平台结果在后续收尾记录中列明。脚本模型不证明真实模型质量。

实施候选 `0d70f87c` 的首轮全量为10,269通过、0失败、16原有跳过。该轮完整48臂中 HTTP 因测试授权冲突失败；第一次修正的单星 glob 未覆盖 URL 子路径，第二轮完整48臂仍失败。这两轮不是已通过的对照，全部原始臂保留。随后先用真实 PermissionEngine 预检本地 allow / 外部 deny，再用一个 HTTP 对照验证实际 API/取消/独立检查；最终协议使用包含子路径的 loopback pattern，重新注册完整48臂。浏览器首次日志断言漏读 JSONL event 外层封装，原检查实际已通过；读取封装修正后9项真实安装包按钮检查通过。

另有真实宿主 SIGKILL → 重启实验：原始命令启动1次，恢复 journal 为 unknown，恢复未被验证完成且未重复执行；由独立脚本核对实际命令行/cwd 后清理原子进程组。Windows journal 改为复用现有 store-integrity 原子持久化/短暂锁重试。最终源代码及归档须再跑全量、对照和同包验收，旧结果不覆盖。

`cdb3022a` 的本地最终全量为10,270通过、0失败、16原有跳过；48臂候选24/24、基线16/24、重复启动0，16个受管理检查在进程仍活跃时读取代码。原生 Windows 的48臂/专项、同包 Ubuntu/Windows UI 和第一代安装验收已实际通过。通用 Windows 全量/嵌套 N6 另外暴露三处测试时序假设：只检查最后一页增量输出、把3.7秒等同于四次轮询、短命令可能在负向断言前自然完成。修正采用真实 loopback held-response：显式授予仅127.0.0.1的测试 sandbox，四次真实回执后才释放静默命令，并收集全部增量页；保留所有退出/预算/验证断言。

本地旧 keyboard runner 的45项交互断言全部通过，但快速导航正常取消尚未完成的 debounced session/search，被统一无 RPC 错误门禁判错。修正只在导航前等待真实 search 回执：同一归档、三个视口重新执行45项全部通过；没有过滤错误、删除断言或改客户端。以上收尾仅修改测试/验收脚本与此记录，应用、工具、权限、预算、Runtime 和已发布资产不变；新 clean SHA 仍需重新执行正式门禁，旧失败不改写。

独立兼容性反例 [legacy-authority-red.json](legacy-authority-red.json) / [复现元数据](legacy-authority-reproducer.json) 证明：原 ToolOrchestrator 接受合法的 optional-turn 只读 context，包装器却在进入原执行链前拒绝。修复只将受管理 owner/预算查询限定到 exec_start/poll/cancel/jobs；原有 read/exec 仍经过原权限、沙箱、预算和工作区锁。回归同时覆盖实际 read、冻结绑定、read-only 写拒绝及无 owner 启动新命令仍拒绝，Core/contracts 未改。修正后相关65项通过；最终 clean SHA 的完整门禁继续执行。
