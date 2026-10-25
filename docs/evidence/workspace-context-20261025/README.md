# 工作区上下文缺失（W1/W2）

已发布 v1.13.0 的 a6a1196b 是红例基线；修复在之后单独提交。真实 SDK 和 Chromium 目录选择器都证明 session.cwd 和相对 read_file 正确，而首轮“你好”的实际 Chat HTTP system 没有所选目录。并发子目录、自动/手动压缩和 JSONL 重启也有同样缺失。原数据摘要及 SHA256 见 baseline.json；完整数据在任务外部证据目录 `/tmp/harness-v113-release-20261025/`，不是付费模型或真实用户网关实验。

修复：两个 Harness context adapter 共享 workspace-context.ts；在原 ContextPipeline 的 admission 前加入每次 opts.cwd 的 JSON 环境，原 system block 负责预算、保护与压缩。路径的 JSON 控制字符及标记边界都转义；静态 agent policy、Runtime/Core、Contracts、权限、沙箱和工具路由不改。所有 profile 都经同一生产装配路径。

本地 typecheck 与47项专项通过，覆盖原 prompt policy、path-scoped、信任边界、真实 HTTP 两种 context adapter 的独立子目录读取、自动/手动压缩、重启、越界拒绝，以及 Web 选择项目后两次真实切模型。下一步在固定 clean SHA 上复跑原独立浏览器与SDK脚本，再做最终全量/main CI，不能把此处的专项结果当成最终交付。

浏览器补充脚本首轮曾因测试驱动漏传 until 参数在发模型请求前中止；该失败完整保留在 workspace-browser-red-a6/。修正驱动后的 attempt2 才是产品红例，不把驱动错误归因于 Agent。未证明具体用户网关是否还会二次注入自己的目录/提示词；只修复已确定的客户端上下文遗漏。
