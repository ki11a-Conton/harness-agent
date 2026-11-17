# Coding 编辑可靠性与有界回执

用户要求继续学习并优化 Harness Agent。基线 main：`5b82292c2f2d0647686a19c414458fece04d2c63`。本轮对照 pi `1f6f319bb28992a40b99c147fffb23b65a23129d`、Codex `c656014177079dae2dcc5e1e70c03e3158383a27` 和 DeepSeek `39163dd30f703a79079e2d2446545cff3c453738`，选择已有生产编辑工具中的可复现缺陷，避免把尚未装配的插件/LSP/缓存摘要建议当作交付。

已在干净源码复现：普通锚点无效编辑报告 success、1 replacement 和文件证据；约8MB/800万空行的真实 edit_file 在64MiB Node堆内写入后因 lineDiff 数组耗尽内存，文件已改变而工具进程未返回结果。四百万空行64MiB探针正常通过，保留为正常规模对照。版本来自真实构建，不以复制实现替代生产工具。

在 @ar/tools 修正：有界 diff、写入前准备回执、无效编辑不写入、不产生成功证据、成功回传写入字节的 SHA256。保持 ToolOrchestrator/权限/沙箱/版本校验/验证链；不修改 Core Runtime、默认Agent策略或插件管理页面。来源固定、保留许可，研究、失败和成功结果均保存源码SHA及哈希。

验收：实际文件与隔离受限堆进程、真实 harness 恢复/连续版本编辑、CLI/Web loopback HTTP 与安装包、相关安全/边界用例、类型及全量测试；普通提交推送、最终 main 精确SHA四项CI复核。不调用付费模型，不发布release，不使用GitHub连接器，不手动重跑/取消CI来掩盖失败。
