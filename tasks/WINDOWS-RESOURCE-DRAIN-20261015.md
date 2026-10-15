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

后续 00a6219d 的 Windows formal 又在 external host observer 功能测试遇到租约冲突。
将 composition 功能 fixture 默认设为 memory host，只有明确验证恢复的测试启用
durableStorage:true；不改任何业务断言、产品租约或 Runtime。强制冲突下基线
3 fail/1 pass，修正后功能 4 pass，持久化恢复仍按预期拒绝；正常 9 项与精确 CI 待复核。

固定源码最终验收：`d6e00881dc804371165170c2a9a0697e34ff7b54` 四个 CI 工作流与十个主 CI 任务全部通过。原始失败保留，原单次会话超时仍是未复现项；主分支归档提交单独监听，不发布 release。
