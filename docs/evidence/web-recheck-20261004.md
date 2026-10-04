# Web 与 Agent 接线复验

结论：配置有效模型服务后，当前 Web 的发送、会话、审批与停止均进入真实 Harness 后端；所有可见按钮都有处理。复验基线 `b016dc3ccbb1808728617374745fae46d5c3ee87`，修复并冻结受测源码 `3adbebe8af87a8490e63365a077840b6765296ea`。本机 OpenAI 兼容确定性服务验证了真正的 `apps/web/dist/main.js` 和生产 OpenAICompatibleProvider 的 HTTP/SSE 路径，未调用线上模型、费用为零。

当前环境没有真实模型 API 配置。无 key 的正常 main 实测：页面 HTTP 200、消息接收 HTTP 200，但模型和回合明确失败，提示配置 `OPENAI_API_KEY` 后重启；没有成功完成事件。不能把页面打开、SSE 已连接或 HTTP 200 当成 agent 任务成功。

## 按钮对应关系

逐项源码映射包含 7 个静态按钮、6 个动态按钮族和4种输入/键盘动作，没有可见未绑定按钮。精确处理器、HTTP、RPC、源码行与哈希见 [原始对应表](web-recheck-20261004/raw/button-map-audit.json)。

| 控件 | 后端或本地动作 | 实测结果 |
| --- | --- | --- |
| 发送 / Enter | `POST /api/messages` → Gateway `session.create/send/run`；运行中追加消息走 `session.followup` | 模型请求、回复、实际回合与验证事件通过；Enter 只发一次 |
| 停止 | `POST /api/commands`，`cancel` → 已绑定会话 `session.status` → 当前回合 `session.cancel` | 普通及 queued 回合收到 abort；正确回合取消，外部 sender 无权取消 |
| 允许执行 / 拒绝 | `POST /api/commands`，`approve:<id>:allow/deny` → `session.approve` | 允许前无文件、允许后生产工具实际写入；拒绝不写；历史审批不可点 |
| 新建会话 | `GET /api/bootstrap` 建立浏览器身份，随后 SSE/history；首次发送才创建真实 agent session | 不串历史；新消息绑定独立后端会话 |
| 会话列表按钮 | 对应 sender 的 `/api/events` 和 `/api/history`，`/api/sessions` 获取标签 | 来回切换恢复正确历史，草稿按会话隔离 |
| 主题、侧栏展开/关闭、手机遮罩、Escape | 浏览器样式、ARIA、本地偏好 | 桌面及手机均有效，不需要后端请求 |
| 复制回复 / 复制代码 | 浏览器 Clipboard API | 实际剪贴板内容与原文/代码一致 |
| 发送失败“重新编辑” | 恢复输入框和草稿；再次发送才请求后端 | 单次明确标记 HTTP 故障后重编辑、恢复真实发送通过 |
| Shift+Enter、中文 IME、输入草稿 | 浏览器输入保护和本地存储 | 换行/组合输入不发消息，正常 Enter 仅一次请求 |

## 本轮发现与修复

1. **queued followup 无法停止**：原 clean 基线浏览器真实发送第一回合、排队第二回合并点击停止，HTTP 200 但 Gateway 指向旧回合，返回 `not_running`，第二模型调用未 abort。Gateway 改为通过已有 `session.status` 获取真实 activeTurn，仍调用原 `session.cancel`，保留直接发送的 starting 缓存回退。Core、权限、沙箱和 followup 队列未改。Gateway 和真实 JSONL Harness/Web HTTP 的持久回归均先 RED 后 GREEN；最终同源码独立浏览器6项严格断言通过。
2. **刷新出现空回复气泡**：正常 main 使用生产 HTTP 模型完成普通回复及两次工具审批后，刷新将两条空正文的 assistant/tool_calls 记录渲染为额外空泡，原严格“3条回复”断言实际得到5条。前端只跳过空正文气泡，工具和审批记录继续显示。最终 main 实测 live/refresh 恰好3条回复，各唯一、零空泡、两张历史审批卡不可操作，刷新不新增模型请求。

修复的 [Gateway RED](web-recheck-20261004/raw/gateway-queued-stop-red.log)、[Web HTTP RED](web-recheck-20261004/raw/queued-stop-reproducer/integration-red-cleanup-corrected.log)、[原始 queued 浏览器失败](web-recheck-20261004/raw/queued-stop-reproducer/result.json)、[原 main 空泡失败](web-recheck-20261004/raw/real-main-loopback/result.json)保留原件。新回归是2项 Vitest 测试与1项浏览器场景，没有减少既有断言或禁用追加消息。

