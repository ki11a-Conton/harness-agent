# 发布前最终工程审查

基线 main：5058d536d44acd61369d822cea4e160b553dff4b。独立工作区。初始阶段按用户要求暂停发布；用户后续已明确授权去除 Preview Notice、完成验收后发布第一代可用版 v1.10.0。下文旧源码及“未发布”原件保持采集时的状态，不改写为新版本证据。

## 已确认问题与修复方向

| ID | 严重性 | 实际触发与结果 | 修复与验收 |
| --- | --- | --- | --- |
| FA-1 | P1 | CLI 模型发出 ask_user 后未调用终端问答处理，退出码 1、原 turn 留在 waiting_for_user、pending ask 未回答。 | 接通实际问答 RPC、原 turn 恢复、EOF/Ctrl-C 和重启待答路径；断言答案只入原任务一次，不创建新任务，不跳过审批。 |
| FA-2 | P1 | 实际 exec 输出测试用合成 API key，模型 tool message 已脱敏，但 tool.output 和 tool.completed.outputPreview 事件仍含明文。 | 在生产工具事件边界保护未提交输出和结果预览；检查分片、超长、转义、失败、其他字段，事件/存储/UI/model 均不含合成 key。 |
| FA-3 | P1 | WorkspaceChangeTransaction 对工作区内指向外部目录的 symlink 可成功 snapshot/commit，实际改写外部文件。 | 原语在快照、提交和回滚前检查完整路径与文件身份，拒绝目标及祖先 symlink；原件不变，普通内部路径仍成功。 |
| FA-4 | P1 | 事务快照把非 UTF-8 字节解码成替换符，commit 后 rollback 无法恢复原字节；0755 可执行文件也会被临时文件默认模式替换为 0600。 | 快照拒绝不可无损解码的内容、保留原模式；读取错误不视为不存在，批量快照失败不留下半份新意图。 |
| FA-5 | P2 | Web 变更比较把两侧强制补上末尾换行，真实的仅换行修改会显示零 hunk、零增删；捕获 UTF-8 BOM 也会被解码器丢弃。 | 保留原始文本格式及标准 EOF 标记，BOM 不在捕获中剥离；换行/BOM/空文件比较回归。 |
| FA-6 | P1 | 问答暂停后 Actor 已 idle，session.cancel 返回 not_running，Ctrl-C 无法真正取消持久 waiting_for_user turn。 | Actor 独占并提交暂停 turn 的取消、撤回问题，合并重复请求并让 close 等待写入；不得改写已结束或其他会话。 |
| FA-7 | P1 | 完成后的同一个 turnId 再次调用 session.run 可再次执行模型；实际两次 completed、两次模型调用。 | Actor 和直接 Runtime API 均拒绝重跑 completed/cancelled turn，保留原记录和历史；有意的 failed 恢复与新 turn 继续验收。 |
| FA-8 | P1 | 实际 CLI 在 write_file → ask_user → 回答后，磁盘文件已修改，但原 turn 的 filesChanged、工具计数、副作用账本及预算被清空；暂停还会被作为失败送入完成回调。 | 为原 turn 保存问答暂停检查点，恢复真实 WorkingState、进度、账本与已消耗预算；人工等待不算执行时长；无可靠检查点的重启拒绝重置；暂停不调用完成反馈。验收实际写入后 CLI 退出/重启、原任务继续、预算/迭代上限及反馈。 |
| FA-9 | P1 | 同一 Runtime 的两个并发 session 共用 activeBudgetUsage 函数；实际 A 的文件工具检查点记录了 B 的 3 次调用消耗。 | 预算提供器按运行中的 session 隔离，所有检查点取本任务实时预算，结束时清理；跨会话错误请求不得清除正在运行的记录。可控并发回归。 |
| FA-10 | P1 | maxToolCalls 在工具返回后检查；设为 0，工具仍先派发，之后才报告 RESOURCE_LIMIT；已消耗预算的问答恢复也会多执行一次写入。 | 模型工具批次在派发前预留上限，仅派发允许的前缀；超额请求逐一给出未执行结果，保持 assistant/tool 协议连续；检查点包含本次已预留消耗。验收零额度、问答恢复和批量工具协议。 |
| FA-11 | P2，依赖公告 | 生产依赖锁定 fflate 0.8.2，公告 [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) 指出其 unzipSync 在畸形 ZIP64 上可死循环。当前服务端调用点为 zipSync 导出，本轮没有对外解压路径的攻击复现。 | 将 Web 依赖和锁文件固定到修复版 0.8.3；检查生产依赖 audit、实际会话 ZIP 导出/解包、冻结前端与独立包。保留原始供应商文件及来源记录。 |
| FA-12 | P2，验收基础设施 | 四处旧验收错误假设：子任务合并检查读取不安全的截断预览；问答协议样例给两次模型请求仅一轮额度，依赖错误的预算刷新；浏览器在答案文本显示时立即检查尚未持久化的完成事件；生产组装测试以固定 500ms 循环等待异步完成，在加载中的 Windows runner 上误判。 | 从父模型实际收到的安全 tool message 验证合并、保留实体文件与子任务状态断言；协议样例明确给两个请求额度，严格额度另有专门回归；浏览器有界等待同一原 turn 的实际终结事件，再验证 exactly-once。生产组装使用未释放模型 gate 验证接收请求不等待模型结束，再有界等待真实完成并保留原消息断言。原失败与改后实测均归档。 |
| FA-13 | P1，SDK 宿主 | 实际编译代码调用 async askUser 回调，回调 throw 后 turn 虽先返回 waiting_for_user，Node 随即因未处理 rejection 退出 1；原 try/catch 只处理同步异常。 | 对返回的 Promise 安装异常处理，记录降级且保留真正的待答任务，不等待慢回调；同步/异步错误和慢回调均能通过实际回答继续原任务。独立 Node 严格 rejection 模式 RED/GREEN 与 SDK 回归。 |
| FA-14 | P1，暂停交接竞态 | 实际 Harness 的暂停写入被有界 gate 控制：问题已发布，立即回答会撞到仍运行的原 Actor，答复已记录却不继续；在 waiting 状态落盘前点击取消，旧取消流程漏掉刚暂停的任务；SDK 在问题交付中 abort 也仍返回 waiting。三项 RED 均复现。 | Web 等原 Actor 完成暂停后再提交答案和续跑，等待在会话锁外且有截止/关闭检查，重复在途回答保持幂等；中断后重新读取等待任务，用 Actor 原任务取消 API；Runtime 在暂停检查点后检查 abort，提交真实取消并撤回问题。验收控制两处真实写入窗口、回答一次和取消真实状态。 |
| FA-15 | P1，归档交付 | 本轮归档提交 2374e94 的深层 fixture 路径达到 240 字符；真实 Windows 工作流在 checkout 阶段报 Filename too long，尚未运行产品测试。 | 将 240 份原始 fixture 转存短路径 fixture-records.tar.gz；归档成员逐个匹配旧 inventory 的字节数和 SHA-256，保留逻辑路径索引。目录最长路径降为 119 字符，必须重新验收真实 Windows checkout 和后续测试。 |
| FA-16 | P2，CI 验收 | coverage 工作流先执行 pnpm test:coverage，再通过 release gate 重跑相同全量；第二次失败时跳过证据上传，公开注解仅有退出码，无法取得失败详情。e87dbbf 的覆盖率阈值步骤 PASS，第二次证据步骤 FAIL，两次结果均保留。 | 先编译 CLI，再仅通过原有 V2 release gate 执行一次规范覆盖率命令；保留阈值、真实退出码及源码校验。无论成功失败都上传覆盖率和 gate 原件；公开已有 gate 记录及摘要，失败详情绑定保存日志摘要，Unicode/日志篡改/明确截断三项真实 Node 进程测试通过。新 CI 最终状态另行记录，不猜测第二次失败的产品根因。 |
| FA-17 | P2，归档字节完整性 | 本轮归档的 .log 未关闭 Git 换行转换；实际 core.autocrlf=true checkout 将最终全量日志由 137854 bytes 改为 139451 bytes，SHA-256 与 inventory 不符。 | 仅在本轮证据目录声明 -text；相同 Git checkout 复算恢复字节一致，记录 RED/GREEN，其他源码不改变换行策略。 |
| FA-18 | P2，失败可见性 | N6 公共诊断不识别 RemoteFailure，并将真实错误与预期错误噪声放在同一优先级；实际 Node 进程重现错误原因被前 8 条注解挤掉。 | 识别以 Error/Failure 类名开头的真正异常，优先于降级噪声及通过标题；正反回归和原始失败保留。 |

