# Harness Agent 当前执行计划入口

当前任务：[Harness Agent Web 品牌统一](plan(20261013-232547).md)，任务合同：[WEB-BRANDING-20261013](tasks/WEB-BRANDING-20261013.md)。移除产品界面的上游名称、鲸鱼、字标及插画，独立资源/浏览器/安装包验收后提交推送。此前验收与缺口保留在[上一轮规格](plan(20261013-194000).md)和[完整 UI 迁移计划](plan(20261008-web-deepseek-parity).md)。各项包含做什么、怎么做与怎么验收。

本轮品牌任务已完成验收：固定 bda6b20 独立包中英文三视口品牌 90 断言、coding 30 场景/75 断言通过，Web 186、资源/传输 20、包路径 3 测试与 clean docs gate 通过。原始发布文件和合法版权归档保持不变；见[品牌报告](docs/web-branding.md)。本轮不改 Core，也不宣布全功能或模型质量通过。

已将官方完整 frontend shell 和 66 个默认客户端 entry 接到真实 Harness，根页面采用官方 UI，旧客户端保留在 `/legacy/index.html`。来源固定为官方 npm `0.2.1-alpha.1`，发布物没有 gitHead，不声明等同于参考 Git 源码。

2026-10-13：桌面、移动和窄高视口的 30 个实际编码/UI 场景、75 项断言通过；另有实际模型设置、双 tab、模型切换和进程重启 18 项断言通过。测试使用生产 Web/Runtime 与 loopback HTTP provider，付费调用为 0，不代表模型质量验收。详见[当前交付与缺口](docs/web-deepseek-delivery.md)和[逐项交付状态](docs/web-deepseek-delivery-matrix.json)。

本轮固定运行时代码 b38566d 已完成完整 9,473 PASS/15 skipped、安全/协议、独立包、真实 Windows、同包官方 UI/CLI、formal 与 coverage 验收。原主 CI 文档门缺当前入口 marker 而失败；入口和真正的当前日期规格已修正，实际 docs:verify PASS。归档提交仅改文档；新 main 自动 CI 的最终状态另行记录，不把旧 CI 称整体通过。

队列原子编辑、Cordis、goal/Plan continuation、可续写子智能体和强沙箱 PTY 等缺口尚在，W3–W6 与逐控件完整 parity 仍部分完成，不能发布为“全部默认 UI 功能已完成”。旧第一代工程计划与发布记录保留在[第一代规格](plan(20261008-024527).md)，原用户未提交文件、v1.9及固定 c5 证据不改写。
