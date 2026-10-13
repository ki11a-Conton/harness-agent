# 最终工程审查（执行中）

基线 main：5058d536d44acd61369d822cea4e160b553dff4b。独立工作区；本轮不发布 release/tag，交付后由用户本地测试决定。

## 已确认问题与修复方向

| ID | 严重性 | 实际触发与结果 | 修复与验收 |
| --- | --- | --- | --- |
| FA-1 | P1 | CLI 模型发出 ask_user 后未调用终端问答处理，退出码 1、原 turn 留在 waiting_for_user、pending ask 未回答。 | 接通实际问答 RPC、原 turn 恢复、EOF/Ctrl-C 和重启待答路径；断言答案只入原任务一次，不创建新任务，不跳过审批。 |
| FA-2 | P1 | 实际 exec 输出测试用合成 API key，模型 tool message 已脱敏，但 tool.output 和 tool.completed.outputPreview 事件仍含明文。 | 在生产工具事件边界保护未提交输出和结果预览；检查分片、超长、转义、失败、其他字段，事件/存储/UI/model 均不含合成 key。 |
| FA-3 | P1 | WorkspaceChangeTransaction 对工作区内指向外部目录的 symlink 可成功 snapshot/commit，实际改写外部文件。 | 原语在快照、提交和回滚前检查完整路径与文件身份，拒绝目标及祖先 symlink；原件不变，普通内部路径仍成功。 |
| FA-4 | P1 | 事务快照把非 UTF-8 字节解码成替换符，commit 后 rollback 无法恢复原字节；私有文件权限也会被临时文件默认模式替换。 | 快照拒绝不可无损解码的内容、保留原模式；读取错误不视为不存在，批量快照失败不留下半份新意图。 |

## 初始检查

typecheck 通过。全量基线 549 文件，9,469 PASS / 6 FAIL / 15 skipped；6 个失败均由尚未提交的本轮计划文档触发 clean-source/晋升门拒绝，原件保留，不归为产品缺陷。最终全量必须在固定 clean 提交上重跑。首次离线安装缺 npm metadata，改用正常代理网络和可写 cache 后完成；未改变锁文件和安全门。

后续记录包括源码审查覆盖、RED/GREEN、固定源码工程门、安装包/浏览器、本地测试步骤和仍未支持的能力。不以测试通过声称不存在所有潜在 bug。
