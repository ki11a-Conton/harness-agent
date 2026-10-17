# 包含 Windows 存储修正的首次候选 CI

源码 9e0abb1a05547f0fb2cb323035348cab665c65c7，实现 f2788ee508be6e204fe1ce73527a8a0f32022599；仅多一份范围文档，代码一致。两个工作流首次 dispatch/attempt 1 完整成功，不重跑原失败。

| 验收 | Run | 结果 | 成功任务 |
| --- | --- | --- | --- |
| [genuine Windows acceptance](https://github.com/ki11a-Conton/harness-agent/actions/runs/39027508288) | 39027508288 | SUCCESS | 1 |
| [official DeepSeek UI installed acceptance](https://github.com/ki11a-Conton/harness-agent/actions/runs/39027506887) | 39027506887 | SUCCESS | 3 |

Windows 专项显式执行原子替换 6 项与原会话问答回归；同包 UI/CLI 在 Windows/Ubuntu 验证。仍须按最终 main SHA 完成四工作流/十项主 CI，不将候选当最终 main。
