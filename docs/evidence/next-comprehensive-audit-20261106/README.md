# 下一轮全面审查（2026-11-06）

基线main `3e4f6e734667abb2f77c5023ac128785502799f5`，修复源码 `988c0b7cc1dd157f92fd3ec0c9baf690a8efa2f8`。本轮只认领新增、实际复现的四组问题；计划见根目录 `plan(20261106-next-comprehensive-audit).md`，任务见 `tasks/NEXT-COMPREHENSIVE-AUDIT-20261106.md`。

| ID | 问题及实际影响 | 修复和证明 |
| --- | --- | --- |
| N1 | SSE工具按首次到达顺序执行，忽略index；先edit后write把文件留在错误结果，命令验证失败 | 数字索引排序；交错片段、稀疏索引和实际HTTP→Runtime→write/edit→Verification通过 |
| N2 | 长Retry-After/退避/请求截止的Node timer溢出成1ms，提早请求或超时；零基数大指数变NaN | 单调时钟分段等待、取消/清理、零退避；真实HTTP请求数量和完整多段时间证明，原请求截止/重试次数不变 |
| N3 | inbox并发首次读取或读取失败污染空缓存，写失败仍修改内存，导致丢旧任务/复活被拒任务/错误消费 | single-flight完整快照、copy-on-write、落盘后发布、失败失效重读；实际文件/目录故障证明 |
| N4 | followup预留在await之后未复查，被并发调用覆盖并破坏FIFO和durable绑定 | 恢复后再次检查唯一预留；冷/热并发及释放/实际绑定消费证明 |

同一最终27项新增回归在独立原main检出25失败/2对照通过；修复后原完整 `pnpm test` 10735通过/16原条件跳过，701文件通过/2跳过，包含相关单元、集成和安全套件。原测试配置、排除项、预算、安全边界和必选断言均未改。构建使用冻结依赖、Node24.19.0，原全量测试命令无附加筛选；原始完整日志以xz保存并核对回执SHA256。

真实CLI/Web工程50断言+提示词接线8断言通过，19实际HTTP请求。正式宿主浏览器42场景/120检查/0页面或连接错误，桌面及两种响应式窄视口，不代表实体手机或所有控件穷尽。浏览器fixture未直接报告sourceSha，来源由干净runner的前后SHA、launch源码路径与compiledDigest绑定；1050个编译文件已逐一重新计算hash一致。大体积浏览器原始RPC响应/截图/完整编译清单未打包，摘要保留实际hash并明确归档范围。

托管命令48实际臂，候选24/24、基线16/24、候选重叠16、重复启动0、failures空。两臂协调门禁不同，属于工程协议验证，不能当作相同工作量速度或真实模型质量收益。模型全部为本地脚本服务，无付费调用，真实模型质量NOT_PROVEN。

初版测试fixture把maxIterations错放在limits内，类型检查发现后已改为maxIterationsPerTurn，在独立原main重新取RED。初版长等待4项的fetch替身忽略abort，把被原生fetch拒绝的调用算成网络请求；失败日志和回执保留，最终改为真实HTTP计数，原模型测试的fetch调用次数断言全部保留。正式最终RED/GREEN采用相同最终测试字节。原实际protocol探针中两个coding构造参数/limits字段被JS忽略：它不作为迭代上限或provider重试配额的证明；最终类型通过的实际HTTP集成测试设置了正确maxIterationsPerTurn=4、maxToolCalls=4、provider retries=0。原探针前后字节相同、原生产源码hash一致，原文件和失败日志不重写。

Windows在原102测试文件末尾追加5文件，必选46项和解析器完全不变。归档时最终main的四组CI尚未触发；以对应最终SHA的Actions和实际win32/Windows_NT/clean回执为准，不预填Windows通过。没有发release。

摘要截断的时序取舍、超大SSE行和其他store跨实例缓存仅是审查候选，本轮未形成完整复现/修复，不认领。不能保证穷尽全部潜在bug。

复验：`pnpm install --frozen-lockfile`，`pnpm exec tsc -b --force`，`pnpm test`。精确新增回归可单独 `pnpm exec vitest run packages/model/src/openai-stream-order.regressions.test.ts packages/model/src/openai-long-delay.regressions.test.ts packages/session/src/inbox-atomicity.regressions.test.ts packages/core/src/runtime/followup-reservation.regressions.test.ts packages/harness/src/stream-tool-order.integration.test.ts`。本目录两个原实际探针保留了当时Linux临时路径，复现前需准备该目录，或使用上述可移植正式回归。
