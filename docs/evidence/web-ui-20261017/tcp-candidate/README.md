# 独立候选的真实双平台 UI 验收

首次 run [39025695993](https://github.com/ki11a-Conton/harness-agent/actions/runs/39025695993)，
精确源码 4ae2f577fb40a7ecc85c23da800fc63185ffe42b、attempt 1，整体 SUCCESS。
该候选只在固定实现 12d053eb 上增加范围文档，apps/packages/scripts/.github
与实现完全相同。独立分支 [skip ci] 文档提交避免重复自动构建，随后显式
首次 dispatch 本 workflow；没有重跑原失败，也没有变更原 main。

| 任务 | Job | 结果 |
| --- | --- | --- |
| archive | 117376125104 | success |
| installed (windows-latest) | 117376258782 | success |
| installed (ubuntu-latest) | 117376258870 | success |

archive 前置执行完整 19 项 UI/网络脚本回归；Windows 和 Ubuntu 同一
archive 上的 30+42 UI 场景、连接恢复，以及独立 CLI 编码/防篡改均通过。
结论按该 SHA 的 workflow/job/step 复核；这是候选验收，不代替后续精确
main 的四工作流及十项主 CI。main-after-candidate.json 显示原 main 仍为
0d960c2c，原主 CI 继续运行。没有付费调用或 release。
