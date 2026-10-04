# 默认指令与中英记忆检索：最终验收

已完成 UI 后的 agent 优化并通过联合验收。冻结受测源码 `35663ba694ae9358fe6c9ed0a08efbbae0a2faad`；本地全仓 **8419 PASS / 12 既有 SKIP**，456 文件通过、1 文件既有跳过，strict named-run usage-audit PASS；typecheck/build/security2135/docs/diff及证据完整性全部PASS。新增111项agent回归及13项UI回归无新增skip。全仓648.096s，使用corepack pnpm11.21.0、Node24.19.0；原始 [最终manifest](agent-context-memory-20261004/raw/frozen-35663ba/manifest.json) 保留各argv、退出码、hash和前后clean检查。

同一源码 [CI37185965733](https://github.com/ki11a-Conton/harness-agent/actions/runs/37185965733) 已 completed/success、**10/10 jobs success**，包含两平台verify/closed-loop/formal、coverage、cold-start、attestation、same-SHA dual-platform。[原生API最终run/jobs](agent-context-memory-20261004/raw/ci-35663ba/final-summary.json)明确指向同SHA。Linuxmanifest的windows=NOT_RUN保留原始含义；Windows工程回归的成功来自独立真实CI，不代表Windows浏览器/性能探针运行过。

生产指令29/29检查；固定存储30/30、实际Harness scripted请求12/12、FTS正命中补集2/2；最终同SHA联合UI浏览器26/26场景、74断言，pageerrors0。独审44场景包含512个预算组合，后续12份生产source/dist同字节复核和CLI观察器13项审查通过；对应完整记录位于raw/review。模型text/messageRef、真实step身份与durable model.started一致；拒绝正文不污染身份，审计仍保存。

默认50,000B cap的16MiB单行输出50,000B、多行49,925B，实际handle捕获均50,004B。基线单行输出16,777,248B并由readFile整文件返回16,777,216B；这里只量化应用捕获/返回，非磁盘IO。非法预算/畸形UTF-8/不完整输入/文件symlink拒绝，原层级和来源保留。Core、权限/沙箱/验收门及实验默认策略未改。

记忆检索只投影content与合法When/Do/Avoid；SQLite保留FTS排名再补集、去重，deleted/type/scope过滤和现有session/lifecycle/safety/TopK门维持；无schema迁移、新依赖或vector/RAG。10k固定safe工程输入，两后端各10,000实际行、2warmup/5search样本，fixture和probe哈希在baseline/candidate完全一致。以下search是中位毫秒，retrieve为一次完整检索计时，不是模型质量或吞吐收益基准。

| 后端 / 查询 | 基线search ms | 最终search ms | 命中数 | 最终retrieve ms |
| --- | --- | --- | --- | --- |
| jsonl / warm-fts | 31.846 | 37.910 | 2000 → 2000 | 56.784 |
| jsonl / chinese-substring | 30.934 | 39.602 | 2000 → 2000 | 573.032 |
| jsonl / structured-do | 29.535 | 33.730 | 0 → 2000 | 61.554 |
| jsonl / actual-miss | 29.489 | 33.708 | 0 → 0 | 31.137 |
| sqlite / warm-fts | 9.220 | 62.455 | 2000 → 2000 | 65.069 |
| sqlite / chinese-substring | 0.032 | 55.173 | 0 → 2000 | 644.707 |
| sqlite / structured-do | 0.026 | 53.369 | 0 → 2000 | 89.745 |
| sqlite / actual-miss | 0.024 | 55.453 | 0 → 0 | 58.018 |

SQLite补集增加filtered-row线性成本：普通FTS及miss变慢，以补回已漏的合法记忆。TopK5只限制返回，既有中文主题去重仍约0.6秒；不宣称检索速度提高。paid=0、realModelQuality/promotion NOT_RUN；真实模型任务成功率未测。

受测source已通过原生Git推送main，并由native ls-remote/native curl ref API确认local/remote/API三者等于35663ba、工作区clean；[发布核验](agent-context-memory-20261004/raw/publish/tested-source-publication-verification.json)。最后完成记录提交只改计划、任务、说明和原始证据，程序代码与受测source同字节；该文档提交的最终main SHA和ref核验存于工作区`.ci/agent-context-memory-20261004/publish/final-publication-verification.json`并在最终答复给出，避免把自身提交SHA写进自身证据造成循环。当前计划标记完成后不再重复已经通过的全仓，文档门与完整性按新增文档另验。

所有原始基线、实际RED、NO_VERDICT选择器、首轮security失败、old observer CI失败、主动中断partial-full、探针oracle错误及修正原件均保留。主索引按原bytes/sha256覆盖实际归档；包含签名下载URL的CI尝试只保留ignored来源。UI进程内bindings/完成消息渲染等边界见 [UI报告](web-dsh-20261004.md)。

历史审查与实施观测（按当时阶段记述，pending/FAIL不改写为PASS）：

实施前方案：[plan(20261004-065049).md](../../plan(20261004-065049).md)。基线 `17aa6c7471faf8bdec020b45bfe7b9bb45470131`。UI 阶段已完成，见 [UI 验收](web-dsh-20261004.md)。

真实生产 discovery 50,000B cap 的 16MiB 单行返回16,777,248B，多行50,026B，两者应用层 readFile 都返回整文件字节；不是磁盘IO量声明。symlink 反例读到外部正文。实际 Harness 双turn在正文因 injection/budget 被拒绝时仍改变指纹；允许正文控制可见且指纹变化。

存储基线30项21通过/9失败，12个实际 Harness scripted 请求6通过/6失败；有FTS正命中时仍漏另一条中文子串。When/Do/Avoid 两后端都未检索。原始请求、审查建议和探针完整保留；fixture 数据库与16MiB输入文件可由探针重新生成，未纳入报告包。

本证据包首先冻结审查基线，随后追加实施阶段原件；候选冻结验收和最终联合全仓结果仍待追加。scripted provider、paid=0；真实模型质量和promotion NOT_RUN。

原始证据：[artifact-index.json](agent-context-memory-20261004/artifact-index.json)，脚本 `node scripts/research/agent-trust-20261004/verify-artifacts.mjs docs/evidence/agent-context-memory-20261004/artifact-index.json` 按原始bytes/sha256验证。

实施阶段：A1/A2 首批固定55测试RED44失败/11通过/0skip；另3个read/cleanup反例先2失败/1通过，修复后定向7文件105项全部通过。A3固定53测试RED35失败/18通过/0skip，修复后相关17文件262项全部通过。编译通过；首轮旧UTF-8测试因历史首行可超预算而失败，其原件保留，旧断言按新预注册硬预算合同更新，新增RED固定测试未改。

独立审查实际FileHandle.close关闭后注入EIO重现全局发现失败；最小best-effort cleanup修复后同探针正常返回cwd与nested控制。首次无效prototype-hook探针（calls0）作为无效观测原样保留，不能充当反例。严格UTF-8/短读/提前EOF新回归纳入默认测试。

10k基线在独立干净17aa工作树运行最终固定性能脚本，原始fixtureSHA与probeSHA保留。分别JSONL/SQLite实际10,000行，2次warmup/5次search计时；基线已知结构化、SQLite中文子串遗漏被明确expectBaselineDefects判定。已有retrieval候选主题去重成本可达约585ms；不将TopK5返回上限解释为扫描上限。候选补集预计增加线性扫描成本，待冻结实际值，不宣称吞吐提升。

首次冻结 `616ef30593da69bdf6db3546d4c22b80c1b4378f`：typecheck/build通过；生产指令29/29、记忆30/30存储+12/12真实请求+2/2FTS补集通过；同SHA联合UI浏览器26/26通过。security为2134通过/1失败，因为新增close恢复与FTS降级分支只有注释而无可观测记录，违反既有no-silent-catch门；runner立即停止，未执行全仓。原FAIL manifest与全部已跑探针不覆盖。随后两分支添加不包含query/body的通用degraded stderr，50项相关回归通过，待新clean源码联合验收。

独审首个冻结探针42/44的两项失败来自oracle漏计合法structured command_alpha/command_beta中的underscore，属于探针错误；原FAIL及精确旧脚本保留。校正后44/44（包含512个cap矩阵样本）通过，并核对12份source/dist hash。该结果不是全仓替代。

首次冻结10k候选：SQLite既有warmFTS中位9.22→61.06ms，miss0.024→53.85ms，中文2000命中search56.15ms、全retrieve557.67ms；JSONL中文原有584.66ms→554.99ms。这是正确召回付出的filtered-row线性扫描成本；TopK仅限返回，既有主题去重也有成本，不宣称吞吐优化。最终修复只增加降级日志，仍须记录新冻结实际性能值。

第二次冻结ecc45e5：生产29/30/12/2探针、联合浏览器26、security2135、docs均通过。原生Git source分支的CI run37185159270实际FAIL（3success/6failure/1skipped，10jobs）；两平台verify注解都定位到S2 AB/BA旧readFile计数expected0to32。其他coverage/formal只确认步骤失败，无完整日志不硬归因。本地full主动中断，original manifest RUNNING连同独立interruption.json保留，不是完整全仓PASS。

直接相关的CLI观察器仅作test-only适配：真实首个bytesRead计captures与实际字节，default readFile=0但仍4docs/request，实际baseline每轮8请求=32captures/1568B/40目录listing；candidate每轮6请求=3captures/153B、默认发现captures0，与durable discovery.reads一致。保留全部AB/BA、独立checker、内容与身份约束，267项定向回归/CLI编译通过。新增回归数量仍111，没有通过减少断言掩盖失败。原source+dist hash一致；首次selector无匹配只作NO_VERDICT，随后untouched实际focused1FAIL收据保留。

CI公开API原件和注解归档；含临时签名下载URL的尝试记录只留ignored来源，不进入公开包，主索引覆盖实际归档文件，不使用旧CI全目录索引声称完整打包。旧source独立17审查项/44场景/512预算样本及持久化事件验证原件也保留。最终新clean联合回归待完成。
