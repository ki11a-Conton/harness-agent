当前任务：[2026-10-31 Codex 对照：Coding 任务可靠性优化](plan(20261031-codex-coding-reliability).md)；[任务合同](tasks/CODEX-CODING-RELIABILITY-20261031.md)。先复现真实上下文超限恢复、文件编辑和命令执行缺陷，再实施最小修复并验收。

前序任务：[2026-10-30 Coding 长任务边界审查与修复](plan(20261030-long-task-boundaries).md)；[任务合同](tasks/LONG-TASK-BOUNDARIES-20261030.md)。七类确定性缺陷及独立验收同步修正已完成；干净实现 27bc9bc3 本地全量 10537 项通过/16 跳过，最终 main 05a7c216 四项 CI 全部首 attempt 通过，真实 Windows 864 通过/2 跳过。范围、原失败及来源版本见计划与上一轮外部报告。

前序任务：[2026-10-28 Bug 复审与修复](plan(20261028-bug-audit).md)；[任务合同](tasks/BUG-AUDIT-20261028.md)。八类已复现问题修复及兼容审查完成；干净实现 10309f0a 的完整源码全量 10498 项通过、16 跳过，最终 main 2cfd8591 四项 CI 均通过。详细范围、原失败和验收证据见计划。

main c7c4d9aa 跟进：Windows 安装验收暴露侧栏重开后即时可见性快照的竞态。修正验收等待真实页签帧，保留原数量、溢出及 6 秒/整体时限；生产 UI 和运行时不改。新修正另做双平台安装与精确 SHA CI，不把原失败重标通过。

前序任务：[v1.13 发布、工作区身份与 Codex harness](plan(20261025-release-workspace-codex).md)。

# 当前执行计划入口

当前实施：[受管理长命令计划](plan(20261024-managed-command-harness).md)；[任务](tasks/MANAGED-COMMAND-HARNESS-20261024.md)；[使用与边界](docs/managed-commands.md)。默认关闭，依次以 H0–H5 的实际门禁验收；发布标签和资产保持。

当前修复：[输入框 ➕ Goal / Plan 计划](plan(20261024-composer-mode-menu).md)；[任务](tasks/COMPOSER-MODE-MENU-20261024.md)。将独立模式选择框移入原生菜单，并以真实指令/状态/执行验收。

当前修复：按用户截图复用最新上游模型推理规格编辑器，完成实际保存、off/max 参数与响应式验收。做什么、怎么做、怎么验收：[模型编辑器计划](plan(20261024-model-reasoning-editor).md)；[任务](tasks/MODEL-REASONING-EDITOR-20261024.md)。

前序发布任务：v1.12.0 已完成发布和公开安装复测；历史计划保留用于追溯。做什么、怎么做、怎么验收：[plan(20261022-release-v112).md](plan(20261022-release-v112).md)。合同：[RELEASE-V112-20261022](tasks/RELEASE-V112-20261022.md)。前序研究与实现：[长任务计划](plan(20261020-161914).md)；[压缩与中断修复](plan(20261020-102019).md)。

当前 UI 修复及真实宿主键盘验收：[Workspace 操作计划](plan(20261024-workspace-actions).md)。历史 Windows 菜单隐藏原因仍未证实，独立键盘缺陷单独修复、留证。
