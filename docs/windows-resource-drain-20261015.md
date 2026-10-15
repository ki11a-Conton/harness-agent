# Windows 资源关闭复核

f2eb7f87 的本地完整套件 9800 passed /15 skipped；真实 Windows CI
38777915854 的 verify 在模型参数测试遇到固定端口冲突，formal 在实际
schedule session-isolation 测试清理目录时出现 ENOTEMPTY。原始日志由
Actions 38779942246 从已有 artifact 投影，没有重跑原失败。

## 关闭竞态

`DefaultSessionActor.closeOwned()` 等待运行中的 turn 和终结 ACK，却没有等待
后台 followup drain。扫描恢复记录、出队、创建 turn、绑定 turn 都可能跨越
await，此时 actor 尚非 running，close 会释放资源并让宿主关闭存储和目录租约。
后续 drain 仍可写入状态，形成目录清理失败的窗口。

新增四个可控屏障用例，在实际 actor/runtime/store 操作边界挂起，基线四项均
因 close 提前返回失败。修复只跟踪 drain 完成屏障，在关闭时等待，并在异步
扫描和出队后检查关闭状态。修复后四项通过，没有资源释放后的写入或模型请求，
扫描和出队阶段取消不会再创建 turn。该确定性缺陷满足 Runtime 冻结的正确性
例外。它证明关闭窗口存在，不声称能从原 ENOTEMPTY 的无堆栈日志还原每个 IO。

## 租约边界

原报错是旧兼容锁端口 127.0.0.1:49666 的 EACCES，随后连接探测成功，因此
拒绝启动符合当前单写者保护策略。日志不能辨认监听进程，不将其虚构为某个
Windows 服务，也不据此弱化保护。产品 `data-dir-lease.ts` 完全不改。

模型窗口/输出上限测试不验证持久化，改用已支持的 memory host，保留真实
loopback HTTP 请求及所有参数断言。其他持久化、重启和 legacy lease 拒绝用例
继续覆盖原路径。固定端口被占用仍可使生产宿主拒绝启动，这是保留的操作约束。

## 验收与未决项

[原始证据和 SHA-256 清单](evidence/windows-resource-20261015/receipt.json)：
四个基线反例失败，修复后相关 135 项、竞态 23、安全 2146 通过，typecheck 退出 0。
baseline.config.ts 先复制到 `.ci/windows-resource/`，再以该配置运行 Vitest，
会读取 Git 中精确 f2eb7f87 的 actor 源码验证反例。完整源码和远端双平台 CI 待完成。

原始新增会话状态测试 25 秒超时，在 Windows 单独和完整诊断各 30 次未复现，
full 组最慢 1612ms。诊断插桩使树 dirty，其他六项失败，因此不是全量验收。
两项早先的审批/预算同步修复已包含在本提交祖先中，见上一报告。未发布 release。
