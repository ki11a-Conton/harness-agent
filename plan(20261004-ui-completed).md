# Harness Agent：当前执行计划入口 — DeepSeek Harness Web UI 移植计划

详细实施前规格的兼容命名副本：[plan(20261004-022759).md](plan(20261004-022759).md)（原始 UI 制定快照的逐字节副本）。

日期：2026-10-04。实施基线：`dec7bd1237870f1d46aa063a7ba1a635e4c523c0`。
用户要求先复用 DeepSeek Harness 的 Web UI，完成后再审查 agent、制定下一轮优化计划并执行。
上一轮完整完成计划原样保留：[plan(20261004-agent-trust-completed).md](plan(20261004-agent-trust-completed).md)。

上游：<https://github.com/deepseek-ai/deepseek-harness>；冻结提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`；MIT，Copyright (c) 2026 DeepSeek。

| 做什么 | 怎么做 | 怎么验收 | 状态 |
| --- | --- | --- | --- |
| U1 复用上游 UI | 原样 vendoring 主题 CSS；移植布局、会话侧栏、聊天、输入区实际样式；提供源路径/哈希/完整 MIT。适配 DOM 与现有 HTTP/SSE | 原样文件 hash 等于冻结上游；浏览器资源本地 200；无需上游服务/CDN 即可启动 | DONE |
| U2 可用聊天工作台 | 桌面/手机布局、浅/深主题、可折叠侧栏、空状态、标题、工具/验收/审批状态、复制回复；只呈现已接入能力 | Chromium 1440×900 与 390×844 实测，无横向溢出；发送/历史/刷新/主题/侧栏/键盘正常；截图和浏览器错误保存 | DONE |
| U3 会话交互正确性 | history 与 SSE 代际守卫、messageId 去重、审批捕获原 from、切换清理、IME Enter；Gateway 审批比对发送者绑定 session，仍走既有 RPC | 慢 A 不污染 B；连续两条回复不丢、重播不翻倍；旧流/旧POST不污染新会话；审批/拒绝/取消按协议；foreign 审批保持 pending 且无 human.approval；HTML 仅作文字 | DONE |
| U4 验收与完成记录 | 具名浏览器脚本用生产 Harness/Gateway/WebServer 和 scripted provider；标记竞态协议控制；web/gateway/security/typecheck、独立审查 | 浏览器闭环和定向测试全部通过；无新增 skip；真实日志、截图对应具体源码；最终 clean 源码全仓回归 | DONE |
| U5 UI 后 agent 优化 | U1–U4 完成后审查策略/实测，新 plan.md 登记具体问题/改法/验收，再实施 | 每项有生产反例或成对评测；不绕权限/沙箱/验收；最终回归和原生 Git 发布 | ENTERED |

审查已有生产反例：连续 assistant 丢第二条；慢 A history 写入 B；foreign sender 仍能调用 session.approve。Runtime Freeze 的确定性/安全例外适用，仅作最小修复。

范围：apps/web/public、静态白名单、gateway 审批归属与相关回归。UI 不改 Core/provider/工具/promotion。上游 React/Lexical/Cordis 与本项目协议不同，复用实际源码样式并移植呈现层，不引入上游 Host。现有会话 from 绑定进程内，暂不声称重启后恢复；完整 assistant 文本仅完成后出现，不声称 token 流。

浏览器含实际生产栈与明确标签的控制场景；scripted provider 不是真实模型质量评测，paid=0，realModelQuality/promotion NOT_RUN。禁止 GitHub 连接器，原生 Git/curl 发布。历史计划/证据不改写。实施前快照：[plan(20261004-ui-preregister).md](plan(20261004-ui-preregister).md)；任务：[WEB-DSH-20261004.md](tasks/WEB-DSH-20261004.md)。

UI 阶段验收：源码 `17aa6c7471faf8bdec020b45bfe7b9bb45470131`，浏览器 26/26 场景、74 断言；gateway/web 115/115、security 2135、typecheck、docs 均通过；独立审查 20/20。原失败候选和原始日志保留。最终联合全仓回归与发布在下一计划执行；真实模型质量 NOT_RUN。证据：[web-dsh-20261004](docs/evidence/web-dsh-20261004.md)。
