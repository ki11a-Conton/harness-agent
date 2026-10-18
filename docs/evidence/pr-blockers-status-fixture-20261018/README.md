# C7 完成场景的测试取消信号修正

原 main `3736aff73e88c254e33e885d55a292f3344d0392`：UI、原生Windows、普通安装首次成功；主CI Windows正式gate因C7 cancelled/completed断言失败，其下游汇总/发布证明状态保留。ci-original保存四工作流和全部job、原始失败注释。

本地在未提交修正驱动的工作树中执行反例，不声称整树clean。产品Runtime/工具/前端实现与 `3736aff73e88c254e33e885d55a292f3344d0392` 相同，仅测试与验收脚本变化：

- status-fixture-red：实际Node命令在11秒后exit2，原测试10秒信号先触发，记录aborted=true/TimeoutError/outcome=cancelled，并复现原completed断言失败。完整红测试源另存local。
- status-fixture-green：无外部取消信号的完成场景，普通/11秒真实命令都通过；全部原状态、退出码、文件URI、verification断言保留。既有4项显式取消回归也通过，合计6passed/2Linux原生Windows跳过。外层Vitest看门狗60s，较仓库默认300s更严格。
- status-fixture-c7-json：实际Vitest JSON回执确认两项C7全名各通过一次，与Windows必跑清单逐字一致。
- status-fixture-parser-green：7项Windows回执解析测试通过。新原生Windows清单和回执要求两个完整C7用例名称各passed一次，不能以缺失、重复、跳过冒充执行。

没有确认原Windows实例的具体延迟持有者；这里修复的是测试把自身看门狗当作真实用户取消的语义错误。产品取消逻辑和执行时限未改。新main的四工作流由push触发，精确SHA/首次attempt另在最终CI报告验收；原失败不重跑、不取消、不删除。

log/json/红测试源码使用确定性gzip；copy-map保存原件与归档双摘要；SHA256SUMS覆盖目录全部文件（除自身）。无付费模型或release。
