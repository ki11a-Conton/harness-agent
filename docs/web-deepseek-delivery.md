# 官方 DeepSeek Web UI 当前交付（2026-10-13）

根页面现在使用官方完整客户端，通过 `window.__DSH_TRANSPORT__.rpc` 调用生产 Harness。旧客户端位于 `/legacy/index.html`。这次采用原发布 bundle，而不是再造少量相似 CSS/DOM。浏览器测试未 mock RPC、未拦截响应、未向页面注入模型输出；HTTP provider 是明确的本地测试 fixture。

## 来源与运行

- npm `@deepseek-ai/dsh-web-frontend@0.2.1-alpha.1` 及完整组件闭包：67 原始 tar、334 原始发布文件、33,142,095 bytes。66 默认动态 client entry 本地装配；772 文件封存包括原件、来源、notice、transport/boot 和本地移动设置 CSS。
- 源码参考 `deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`；npm 没有 gitHead，不能称同一源码逐字构建。MIT、字体 OFL 等见 [许可证](web-deepseek-frontend-licenses.md)。原 bundle 不修改，`harness-adaptations.css` 为宿主适配。
- 开发运行：`pnpm install --frozen-lockfile`、`pnpm typecheck`，在项目目录设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、独立的 `HARNESS_DATA_DIR` 后运行 `node <repo>/apps/web/dist/main.js`，默认 `http://127.0.0.1:8787`。没有模型 key 的 stub 启动不证明 coding 质量。
- 原 [146 项审查](web-deepseek-parity-matrix.json)保留为 d245102 旧 UI 基线。[当前矩阵](web-deepseek-delivery-matrix.json)逐 stable id 区分已验收、组件已装配但控件待验收、backend 已测、阻断和可选；不根据文件存在计算功能完成率。

## 这轮发现并修复的缺陷

| 问题 | 修复与验收 |
| --- | --- |
| 官方长连接占满浏览器 HTTP/1.1 六连接，Send 请求不能抵达服务端 | 单 WebSocket multiplex，bounded 请求/队列/backpressure/heartbeat；HTTP 回退保留。真实 transport 与浏览器发送通过 |
| plugin lazy terminal URL 与本地静态路径不一致，点击后加载失败 | 只接受白名单 id/revision/client 文件，复用原始 bytes；对应 HTTP 回归与实际加载检查 |
| 一 tab 关闭会关掉 shared services；socket 退出可拖住 host 停机 | per-peer close 与全局 service close 分离，限时 drain/terminate，断线取消实际请求 |
| 假模型选择、已冻结会话模型/工作区可被表面更改 | blank draft 创建新 native owner 并持久 alias CAS；admitted session 明确拒绝；完整 provider fingerprint 防止旧缓存路由漂移 |
| 模型选择有 CAS/activation 窗口，page/follow/file read 可读到 failed/退役物理身份 | 短 snapshot 使用同一 alias lock，旧/新 journal 形成稳定全局坐标；长流不持锁；物理替代 ID 不公开 |
| 配置了窗口/输出上限却仍使用 provider 默认值 | metadata capabilities 接 context budget，actual `max_tokens` clamp；真实 loopback HTTP 与预算事件断言 |
| 子 owner 的 agent UUID 不能匹配角色目录，界面显示 UUID | 展示/选择使用实际 role name，物理 Runtime agentId 保持不变；activity/session/projection 回归 |
| session 未加载 actor 被误当 agent 不可用、历史私有失败 draft 泄露进列表 | 使用实际 session agent owner，过滤初始化私有失败；恢复与 generation 回归 |
| ask 只有 waiting，没有正式 tool advertisement；回答可能另开 turn | reserved formal ask phase，不伪装普通 executable tool；方法内核验真实 ask/session/turn/history，幂等 crash 恢复；实际 HTTP + 三视口刷新后继续原 turn |
| 取消/超时审批只结算内存 waiter，durable pending 未清理 | outcome 写回同一审批 store；取消/超时/reopen/已有决定只写一次。历史 RED 保留 |
| byte range 可切碎读取 secret，绕过全文件秘密检查 | 限额 FD snapshot 先整体 scan 后切 range，并核验版本；拒绝软链/hardlink/替换/文件增长竞态 |
| private catalog/owner index/metadata receipt/activity store 存在 lstat/read 的 TOCTOU | nofollow descriptor、有界读取、inode/nlink/parent/大小检查，private 文件权限；实际 RED/GREEN |
| timer due/update、workspace stop/archive、alias 变化竞争可假提交或覆盖活动状态 | due CAS、admission fence、stable inbox receipt；父子/PTY/任务/未消费 inbox 都计活动，无法原子取消的队列继续阻挡归档 |
| UI upload/terminal/metadata 用错 physical owner，或可绕实际 frozen policy | 私有宿主工具按实际 owner 注册，通过 ToolOrchestrator/PermissionEngine/SandboxManager；副作用与 alias 共用锁，失败不造成功 |
| 改动/交付外部 observer 可覆盖实际 capture，source sequence 不稳定 | 固定真实事件 capture、稳定 journal coordinates、owner 归属 ZIP/export，实际文件/工具投影 |
| 手机模型设置固定宽导航挡住表单 Cancel 按钮 | 仅本地适配样式，≤600px 设置导航横排；390×844 与 320×1100 实际 pointer 点击通过 |
| portable 漏执行模式，长 DeepSeek notice 名无法合法 USTAR 分割 | schema 2 绑定文件 mode，合法 slash 搜索/严格 header/size 检查；真实 notice roundtrip 与篡改拒绝 |
| fresh install ignore-scripts 导致 node-pty addon 未安装 | 只执行锁定且已审查的 node-pty lifecycle，保存原跨平台 prebuild；Node 22/24 actual import/spawn fixture 通过，不等于强沙箱 PTY 可用 |
| 全量门把 Linux 已死的 zombie 当成仍执行进程，旧首页测试大小写过度约束 | 仅修测试语义：实际 `/proc` Z 为已退出，其他活进程仍失败；首页检测真实官方入口。原失败报告保留，不降低产品边界 |

