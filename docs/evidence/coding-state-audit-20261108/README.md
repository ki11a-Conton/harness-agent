# Coding 状态与恢复审查证据（2026-11-08）

基线 main `5f55f1bd4f0dabfdf58f2bccebfd8885d003513c`。问题、方法和限定见 [执行计划](../../../plan(20261108-coding-state-audit).md)。

`regression-evidence.json.xz` 解压后是文件名到原始文本的 JSON 对象；每个命令的 receipt 包含源码 SHA/工作树状态、开始结束时间、退出码和日志 SHA-256。`regression-manifest.json` 包含归档及成员哈希。

- 最终相同 44 项测试：旧实现 38 失败 / 6 正常对照通过；修复后全部通过。
- 最终旧实现为干净提交 `528cd0742976c336e263836b4b8a57edc9e5ccb3`，五个生产文件与 main 基线一致；`baseline-comparison.json` 记录哈希和对照过程。修改过的生产文件在退出时恢复，修复后再次构建。
- 最终相关回归共 10 文件 / 133 通过：`final-targeted` 8 文件 / 102，`final-related-companion` 2 文件 / 31。前者两个旧关联文件名拼错，Vitest 忽略未匹配过滤项，因此没有将其报告为 10 文件；后者使用正确路径补验。
- 第一次 RED 的测试参数展开错误、初次写锁用例的清理错误以及中间修复/回归结果均保留。最终 RED/GREEN 不用这些中间计数替代。
- Windows 专项保留原 114 文件和 46 项指定用例，增加 4 文件共 118；POSIX 权限用例在 Windows/root 条件下跳过。

此时完整回归、安装版验收及 main CI 待后续回执。未调用付费模型，不据工程测试声称真实模型 coding 质量已证明。
