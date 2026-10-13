# DeepSeek Harness Web UI 完整迁移与真实接线

基线：d2451026a194c03194ab56f79f465b7db1de2bed。用户指出此前Web只移植主题和少量布局，不满足完整复用DeepSeek UI要求。本任务必须先做源码和实际浏览器差距审查，再按完整标准UI矩阵执行。

## 做什么

复用有许可证上游真实Web shell和默认客户端组件，补齐布局、聊天/Markdown/工具、会话/工作区、模型/设置、右栏/文件/终端、审批/提问、任务与轨迹等默认界面；逐控件接入真实Harness能力，缺失后端必须实做或如实列阻断，不能以假成功/无效按钮充数。标准与上游experimental opt-in分别按真实默认组成记录。

## 怎么做

- 原用户dirty工作区、已经发布c5工程验收和历史RED/GREEN不改写；独立worktree完成。
- 上游固定源码/官方发布物分别记录sourceSHA/gitHead、原始tar integrity、文件hash、MIT及第三方notice；不能把发布物未经核验称为同一源码。
- 优先官方 `__DSH_TRANSPORT__.rpc` seam复用完整动态组件；适配真实gateway/runtime/services，不重写一套仿外观DOM。
- 先形成80项左右默认UI差异矩阵和具体transport endpoint/catalog，再更新plan.md列每域实现和验收。
- Core仍不依赖UI/providers；副作用沿ToolOrchestrator、PermissionEngine、SandboxManager、Verification。Runtime只能为复现正确性、安全或发布完整性缺陷补修，不能为UI方便绕过身份/审批/单写者或改写N7。
- 独立复核已观察的真实Markdown未渲染、长tool live/history差异、逐token未呈现、ask只显示waiting但无法回答等路径；记录真实RED，再实现GREEN。

## 怎么验收

- 矩阵每项均有实际上游源文件、采用方式、用户可见行为和真实后端证据；默认UI不能由几份CSS声称完成。
- 完整官方UI从本地离线资产正确boot；所有默认已交付控件有实际HTTP或RPC交互及可见结果；操作失败/权限拒绝明确显示，不伪造模型/文件/终端/任务状态。
- 生产Harness+真实loopback provider+Chromium桌面、移动端、窄高视口；Markdown/代码/公式/长输出、逐token、工具折叠、ask/approval、恢复、会话操作、右栏、配置及错误取消闭环；付费调用0不等于模型质量证明。
- 身份/路径/取消/策略漂移/未知请求/多tab与重连/审批拒绝等负向真实检查；src typecheck、相关unit/integration/security及固定clean源码完整测试。
- 真实Windows与同正式portable archive安装消费复验；新发布只在新源必要门通过后进行，不覆盖v1.9标签。

当前（2026-10-13）：官方完整客户端已接生产 Harness，普通编码链路三视口 30 场景/75 断言及实际模型配置/双 tab/重启 17 断言 PASS。见 `docs/web-deepseek-delivery.md`。W8 clean 全量及 W9 完整包/同包 Windows 门仍待最终运行；缺失的后端能力如实阻断，尚未声明默认 UI 全功能 parity 完成。
