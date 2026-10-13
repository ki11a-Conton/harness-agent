# 官方 DeepSeek Web UI 当前交付（2026-10-13）

根页面现在使用官方完整客户端，通过 `window.__DSH_TRANSPORT__.rpc` 调用生产 Harness。旧客户端位于 `/legacy/index.html`。这次采用原发布 bundle，而不是再造少量相似 CSS/DOM。浏览器测试未 mock RPC、未拦截响应、未向页面注入模型输出；HTTP provider 是明确的本地测试 fixture。

固定验收源码：`b38566d5c370509db58cbb495aaf4eb68cbe3ce3`，tree `bf6272b1e03ba788a1437f0520dfaba4d614f94c`。后续文档归档提交不作为测试执行 SHA；原主 CI 的文档门失败与后续文档修正分别归档。

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
| 实际完整包发现 xterm npm 包声明 MIT 却漏独立 LICENSE，构建被拒绝 | 只对固定两个包的 name/version/license/commit 引入固定上游原 LICENSE，并绑定 SHA256；其他缺许可证的包继续拒绝，不放宽全局门 |
| 全量门把 Linux 已死的 zombie 当成仍执行进程，旧首页测试大小写过度约束 | 仅修测试语义：实际 `/proc` Z 为已退出，其他活进程仍失败；首页检测真实官方入口。原失败报告保留，不降低产品边界 |
| Windows 8.3 路径与实际根目录比较产生误拒绝 | 所有目录边界以 canonical physical parent 核验；路径逃逸仍拒绝。Windows fixture 使用 realpath，以真实路径验收 |
| Windows reader/scanner 锁使原子替换瞬时 EPERM，或者并发临时文件互相覆盖 | UUID + wx 独立临时文件；仅 Windows EPERM/EACCES/EBUSY 允许最多 16 次原子 rename、累计重试等待 5.13s。拒绝删除旧 target 后重建；耗尽/永久错误仍失败 |
| 新 draft 的 control frame 发负 sequence，或发第二个 opening baseline，官方 store 拒绝 | 仅一个开场 baseline；未提交的空 cursor 不发 live projection，后续必须真实 committed 非负 seq。原始 UI/Windows 红例保留 |
| Windows 高端口保留区使 CLI 单写者 lease 不能启动 | 新版固定低端口映射，并尝试保有旧高端口兼容 guard；真实旧 listener 仍拒绝。端口冲突不随机换锁，不接受多机共享数据目录 |
| 原 turn 回答的 metadata 与 native terminal inbox ACK 在关闭返回后仍写盘 | host 排序 drain 正在处理的调用/continuation/metadata，再关闭 native owner；actor 保有消费 ACK，所有并发 close 等待同一收尾。门控原件 RED → GREEN |
| 重启后新 registry ID 不能提供原 role 名，官方 header 显示 UUID | 新 Session 保存身份绑定的 cosmetic metadata；当前 registry 展示元数据仍优先。策略仍只取原 validated effective config；真实重启后的 DOM/projection 验收 |
| 一些验收 fixture 把 pending ask 当作 turn 已 waiting，或忽略 Windows rm 临时争用 | 状态屏障等待真实 waiting/positive turn 数；只对 Windows 测试目录应用 Node 有界 rm 重试。覆盖率阈值和安全拒绝门不降低 |

每个域的回归位于 `apps/web/src/deepseek/*.test.ts`；Core ask 与 security settlement 的回归在各自包中。历史原件位于 `docs/evidence/web-deepseek-parity-20261011/`、`20261012/`、`20261013/`，文件名 green 不代替其报告状态；runner 的 selector 错误与产品缺陷分开记录。

## 固定源码工程验收

