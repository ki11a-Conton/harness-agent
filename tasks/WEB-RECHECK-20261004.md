# WEB-RECHECK-20261004

用户要求再次确认 Web 是否能运行 agent，以及所有实际按钮与后端是否对应。
复验基线：`b016dc3ccbb1808728617374745fae46d5c3ee87`。

做什么：重新执行现有浏览器验收，核对全部按钮与 HTTP/RPC 对应关系，补测正常 Web main 的模型入口和运行中追加消息后的停止。

怎么做：生产 Harness/Gateway/WebServer + Chromium 真实 DOM；正常 main 分别验证缺失模型配置的显式失败，以及本机 OpenAI 兼容确定性服务的 HTTP 接线。模型服务与 scripted provider 均为离线控制，不声称真实模型任务质量。原始记录保存在 `.ci/web-recheck-20261004/`。

已实测缺陷：首回合完成后，queued followup 自动开始新回合；UI 停止发出真实 `/api/commands`，Gateway 的缓存仍指向首回合，返回 not_running，新回合未 abort。保留原始 clean 浏览器复现与截图。

修复范围：Gateway 通过现有 `session.status` 查询已绑定 sender 的当前 activeTurn，再调用现有 `session.cancel`。保留 starting 阶段缓存回退、sender/session 归属和 actor 取消语义。Core、权限、沙箱、验证与 followup 队列合同不改。

正常 main 的本机 OpenAI 兼容 HTTP 模型闭环另发现：刷新历史后，content 为空的 assistant/tool_calls 记录被渲染成空回复气泡。保留原严格 count 失败，前端只跳过空文本气泡，真实 tool/approval 记录及非空回复不隐藏；增加 history/live/replay 浏览器回归。

怎么验收：新增 Gateway/真实 Web HTTP 回归先 RED 后 GREEN；第二回合取消、第一回合完成、human.cancel 指向正确回合，外部 sender 无权取消。重跑原浏览器复现、26 场景验收及补充按钮实测；正常 main HTTP 模型回复和审批闭环；typecheck、相关 Gateway/Web 回归、安全、docs/diff 通过。明确 HTTP200 仅代表接收、无模型 key 时不能完成任务，以及进程重启不恢复会话绑定的已有边界。

DONE：冻结源码 `3adbebe8af87a8490e63365a077840b6765296ea`，Gateway/Web 117/117、安全 2135/2135、typecheck/docs 全部通过。原浏览器增加空气泡回归后 27/27、77 断言；补充控件 10/10、46 断言；queued stop 6 项严格真实浏览器断言通过；实际 main + 本机 OpenAI HTTP 模型的回复、allow/deny、刷新 4 项通过。独审 18/18。原始 RED/失败探针与修正版本均保留，paid=0、线上模型质量 NOT_RUN；不是在本轮重跑了全仓测试。受测修复已原生 Git 发布 main；完成报告仅追加说明和证据及其字节保存规则，程序与受测源码等价。证据：[Web 复验报告](../docs/evidence/web-recheck-20261004.md)。
