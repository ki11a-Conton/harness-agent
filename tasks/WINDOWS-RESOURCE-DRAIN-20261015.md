# Windows 资源收尾与目录租约排查

基线 f2eb7f87：本地完整 9800 passed /15 skipped；远端 Windows verify 在
configured model limits fixture 出现 DataDirLeaseError，formal 在 schedule
session-isolation fixture 清理时出现 ENOTEMPTY。保留原失败，不重跑替代。

做什么：定位关闭后的异步写入及实际锁端口冲突。怎么做：读取原始 artifact，
先用屏障构建 actor close 的确定性反例，再实施最小修复；只有复现的正确性
缺陷允许触碰冻结 Runtime；不随机换端口、不绕过单写者保护。怎么验收：
反例修复前失败、修复后通过；队列恢复/取消/关闭竞态、真实 activity、目录租约
安全回归、typecheck/security/full suite 和精确提交真实 Windows CI。

会话状态原始超时在 Windows focused/full 各 30 次均未复现，根因未明仍保留。
不使用连接器、子 agent、付费模型或 release，不触碰原始脏工作区。