- 固定运行时代码 [`b38566d`](https://github.com/ki11a-Conton/harness-agent/commit/b38566d5c370509db58cbb495aaf4eb68cbe3ce3)：[全量原件](evidence/web-deepseek-parity-20261013/accepted-b38566d/full.json) 9,473 PASS / 15 skipped；[安全](evidence/web-deepseek-parity-20261013/accepted-b38566d/security.json) 2,146 PASS；[协议](evidence/web-deepseek-parity-20261013/accepted-b38566d/protocol.json) 52 PASS。测试时 clean；后续归档为 docs-only，不冒充在新文档 SHA 重跑全量。
- [独立包官方 UI](evidence/web-deepseek-parity-20261013/accepted-b38566d/official-ui-consumer/result.json)：三视口 30 场景 / 75 断言 PASS；设置、模型表单、目录/文件、会话生命周期、流式 Markdown/刷新、真实读写、批准/拒绝、提问刷新继续原 turn。
- [模型/重启浏览器](evidence/web-deepseek-parity-20261013/accepted-b38566d/model-browser/result.json)：18 断言 PASS，包含真实 HTTP route/credential、双 tab、冻结拒绝、历史前缀、实际角色标签和 Core artifact 身份。个别 screenshot timeout 独立列为 BLOCKED，不计作图片成功。
- [真实 Windows](evidence/web-deepseek-parity-20261013/accepted-b38566d/native-windows-receipt.json)：253 PASS / 1 skipped，Windows_NT 10.0.26100、Node 22.23.3；[workflow](https://github.com/ki11a-Conton/harness-agent/actions/runs/38388122089)。
- [同一 archive 官方 UI 两端](https://github.com/ki11a-Conton/harness-agent/actions/runs/38388121962)：Ubuntu 与 Windows 各 30 / 75 PASS，archive SHA256 `337011c5f54c1d505f2988b79f4451c3562a2003267f70b340bedb24a639e293`；原 receipt/hash 在归档。另有 Linux-built CLI 同包 Windows 消费 49 断言 / 18 请求 PASS；本地 CLI 50 / 19、doctor=0、篡改拒绝 PASS。
- [主 CI 原件](evidence/web-deepseek-parity-20261013/accepted-b38566d/main-ci-original.json)：b38566d 的 formal 两端、r97/r98 两端、coverage、cold-start 均通过；verify 最终 docs 门缺入口 marker 而失败，整体 FAIL。已补当前 marker 与当前日期规格，实际 docs:verify PASS；新 main 的自动 CI 状态需另行读取，不能称旧流水线整体成功。


## 尚未完成的功能与发布条件

以下缺口不是靠移植 React/bundle 就能完成的后端能力，已明确拒绝或显示不可用：

1. `session/updateQueue` 原子 edit/remove/steer-now；现有 enqueue/steer/cancel 不等于任意编辑已持久 inbox。
2. frozen session 的权限 preset 和根 agent preset 更换；现有 native role delegation 保留，不能改写已有 owner 身份。
3. Cordis 动态 bundle 安装/启停/配置；列表可读，管理变更未挂载。
4. durable goal continuation、DeepSeek Plan review/loop、continuable 子 agent inbox；native one-shot delegation 不冒充可继续子会话。
5. 泛用图片/二进制模型输入；目前受限 UTF-8 文本上传，不能把上传成功当多模态理解。
6. native OS open-in-app；headless 应用目录为空且 ability=false，网页文件 preview 可用。
7. Windows lease 仅保证同机/同 network namespace 的单写者；固定端口占用或不可绑定时拒绝。旧高端口 guard 不可持有时，不保证跨旧/新版的滚动混跑；不支持多机 NFS 共享 dataDir。旧 Session 未保存 cosmetic metadata 时仍可能显示 durable ID，不伪造无法证明的原角色。
8. 本 managed Linux 不支持强 PTY confinement，实际 owner 返回 `SANDBOX_BACKEND_DENIED`；native addon 可加载不证明产品交互终端通过。手机右栏打开时 approval 需收起右栏查看，尚待统一交互验收。
9. 矩阵中尚未实际操作的默认细项，如高级 preview/复杂 Markdown、快捷键所有分支、完整 trajectory/artifact/skill 交互，还不能从组件装配或后端 unit PASS 推广为逐控件通过。

因此本次作为有明确能力边界的代码候选提交，不声明 140 个默认细项全部完成，不发布“全功能生产级” release。W3–W6 整域仍部分完成。真实付费模型 coding 质量为 NOT_PROVEN；用户线下实验与这次工程接线证据分别记录。v1.9/c5 发布与 N7 结论不改写。
