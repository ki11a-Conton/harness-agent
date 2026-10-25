# 受管理的长命令：源码比较与实施边界

研究基线为已发布的 Harness Agent v1.12.0 / `37a16e3d0ac60da12caff5e28c77a20c8a017e2e`。本阶段比较执行、输出、owner、取消与完成验证相关模块；[输入清单](sources.json)记录24份实际源码、版本和 SHA256，均与记录的 HEAD 一致。完整实施及验收见[下一轮计划](../../../plan(20261024-managed-command-harness).md)。

| 职责 | 上游实现 | 当前 Harness 及采用方向 |
| --- | --- | --- |
| 长命令交还控制 | Codex `unified_exec/mod.rs` 和 `process_manager.rs` 在有限 yield 后保留进程句柄，后续请求使用同一进程 | `exec.ts` 等待既有 executor 的终态；先通过默认关闭的工具 challenger 研究 start/poll/cancel，不改变现有同步工具 |
| 输出与退出 | Codex `async_watcher.rs` 对流量和 UTF-8 delta 设限，区分根进程退出与排空；pi `core/tools/bash.ts` 提供流式更新、截断说明和日志引用 | 现有 bounded collector、诊断尾和有界排空保留；增量游标、丢失标记及后续 artifact 分页需要分别验证 |
| 所有权与准入 | DeepSeek `terminal/src/index.ts` 把 pending spawn 和已发布会话绑定到精确 owner，销毁前保持可追踪性；`background.ts` 使用单调字节游标 | 句柄须绑定 session/turn/agent/规范工作区和策略；未完成的 spawn 也占容量；拒绝外部 owner 的访问和操作 |
| 取消与完成 | pi 的 signal/进程组清理和 DeepSeek owner teardown 提供职责分离的参考 | 本项目 `orchestrator.ts:runBounded` 配置单次 timeout 的路径在 finally 解除 signal 链接；新句柄须有明确 owner 生命周期与绝对期限，并进入原 verifier 的完成门禁 |

当前已具备自动/手动压缩、同任务持久恢复、预算回放、inbox、工具账本、验证失败修复、代码导航及按实际工具装配的提示词。相关依据见[已交付长任务说明](../../longrun-harness.md)。本研究据此选择执行控制的下一步，不重新建立这些机制。

集成前需证明三个边界：返回 start 回执后仍可可靠取消并清理；未结束或失败的 job 不能让任务通过验证；压缩可查询活跃 owner 记录，进程重启后对未知副作用执行对账。现有 verifier 扩展点与宿主 Lifecycle 可以作为研究接线点，须以真实调用和进程效果证明其完整性。

这是能力对照和实验设计。尚未实现新工具、启动实验或测量真实模型质量。计划预注册24对/48臂的工程对照，保留默认行为、预算及全部失败；代码直接复用时保留原许可、NOTICE 和修改记录。Runtime 维护继续遵循 AGENTS.md 的确定反例要求。
