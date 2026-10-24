# 输入框原生 Goal / Plan 菜单

用户要求将输入框左下角独立的“编程 / 目标 / 计划”选择框移入 ➕，提供原生 Goal、Plan 入口，支持键入 `/goal` 和 `/plan`。

按 [计划](../plan(20261024-composer-mode-menu).md) 实施。基线 main `086155ec04e197a2b58eed7d0cbb905e01cffad3`，上游 DeepSeek Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。复用已经保留的 ui-commands / ui-goal / ui-plan 组件；不以隐藏 CSS 或模拟点击替代真实入口。

Runtime 冻结；所有目标、计划、权限、执行继续经过原 commands/execute、goals 服务、ToolOrchestrator、PermissionEngine、SandboxManager、Verification。保留 Goal 暂停/编辑/恢复/清除、Plan 审阅批准及只读边界。Goal 与 Plan 的既有组合语义保持；进入 Goal 输入不会自动取消未审批计划。

只使用原生 Git/HTTP；不创建子 agent、不使用 GitHub 连接器、不触发付费模型、不修改其它工作树或历史发行资产、不发布 release。验收需要真实浏览器菜单/键盘/指令输入 → 原生宿主 → 持久状态、实际 HTTP/文件，及相关回归、类型、全量、安装包和 CI。保留失败，不删断言或取消 CI 获得通过。