## 初始检查

typecheck 通过。全量基线 549 文件，9,469 PASS / 6 FAIL / 15 skipped；6 个失败均由尚未提交的本轮计划文档触发 clean-source/晋升门拒绝，原件保留，不归为产品缺陷。最终全量必须在固定 clean 提交上重跑。首次离线安装缺 npm metadata，改用正常代理网络和可写 cache 后完成；未改变锁文件和安全门。

后续记录包括源码审查覆盖、RED/GREEN、固定源码工程门、安装包/浏览器、本地测试步骤和仍未支持的能力。不以测试通过声称不存在所有潜在 bug。

## 修复阶段验收

截至源码冻结前，14 个重点文件、202 项相关测试已通过，覆盖问答与重启、Actor 并发/取消、跨会话与重复回答、工具事件保护、事务路径/字节/模式、真实 Web 变更捕获、RPC 与两种协议传输。随后加入暂停完成回调、检查点缺失和迭代上限回归；最终结果以下文固定源码验收为准。

工具输出的未提交片段及截断预览不进入事件存储，事件保留字节数和 withheld 标志；完整工具结果仍走既有 Runtime 输出检查，再进入模型和历史。事务仍是受控写工具的协调原语，不能把路径复查声称为能抵抗任意外部进程竞争的 OS 沙箱。

