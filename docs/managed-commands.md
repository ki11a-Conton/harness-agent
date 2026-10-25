# 受管理的长命令（实验，默认关闭）

这是 Agent/tool/host 层的可选能力。未配置时，工具列表、提示词、冻结配置和原有同步 `exec` 语义保持原样。没有 PTY、交互式 stdin、分离守护进程或自动重放。

CLI/Web 需要明确启用，并提供实际项目检查：

```sh
HARNESS_MANAGED_COMMANDS=1 HARNESS_MANAGED_TURN_MS=600000 HARNESS_VERIFY_COMMAND="npm test" node apps/web/dist/main.js
```

CLI 也支持同样环境变量，或使用已有 `run … --verify "npm test"`。SDK 服务端通过 `createHarness({ …, managedCommands: { enabled: true }, limits: { maxDurationMs: 600000 }, task: { …, verification: [{ kind: "command", command: "npm test" }] } })` 开启；客户端不能通过请求参数提高预算或开启服务器未提供的能力。Web 的权限、发送和停止按钮沿用现有入口，工具动作仍走 PermissionEngine、ToolOrchestrator、SandboxManager。

- `exec_start`：structured argv 或原有 shell recipe，只启动一次并有限等待，返回 `jobId`。工具回执成功表示已受理，不表示命令退出成功。
- `exec_poll`：携带同一 `jobId` 和上一回执的 `pollToken`。每次查询仍计入原始工具/turn 预算，最长等待10秒。正文只返回游标后的 UTF-8 输出；`lostBytes`、`incomplete` 表示已丢失内容，不能据此声称完整日志。可显式传 `cursor` 重读尚保留部分。
- `exec_cancel`：请求终止并等待原 ProcessExecutor 的进程树清理。取消不是退出0。取消清理错误保留为 unknown。
- `exec_jobs`：压缩后查询同一 session/turn/agent/规范工作区/策略 owner 的句柄，不启动命令，不返回其他 owner 的输出。

初始上限为每 owner 4、整个宿主进程16个 pending/running，128个保留记录；同一或嵌套工作区采用更严格的单个活跃命令锁。每个命令增量输出最多64KiB，并尊重更低的 sandbox capture cap。执行期间可继续读代码和经授权的只读 API 检查，其它写入、新命令受到 narrowing hook 和最终执行边界双重阻止。多个 Web Harness 实例共享容量/工作区锁，不共享句柄访问权。

绝对期限取原始 turn 剩余预算、sandbox 进程上限和单命令上限的最小值，poll 和恢复都不会延长它。owner 取消、turn 结束和宿主关闭负责清理。未完成、失败、未知或非主动取消的命令阻止原 TaskVerifier 的完成门禁；修复代码后，使用完全相同命令及 `supersedes` 指向失败句柄，真实成功才消解该失败。显式终止用于 API 检查的服务可以结束生命周期，但不会被描述成命令成功。

持久宿主在启动前原子写入并同步不含命令、环境或正文的 journal。重启后遗留记录全部进入 unknown，对工作区执行 fail-closed 对账；不使用旧 PID 重新接管、不自动重跑未知副作用。用户必须独立核查进程和工作区后再处理这些记录；当前没有模型可调用的“信任并清除”接口。

工程对照脚本为 `node scripts/research/managed-commands-20261025/paired.mjs NEW_OUTPUT_DIR`：固定 clean SHA，同一宿主源码的默认关闭基线与显式开启候选，3类真实 Git 仓库任务，各8对、共48臂。实际付费模型调用为0；这证明协议、工程重叠和安全行为，不代表真实模型任务成功率、摘要质量或成本收益。

验收状态及失败记录见 [实施计划](../plan(20261024-managed-command-harness).md)。发行标签与资产不随此实验自动更新。
