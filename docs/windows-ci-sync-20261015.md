# Windows CI 两项测试同步修复

基线 main `6e81e2e976e678ab78f610ea3cd699d35d9e1986`，CI run 38761338730。
本提交只改变测试和文档，不改 Runtime、安全策略或产品实现。

## 观察与修改

- 预算 mid-stream 测试在 `drain()` 的持久化准备之前计算 300ms 截止时间。
  准备耗时越界时，发送前门禁正确拒绝，原测试却仍断言 provider entered=1。
  现在注入时钟在准备阶段固定，进入 transport 后开始真实计时，真实 abort
  timer 仍必须中断 30s stall；新增独立用例验证准备期间过期时零发送并释放预留。
- composition coding 测试最多轮询 300 次、每次等待 5ms，早于真实 HTTP
  返回就能报错。失败后未持有的 actor 继续运行，而 cleanup 已关闭 owner，
  又产生未处理的 `Workspace owner manager is closed`。
  现在在启动 actor 前订阅真实 ApprovalStore.create，调用原 create 完成持久化
  后才报告 readiness；真实审批和文件、journal、diff 断言保留。任务结束过早
  或拒绝直接传播，cleanup 先取消并等待任务，再关闭 owner。

## 受控验收

证据在 [evidence/windows-ci-sync-20261015](evidence/windows-ci-sync-20261015/receipt.json)。

- 在精确基线上，只通过 Vitest transform 给 cost reservation 增加 500ms、
  第一个本地 HTTP 响应增加 5000ms，两个原用例均失败；另捕获 1 个未处理的
  owner-closed rejection。修复后在相同注入下两个用例通过，没有未处理错误。
- 三个相关测试文件合计 26 passed；typecheck 退出 0；安全测试 2146 passed。
- 仅移除真实 deadline callback 的 abort，修改后的 mid-stream 用例 30s 后
  因 aborted=false 失败。因此它仍检测真实中断，未把测试改成只检查错误字符串。
- `inventory.json` 绑定原始日志和配置的 SHA-256；.gitattributes 保留原字节。

复现配置必须先复制到根目录 `.ci/windows-ci-fix/`，相对 import 才能找到
`vitest.config.ts`。在基线或修复工作树执行：

```sh
pnpm exec vitest run --config .ci/windows-ci-fix/red.config.ts apps/web/src/deepseek/composition.integration.test.ts packages/evaluation/src/tool-call-efficiency-tool-budget.test.ts -t 'R3-mid-stream|a production-composed selected coding model'
```

归档配置名为 `timing-repro.config.ts`，复制时命名 `red.config.ts`。mutation
配置同样复制到 `.ci/windows-ci-fix/no-abort.config.ts`，只运行 R3-mid-stream。

## 尚未闭环

完整套件与提交后精确源码的 Windows/Ubuntu CI 仍待验收。原始新增
`session-running-status.regressions.test.ts` 的 25000ms 超时仍未定位；独立
诊断 workflow 的成功不替代原失败，也不能把本提交描述为三项全部修复。
受控实验证明两处时序假设与同样的失败症状，不虚构原 Windows IO 的耗时。