审查覆盖：CLI 终端/问答/审批/恢复；Web 会话、模型配置、流式活动和工作区变更；Gateway/AppServer/SDK 的身份、取消与消息协议；Runtime/Actor、上下文、provider 流与错误恢复；工具、权限/沙箱与持久化；冻结前端资产、品牌和独立安装包。付费模型质量由用户本地实验；本轮不把脚本 provider 验收作为模型能力证据。

## 固定源码验收

验收源码：`88504f013eec54f1ae0328783345c8c4cf8265e3`，树 `8860e33ee19ef14f6bef8504bdc57f19b915bc37`，执行时工作区 clean。后继 `8613c6e` 只修一处生产组装验收测试、补 Windows 验收列表和文档；1,320 个产品/构建输入的 Git blob 与 `88504f0` 完全相同，见 product-source-identity.json。其后的提交只归档文档、原件及验收复现脚本，不把旧 SHA 的运行记录改写为后继 SHA 的结果。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 类型检查/真实编译 | PASS，Node 24.19.0、pnpm 11.21.0 | `logs/final-audit-typecheck-last-fix.log` |
| 全量单元/集成 | 556 文件：554 PASS / 2 skipped；9,520 PASS / 15 skipped，失败 0 | `logs/final-audit-full-88504f0.log` |
| 安全 | 21 文件、2,146 PASS | `logs/final-audit-security-88504f0.log` |
| 协议 | 7 文件、54 PASS | `logs/final-audit-protocol-88504f0.log` |
| 发布/供应商/传输脚本 | 68 PASS | `logs/final-audit-release-scripts-88504f0.log` |
| 冻结资源、文档及 clean docs gate | PASS | `logs/final-audit-vendor-88504f0.log`、`logs/final-audit-docs-gate-88504f0.log` |
| 生产依赖 | 14 依赖，已知漏洞 0 | `logs/final-audit-dependencies-88504f0.json` |
| 独立包 CLI/Web 编程 | 50 断言；19 个真实 loopback HTTP 请求；真实读/改/失败验证/修复/重测、审批拒绝、取消及重启 | `installed/cli/result.json` |
| 独立包 Web 常规 coding 控件 | 30 场景、75 断言，桌面/移动/窄高三视口 | `installed/web/result.json` 与 `installed/web/browser/` |
| 独立包问答/脱敏 | 15 断言，3 个独立 CLI 进程、5 次真实 HTTP 请求，原任务/已写文件/工具计数保留，事件与模型输出无合成明文密钥 | `installed/questions/result.json` |
| 中英文品牌 | 6 场景、90 断言，中英三视口；用户可见名称、欢迎、设置、内置组件、清单与图标为 Harness Agent | `installed/branding/result.json` |
| 真实 Windows | Windows_NT 10.0.26100、Node 22.23.3、30 文件，352 PASS / 0 FAIL / 2 skipped；12 项必需进程测试全部 PASS | `ci/final-audit-native-ci-88504f0/windows-receipt.json`、完整 case records 和校验记录 |

