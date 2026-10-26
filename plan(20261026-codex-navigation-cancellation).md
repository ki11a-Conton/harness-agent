# Codex 对照与 Harness 代码导航优化

基线：main `1f12468343a18b96611b2d2d6ecd5b4bef613ead`。状态：源码比较、两项独立红例和实现完成；实际扫描/热查询冒烟转绿，154项专项和2项完整回合集成通过。最终 clean SHA 全量与main CI仍须由固定源码收据确认，之前失败记录保留。

| 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- |
| 固定源码比较 | 阅读 HARNESS-SRC-FORK 中 Codex file-search 的取消、共享工作、walk_complete 和结果限制；同时审查 Harness 的 lexical/syntax 搜索、上下文余额及既有进程能力，记录已读文件 SHA256 | 对照能定位到实际代码；不把 Rust 实现整套移植，不重复上一轮已经完成的环境探测和工作区修复 |
| 证明取消缺口 | 在真实临时 TS 仓库中通过原 ToolOrchestrator 发起 symbol_search；只观察并在首个实际源文件读完时取消，保留原文件读取行为与结果 | 基线仍读取后续全部源文件，证明工具状态最后显示 cancelled 并不代表工作及时停止；模型调用为0 |
| 将取消传到索引扫描 | 从工具传入同一 AbortSignal，在范围解析、遍历、stat、readFile、刷新及返回之间检查；readFile 使用内部工作信号；取消从 catch 继续抛出 | 单调用取消后不继续扫描其余源文件；预取消零源文件 I/O；取消后重试得到完整索引，缓存不发布半成品 |
| 保留共享构建且隔离订阅者 | 每个同根/同范围 flight 维护自身 AbortController 和订阅者，调用者取消只退出自己的等待，最后一个订阅者退出才停止后台；中止的旧 flight 不能删除或覆盖新 flight | 同时查询仍只构建一次；取消一人，其他人成功；全部取消后扫描停止；随后新调用可立即重新开始；原冷热缓存/TTL/LRU/范围回归通过 |
| 让长查询接受用户停止 | 对索引内逐行匹配加入有界批次的 cooperative yield 与取消检查，命中上限后全局停止；保持命中内容、分类及顺序 | 热索引长查询期间定时器能触发取消；取消返回后没有继续匹配；既有 TS/JS 分类和其他语言回退不变 |
| 验收并交付 | 做真实 ToolOrchestrator 红绿对照、并发/安全/路径专项，typecheck 与完整测试；提交并推 main，监听精确提交的四条 CI | 所有必要检查通过且原始证据可复核；不改 Core/Contracts/权限/沙箱；旧发布资产不变；不声称脚本/本地工程结果等于真实付费模型质量提升 |

其余对照发现：Codex snapshot 的 scanned_file_count/total_match_count/walk_complete 适合后续检索完整性设计；本项目 grep 和 AST 模式已有部分相应信息，旧数组工具及 lexical 索引的大文件/总资源限制还需另做独立反例与兼容设计。本轮不混入这些 API 变更。get_context_remaining 应使用实际会话账本，不能把裁剪前估算冒充精确余额。已有首尾日志和持久压缩本轮不重写。

实现边界与原因见 [任务](tasks/CODEX-NAVIGATION-CANCELLATION-20261026.md)。
