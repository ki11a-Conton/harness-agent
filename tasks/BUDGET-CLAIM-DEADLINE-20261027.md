# 预算 claim 锁遵守调用方超时

根据 main CI `40543517989` 的真实 Windows 失败修复 `openR97BudgetLedger` 的 `lockTimeoutMs` 漏传。执行 [本轮计划](../plan(20261027-large-repository-harness).md) 的 CI 后续章节，先保存四种确定性红例再沿既有调用链修复。保持原生进程 2 秒守卫、owner token、活持有者保护和失败关闭；完成相关预算/安全/完整及原生 Windows 验收。
