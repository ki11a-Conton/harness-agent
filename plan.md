# Harness Agent 当前执行计划

当前任务：[DeepSeek Web UI 完整迁移计划](plan(20261008-web-deepseek-parity).md)，任务合同：[WEB-DEEPSEEK-PARITY-20261008](tasks/WEB-DEEPSEEK-PARITY-20261008.md)。各项包含做什么、怎么做与怎么验收。

已将官方完整 frontend shell 和 66 个默认客户端 entry 接到真实 Harness，根页面采用官方 UI，旧客户端保留在 `/legacy/index.html`。来源固定为官方 npm `0.2.1-alpha.1`，发布物没有 gitHead，不声明等同于参考 Git 源码。

2026-10-13：桌面、移动和窄高视口的 30 个实际编码/UI 场景、75 项断言通过；另有实际模型设置、双 tab、模型切换和进程重启 17 项断言通过。测试使用生产 Web/Runtime 与 loopback HTTP provider，付费调用为 0，不代表模型质量验收。详见[当前交付与缺口](docs/web-deepseek-delivery.md)和[逐项交付状态](docs/web-deepseek-delivery-matrix.json)。

接下来按 W8/W9 完成固定 clean 源码全量测试、独立 portable 包及同一包的 Windows 消费验收，再提交验收记录。队列原子编辑、Cordis、goal/Plan continuation、可续写子智能体和强沙箱 PTY 等缺口尚在，不能发布为“全部默认 UI 功能已完成”。旧第一代工程计划与发布记录保留在[第一代规格](plan(20261008-024527).md)，原用户未提交文件、v1.9及固定 c5 证据不改写。
