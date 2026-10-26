# 全面功能审查：可复现缺陷与修复

基线 main：`dfa09106bbc1ce2b8521c8d98df3aadecdcb3b2f`。执行约束与验收见根目录 `plan(20261026-comprehensive-function-audit).md`。本次不发布版本，不修改已有 release/tag/安装包。

| 编号 | 实际故障与根因 | 修复与验收 |
| --- | --- | --- |
| F1 | 完整文件读取只检查读前 stat。外部写入者扩大真实文件后，超过16MiB仍success，versioned同样受影响 | 检查实际读取字节，最多读取上限+1个探测字节，分块填满避免短读放大内存。改前2红例；覆盖读中增长、边界大小、短读UTF-8/CRLF、SHA、取消/超时/FD释放 |
| F2 | Git origin URL的通用密码不匹配通用secret正则，经真实Harness进入第二次模型请求 | 快照源头清除URL认证、query/fragment；保持仓库identity和SSH/local路径。真实Git→工具→Core→模型对照，包含interactive审批与test配置 |
| F3 | glob被编成指数回溯正则，普通103字符文件名配49字符pattern就卡住search_files和权限引擎；内部超时/心跳失效 | matchGlob改为动态规划，保留globToRegex兼容API。旧正则差分、UTF-16/Windows/换行、deny冲突、外部watchdog及长token折叠回归 |
| F4 | 非2xx错误体读取取消被best-effort摘要吞掉，用户取消/整次请求超时被误报HTTP错误 | 在错误体摘要后恢复真实取消/超时终态；正常401/403诊断和429/500成功重试保持。真实原生HTTP、两种重试预算、socket关闭及唯一终态 |
| F5 | repo_tree缺失目录、普通文件scope或读取失败返回成功空数组 | legacy遇不可用/读取失败明确SCAN_INCOMPLETE，保留正常数组/cap合同。repo_tree/search_files提供opt-in includeSummary，模型可见complete和上限；不完整不能作为不存在的证据 |
| F6 | managed.close先保存已结束记录，再内存删除；重启把succeeded等全部恢复成unknown，后续命令被工作区屏障拒绝 | 先持久化最终排空状态，再释放已确认结束记录。unknown/recovered和持久化失败屏障保留。真实成功/非0/主动或宿主取消、重开、写盘失败控制 |
| F7 | 实际长命令成功写文件、回传模型、通过验证，但现有session/codingStatus状态API只收集exec，漏掉exec_start/poll等 | 按jobId归并真实观察，返回状态、退出码与诊断，cursor去重，不把运行/未知当成功。普通exec兼容、不同job隔离、turn重置、真实Harness及原生UI执行后只读RPC断言 |
| F8 | search_files先按原始pattern是否含/选择basename，但matcher会归一化反斜杠；src\\*.ts被错误只对文件名匹配，漏掉真实文件 | 统一分隔符判断和匹配语义，覆盖Windows风格/正斜杠/嵌套路径与basename兼容。真实ToolOrchestrator前后对照 |

这些是本轮已独立复现的缺陷，不代表已经证明不存在其他缺陷。未改Core架构，不新增绕过权限/沙箱的执行通道，不放宽预算/测试/验证标准。

## 审查覆盖和证据解释

基线真实浏览器：桌面/手机/320px窄屏42场景120断言；模型规格→落盘→真实loopback Chat HTTP22断言；加号Goal/Plan及中英文24断言；后端真实断开/重启/恢复读取10断言。额外真实Harness投影独立复现F7；旧public/coding-workflow.js面板未挂载，试图从该旧入口验收的失败留存，并撤回对未使用资产的改动。基线通过的交互不被误算为本轮修复。

另检查自动/手动压缩、checkpoint、恢复预算、inbox故障、Goal round重开exact-once/stale reference等80项；模型与终止专项251项；导航范围/条件编辑、命令恢复、权限与secret链路均由专项及全量测试验证。最终数量和CI必须以外部固定clean源码验收收据为准，不能用此文档代替运行。

原生图片输入在当前文本provider中明确禁用并由后端拒绝，属于已提示的未支持能力；本次没有宣称支持多模态。Linux本地浏览器和loopback协议实验不能代替真实Windows及付费模型质量实验。默认lexical符号索引的总资源边界仍是后续需独立量化的风险，不能据本次通过宣称任意超大仓库都可用。

原始失败、夹具错误、旧dist误用及改后成功均保留在任务外部证据目录 `/tmp/harness-full-audit-evidence-20261026`，最终归档清单逐文件复算SHA256。复现脚本在 `scripts/research/full-audit-20261026/`；传入已编译源码路径和独立输出文件，可对同一输入比较两个版本。不调用付费模型，Git/HTTP为原生调用。

完整最终收据与CI链接在工作区 `harness-full-audit-STATUS-20261026.md`、`harness-full-audit-CURRENT-20261026.json`；未到自然终态的CI不得当作通过。

## 安装包CI补修

首次main提交6a0598e4的原生浏览器实际通过10项，但两层安装包封装仍要求9项，官方UI安装包CI40293963703因此失败；CLI证据目录未产生导致次级上传报错。修复共享的10个必需检查名称合同，两层封装统一，严格拒绝缺失、重复、替换、失败、不完整或含错误/付费调用的报告；8项Node负控制加入安装包CI原纯函数测试步骤。原失败和当前源码验收分别归档，不以重跑原失败或放宽门禁掩盖。最终提交和CI以外部最终收据为准。

候选导出收据校验也复用同一必需检查数量；新增拒绝仅9项的数值收据与字符串伪造负例。合同/候选导出/已有UI纯函数共94项通过，实际10项浏览器收据通过新合同校验。

Windows CI另一个取消断言存在已独立复现的因果缺口：原900ms命令可在abort之前自然完成，却被误计为取消后迟写。取消用例改为现有真实HTTP闸门，确认进程活且未写入→abort→等待回合返回→确认PID已退出→release后仍无写入，原turn/process预算不变、不跳过Windows。Linux6项集成专项通过，真实Windows仍需最终CI。

原Windows48arm配对失败的完整日志存储被云代理CONNECT403拒绝，API仅通用退出码，不能猜测根因或记为已修。配对脚本只增加结构化failed-arm/overlap/PID/退出码诊断及不改变Node退出的uncaughtExceptionMonitor；原48arm、24candidate通过、16overlap、零重复启动等断言原样保留。后续Windows据真实诊断决定是否补修。

5262c191本地完整运行期间写入取消验收修改，6个clean-source门禁因此正确拒绝该脏工作树。该次原始10374通过/6失败及dirty状态已保留，不能作为最终验收；所有修改提交后再固定clean SHA复跑，不更改clean-source门禁。