每个域的回归位于 `apps/web/src/deepseek/*.test.ts`；Core ask 与 security settlement 的回归在各自包中。历史原件位于 `docs/evidence/web-deepseek-parity-20261011/`、`20261012/`、`20261013/`，文件名 green 不代替其报告状态；runner 的 selector 错误与产品缺陷分开记录。

## 当前验收证据

- [生产浏览器最终报告](evidence/web-deepseek-parity-20261013/browser-final/result.json)：30 场景、75 断言 PASS；桌面 1440×900、手机 390×844、窄高 320×1100，Chromium 151.0.7922.173、Playwright 1.55.1。覆盖主题/模型编辑/目录选择/文件预览/会话生命周期/流式 Markdown 与刷新/真实 read/write/批准拒绝/提问刷新回答。没有外部资源请求或未预期 RPC/browser 错误。
- [模型浏览器报告](evidence/web-deepseek-parity-20261013/model-browser-final/result.json)：17 断言 PASS；真实 profile/credential、实际替代 model HTTP request、双 tab、follow/page/selection 一致、旧草稿 cursor、新 turn、冻结拒绝及重启恢复。个别 screenshot 抓取有独立 timeout 记录，不冒充图片通过，也没有拿图片替代请求证据。
- [最新相关回归](evidence/web-deepseek-parity-20261013/final-gates/preset-and-models.json)：60 PASS；actual composition 包含模型窗口/输出限制的 HTTP 断言。其他 RED/GREEN 见相应目录。
- 最终 clean 全量/security/protocol、完整 portable 与实际 Windows 消费结果将在固定源码上运行并另补 receipt。`deepseek-ui-installed.yml` 让 Ubuntu 构建一次，Ubuntu/Windows 使用同一 SHA256 archive，再运行上述 30 场景；未运行前不称 Windows PASS。

## 尚未完成的功能与发布条件

以下缺口不是靠移植 React/bundle 就能完成的后端能力，已明确拒绝或显示不可用：

1. `session/updateQueue` 原子 edit/remove/steer-now；现有 enqueue/steer/cancel 不等于任意编辑已持久 inbox。
2. frozen session 的权限 preset 和根 agent preset 更换；现有 native role delegation 保留，不能改写已有 owner 身份。
3. Cordis 动态 bundle 安装/启停/配置；列表可读，管理变更未挂载。
4. durable goal continuation、DeepSeek Plan review/loop、continuable 子 agent inbox；native one-shot delegation 不冒充可继续子会话。
5. 泛用图片/二进制模型输入；目前受限 UTF-8 文本上传，不能把上传成功当多模态理解。
6. native OS open-in-app；headless 应用目录为空且 ability=false，网页文件 preview 可用。
7. 本 managed Linux 不支持强 PTY confinement，实际 owner 返回 `SANDBOX_BACKEND_DENIED`；native addon 可加载不证明产品交互终端通过。手机右栏打开时 approval 需收起右栏查看，尚待统一交互验收。
8. 矩阵中尚未实际操作的默认细项，如高级 preview/复杂 Markdown、快捷键所有分支、完整 trajectory/artifact/skill 交互，还不能从组件装配或后端 unit PASS 推广为逐控件通过。

因此本次作为有明确能力边界的代码候选提交，不声明 140 个默认细项全部完成，不发布“全功能生产级” release。W3–W6 整域仍部分完成。真实付费模型 coding 质量为 NOT_PROVEN；用户线下实验与这次工程接线证据分别记录。v1.9/c5 发布与 N7 结论不改写。
