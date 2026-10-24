# Workspace 树行键盘入口与操作可见性

基线：`54cd148eae82c2d9b9f4ab00ee7e0c2eb5ce2d5e`。合同：[RELEASE-V112-20261022](tasks/RELEASE-V112-20261022.md)。独立缺陷 `UI-WORKSPACE-KEYBOARD-01` 的审计与浏览器证据在工作树外 `/workspace/.cache/harness-longrun-20261020/ui-54cd-accessibility-audit/`；本轮新证据写入 `workspace-actions-20261024/`，不覆盖历史。

## 做什么

- 修复已证明的项目、会话及搜索结果树行无法通过原生 Tab 到达、无法按 Enter/Space 激活的问题。
- 行内有键盘焦点时显示原操作按钮；选中的会话即使鼠标移走，也持续显示原操作按钮。保留原 hover/menuOpen 行为。
- 单独验收嵌套按钮键盘操作，确保不会顺带触发行选择、折叠或重复导航。
- 历史 Windows 窄屏 session-lifecycle 第二次菜单点击从 stable 到 hidden 的具体原因仍为 `NOT_PROVEN`；本修复及本地通过均不能解释或代替该历史失败。

## 怎么做

- 只在自己的 `scripts/research/web-branding-lib.mjs` 衍生生成链增加受边界校验的 UI 转换，再重生成 `harness-brand` workspace 资产及必要清单。冻结 `apps/web/public/deepseek/plugins/` 原始输入。
- 使用最小行入口 `tabIndex=0`；Enter/Space 仅在事件目标就是该行、未被处理、非输入法组合/重复/修饰键时触发该行原有 click handler。嵌套原生 button 保持原生键盘行为，事件不得再次激活外层行。不新增全局快捷键或扩大成树导航重构。
- 在原行 CSS 上补充 `:focus-within` 与 selected session 的 actions 显示条件，并提供可见键盘焦点。不修改 Runtime、providers、权限、后端或真实业务 handler；真实操作继续沿原宿主及 ToolOrchestrator 链。
- 新建独立真实宿主验收脚本，不改 `deepseek-browser-interactions.mjs` 原30场景、pointer 动作、断言及4000ms时限；不 force click、不重试变绿、不放宽时限。

## 怎么验收

- 先在旧版真实 loopback production host、Chromium140/Playwright1.55.1 中观察原生 Tab 跳过树行及隐藏操作的 red，不能使用 mock DOM 或注入 CSS 代证。
- 同一真实宿主路径加载新衍生资产后，原生 Tab 到达项目/会话/搜索结果行及其操作；Enter/Space 调用原操作，项目和会话菜单、归档搜索恢复按钮实际可用。记录 nested button 没有触发外层行及没有重复导航。
- 选中会话、移开鼠标并移走焦点后，操作按钮仍可点击并完成真实菜单操作。原 hover/menuOpen 仍可显示操作。
- 补充受边界校验转换与键盘 guard 的定向回归、既有 workspace/navigation/branding 相关检查和 typecheck；本子任务不执行 full/coverage、提交、推送或网络发布。最终固定源码 full、同包双平台安装、原30场景及精确 SHA CI/发布由发布计划继续执行。
- 保存实际资产 hash、host/浏览器版本、红绿结果及限制；静态 CSS/DOM 审计只作补充，不宣称原生 Windows 或触屏已验收。

## 同一发行归档的门禁

`deepseek-installed.mjs` 在原30个 pointer 场景成功后，复用该归档的真实宿主，独立执行三个视口的键盘验收。预期 workspace SHA 从已验证的归档 manifest 唯一成员取得；逐视口要求正常验收模式、PASS、实际 OS、全部资产正文摘要一致，以及至少15组检查，总计至少45组，不能把旧版红观察算成通过。键盘计数单列，原30场景、75项基本断言和其它控制/日常/重连门禁保持。

本地工程报告保留该阶段的原始结果、截图和日志，只有其通过才记录 LOCAL_PASS/PASS。最终 clean SHA 的全量、同包 Web/CLI、四组 CI、实际导出和公开归档安装复验仍需全部完成。测试宿主的 SIGTERM 保活另经真实协议对照确认属于测试 IPC 生命周期：Web及目录锁已关闭，fixture-stop断开通道后正常0退出，不作为本次生产修复。
