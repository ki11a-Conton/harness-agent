# Harness Agent 当前执行计划入口

补充复核：`d202e952` 归档提交的 Windows checkout 被过长证据路径阻断，正在修复归档可移植性并审查用户指定 PR #9/#10；见[复核记录](docs/archive-ci-pr-review-20261015.md)。产品源码 `4ee21776` 的原成功结论不替代归档提交 CI。

当前执行任务：[全面实施 coding agent 优化](plan(20261015-114843).md)，合同：[CODING-EVOLUTION-20261015](tasks/CODING-EVOLUTION-20261015.md)。按研究规格 C1–C7 实施缓存观测、评测基线、coding-v2、长任务记忆、跨语言检索、稳定前缀与工作流展示；已完成 C1–C7 工程实施：固定源码 `4ee21776` 全量 9794 通过/15 跳过，安全 2146 通过，主 CI 第 2 次完整尝试 10 任务成功，真实 Windows 与两种安装包工作流通过。做什么、怎么做、怎么验收及限制见上述规格与[最终证据](docs/evidence/coding-evolution-20261015/final-4ee21776/README.md)。付费模型质量/缓存收益仍 NOT_PROVEN，新策略维持 opt-in；本轮不发布 release。研究原件与首次失败保留。

上一任务（已完成）：[PR 集成与 Web 连接修复](plan(20261014-214704).md)，合同：[PR-INTEGRATION-WEB-20261014](tasks/PR-INTEGRATION-WEB-20261014.md)。关闭开放 PR 的实证缺陷后合并 main，并修复源码启动时右下角持续“重新连接中”；做什么、怎么做和怎么验收见该规格。已完成：产品源码 `3af15705` 全量 9,707 PASS / 15 SKIP，完整 CI 10 项成功，PR #3–#7 merged=true；见[审查与验收报告](docs/pr-integration-web-20261014.md)。旧发布记录保持原源码绑定。

上一任务：[发布前最终大审查](plan(20261014-003000).md)，任务合同：[FINAL-AUDIT-20261014](tasks/FINAL-AUDIT-20261014.md)。按用户追加授权，移除 Preview Notice、修复剩余确认缺陷并完成固定源码验收后，已发布 [v1.10.0](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.10.0)。此前[品牌统一](plan(20261013-232547).md)、[上一轮规格](plan(20261013-194000).md)及[完整 UI 迁移计划](plan(20261008-web-deepseek-parity).md)保留。各项包含做什么、怎么做与怎么验收。

最终发布源码 b65801e4 全量 9,521 PASS / 15 SKIP / 0 FAIL；发布脚本 77 PASS，原生 Windows 专项 393 PASS / 2 POSIX SKIP。完整第三轮 CI 的 10 个任务全部成功；同一安装包在 Ubuntu/Windows 的 Web 均 30 场景/75 断言、CLI 分别 50/49 断言通过，另有问答 15、品牌 96 断言通过。14 项代码/接口缺陷、1 项依赖公告及 7 处验收假设已处理，见[最终审查报告](docs/final-audit-20261014.md)与[安装及发布验收](docs/release-v1.10.0.md)。4 项公开发布资产已无需登录下载并逐字节复核。付费模型质量和完整默认 UI parity 仍为 NOT_PROVEN。

上一轮品牌任务已完成验收：固定 bda6b20 独立包中英文三视口品牌 90 断言、coding 30 场景/75 断言通过，Web 186、资源/传输 20、包路径 3 测试与 clean docs gate 通过。原始发布文件和合法版权归档保持不变；见[品牌报告](docs/web-branding.md)。该轮未改 Core，也未宣布全功能或模型质量通过。

已将官方完整 frontend shell 和 66 个默认客户端 entry 接到真实 Harness，根页面采用官方 UI，旧客户端保留在 `/legacy/index.html`。来源固定为官方 npm `0.2.1-alpha.1`，发布物没有 gitHead，不声明等同于参考 Git 源码。

2026-10-13：桌面、移动和窄高视口的 30 个实际编码/UI 场景、75 项断言通过；另有实际模型设置、双 tab、模型切换和进程重启 18 项断言通过。测试使用生产 Web/Runtime 与 loopback HTTP provider，付费调用为 0，不代表模型质量验收。详见[当前交付与缺口](docs/web-deepseek-delivery.md)和[逐项交付状态](docs/web-deepseek-delivery-matrix.json)。

本轮固定运行时代码 b38566d 已完成完整 9,473 PASS/15 skipped、安全/协议、独立包、真实 Windows、同包官方 UI/CLI、formal 与 coverage 验收。原主 CI 文档门缺当前入口 marker 而失败；入口和真正的当前日期规格已修正，实际 docs:verify PASS。归档提交仅改文档；新 main 自动 CI 的最终状态另行记录，不把旧 CI 称整体通过。

队列原子编辑、Cordis、goal/Plan continuation、可续写子智能体和强沙箱 PTY 等缺口尚在，W3–W6 与逐控件完整 parity 仍部分完成，不能发布为“全部默认 UI 功能已完成”。旧第一代工程计划与发布记录保留在[第一代规格](plan(20261008-024527).md)，原用户未提交文件、v1.9及固定 c5 证据不改写。