独立包版本为内部测试标识 `1.10.0-rc.1`，3,045 个受校验文件；归档 SHA-256：`d0eee62c37fddfc6bd1b29938e50cfe1ba47439c03bdb3c9dfc310e90d68c665`。构建来自 fresh pinned snapshot，没有复用工作区构建文件、workspace links 或旧 native 二进制；doctor 无错误，真实启动拒绝被篡改的资产。此包未发布为 GitHub release。

Windows 跳过的两项均为 POSIX chmod 语义：B05 模式变更合并和事务可执行位保留；Linux 相应测试已运行。Windows 的真实 `.cmd`/`.ps1`、PATH/PATHEXT、空格/CJK 参数、安全拒绝、超时、取消与实际孙进程终止均有 passed 最终状态。Azure 原始 artifact 下载受当前网络代理 403 限制，使用工作流原本公开的 notice 分片恢复完整 case records，校验 `caseRecordsSha256`；不声称取得了原始 Vitest JSON 字节。

冻结产品源码的 CI：[原生 Windows](https://github.com/ki11a-Conton/harness-agent/actions/runs/38497874192)、[独立 CLI/Web 包](https://github.com/ki11a-Conton/harness-agent/actions/runs/38497874182)、[浏览器安装包](https://github.com/ki11a-Conton/harness-agent/actions/runs/38497874148) PASS；主 CI 的 Windows 全量 leg 因固定 500ms 的生产组装完成等待误报而失败，coverage/Ubuntu formal/closed-loop/cold-start 已通过。`8613c6e` 使用未释放模型 gate 保持“接收请求不能等模型完成”的证明，再有界等待真实终结状态；本地相关 30 项 PASS，[原生 Windows](https://github.com/ki11a-Conton/harness-agent/actions/runs/38500633280) 353 PASS / 2 skipped、31 文件（含此生产组装测试）。[该提交主 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38500633252) 的最终状态按原始 API 快照记录，不将 pending 称为整体 PASS。

补充追踪：8613c6e 主 CI 最终为 FAILURE，Windows 常规全量、Ubuntu 全量、coverage、Ubuntu formal、双平台 closed-loop 和 cold-start 均 PASS；Windows formal 的全量中 `owners.test.ts` 的 stable Web draft 模型切换/重启案例失败，因此 dual-platform gate 也失败。公开诊断尚无完整断言原因，不将它猜测为时序误报；本地 owners 全部 21 项 PASS，已加入原生 Windows 目标并补充终态诊断，继续取得实际结果。2374e94 主 CI 的 Windows leg 则全部因 FA-15 在 checkout 失败；原始 job/annotation 分别保留，不能把 Ubuntu 通过当成 Windows 通过。

`e87dbbf` 的 [原生 Windows](https://github.com/ki11a-Conton/harness-agent/actions/runs/38510542360) 已 PASS：32 文件、374 PASS / 0 FAIL / 2 skipped，含模型切换/重启完整案例和 12 项必需进程测试；case-records SHA-256 为 `0d33b4ec926bfc2c772d7c691e48dc5a9fcea068c3a05c872a583375b6655ab1`。原生 checkout 成功，FA-15 已实际验证。[独立安装包](https://github.com/ki11a-Conton/harness-agent/actions/runs/38510542218) 和 [浏览器安装包](https://github.com/ki11a-Conton/harness-agent/actions/runs/38510542352) 均 PASS；[主 CI](https://github.com/ki11a-Conton/harness-agent/actions/runs/38510542386) 的 Ubuntu/Windows formal、双平台 closed-loop 与 cold-start 已 PASS，coverage 阈值测试 PASS，但重复生成证据的第二遍失败。未把此 run 写为整体 PASS，FA-16 修正后等待真实 CI。此前单次 Windows 模型切换失败的根因未取得，保留失败记录及本次 targeted/formal 正向验收。

`b12a87f` 的主 CI 38513132964：双平台常规完整 leg、coverage V2、Ubuntu formal、closed-loop/cold-start PASS；Windows formal 在 catalog 的真实网络模型发现案例失败，整体 FAILURE。该案例通过 200 次短轮询推断审批是否已创建；在真实执行路径加入 600ms 延迟可确定复现“审批尚未创建就断言”的 RED。改为有界等待真实 create 事件，仍调用原审批 store、明确 deny、检查 HTTP 请求未增加、一次性凭证未落盘；本地 GREEN。此项作为 FA-12 的第五处验收假设记录，不将其新增为已证明的模型发现产品漏洞；新 Windows 运行仍需实际验证。

## 用户追加的 Preview Notice 移除及正式发布

删除实际前端的 welcome-notice 启动注册和首页 Preview/预览版徽标，不以伪造后台确认字段实现；旧确认字段留作配置兼容。七份明确标注的前端呈现衍生物与原始许可证/资产分别保存，原始 npm 字节继续逐件校验。浏览器验收改为全新状态直接进入 composer，模型设置/工具审批仍走实际后端，中英三视口、刷新/重启均检查无通知和徽标。

发布目标 v1.10.0：重新冻结 clean 源码，执行完整工程门、真实 Windows 与同一个 Ubuntu 构建包在两平台的 CLI/Web 安装验收。当前代理仍拒绝 Azure artifact 下载；新增受限、手动调度的导出入口，只接受同一源码的 successful CI、四份同 archive hash 的安装收据及绑定该 SHA 的既有 v1.10.0 draft，不能创建或公开发布 release。正向及已发布目标/失败 Windows job/异包收据/篡改包负向控制共 5 项通过。最终公开动作仍由原生 Git/HTTP 在验收通过后完成；新版本不把旧 UI 的运行结果当作其验收证明。

候选 `d459f26` 的原生 Windows 专项为 393 PASS / 2 SKIP / 33 文件，含真实模型发现审批；第一代跨平台安装验收通过。但主 CI 的 HTTP 资产测试仍写死六个派生模块，新增 conversation 模块后实际为七个，确定 FAIL；作为 FA-12 第六处旧验收假设修正，新增模块仍逐个检查内容 digest 和旧 revision 拒绝。该候选的 Windows UI 浏览器验收也失败，CLI 子步骤因此跳过；本轮保留红色结果，通过只读工作流恢复原 artifact 的失败 case records，不能将 skipped 视为 CLI 通过。后续安装 UI 失败也输出有界实际案例诊断，保持原退出码。最终发布必须重新通过这些验收。

## 原始失败与修正记录

基线 clean-source gate 的 6 个失败、最初安装缓存限制、自己的空 catch 被安全门拒绝、生产依赖公告、885 之前全量两处旧断言失败、旧浏览器过早判断完成以及新增暂停交接的三个 RED 均保留。`fdd8c0e` 与 `4028440` 的全量被显式停止以先修检查发现的问题，没有把中止算通过。`dd05fc1` 全量为 9,512 PASS / 2 FAIL；`7e0295a` 完整为 9,514 PASS / 15 skipped；最终结果只取上表冻结源码。

安装包问答实测曾因验收脚本把实际 `[redacted]` 写成大写而误报，修正大小写判定后在全新项目/状态目录重跑，原件保留。与真实产品缺陷、公开依赖缺陷分别记录，不用重试抹去失败。

原件归档与可复算清单位于 [evidence](evidence/final-audit-20261014/README.md)；inventory 逐文件记录原字节 SHA-256，不含用户 GitHub token。问答实测复现：先校验解出的包，再运行 `node docs/evidence/final-audit-20261014/installed-question-acceptance.mjs <unpacked-root> <new-output-directory>`；该脚本只调用本地 HTTP 模型 fixture。

## 交付范围与本地验收

本轮关闭 12 项已复现的代码/接口缺陷（FA-1–FA-10、FA-13–FA-14），升级 1 项有公开公告的生产依赖（FA-11），纠正 4 处旧验收假设（FA-12）。保留既有工具、权限、沙箱、验证、持久化和模型策略；没有自动晋升 paid 模型质量结论。

队列原子编辑/steer-now、Cordis 生命周期、goal/Plan continuation、可续写子 agent、多模态二进制接入、原生桌面打开器和强沙箱 PTY 等声明缺口仍在。上述工程门和常规 coding 场景通过不能改写为完整默认 UI parity 或 Codex/Claude Code 等模型能力等价；两项仍为 `NOT_PROVEN`。付费模型实验由用户本地执行，本轮调用数为 0。

已完成或已取消的 turn 现在拒绝重跑；新工作需要创建新 turn。旧版本已暂停但没有完整问答检查点的任务会明确拒绝恢复，避免重置预算、遗失已落地改动；可以查看文件后取消旧任务并开新任务，旧状态不删除。

Windows PowerShell 本地测试可使用以下流程（`npm test` 要替换成你的项目验证命令）：

```powershell
git switch main
git pull --ff-only
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
$harnessCli = (Resolve-Path .\apps\cli\dist\main.js).Path
$harnessWeb = (Resolve-Path .\apps\web\dist\main.js).Path
$env:OPENAI_BASE_URL = "你的模型服务 /v1 地址"
$env:OPENAI_MODEL = "你的模型 ID"
$env:OPENAI_API_KEY = "你的模型服务密钥"
$env:HARNESS_AGENT_PROMPT = "coding-v1"
$env:HARNESS_DATA_DIR = Join-Path $env:LOCALAPPDATA "HarnessAgent\final-audit-cli"
node $harnessCli chat "C:\code\your-project" --verify "npm test"
# 保存终端实际打印的 session id，退出后用相同配置和目录继续：
node $harnessCli chat "C:\code\your-project" --resume "实际 session id" --verify "npm test"
# CLI 关闭后，在项目目录启动 Web；使用独立状态目录验收。
$env:HARNESS_DATA_DIR = Join-Path $env:LOCALAPPDATA "HarnessAgent\final-audit-web"
$env:HARNESS_VERIFY_COMMAND = "npm test"
Set-Location "C:\code\your-project"
node $harnessWeb
```

验收一个真实小项目的读取、修改、失败测试后修复并重测；检查审批允许/拒绝、运行中取消、问题显示后的立即回答/取消、问答 EOF 后重启恢复、实际文件及测试结果、Web 模型设置保存/重启，以及中英文页面的 Harness Agent 名称和图标。Web 默认地址为 `http://127.0.0.1:8787`。同一状态目录只由一个宿主占用；使用真实模型而非未配置密钥时的 stub 来评价 coding 质量。

不创建 release/tag。用户拉取本地测试并明确确认后，再按实际发布 SHA 做发布验收。

实际交付状态：修复及验收完成；commit 推送 main 后由用户本地测试决定发布。本轮无 release/tag。