## 冻结源码验收

| 验收 | 结果 | 原始记录 |
| --- | --- | --- |
| 既有浏览器闭环＋空泡回归 | 27/27 场景，77断言，0页面错误 | [browser-result](web-recheck-20261004/raw/browser-3adbebe/browser-result.json) |
| 补充桌面/手机控件 | 10/10 场景，46断言，0页面错误 | [extra-controls](web-recheck-20261004/raw/extra-controls/run-3adbebe-v2/result.json) |
| queued 回合实际 UI 停止 | 6/6 严格断言 | [queued-stop-green](web-recheck-20261004/raw/queued-stop-green/result.json) |
| 正常 Web main＋生产 HTTP 模型 | 回复、allow实际写文件、deny不写、刷新4项通过；5个模型 HTTP 请求，3完成回合，54生产事件 | [normal-main](web-recheck-20261004/raw/real-main-final-3adbebe/acceptance-summary.json) |
| 全部 Web/Gateway 相关测试 | 6文件117/117，0skip | [gate](web-recheck-20261004/raw/gates-3adbebe/web-gateway.json) |
| 安全回归 | 19文件2135/2135，0skip | [gate](web-recheck-20261004/raw/gates-3adbebe/security.json) |
| typecheck / docs | 通过 | [typecheck](web-recheck-20261004/raw/gates-3adbebe/typecheck.json)、[docs](web-recheck-20261004/raw/gates-3adbebe/docs.json) |
| 独立源码与证据复核 | 18/18，通过，无阻塞 | [review](web-recheck-20261004/raw/independent-fix-review.json) |

以上最终浏览器/正常 main/工程门均记录同一冻结 SHA、前后 clean、source/dist/static指纹。修改前基线重跑为原 **26/26**，新增回归后的验收为27场景；原件见 [baseline recheck](web-recheck-20261004/raw/browser-b016dc3/browser-result.json)。本轮没有重跑全仓；此前8419全仓及两平台CI属于旧受测源码35663ba，不能用于声明这次新源码全仓或两平台CI已通过。

额外控件首轮8/10失败也保留：[原结果](web-recheck-20261004/raw/extra-controls/run-3adbebe/result.json)。原因是探针要求合成 compositionstart 后真实 Chromium Enter 不改变 textarea 原字节，但原生默认行为可插入换行；实际上没有发送。第二失败由第一场景提前退出、未建立A会话导致。探针改为检查正文未丢、零POST/零模型调用，并分别建立会话控制，产品代码不变。原脚本和新脚本哈希均与各自结果对应，未覆盖失败。

## 范围与证据

正常启动使用默认 interactive Harness；memory/delegation并未默认启用，fixture自带验证命令不代表默认 main 自动配置了任务验收。当前没有模型切换或设置按钮；模型通过环境变量配置。浏览器刷新恢复同一后端进程的历史；身份绑定在内存，服务重启后旧身份不自动恢复 durable session。模型完整回复落库后显示，SSE传送状态，未证明逐token输出或线上模型任务质量。

停止定位当前运行回合，不清空后续队列。查询与取消之间如果回合发生变化，actor会安全返回 `not_running`；自动followup短暂starting阶段不在此次保证范围，不会为了停止而取消另一个回合。取消请求接受与最终落库的取消结果分别观察。

受测修复已通过原生 Git 推送main：[push](web-recheck-20261004/raw/publish/tested-source-main-push.json)、[ref](web-recheck-20261004/raw/publish/tested-source-main-ref.json)。最后完成记录仅更新说明、任务、证据及原字节保存规则，程序代码与受测源码等价；最终提交 SHA 与 Git/API核验保存于工作区`.ci/web-recheck-20261004/publish/final-publication-verification.json`并在最终答复标明。

原始选定证据：[artifact-index](web-recheck-20261004/artifact-index.json)，包含 probe、日志、请求、runtime snapshot、截图、真实RED及错误oracle观测；可再生成的fixture workspace/runtime-data/data目录不纳入包。验原字节：`node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/web-recheck-20261004/artifact-index.json`。所有模型控制均本机确定性输入，paid=0，liveModelQuality/promotion NOT_RUN。
