# v1.13 发布、工作区身份与后续 coding harness

状态：R1 已发布；W2 专项通过、待冻结提交后的独立绿例；C1 尚未开始。发布源码与之后的 bug 修复分开。合同见 [任务](tasks/RELEASE-WORKSPACE-CODEX-20261025.md)。

| 阶段 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| R1 | 发布 v1.13.0 | 从已验收 main 63545d01 建隔离工作树；更新新版本绑定、修复 exporter 的 ubuntu-latest 与实际 ubuntu-24.04 不匹配；保留严格 draft/source/hash/逐资产 fresh 检查，补齐现有 UI 和 managed 命令验收门槛 | 新固定 clean SHA 的 typecheck、发布安全回归、全量、同一归档 Ubuntu/原生 Windows Web/CLI 及四项 CI 成功；新草稿导出成功后发布，核对公开 tag/资产 digest，旧版本不变 |
| W1 | 定位网关目录与所选工作区混淆 | 在网关宿主目录和项目目录不同的真实进程/HTTP 场景检查持久 cwd、实际文件工具和最终模型请求；对比 Chat/Responses 等生产转换入口；保留独立红例 | 不把模型一句话当作 cwd 证据；红例明确到底是会话/工具/上下文缺失还是外部网关行为，未证明部分注明 |
| W2 | 修复工作区权威信息 | 根据反例在已有 host/context 扩展点提供可信、每会话准确的工作区信息，避免用 process.cwd 或模型/网关声称的路径覆盖；恢复和切换项目仍取真实会话值 | 真实 CLI/Web/API 请求使用所选项目；工具实际读写落在该项目；跨会话/恢复/模型切换、特殊路径及权限拒绝保持；类型、专项、安全和全量通过 |
| C1 | 研究 Codex 的下一项可迁移优点 | 固定开源源码 SHA，读实际 prompt/environment/context/工具实现并与当前 harness 比较；从可测的 coding 工程缺口选择一项，在本计划补充具体实施和门槛后编码 | 公开已读文件和指纹；生产扩展点及独立反例明确；固定输入/预算对照，失败不隐藏；不为模型策略假设改写 Runtime |
| C2 | 实施与交付 | 在发布之后的独立提交修复 W2 并完成所选 C1 优化；默认行为变化需有明确证据，实验能力保持显式 opt-in | 最终 clean SHA 的相关专项/安全、全量和实际 CLI/Web/SDK 检查通过，main/CI、改动说明、局限及原始证据可复核；付费模型调用为0 |

v1.13.0 的 release 只对应 R1 固定源码，不将后续 W/C 改动自动塞入已经发布的资产。遇到发布、网络或模型质量限制保留实际证据，不跳过门禁、不覆盖历史失败。

## R1 首轮门禁收尾

50a294be 的两项 Windows 失败及受控证据见 [独立记录](docs/evidence/release-v113-gates-20261025/README.md)。只补验收输入提交准备及 quiet-command 夹具协调；生产应用和预算不改，原全部失败保留。后续候选必须重新通过精确 clean SHA 的全量、同包安装和四项CI；R1 尚未发布，W/C 尚未实施。

## R1 已发布；W2 具体实施

2026-10-25 18:22:59 UTC 已发布 [v1.13.0](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.13.0)，固定源码 `a6a1196bc43f0ad47654ccc534f72b0383aa5ff4`，四项 main CI 和 exporter `40220887442` 均为 attempt1 成功。公开四资产下载指纹一致，归档 SHA256 `3a915587b6a7fae172c24171848fa960b008c89d0e6dd80d490ea9758cde78a4`，v1.12.0 元数据、tag、六资产不变。上一节为首轮历史状态，不是当前发布结论。

W1 已在同一 a6 源码上通过真实 SDK HTTP、Chromium 目录选择器和并发/压缩/持久恢复证明：实际 session.cwd、读文件目录正确，但模型系统上下文缺少当前 cwd。具体网关二次注入仍未证明。

W2 做法：只在 Harness 的公共 ContextPipeline 扩展中，将每次 build 的 session cwd 渲染成边界安全的 JSON 环境；默认及 path-scoped 两条装配链共用，进入原 system block 的 token 统计、保护、压缩与实际请求见证。静态 agent prompt、Core、Contracts、权限和沙箱保持原实现。所有 profile 均修复，避免测试专用路径与生产不同。

W2 验收：同一独立浏览器及生命周期 probe 红转绿；真实 Chat HTTP 首轮、并发子目录、自动/手动压缩、JSONL 重启、Web 切模型均携带正确 session cwd；特殊路径不逃出 JSON 边界，原 token estimator 计入开销，path-scoped 发现和外部目录拒绝不退化。现有生产适配器只支持 Chat Completions，不声称完成尚不存在的 Responses/Anthropic 适配。通过专项后再开始 C1 研究，最终统一做 clean SHA 全量及 main 双平台 CI。
