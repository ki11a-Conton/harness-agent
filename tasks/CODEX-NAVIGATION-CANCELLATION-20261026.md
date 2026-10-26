# Codex 对照：代码导航的取消与共享工作生命周期

用户要求继续阅读开源 Codex，找出 Harness coding 流程的缺口并实施优化。按 [计划](../plan(20261026-codex-navigation-cancellation).md) 执行。

本轮从 main `1f12468343a18b96611b2d2d6ecd5b4bef613ead` 建隔离工作树。只用原生 Git/HTTP，不用 GitHub 连接器；不调用付费模型，不修改旧 release/tag/assets。保持 Core/Contracts、权限、沙箱、验证器及静态 Agent policy 不变。

已读 Codex file-search 的 session/drop、walker、matcher、snapshot 和并发取消测试；其共享外部取消与单会话 shutdown 分离，取消能停止后台遍历。Harness 默认 lexical symbol_search 的工具入口检查 signal，但 indexedSymbolSearch/getSymbolIndex/listSourceFiles/buildRootIndex 不接收 signal。因此取消只能在整个索引完成后被工具入口察觉，后台 I/O 不随用户停止。本轮属于可独立复现的工具生命周期缺陷修复，不将它当成模型质量策略实验。

必须先留存同一真实 ToolOrchestrator 驱动的红例，再实现。现有同根/同范围共享构建、热验证、TTL、LRU、语言回退、选定路径与根别名隔离均需保留；取消一个订阅者不能破坏其他订阅者，最后订阅者取消后不得发布半成品缓存。文件读取/遍历错误不能吞掉取消。查询已缓存的索引时也要定期让出事件循环以接收用户取消。

任务完成须有明确的做什么/怎么做/验收、源码对照指纹、红绿实测、类型检查、相关工具/安全/集成及完整测试，最后推送 main 并等待该精确提交 CI 终态。失败原始记录保留，不跳过、不取消 CI、不扩大原验收预算。
