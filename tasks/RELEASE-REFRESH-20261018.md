# 第一代 release 更新与 Web 交互复验

## 做什么

用户已授权复测最新 main 的 Web 按钮交互，修复问题后更新第一代 release。本任务取代旧 PR 任务中“本轮不发布”的任务范围限制；保留旧记录，不覆盖旧 tag。

## 怎么做

按 [plan.md](../plan.md) 执行，固定最新 main 与独立工作区。v1.11.0 使用真实 portable 构建和现有安装验收，受限 exporter 只能写绑定同 SHA 的新 draft，正式发布由最后独立核对执行。禁止 GitHub 连接器、付费调用、force push、删除失败证据或修改其他人的工作区。无需子 agent。

## 怎么验收

42/117 日常按钮、基础 coding UI、中文/英文连接恢复；同一安装包 Linux/Windows Web/CLI 通过；精确 SHA 四类 CI、主 CI 十项、完整测试及安全通过；tag、release、公开下载哈希一致。报告实际跳过与未覆盖能力，不作所有潜在 bug 或付费模型质量保证。
