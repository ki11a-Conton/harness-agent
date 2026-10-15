# 归档 CI 复核及 PR 审查

归档提交 `d202e952fe55baf9956d4b85428812dc5dc1862e` 的四个工作流均未整体通过：Windows 在 checkout 因新增证据文件路径过长失败；Ubuntu 相关任务成功。原始链接：[主 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38729829499)、[真实 Windows](https://github.com/ki11a-Conton/harness-agent/actions/runs/38729829464)、[普通安装](https://github.com/ki11a-Conton/harness-agent/actions/runs/38729829508)、[UI 安装](https://github.com/ki11a-Conton/harness-agent/actions/runs/38729829717)。

实际错误为 `Filename too long`，不是产品测试失败；主 CI 的 Windows job `116404575964` 等均在 Git checkout 终止。先前产品源码 `4ee21776` 的 10 项成功结论保持原有绑定，不能用它称归档提交整体通过。

修复只移动 10 个新增运行态证据文件到短路径，原始字节保持不变；保存原始清单及完整路径映射，并增加相对路径长度检查。重跑证据验证、文档检查；修复后的真实 Windows/完整 CI 状态后续据实记录。

用户指定的 PR 为 #9 `fix/ui-model-discovery-authorization`（`e5571881`）与 #10 `fix/web-memory-only-model-selection`（`ecc73a56`），本轮按固定 head 和当前 main 分别审查、执行相关回归。审查结果后续写入，不将未运行的检查写为通过。
