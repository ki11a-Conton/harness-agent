# Web 会话生成结束状态根因

已确定性复现并修复一个宿主与既有客户端的通知协议缺口。

1. `session/list` 在模型运行中返回 `running=true`，客户端 `refreshList()` 将它写入已打开 Session 的 `running`。
2. 模型和回合完成后，`session/follow` 正确发布 turn/end，因此对话轨迹显示 Completed。
3. 原 `createEventsService` 只把新的 summary 发到 `api-session/added`。客户端该 handler 仅更新列表/投影，不更新驻留 Session.running。
4. 更新驻留运行位的正式入口是 `api-session/status` → handleSessionStatus → handleRunning。后端漏发，所以输入框仍显示 Deep diving / Stop generating。

精确 bundle 状态机重放、真实 composition → 该客户端的红/绿回归，以及真实浏览器 + 生产 HTTP 的生成中 reload 均复现旧版故障并确认补发 status(false) 后恢复。浏览器记录证明旧版已经收到 added(false)，因此不是该通知没有到达；前后端适配缺口存在于消费路径。

修复只在 events.ts 的摘要变更路径追加协议定义的 api-session/status(sessionId, running)，未改 Core/Runtime、上游不可变客户端和模型策略。即使两次扫描都为 false，也应随新摘要重发这个幂等状态：两次扫描之间客户端列表可能曾读取 running=true，不能仅按扫描器自己看到的布尔变化去重。

原 Windows CI 的失败记录中 session/list 的结果也落在 session/prompt 之后，符合上述时序窗口；原 artifact 不含该 list 结果的 running 字段，故不把未记录的字段补造成证据。修复源码的真实 Windows installed UI 已通过，旧失败仍保留。

## 验收与交付

固定干净源码 `d29537d652d35556251ac4cacdd47a7e7583b7b8`：全量 **9799 通过 / 15 跳过 / 0 失败**，安全 **2146 通过**，类型检查与文档检查通过。35 项专项包含真实 composition 到精确客户端的回归。真实 Chromium + 生产 HTTP 的原版/修正版对照在两边都实际捕获运行中的 list，原版完成后仍卡住，修正版正确清除。未执行付费模型请求。

修复分支的[真实 Windows 专项](https://github.com/ki11a-Conton/harness-agent/actions/runs/38758773791)与[同源码 UI 安装验收](https://github.com/ki11a-Conton/harness-agent/actions/runs/38758773677)通过，后者 Windows/Ubuntu 均成功。后续归档只改文档、证据和证据换行属性，推送 main 后的正式 CI 需按新 SHA 单独核对，不能把分支结果称作新 main 工作流完成。

[原始证据与完整性清单](evidence/web-running-20261015/inventory.json)，验证命令 `python docs/evidence/web-running-20261015/verify-evidence.py` 只检查字节与收据，不重跑测试。原始 Windows 失败和修复前失败均保留。原始浏览器复现脚本保留了本次执行的本地绝对路径，跨机器重放需相应调整路径并构建两个源码版本。
