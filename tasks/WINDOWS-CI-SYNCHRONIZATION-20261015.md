# Windows CI 三项失败闭环

用户要求继续处理精确 main 6e81e2e9 的 CI 失败。原始结果保存在本地
`/workspace/harness-agent-ci-review-6e81e2e9-20261015/`；原始运行不重跑、不取消。

1. 做什么：定位会话状态回归超时、secondary workspace 审批等待失败、provider deadline 用例 entered=0；区分功能缺陷和测试同步假设。
2. 怎么做：隔离工作树；保留原日志；为失败建立受控复现；修改最小范围；不凭推测改 Runtime，不跳过断言，不以延长超时替代同步。
3. 怎么验收：原失败条件的修复前失败/修复后通过；相关 integration/security、typecheck 和完整套件；提交后验证同一个 SHA 的真实 Windows 和 Ubuntu CI。诊断插桩 dirty tree 的结果不作为发布验收。

禁止 GitHub 连接器、子 agent、付费模型调用、release；不触碰原始脏工作区。
