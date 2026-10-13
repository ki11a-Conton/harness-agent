# DeepSeek Web UI 完整迁移：做什么、怎么做、怎么验收

当前基线 `d2451026a194c03194ab56f79f465b7db1de2bed`；源码参考 `deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`。已发布v1.9的固定源码工程验收保留，但它不能证明WebUI完整迁移。旧第一代计划保留在 `plan(20261008-024527).md`。

## 已完成的先行审查

- [逐项源码对照](docs/web-deepseek-parity-audit.md)与[146项矩阵](docs/web-deepseek-parity-matrix.json)：直接复用仅六份主题CSS，缺真实上游组件、完整布局及交互。默认标准和experimental/opt-in按上游实际配置区分；矩阵每项记录具体源码、当前行为、移植方式和验收，不以缺后端排除标准UI优势。
- Backend源码识别132个Remote endpoints（含2内部event endpoint）及7个非Remote HTTP；官方 `__DSH_TRANSPORT__.rpc.call/open` 是完整客户端复用切点，不能把旧六REST入口当同名协议。
- 真实浏览器已复现Markdown原样文本、长tool live/history不同、model.delta已发但未显示、ask没有问答控件/普通答案另开turn/旧ask永远pending、等待提问时stop假提示、mobile侧栏焦点进入背景等问题。
- Runtime公开答案边界真实RED14项中10FAIL：错误session/turn答复、无store伪造ask、重复注入和durable answered-before-append故障。限定安全补修已完成14新增/171相关PASS；其工作树证据仍不是最终clean-source发布门。
- 初始官方组件构建原型曾使用 mock 帧识别协议形状，此结果未计入验收。现已删除 mock 依赖，正式 carrier 经单一 WebSocket 接到生产 Harness；发布物 `0.2.1-alpha.1` 无gitHead，单独绑定原始 67 个 tar、334 个逐字发布文件及本地适配文件 hash，不伪称逐字等于参考 Git 源码。

## 实施与验收

| 编号 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| W1 | 完整官方客户端与布局 | 直接纳入官方frontend和默认动态组件闭包，保留slot/renderer/store/locale/theme/primitives及许可证；以官方transport seam接Harness，停止继续仿少量CSS/DOM | 来源/版本/每个tar及实际运行bundlehash可追溯；全默认roster启动；三列/可拖/折叠/移动/主题/快捷键与真实组件一致，离线运行无CDN依赖 |
| W2 | 严格Remote协议和宿主边界 | allowlist `/api` endpoints，定义真实 `{args}`与`ok/value/error`、可取消call/open、generation、ready/emit/waterfall、history page与sequence/revision投影 | 未知/坏参数/错误身份/失败均拒绝；没有全局empty-success；双tab/重连/切session不串数据；保留Host/Origin、目录lease、秘密保护 |
| W3 | 完整持续会话与问答 | 接Runtime/SessionService创建、列表、全文搜索、重命名、软归档/undo、pin/排序、fork、history/control/follow、审批及ask回答；copy官方会话/chat工具呈现 | 真实编码/批准拒绝/逐token/工具结果/长输出折叠/Markdown公式与代码；重启和清storage恢复；问题answer真正mark原ask并恰好一次续写；waiting停止实际完成，失败不得假‘已停止’ |
| W4 | 工作区、文件、改动、终端与附件 | 补可持久工作区注册/切换和受限文件服务、真实工具与改动投影，接上游右栏；终端执行及文件副作用经现有Orchestrator/权限/沙箱 | 文件树/预览/diff/终端执行输出为真实项目状态；路径穿越/软链越界/取消/审批拒绝无副作用；无虚构目录/执行/attachment；Windows路径与实际process终止复验 |
| W5 | 模型、设置、技能与插件 | 接实际provider/catalog与配置描述，秘密只服务端存；已有会话维持冻结身份，变更按明确受支持生命周期；技能/工具/权限/preset/插件页依据实际能力 | 选定模型确实发送到真实HTTP；无效配置可见拒绝、不泄露key或改旧冻结session；已存在skills/tools实际列举；未知功能不返回伪造空成功 |
| W6 | 任务、计划、轨迹、subagent与交付 | 复用官方UI，投影真实run/tool/verification/delegation/plan/todo/artifact；所需host服务补齐并保留边界 | 页面值与durable事件/文件/实际owner一致；失败、取消、未验收明确；运行或审批不能从父子/不同会话互相冒用；实验插件不冒充默认功能 |
| W7 | 问答安全及恢复修复 | submitUserAnswer方法内验证真实ask及session/turn、严格history证据、sameRuntime串行、保存durable原答复的crash重试 | 保存真实RED→GREEN原件；14新增/171相关已PASS，还需最终clean源码完整/security/protocol门及Web真实提问回归 |
| W8 | 完整迁移与回归验收 | 矩阵逐项更新实际组件、后端和可见证据；真Chromium+生产Harness/loopback provider覆盖桌面/mobile/窄高/错误/流式/问答/配置/右栏，独立复审源码 | 每个标准已交付控制有实际行为与后端证据；缺口仍标阻断而不是宣称完成；typecheck、相关unit/integration/security、固定clean全量通过 |
| W9 | 独立包与跨平台交付 | 确认portable包含完整官方bundle/字体/主题/notice且静态route正确；新固定源码执行真实Windows与同archive消费 | 新包无workspace links，doctor/篡改拒绝/真实CLI-Web闭环通过；下载后hash复核。只在新门通过后commit/push及后续release，不覆盖v1.9/c5证据 |

