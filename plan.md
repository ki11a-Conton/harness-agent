# Harness Agent 当前执行计划入口

当前执行任务：[PR #8 安全集成](plan(20261016-162400).md)，合同：[PR8-SAFE-INTEGRATION-20261016](tasks/PR8-SAFE-INTEGRATION-20261016.md)。按用户追加授权修正两项阻塞后合并，再进行coding优化。生产完整日志不再自动声明首事件基线，owner严格验证retired前缀，队列屏障按源序号过滤。Web226、类型、安全2146和文档通过，旧PR3项失败对照保留；固定clean源码全仓和远端CI待验收，见[修正记录](docs/pr8-integration-20261016.md)。不发布release。

上一任务：[PR #8 审查](plan(20261016-114700).md)，合同：[PR8-REVIEW-20261016](tasks/PR8-REVIEW-20261016.md)。发现唯一开放且未审的 #8；已完成四个文件与调用链审查，确认日志前缀缺失被接受和非零坐标下队列屏障失效两项阻塞。原Web217、类型、安全2146通过，但候选反例3失败2通过，精确main对照4通过1跳过。仅在本地review分支保留候选与[审查记录](docs/pr8-review-20261016.md)，不合入main、不发布release；原main95a27dfd保持。

上一任务：[Web 验收子进程关闭](plan(20261015-windows-web-acceptance-shutdown).md)，合同：[WINDOWS-WEB-ACCEPTANCE-SHUTDOWN-20261015](tasks/WINDOWS-WEB-ACCEPTANCE-SHUTDOWN-20261015.md)。main ef0cf955 的 Windows 复核出现临时 cwd 清理 EBUSY；已用真实父/孙进程管道复现 exit 早于 close 的窗口，修正进程所有权与错误保留，并用真实租约预检分配新的持久化 fixture。进程回归5项、实际审查验收21项、类型及安全2146通过；精确提交的完整双平台 CI 继续复核，不发布 release。

上一任务：[Windows 关闭资源收尾](plan(20261015-windows-resource-drain).md)，合同：[WINDOWS-RESOURCE-DRAIN-20261015](tasks/WINDOWS-RESOURCE-DRAIN-20261015.md)。固定源码 `d6e00881dc804371165170c2a9a0697e34ff7b54` 已通过四个原始 CI 工作流，主 CI 十项全部成功，包含真实 Windows、双平台正式/安装/UI 验收；见[最终 CI 复核](docs/evidence/windows-resource-20261015/final-d6e00881/README.md)及[修复报告](docs/windows-resource-drain-20261015.md)。后台关闭竞态、审批/预算同步和功能 fixture 归属已按计划处理。原25s单次超时在60次 Windows 诊断未复现，根因未确立仍保留；本轮未发布 release。主分支归档提交的 CI 另据 GitHub Checks 复核。

上一任务：[Web 会话生成结束状态修复](plan(20261015-web-session-running).md)，合同：[WEB-SESSION-RUNNING-20261015](tasks/WEB-SESSION-RUNNING-20261015.md)。已确定性复现宿主缺失 api-session/status 导致已打开会话的 running 不复位；真实 composition + 精确客户端回归在原版失败，修正后通过，35 项相关回归通过。仅补齐宿主协议通知；固定 `d29537d6` 全量 9799 通过/15 跳过、安全 2146 通过，实际浏览器对照与 Windows/Ubuntu UI 安装通过，见[根因与验收报告](docs/web-session-running-20261015.md)。

上一任务（已合并并复核 CI）：[模型配置 PR 合并](plan(20261015-212057).md)，合同：[MODEL-CONFIG-PR-MERGE-20261015](tasks/MODEL-CONFIG-PR-MERGE-20261015.md)。按用户授权，#10 的 P2 与三项回归已补齐并推送原 PR 分支，#9/#10 已保留完整历史合入组合源码 `e3233deb`；全量 9798 通过/15 跳过、安全 2146 通过，类型与真实 CLI/Web 验收通过，按正常 Git 推送交付 main。远端结果及额外本地审计的证据缺口见[本次合并验收](docs/model-config-pr-merge-20261015.md)。

补充复核：`d202e952` 的 Windows checkout 被过长证据路径阻断，已以 `7e199f2a` 修复并保留字节映射。真实 Windows 与普通安装通过，但 Windows UI 安装两次失败，主 CI 状态见[复核及 PR 审查](docs/archive-ci-pr-review-20261015.md)，整体不能称为全绿。PR #9 无阻塞发现；#10 存在一个已复现的 P2，三行修正与反例附件已验证。两个 PR 组合全量 9795 通过/15 跳过，不能替代新增反例。产品源码 `4ee21776` 的原成功结论保持原有绑定。

上一任务（工程实施完成）：[全面实施 coding agent 优化](plan(20261015-114843).md)，合同：[CODING-EVOLUTION-20261015](tasks/CODING-EVOLUTION-20261015.md)。按研究规格 C1–C7 实施缓存观测、评测基线、coding-v2、长任务记忆、跨语言检索、稳定前缀与工作流展示；已完成 C1–C7 工程实施：固定源码 `4ee21776` 全量 9794 通过/15 跳过，安全 2146 通过，主 CI 第 2 次完整尝试 10 任务成功，真实 Windows 与两种安装包工作流通过。做什么、怎么做、怎么验收及限制见上述规格与[最终证据](docs/evidence/coding-evolution-20261015/final-4ee21776/README.md)。付费模型质量/缓存收益仍 NOT_PROVEN，新策略维持 opt-in；本轮不发布 release。研究原件与首次失败保留。

上一任务（已完成）：[PR 集成与 Web 连接修复](plan(20261014-214704).md)，合同：[PR-INTEGRATION-WEB-20261014](tasks/PR-INTEGRATION-WEB-20261014.md)。关闭开放 PR 的实证缺陷后合并 main，并修复源码启动时右下角持续“重新连接中”；做什么、怎么做和怎么验收见该规格。已完成：产品源码 `3af15705` 全量 9,707 PASS / 15 SKIP，完整 CI 10 项成功，PR #3–#7 merged=true；见[审查与验收报告](docs/pr-integration-web-20261014.md)。旧发布记录保持原源码绑定。

上一任务：[发布前最终大审查](plan(20261014-003000).md)，任务合同：[FINAL-AUDIT-20261014](tasks/FINAL-AUDIT-20261014.md)。按用户追加授权，移除 Preview Notice、修复剩余确认缺陷并完成固定源码验收后，已发布 [v1.10.0](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.10.0)。此前[品牌统一](plan(20261013-232547).md)、[上一轮规格](plan(20261013-194000).md)及[完整 UI 迁移计划](plan(20261008-web-deepseek-parity).md)保留。各项包含做什么、怎么做与怎么验收。

最终发布源码 b65801e4 全量 9,521 PASS / 15 SKIP / 0 FAIL；发布脚本 77 PASS，原生 Windows 专项 393 PASS / 2 POSIX SKIP。完整第三轮 CI 的 10 个任务全部成功；同一安装包在 Ubuntu/Windows 的 Web 均 30 场景/75 断言、CLI 分别 50/49 断言通过，另有问答 15、品牌 96 断言通过。14 项代码/接口缺陷、1 项依赖公告及 7 处验收假设已处理，见[最终审查报告](docs/final-audit-20261014.md)与[安装及发布验收](docs/release-v1.10.0.md)。4 项公开发布资产已无需登录下载并逐字节复核。付费模型质量和完整默认 UI parity 仍为 NOT_PROVEN。

上一轮品牌任务已完成验收：固定 bda6b20 独立包中英文三视口品牌 90 断言、coding 30 场景/75 断言通过，Web 186、资源/传输 20、包路径 3 测试与 clean docs gate 通过。原始发布文件和合法版权归档保持不变；见[品牌报告](docs/web-branding.md)。该轮未改 Core，也未宣布全功能或模型质量通过。

已将官方完整 frontend shell 和 66 个默认客户端 entry 接到真实 Harness，根页面采用官方 UI，旧客户端保留在 `/legacy/index.html`。来源固定为官方 npm `0.2.1-alpha.1`，发布物没有 gitHead，不声明等同于参考 Git 源码。

2026-10-13：桌面、移动和窄高视口的 30 个实际编码/UI 场景、75 项断言通过；另有实际模型设置、双 tab、模型切换和进程重启 18 项断言通过。测试使用生产 Web/Runtime 与 loopback HTTP provider，付费调用为 0，不代表模型质量验收。详见[当前交付与缺口](docs/web-deepseek-delivery.md)和[逐项交付状态](docs/web-deepseek-delivery-matrix.json)。

本轮固定运行时代码 b38566d 已完成完整 9,473 PASS/15 skipped、安全/协议、独立包、真实 Windows、同包官方 UI/CLI、formal 与 coverage 验收。原主 CI 文档门缺当前入口 marker 而失败；入口和真正的当前日期规格已修正，实际 docs:verify PASS。归档提交仅改文档；新 main 自动 CI 的最终状态另行记录，不把旧 CI 称整体通过。

队列原子编辑、Cordis、goal/Plan continuation、可续写子智能体和强沙箱 PTY 等缺口尚在，W3–W6 与逐控件完整 parity 仍部分完成，不能发布为“全部默认 UI 功能已完成”。旧第一代工程计划与发布记录保留在[第一代规格](plan(20261008-024527).md)，原用户未提交文件、v1.9及固定 c5 证据不改写。
