# Codex 对照：代码导航的取消生命周期

对照来源及指纹见 [sources.json](sources.json)，固定在 HARNESS-SRC-FORK collection `1a46ea13`；这不是声称的上游 Codex revision。阅读重点为 `file-search/src/lib.rs` 的 `FileSearchSession::drop`、walker/matcher、snapshot 及 `dropping_session_does_not_cancel_siblings_with_shared_cancel_flag`。Codex 将独立 session shutdown 与共享取消分开，并让后台遍历检查停止信号。本轮借鉴生命周期原则，未复制其 Rust 代码，也未引入新执行器。

Harness 已有同根/同范围的共享索引、文件级热验证、60秒 TTL、64根 LRU、权限及范围隔离。本轮发现两处确定性缺口：工具入口的取消信号未进入 lexical 索引；长索引匹配循环也不让出事件循环。前者在外部真实 ToolOrchestrator 红例中，取消后仍读完36个实际 TS 文件；后者在20万行实际热索引中，要扫描到末行后，已排队的取消定时器才生效。见 [扫描红例](baseline.json)、[查询红例](hot-baseline.json)。两者都会最后显示 cancelled，因此仅断言最终状态不足以验收。

做法：共享扫描有独立 AbortController，调用者仅订阅自己的等待；最后一个订阅者取消才停止扫描。遍历、stat、readFile、刷新和返回之间传播取消，取消不被普通文件错误处理吞掉；终止的旧 flight 不得删除替代 flight，半成品不进入缓存。遍历与逐行查询每批让出事件循环，命中上限全局停止。工具名、输入/输出结构、权限、沙箱、Core/Contracts及静态 Agent policy 不变。

[预注册门槛](registration.json) 以实际 I/O 数量和取消发生在末行之前为准，不以经过固定15ms协调等待的墙钟时间宣传性能。初步绿例中，单调用/全部共享调用取消都只读1个文件；单方取消仍让另一方成功得到全部36个命中，且总计只读36次。20万行热查询在末行前取消。154项导航/缓存/范围专项及2项完整 Harness 回合集成已通过，包含 interactive/test 两种权限配置的停止后继续任务。最终 clean SHA 的完整测试与远端CI须另由收据确认。

复算需先 `pnpm typecheck`，再用新的输出目录运行：

```sh
node scripts/research/navigation-cancellation-probe.mjs "$PWD" /tmp/harness-nav-scan-proof
node scripts/research/navigation-hot-query-probe.mjs "$PWD" /tmp/harness-nav-query-proof
```

原始扫描探针的 SHA256 在 registration.json。热查询探针指纹及全部探针文件见 probes.json。文件系统观察器保留真实读取和文本，仅协调首次读取/观察行访问；调用走生产 ToolOrchestrator。模型调用为0。完整回合集成使用本地脚本 provider 验证接线，不是模型质量提升证明。

初轮环境准备沿用旧增量缓存导致缺少新工作树 dist，强制完整构建后通过；初轮专项150通过/4失败，是4项测试在取消前读取尚不存在的 reason，改为预先定义并检查同一 reason 后154项全部通过。原始日志保存在本轮外部证据目录，不覆盖失败结果。

其他对照发现保留为后续项：旧数组检索输出的完整性提示，以及 lexical 索引的超大文件/总资源限制，需要单独做反例和兼容设计；当前 grep/AST 已有部分边界。Codex 的 get_context_remaining 使用会话实际账本，不能用裁剪前预算估算代替。本轮不宣称这些后续项已完成。