## 进度与原则

2026-10-13 更新：

| 项目 | 当前结果 | 后续验收 |
| --- | --- | --- |
| W1 | 官方完整 shell、66 默认动态 entry、字体/主题/notice 离线纳入；原发布 bytes 保持一致，新增本地移动设置样式 | 来源封存 verifier 已 PASS；随独立包再次核验 |
| W2 | 真实 HTTP + 单一 WebSocket multiplex、bounded queues/cancel/uplink/generation；Host/Origin/路径/身份拒绝 | 相关真实 transport/security 测试已 PASS，b38566d clean 全量 9,473 PASS/15 skipped、安全 2,146、协议 52 PASS |
| W3 | 创建、历史、流式 Markdown、读写、审批、提问原 turn 恢复、fork/pin/rename/archive/search 已接真实 owner | 三视口普通编码链路 30 场景/75 断言 PASS；队列原子编辑仍阻断 |
| W4 | 工作区、受限文件读写/preview/upload、真实改动与交付、PTY owner 接入 | 文件与编码链路 PASS；本环境强 PTY sandbox 不可用，未声称交互终端已验收 |
| W5 | 真实配置、凭证服务端保存、模型目录/默认路由/draft replacement、窗口与输出限制生效 | 浏览器模型/两 tab/重启与角色 18 断言 PASS；已启动身份冻结、权限 preset 和 Cordis 变更仍受限 |
| W6 | 实际 journal 投影、任务/timer/job/skills/delegation/artifact，任务 due/admission 与 alias race 修复 | backend 集成有证据；goal/Plan continuation 和 continuable 子 agent 未实现，不接受整域 parity |
| W7 | ask 身份/历史/幂等/crash 恢复和真实模型 ask 广告已修复；取消/超时审批写入 durable store | 真实 RED/GREEN、loopback 提问和三视口刷新回答 PASS |
| W8 | 原审查矩阵保留为基线；新增相同 stable id 的当前交付状态；普通链路真实浏览器复验完成 | 固定 clean b38566d 全量/security/protocol 与 formal/coverage 已 PASS；旧主 CI docs marker 失败，文档修正已通过事实检查，未经运行的控件不算通过 |
| W9 | portable 模式/长 notice 路径/native 安装缺陷已修复；新增同一 archive Linux/Windows 官方 UI CI | 3,034 文件独立包、原生 Windows 253 PASS/1 skipped、同 archive 两端 UI 各 30 场景/75 断言 PASS；不改 v1.9，不因当前部分通过发布全功能版本 |

[当前交付、缺陷及限制](docs/web-deepseek-delivery.md)和[交付矩阵](docs/web-deepseek-delivery-matrix.json)是当前状态；原146项审查仍是旧 UI 的历史基线。所有副作用仍走 ToolOrchestrator/PermissionEngine/SandboxManager/Verification；Core 不依赖 UI。paidModelCalls=0，真实模型质量 NOT_PROVEN，旧 N7/champion 及归档结论不改写。

### W8 补修：停机仍有持久 inbox 写入（2026-10-13）

- 做什么：修复真实 CI `38348315036` 的 terminal inbox ACK/关闭竞态，纠正问答测试过早提交的状态屏障；不降低覆盖率门槛。
- 怎么做：actor 保有 terminal ACK promises，释放 resource scope 前 drain；并发 close 共用同一结果。Web activity 的 fixture 关闭 actual session service；问答回归等待实际 turn `waiting_for_user`。
- 怎么验收：真实 InboxStore ACK 门控 RED 1 FAIL → GREEN；113 项相关测试与 typecheck 已 PASS。固定 clean 新源码再跑全量、CI、真实 Windows、同 archive 官方 UI 消费。原 7ba9eee 本地全量与 UI PASS、主 CI FAIL 分别保留，不拼接成新源通过。

### W8/W9 补修：Windows 长锁与重启角色标签（2026-10-13）

- 做什么：修复 `9c02f1b` 原生 Windows 正式门真实 EPERM（turn JSON 原子替换），修正 Windows workspace 测试清理争用；修复官方 UI 重启后角色名称降级为 UUID。
- 怎么做：仅 Windows 原有临时错误允许 16 次原子替换、累计重试等待最多 5.13s，永久失败仍拒绝且保留旧文件；状态回归使用有界 10s I/O 屏障。新建 Session 独立保存并核验 cosmetic name/description/mode，不从该记录取执行策略，不改变 frozen effective config。
- 怎么验收：实际 rename 八次争用与重启未知注册身份两项 deterministic RED 2 FAIL → 120 targeted GREEN；typecheck PASS。真实浏览器新增重启后的 DOM/projection 角色检查与 Core artifact identity；新 clean 源码再跑完整、安全、协议、覆盖率/正式 CI、Windows 和同包 UI。原 9c02f1b 本地 PASS 与 Windows 正式 FAIL 分开保留。

最终工程原件：[accepted-b38566d](docs/evidence/web-deepseek-parity-20261013/accepted-b38566d/README.md)。主 CI 文档入口失败已独立保留并补 marker/当前日期规格；后续仅文档提交，Code 与已验收 runtime 相同。W8 的逐控件 parity 仍部分完成，W9 的普通链路候选包验收完成，未发布全功能 release。
