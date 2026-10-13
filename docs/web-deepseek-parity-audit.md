# DeepSeek 默认 Web UI 完整移植审查（2026-10-08）

审查基线：本工程 `d2451026a194c03194ab56f79f465b7db1de2bed`，上游 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。此矩阵评价旧 `apps/web/public/index.html`、`app.js`、`style.css` 和 vendor manifest；正在实施的官方 bundle 需在完成后用同一 stable id 逐项重新验收。

用户所指缺漏成立：既有客户端移入六张主题 CSS 和七个展示 CSS 模块，保留真实发送、历史、取消、审批等少量能力，但没有移植默认 Web 的大部分组件、控制及渲染行为。六张 CSS 与 LICENSE 已实测 SHA256 一致。

共 146 项：已有 8、缩水/部分 26、缺失 106、可选未移植 6。条目按组件/交互/渲染规则拆分，会有模块级与细节项交叉；不按条目数声称插件覆盖率或测试通过。

## 范围与实施依据

默认组成以 `packages/bundle/web-app/cordis.patch.yml` 为准，不能由 npm 依赖或 preview fixture 推断默认启用。默认 Trajectory、右栏文档/文件/terminal、插件页、Settings、模型/权限/preset、任务/goal/plan/questions/subagent 均须有实际接线。Browser tab 为 Web opt-in；experimental 另列，不计默认缺。

父任务已选真实官方 MIT 发布包闭包和官方 Web entrypoint，通过官方 `__DSH_TRANSPORT__.rpc` seam 接 Harness。下表中纯组件或本地展示适配为早期备选，不构成缩小完整范围的理由。保留 MIT 和所有依赖许可证；字体另带 Montserrat OFL。

本审查只做源码与来源校验，Browser NOT_RUN。验收列是必须运行的可测条件，不是已通过结果。v1.9 的 49 工程 bug 修复以及旧 mini-client 的通过记录不证明完整 UI 移植。

上游没有永久删除 Session；默认是 archive/unarchive，workspace 删除仅取消注册并保留会话。不能把新需求冒充上游已有按钮。

## 默认 roster 对照

| entry | 默认 Web | exact source root | 矩阵 stable id |
|---|---|---|---|
| product-analytics | 关闭（desktop only） | `packages/client/product-analytics` |  |
| session-log-download | 启用 | `packages/session-query/session-log-export` |  |
| ui-open-in-app | 启用 | `packages/client/ui-open-in-app` | `open-in-app` |
| session-controller | 启用 | `packages/api/session-controller` |  |
| job-controller | 启用 | `packages/api/job-controller` |  |
| terminal-controller | 启用 | `packages/api/terminal-controller` |  |
| workspace-files | 启用 | `packages/api/workspace-files` |  |
| ui-settings-account | 启用 | `packages/client/ui-settings-account` | `settings.account` |
| workspace-controller | 启用 | `packages/api/workspace-controller` |  |
| client-hmr | 启用 | `packages/client/hmr` | `modules.live-extensions` |
| modules | 启用 | `packages/client/modules` | `modules.live-extensions` |
| connection | 启用 | `packages/client/connection` |  |
| file-upload | 启用 | `packages/client/file-upload` |  |
| api-remotes | 启用 | `packages/api/remotes` |  |
| cordis-client-runner | 启用 | `packages/extensions/cordis-client-runner` |  |
| ui-theme | 启用 | `packages/client/ui-theme` | `theme.vendor.base`, `theme.vendor.design-platform`, `theme.vendor.scrollbar`, `theme.vendor.focus`, `theme.vendor.corner-shape`, `theme.vendor.gradient-shadow-text`, `theme.preference`, `theme.prepaint`, `theme.onboarding-shiki`, `theme.brand-font` |
| locale | 启用 | `packages/client/locale` | `settings.locale` |
| shortcuts | 启用 | `packages/client/shortcuts` |  |
| ui-shortcuts | 启用 | `packages/client/ui-shortcuts` | `shortcuts.reference_customization` |
| ui-layout | 启用 | `packages/client/ui-layout` | `theme.preference`, `boot.document-title`, `layout.columns`, `layout.navigation-slots`, `shortcuts.new_sidebar`, `responsive.sidebar` |
| ui-renderer | 启用 | `packages/client/ui-renderer` | `modules.live-extensions` |
| ui-session | 启用 | `packages/client/ui-session` | `resources.unified` |
| resources | 启用 | `packages/client/resources` | `resources.unified` |
| ui-sidebar | 启用 | `packages/client/ui-sidebar` | `layout.navigation-slots`, `sidebar.shell` |
| ui-sidebar-right | 启用 | `packages/client/ui-sidebar-right` | `rightbar.shell`, `rightbar.docking`, `rightbar.state` |
| ui-sidebar-documentpreview | 启用 | `packages/client/ui-sidebar-documentpreview` | `preview.toolbar`, `preview.text-code-md`, `preview.html-image`, `preview.pdf-office-excel` |
| ui-sidebar-browser | 关闭（desktop only） | `packages/client/ui-sidebar-browser` | `optional.browser` |
| ui-sidebar-terminal | 启用 | `packages/client/ui-sidebar-terminal` | `terminal.interactive` |
| ui-sidebar-files | 启用 | `packages/client/ui-sidebar-files` | `files.tree` |
| ui-settings | 启用 | `packages/client/ui-settings` | `settings.general-coding` |
| ui-settings-general | 启用 | `packages/client/ui-settings-general` | `settings.shell`, `settings.connection-recovery`, `settings.general-coding` |
| ui-settings-models | 启用 | `packages/client/ui-settings-models` | `settings.models-directory`, `settings.models-credentials`, `settings.models-catalog`, `settings.onboarding-web` |
| ui-plugin-manager | 启用 | `packages/client/ui-plugin-manager` | `plugins.catalog`, `plugins.install`, `plugins.switch-remove` |
| ui-settings-plugin-inventory | 启用 | `packages/client/ui-settings-plugin-inventory` | `settings.builtin-inventory` |
| ui-conversation | 启用 | `packages/client/ui-conversation` | `brand.slots`, `chat.session_header`, `chat.view_tabs`, `composer.send.basic`, `composer.keyboard.safety`, `composer.primary.send_stop`, `composer.stop.double_escape`, `composer.busy_delivery`, `composer.command.plus_slash`, `composer.file_intake`, `composer.rich_controls.entries`, `composer.queue.dock`, `composer.todo.dock`, `conversation.content_width`, `composer.context_meter`, `responsive.composer_controls` |
| ui-approval | 启用 | `packages/client/ui-approval` | `approval.composer` |
| ui-chat | 启用 | `packages/client/ui-chat` | `render.message_content`, `render.user_text`, `render.markdown_links`, `render.markdown_images`, `render.message_images`, `render.file_attachments`, `render.unknown_block`, `render.reasoning`, `render.process_display`, `chat.system_prompt`, `chat.context_injection`, `chat.turn_trigger`, `chat.compaction`, `chat.retry_failure`, `chat.running_status`, `chat.session_activity_stats`, `chat.session_token_stats`, `chat.turn_token_usage`, `message.copy.assistant`, `message.copy.user_clock`, `message.turn_fork`, `chat.scroll.reading`, `chat.turn_navigation`, `chat.history.load_earlier` |
| ui-brand-official | 启用 | `packages/client/ui-brand-official` | `brand.slots` |
| ui-attachment | 启用 | `packages/client/ui-attachment` | `render.message_images`, `render.composer_attachments` |
| ui-tool | 启用 | `packages/client/ui-tool` | `render.tool_row`, `render.tool_cards`, `render.tool_subcalls`, `render.tool_navigation` |
| ui-cordis | 启用 | `packages/extensions/ui-cordis` | `cordis.historical-panel` |
| ui-deliverables | 启用 | `packages/client/ui-deliverables` | `deliverables.cards`, `deliverables.review-diff` |
| ui-workspace | 启用 | `packages/client/ui-workspace` | `workspace.catalog`, `workspace.picker`, `workspace.manage`, `workspace.view-options`, `workspace.search`, `session.new-navigation`, `session.rename`, `session.pin`, `session.fork`, `session.archive`, `session.row-details`, `shortcuts.new_sidebar` |
| ui-workflow-run | 启用 | `packages/client/ui-workflow-run` | `workflow.run` |
| ui-input-trigger | 启用 | `packages/client/ui-input-trigger` | `composer.reference.mention` |
| ui-commands | 启用 | `packages/client/ui-commands` | `composer.command.plus_slash` |
| ui-skill | 启用 | `packages/client/ui-skill` | `skill.invoke-preview-card` |
| ui-subagent | 启用 | `packages/client/ui-subagent` | `subagent.navigation`, `subagent.continuation` |
| ui-reference | 启用 | `packages/client/ui-reference` | `composer.reference.mention` |
| ui-jobs | 启用 | `packages/client/ui-jobs` | `jobs.roster` |
| ui-schedule | 启用 | `packages/client/ui-schedule` | `schedule.catalog`, `schedule.rules`, `schedule.history-delete` |
| ui-goal | 启用 | `packages/client/ui-goal` | `goal.bar` |
| ui-message-feedback | 启用 | `packages/client/ui-message-feedback` | `message.feedback.actions` |
| ui-model-selection | 启用 | `packages/client/ui-model-selection` | `model.selection` |
| ui-permission | 启用 | `packages/client/ui-permission-presets` | `permission.selection`, `optional.auto-review` |
| ui-agent-preset | 启用 | `packages/client/ui-agent-preset` | `presets.selection`, `presets.configuration-help` |
| ui-settings-session-log | 启用 | `packages/client/ui-settings-session-log` | `settings.session-log-upload` |
| ui-settings-plugins | 启用 | `packages/client/ui-settings-plugins` | `settings.builtin-inventory` |
| ui-settings-shell | 启用 | `packages/client/ui-settings-shell` | `settings.plugin-shell` |
| ui-settings-agent-loop | 启用 | `packages/client/ui-settings-agent-loop` | `settings.plugin-loop` |
| ui-settings-subagent | 启用 | `packages/client/ui-settings-subagent` | `settings.plugin-subagent` |
| ui-settings-web-search | 启用 | `packages/client/ui-settings-web-search` | `settings.plugin-websearch` |
| ui-plan | 启用 | `packages/client/ui-plan` | `plan.mode`, `plan.documents` |
| ui-user-questions | 启用 | `packages/client/ui-user-questions` | `questions.answer`, `questions.timed-recovery`, `plan.review` |
| ui-trajectory | 启用 | `packages/client/ui-trajectory` | `trajectory.default`, `trajectory.timeline`, `trajectory.default_inspection` |

## 完整矩阵索引

| stable id | 状态/范围 | 模块/行为 | exact upstream 原件 |
|---|---|---|---|
| `theme.vendor.base` | 已有 / default | 主题原样文件 base | `packages/client/ui-theme/src/styles/base.css:1` |
| `theme.vendor.design-platform` | 已有 / default | 主题原样文件 design-platform | `packages/client/ui-theme/src/styles/design-platform.css:1` |
| `theme.vendor.scrollbar` | 已有 / default | 主题原样文件 scrollbar | `packages/client/ui-theme/src/styles/scrollbar.css:1` |
| `theme.vendor.focus` | 已有 / default | 主题原样文件 focus | `packages/client/ui-theme/src/styles/focus.css:1` |
| `theme.vendor.corner-shape` | 已有 / default | 主题原样文件 corner-shape | `packages/client/ui-theme/src/styles/corner-shape.css:1` |
| `theme.vendor.gradient-shadow-text` | 已有 / default | 主题原样文件 gradient-shadow-text | `packages/client/ui-theme/src/styles/gradient-shadow-text.css:1` |
| `theme.preference` | 缩水/部分 / default | 主题选择与字体大小 | `packages/client/ui-theme/src/client/AppearanceRow.tsx:42`<br>`packages/client/ui-theme/src/client/FontSizeRow.tsx:35`<br>`packages/client/ui-theme/src/client/settings-store.ts:26`<br>`packages/client/ui-layout/src/client/theme-presenter.ts:15` |
| `theme.prepaint` | 缺失 / default | 首次渲染主题/字体bootstrap | `packages/client/ui-theme/src/index.ts:30`<br>`packages/client/ui-theme/src/client/index.ts:39` |
| `theme.onboarding-shiki` | 缺失 / default | onboarding与语法主题样式 | `packages/client/ui-theme/src/styles/onboarding.css:1`<br>`packages/client/ui-theme/src/styles/shiki.css:1` |
| `theme.brand-font` | 缺失 / default | 本地品牌字体与许可证 | `packages/client/ui-theme/src/styles/brand-font.css:1`<br>`packages/client/ui-theme/src/styles/Montserrat-OFL.txt:1` |
| `boot.manifest` | 缺失 / default | Web安装manifest/favicon | `apps/web/index.html:1`<br>`apps/web/public/manifest.webmanifest:1` |
| `boot.document-title` | 缩水/部分 / default | 动态document title | `packages/client/ui-layout/src/client/DocumentTitle.tsx:17` |
| `layout.columns` | 缩水/部分 / default | 三栏框架与可拖宽度 | `packages/client/ui-layout/src/client/AppFrame.tsx:121`<br>`packages/client/ui-layout/src/client/columns.ts:11`<br>`packages/client/ui-layout/src/client/stores.ts:78` |
| `layout.navigation-slots` | 缺失 / default | 全局页面/区域装配 | `packages/client/ui-layout/src/client/index.ts:150`<br>`packages/client/ui-layout/src/client/service.ts:1`<br>`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:88` |
| `sidebar.shell` | 缩水/部分 / default | 侧栏rail与导航细节 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:88`<br>`packages/client/ui-sidebar/src/client/SidebarRoot.module.css:1` |
| `brand.slots` | 缩水/部分 / default | 品牌/空态可插入组件 | `packages/client/ui-brand-official/src/client/index.ts:8`<br>`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx:22` |
| `workspace.catalog` | 缩水/部分 / default | workspace与session分组树 | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`<br>`packages/client/ui-workspace/src/client/tree.ts:18`<br>`packages/client/ui-workspace/src/client/rows/Rows.tsx:219` |
| `workspace.picker` | 缺失 / default | 工作目录选择与创建 | `packages/client/ui-workspace/src/client/WorkspacePicker.tsx:61`<br>`packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:273`<br>`packages/client/ui-directory-picker-native/src/client/flow.ts:25` |
| `workspace.manage` | 缺失 / default | workspace管理 | `packages/client/ui-workspace/src/client/rows/Rows.tsx:219`<br>`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836` |
| `workspace.view-options` | 缺失 / default | 导航视图/排序/归档过滤 | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`<br>`packages/client/ui-workspace/src/client/stores.ts:14`<br>`packages/client/ui-workspace/src/client/pin-order.ts:26` |
| `workspace.search` | 缺失 / default | 会话搜索 | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`<br>`packages/client/ui-workspace/src/client/rows/Rows.tsx:219` |
| `session.new-navigation` | 缩水/部分 / default | 新会话/恢复/导航正确性 | `packages/client/ui-workspace/src/client/navigation.ts:1`<br>`packages/client/ui-workspace/src/client/index.ts:96` |
| `session.rename` | 缺失 / default | 会话重命名 | `packages/client/ui-workspace/src/client/session-actions/RenameSession.tsx:19` |
| `session.pin` | 缺失 / default | 会话固定 | `packages/client/ui-workspace/src/client/session-actions/PinSession.tsx:30`<br>`packages/client/ui-workspace/src/client/pin-order.ts:26` |
| `session.fork` | 缺失 / default | 会话分叉 | `packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx:11` |
| `session.archive` | 缺失 / default | 会话归档/恢复 | `packages/client/ui-workspace/src/client/session-actions/ArchiveSession.tsx:31`<br>`packages/client/ui-workspace/src/client/session-actions/RowActionToast.tsx:25` |
| `session.row-details` | 缩水/部分 / default | 会话行状态与hover | `packages/client/ui-workspace/src/client/rows/Rows.tsx:219`<br>`packages/client/ui-workspace/src/client/session-actions/derived.ts:12` |
| `rightbar.shell` | 缺失 / default | 右侧栏开启/展示 | `packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx:161`<br>`packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx:34`<br>`packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx:33` |
| `rightbar.docking` | 缺失 / default | 右侧栏tabs/分屏/浮窗 | `packages/client/ui-dockkit/src/components/DockSurface.tsx:300`<br>`packages/client/ui-dockkit/src/components/TabLayout.tsx:118`<br>`packages/client/ui-dockkit/src/components/TabMenu.tsx:55`<br>`packages/client/ui-dockkit/src/components/FloatLayer.tsx:74`<br>`packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:88` |
| `rightbar.state` | 缺失 / default | 右侧栏恢复及资源导航 | `packages/client/ui-sidebar-right/src/client/index.ts:83`<br>`packages/client/ui-sidebar-right/src/client/contract/seed.ts:26` |
| `files.tree` | 缺失 / default | workspace文件树 | `packages/client/ui-sidebar-files/src/client/FilesBody.tsx:48`<br>`packages/client/ui-sidebar-files/src/client/FilesTitle.tsx:17`<br>`packages/client/ui-sidebar-files/src/client/definition.tsx:15` |
| `terminal.interactive` | 缺失 / default | 用户terminal | `packages/client/ui-sidebar-terminal/src/client/TerminalGuide.tsx:32`<br>`packages/client/ui-sidebar-terminal/src/client/terminal.tsx:24`<br>`packages/client/ui-sidebar-terminal/src/client/TerminalTitle.tsx:14`<br>`packages/client/ui-sidebar-terminal/src/client/TerminalRecovery.tsx:18`<br>`packages/client/ui-sidebar-terminal/src/client/TerminalCleanup.tsx:22` |
| `preview.toolbar` | 缺失 / default | 文件预览toolbar/状态 | `packages/client/ui-sidebar-documentpreview/src/client/TextTitle.tsx:16`<br>`packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx:56`<br>`packages/client/ui-sidebar-documentpreview/src/client/LoadingIndicator.tsx:11` |
| `preview.text-code-md` | 缺失 / default | Markdown/代码/纯文本预览 | `packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx:34`<br>`packages/client/ui-sidebar-documentpreview/src/client/code/CodeBody.tsx:14`<br>`packages/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx:9` |
| `preview.html-image` | 缺失 / default | HTML与图片预览 | `packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx:76`<br>`packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx:44`<br>`packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.tsx:24`<br>`packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx:31` |
| `preview.pdf-office-excel` | 缺失 / default | PDF/Office/Excel预览 | `packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx:45`<br>`packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx:44`<br>`packages/client/ui-sidebar-documentpreview/src/client/office/OfficeFontAction.tsx:16`<br>`packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx:21` |
| `open-in-app` | 缺失 / default | 外部应用打开/文件位置 | `packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx:33`<br>`packages/client/ui-open-in-app/src/client/OpenTargetButton.tsx:45`<br>`packages/client/ui-open-in-app/src/client/OpenPathAction.tsx:39`<br>`packages/client/ui-open-in-app/src/client/OpenPathEmptyAction.tsx:19` |
| `settings.shell` | 缺失 / default | Settings窗口/导航与focus | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:112`<br>`packages/client/ui-settings-general/src/client/GeneralSection.tsx:14`<br>`packages/client/ui-settings-general/src/client/chrome.tsx:22` |
| `settings.connection-recovery` | 缩水/部分 / default | 连接恢复反馈/重试 | `packages/client/ui-settings-general/src/client/chrome.tsx:22`<br>`packages/client/ui-primitives/src/ConnectionIndicator.tsx:29` |
| `settings.general-coding` | 缺失 / default | General开发工具与版本/配置文件 | `packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx:19`<br>`packages/client/ui-settings-general/src/client/CurrentVersionRow.tsx:10`<br>`packages/client/ui-settings-general/src/client/SettingsDocumentAction.tsx:29`<br>`packages/client/ui-settings/src/client/developer-tools.ts:1` |
| `settings.locale` | 缺失 / default | 语言选择与locale所有权 | `packages/client/locale/src/client/LanguageRow.tsx:30`<br>`packages/client/locale/src/client/bootstrap.ts:24`<br>`packages/client/locale/src/client/settings-store.ts:35` |
| `settings.account` | 缺失 / default | 账号与登录/登出 | `packages/client/ui-settings-account/src/client/AccountSection.tsx:84`<br>`packages/client/ui-settings-account/src/client/SignInDialog.tsx:11`<br>`packages/client/ui-settings-account/src/client/SignOutDialog.tsx:8`<br>`packages/client/ui-settings-account/src/client/AccountMenu.tsx:22` |
| `settings.models-directory` | 缺失 / default | Models provider页面 | `packages/client/ui-settings-models/src/client/ModelsSection.tsx:141`<br>`packages/client/ui-settings-models/src/client/ProviderEditor.tsx:121`<br>`packages/client/ui-settings-models/src/client/CustomProviderCard.tsx:95` |
| `settings.models-credentials` | 缺失 / default | API key与endpoint/protocol设置 | `packages/client/ui-settings-models/src/client/apiKey.ts:51`<br>`packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:42`<br>`packages/client/ui-settings-models/src/client/ProviderEditor.tsx:121`<br>`packages/client/ui-settings-models/src/client/EditorFooter.tsx:45` |
| `settings.models-catalog` | 缺失 / default | 模型列表/能力编辑 | `packages/client/ui-settings-models/src/client/ModelListEditor.tsx:148`<br>`packages/client/ui-settings-models/src/client/ModelRow.tsx:44`<br>`packages/client/ui-settings-models/src/client/ModelInputTypes.tsx:32` |
| `settings.onboarding-web` | 缺失 / default | Web首次启动welcome与凭证 | `packages/client/ui-settings-models/src/client/WelcomeNotice.tsx:34`<br>`packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx:58`<br>`packages/client/ui-settings-models/src/client/OnboardingModal.tsx:17` |
| `settings.session-log-upload` | 缺失 / default | General session log上传开关 | `packages/client/ui-settings-session-log/src/client/UploadRow.tsx:26` |
| `settings.builtin-inventory` | 缺失 / default | Built-in plugins只读inventory | `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx:33`<br>`packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:252` |
| `settings.plugin-shell` | 缺失 / default | Shell官方配置页 | `packages/client/ui-settings-shell/src/client/ShellCard.tsx:20` |
| `settings.plugin-loop` | 缺失 / default | Agent loop官方配置页 | `packages/client/ui-settings-agent-loop/src/client/AgentLoopCard.tsx:20` |
| `settings.plugin-subagent` | 缺失 / default | Subagent官方配置页 | `packages/client/ui-settings-subagent/src/client/SubagentCard.tsx:22`<br>`packages/client/ui-settings-subagent/src/client/SubagentLimitsFields.tsx:18`<br>`packages/client/ui-settings-subagent/src/client/SubagentModelSelectionFields.tsx:22` |
| `settings.plugin-websearch` | 缺失 / default | Web search官方配置页 | `packages/client/ui-settings-web-search/src/client/WebSearchCard.tsx:24` |
| `plugins.catalog` | 缺失 / default | Plugins全局页/详情/刷新 | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`<br>`packages/client/ui-plugin-manager/src/client/PluginRefreshToast.tsx:21`<br>`packages/client/ui-plugin-manager/src/client/presentation.ts:28` |
| `plugins.install` | 缺失 / default | 插件添加/安装输出与取消 | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`<br>`packages/client/ui-plugin-manager/src/client/manager-store.ts:124`<br>`packages/client/ui-plugin-manager/src/client/sanitize-install-input.ts:8` |
| `plugins.switch-remove` | 缺失 / default | bundle/entry enable disable remove | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`<br>`packages/client/ui-plugin-manager/src/client/manager-store.ts:124`<br>`packages/client/ui-plugin-manager/src/client/config-ledger.ts:36` |
| `presets.selection` | 缺失 / default | Agent preset当前/未来选择 | `packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx:81`<br>`packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx:64`<br>`packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:43` |
| `presets.configuration-help` | 缺失 / default | Preset配置/help/Creator入口 | `packages/client/ui-agent-preset/src/client/PresetGuideDialog.tsx:32`<br>`packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx:27`<br>`packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx:64` |
| `model.selection` | 缺失 / default | 模型/推理强度composer与/model | `packages/client/ui-model-selection/src/client/ModelSelect.tsx:64`<br>`packages/client/ui-model-selection/src/client/index.ts:107` |
| `permission.selection` | 缺失 / default | 权限preset composer/slash/settings | `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:76`<br>`packages/client/ui-permission-presets/src/client/PermissionRow.tsx:41`<br>`packages/client/ui-primitives/src/RiskConfirmation.tsx:29` |
| `goal.bar` | 缺失 / default | Goal strip/编辑和运行控制 | `packages/client/ui-goal/src/client/GoalBar.tsx:42`<br>`packages/client/ui-goal/src/client/GoalCommandInputView.tsx:17` |
| `plan.mode` | 缺失 / default | Plan模式入口/退出 | `packages/client/ui-plan/src/client/PlanModeControl.tsx:19`<br>`packages/client/ui-plan/src/client/index.ts:52` |
| `plan.documents` | 缺失 / default | plan卡片/完整文本和自动open | `packages/client/ui-plan/src/client/PlanCard.tsx:43`<br>`packages/client/ui-plan/src/client/PlanPreview.tsx:18` |
| `questions.answer` | 缺失 / default | agent questions回答交互 | `packages/client/ui-user-questions/src/client/QuestionComposer.tsx:35`<br>`packages/client/ui-user-questions/src/client/QuestionReplyView.tsx:21` |
| `questions.timed-recovery` | 缺失 / default | question计时/迟答/草稿恢复 | `packages/client/ui-user-questions/src/client/QuestionComposer.tsx:35`<br>`packages/client/ui-user-questions/src/client/index.ts:56` |
| `plan.review` | 缺失 / default | 计划审批composer card | `packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx:29` |
| `jobs.roster` | 缺失 / default | background jobs列表/输出/停止 | `packages/client/ui-jobs/src/client/JobListAction.tsx:325`<br>`packages/client/ui-jobs/src/client/index.ts:27` |
| `schedule.catalog` | 缺失 / default | Automation tasks全局页/header/row标记 | `packages/client/ui-schedule/src/client/TaskManagerPage.tsx:41`<br>`packages/client/ui-schedule/src/client/ScheduleCatalogAction.tsx:35`<br>`packages/client/ui-schedule/src/client/SessionScheduleMark.tsx:40`<br>`packages/client/ui-schedule/src/client/SessionScheduleHover.tsx:22` |
| `schedule.rules` | 缺失 / default | 任务Rules/时间与时区编辑 | `packages/client/ui-schedule/src/client/TaskDetail.tsx:250`<br>`packages/client/ui-schedule/src/client/DatePicker.tsx:118`<br>`packages/client/ui-schedule/src/client/ClockPicker.tsx:100`<br>`packages/client/ui-schedule/src/client/TaskMenu.tsx:123` |
| `schedule.history-delete` | 缺失 / default | 任务记录/linked session/delete/transcript | `packages/client/ui-schedule/src/client/DeliveryHistory.tsx:70`<br>`packages/client/ui-schedule/src/client/TaskDetail.tsx:250`<br>`packages/client/ui-schedule/src/client/ScheduleCreateCard.tsx:46`<br>`packages/client/ui-schedule/src/client/ScheduleTurnCard.tsx:103` |
| `workflow.run` | 缺失 / default | workflow run/phases/members | `packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx:347` |
| `deliverables.cards` | 缺失 / default | 交付物/changed files/inlinefile links | `packages/client/ui-deliverables/src/client/Deliverables.tsx:45`<br>`packages/client/ui-deliverables/src/client/ChangedFiles.tsx:37`<br>`packages/client/ui-deliverables/src/client/PresentedFileCard.tsx:22`<br>`packages/client/ui-deliverables/src/client/PresentRow.tsx:31` |
| `deliverables.review-diff` | 缺失 / default | 文件review比较/diff | `packages/client/ui-deliverables/src/client/ReviewTab.tsx:68`<br>`packages/client/ui-deliverables/src/client/FileDiff.tsx:14` |
| `trajectory.default` | 缺失 / default | Trajectory标准事件账本 | `packages/client/ui-trajectory/src/client/TrajectoryView.tsx:132`<br>`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2069`<br>`packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx:38`<br>`packages/client/ui-trajectory/src/client/TrajectoryTurnHeader.tsx:22` |
| `trajectory.timeline` | 缺失 / default | Trajectory timing overview | `packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx:241`<br>`packages/client/ui-trajectory/src/client/TrajectoryTurn.tsx:22` |
| `primitive.controls` | 缩水/部分 / default | 菜单/modal/tooltip/toast/forms/焦点 | `packages/client/ui-primitives/src/Menu.tsx:84`<br>`packages/client/ui-primitives/src/Modal.tsx:48`<br>`packages/client/ui-primitives/src/Tooltip.tsx:20`<br>`packages/client/ui-primitives/src/Toast.tsx:46`<br>`packages/client/ui-primitives/src/input-modality.ts:9`<br>`packages/client/ui-primitives/src/focus.ts:12`<br>`packages/client/ui-primitives/src/settings-form/SettingsForm.tsx:50` |
| `modules.live-extensions` | 缺失 / default | 模块装配/HMR/插件UI扩展 | `packages/client/modules/src/client/index.ts:39`<br>`packages/client/ui-renderer/src/client/index.ts:52`<br>`packages/client/ui-slots/src/index.ts:865`<br>`packages/client/hmr/src/client/index.ts:9` |
| `resources.unified` | 缺失 / default | 资源模型/授权读取与共享 | `packages/client/resources/src/client/index.ts:23`<br>`packages/client/ui-session/src/client/index.ts:664` |
| `optional.browser` | 可选未移植 / optional-web-disabled | Web opt-in sandbox browser tab | `packages/client/ui-sidebar-browser/src/client/index.ts:40`<br>`packages/client/ui-sidebar-browser/README.md:10`<br>`packages/bundle/web-app/cordis.patch.yml:1` |
| `optional.voice` | 可选未移植 / experimental | Experimental voice input | `packages/experimental/client-ui-voice-input/src/client/VoiceInput.tsx:56`<br>`packages/experimental/client-ui-voice-input/src/client/VoiceSetupDialog.tsx:16`<br>`packages/experimental/voice-input-bundle/cordis.patch.yml:1` |
| `optional.agent-team` | 可选未移植 / experimental | Experimental Agent Team | `packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:179`<br>`packages/experimental/agent-team-profile/cordis.patch.yml:1` |
| `optional.inspector` | 可选未移植 / experimental | Experimental shared/session inspector | `packages/experimental/session-inspector/src/client/views/View.tsx:47`<br>`packages/experimental/inspector/src/client/bottom/page.tsx:58`<br>`packages/experimental/inspector-profile/cordis.patch.yml:1` |
| `optional.auto-review` | 可选未移植 / experimental | Experimental Auto permission integration | `packages/experimental/auto-review/cordis.patch.yml:1`<br>`packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:76` |
| `optional.claude-mods` | 可选未移植 / experimental | Experimental Claude Code mods | `packages/experimental/client-ui-claude-code-mods/src/client/Band.tsx:104`<br>`packages/experimental/client-ui-claude-code-mods/src/client/index.ts:16` |
| `approval.composer` | 缩水/部分 / default | 审批composer占位/工具详情与键盘 | `packages/client/ui-approval/src/client/ApprovalPanel.tsx:12`<br>`packages/client/ui-approval/src/client/index.ts:25` |
| `subagent.navigation` | 缺失 / default | Subagent目录/lineage/右栏聊天 | `packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx:744`<br>`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:18` |
| `subagent.continuation` | 缺失 / default | 子agent继续/只读/独立停止 | `packages/client/ui-subagent/src/client/SubagentReadOnlyComposer.tsx:19`<br>`packages/client/ui-subagent/src/client/index.ts:34` |
| `skill.invoke-preview-card` | 缺失 / default | Skill slash invoke/预览/历史卡 | `packages/client/ui-skill/src/client/index.ts:73`<br>`packages/client/ui-skill/src/client/SkillRow.tsx:102` |
| `cordis.historical-panel` | 缺失 / default | Cordis历史卡与process-local定义控制 | `packages/extensions/ui-cordis/src/client/CordisPanel.tsx:118`<br>`packages/extensions/ui-cordis/src/client/CordisDefineRow.tsx:39`<br>`packages/extensions/ui-cordis/src/client/CordisRunRow.tsx:36`<br>`packages/extensions/ui-cordis/src/client/CordisActionRow.tsx:16` |
| `render.message_content` | 缩水/部分 / default | 按content类型保留正文、推理、图片、工具及未知block | `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:79`<br>`packages/client/ui-chat/src/client/chat/MessageItem.tsx:19` |
| `render.user_text` | 缩水/部分 / default | 用户安全纯文本气泡及语义引用 | `packages/client/ui-chat/src/client/chat/MessageItem.tsx:221`<br>`packages/client/ui-chat/src/client/chat/MessageItem.tsx:195` |
| `render.markdown_gfm` | 缺失 / default | 完整GFM正文：标题/列表/引用/强调/删除线/任务/表格/脚注 | `packages/client/ui-primitives/src/markdown/parse.ts:27`<br>`packages/client/ui-primitives/src/markdown/render.tsx:275`<br>`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:29` |
| `render.markdown_math` | 缺失 / default | 完成回复中的TeX与兼容分隔符 | `packages/client/ui-primitives/src/markdown/parse.ts:40`<br>`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:149`<br>`packages/client/ui-primitives/src/markdown/katex.tsx:1` |
| `render.markdown_links` | 缺失 / default | 普通URL、行号文件链接、inline-code URL/文件引用 | `packages/client/ui-primitives/src/markdown/render.tsx:301`<br>`packages/client/ui-primitives/src/markdown/render.tsx:553`<br>`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:164`<br>`packages/client/ui-chat/src/client/apply.ts:216` |
| `render.untrusted_html_literal` | 已有 / default | 模型HTML不执行且输出安全 | `packages/client/ui-primitives/src/markdown/render.tsx:333`<br>`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:170` |
| `render.markdown_streaming` | 缺失 / default | 流式Markdown增量冻结与稳定DOM | `packages/client/ui-primitives/src/markdown/MarkdownText.tsx:66`<br>`packages/client/ui-primitives/src/markdown/incremental.ts:1` |
| `render.code_fence` | 缩水/部分 / default | 代码围栏、语言名、横向滚动与复制 | `packages/client/ui-primitives/src/markdown/CodeBlock.tsx:71`<br>`packages/client/ui-primitives/src/markdown/render.tsx:385` |
| `render.code_toolbar` | 缩水/部分 / default | 代码卡片换行切换/复制确认/粘性header | `packages/client/ui-primitives/src/CodeToolbar.tsx:38`<br>`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:156`<br>`packages/client/ui-primitives/src/markdown/CodeBlock.module.css:1` |
| `render.code_highlight` | 缺失 / default | 语言grammar懒加载、流式增量语法高亮 | `packages/client/ui-primitives/src/markdown/CodeBlock.tsx:77`<br>`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:120`<br>`packages/client/ui-primitives/src/markdown/highlight.ts:1` |
| `render.markdown_images` | 缺失 / default | Markdown远程/本地图片、安全alt fallback与预览 | `packages/client/ui-primitives/src/markdown/render.tsx:70`<br>`packages/client/ui-primitives/src/markdown/render.tsx:639`<br>`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:23` |
| `render.message_images` | 缺失 / default | 用户/助手/工具图集、单图尺寸与失败重试 | `packages/client/ui-attachment/src/MessageImage.tsx:45`<br>`packages/client/ui-attachment/src/MessageImage.tsx:85`<br>`packages/client/ui-attachment/src/MessageImage.tsx:169`<br>`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:104` |
| `render.image_lightbox` | 缺失 / default | 原图modal、Esc/遮罩/关闭与焦点恢复 | `packages/client/ui-primitives/src/ImageLightbox.tsx:27`<br>`packages/client/ui-primitives/src/ImageLightbox.tsx:36` |
| `render.file_attachments` | 缺失 / default | 历史用户文件卡片：名称/类型/大小/顺序 | `packages/client/ui-chat/src/client/chat/MessageItem.tsx:208` |
| `render.composer_attachments` | 缺失 / default | 草稿图片/文件rail、拖放、上传进度/删除/失败重试 | `packages/client/ui-attachment/src/client/ComposerAttachments.tsx:21`<br>`packages/client/ui-attachment/src/client/ComposerAttachments.tsx:59`<br>`packages/client/ui-attachment/src/FileCard.tsx:21`<br>`packages/client/ui-attachment/src/client/index.ts:16` |
| `render.unknown_block` | 缺失 / default | 未知/额外消息block的受限JSON披露 | `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:131`<br>`packages/client/ui-chat/src/client/chat/MessageItem.tsx:223`<br>`packages/client/ui-primitives/src/markdown/JsonBlock.tsx:8` |
| `render.reasoning` | 缺失 / default | 推理独立disclosure与流式摘要 | `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx:47`<br>`packages/client/ui-chat/src/client/chat/ReasoningRow.tsx:56`<br>`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:92` |
| `render.process_display` | 缺失 / default | work details四模式、步骤组与completed turn整体折叠 | `packages/client/ui-chat/src/chat-settings.ts:32`<br>`packages/client/ui-chat/src/client/presentation-policy.ts:24`<br>`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx:36`<br>`packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx:1` |
| `render.tool_row` | 缩水/部分 / default | 工具准备/运行/完成/失败/停止生命周期与独立披露 | `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:120`<br>`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:169`<br>`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:1` |
| `render.tool_cards` | 缺失 / default | 默认专业工具卡：terminal/read/image/diff/search/web/todo/details/question | `packages/client/ui-tool/src/client/apply.ts:44`<br>`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:169`<br>`packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx:33` |
| `render.tool_subcalls` | 缺失 / default | 工具/PTC子调用树 | `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:61`<br>`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:82` |
| `render.tool_navigation` | 缺失 / default | 工具文件/URL链接和Inspect跳转 | `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:189`<br>`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:197`<br>`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:38` |
| `chat.system_prompt` | 缺失 / default | 完整系统提示词及历史更新披露 | `packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx:25`<br>`packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts:92` |
| `chat.context_injection` | 缺失 / default | 注入/召回/工具增减上下文及producer/form详情 | `packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx:31`<br>`packages/client/ui-chat/src/client/chat/ContextBody.tsx:551` |
| `chat.turn_trigger` | 缺失 / default | 非人工回合触发归因、时间与内容披露 | `packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.tsx:29`<br>`packages/client/ui-chat/src/client/chat/turn-trigger.ts:1` |
| `chat.compaction` | 缺失 / default | 自动/手动压缩标记、token/item数量与summary | `packages/client/ui-chat/src/client/chat/CompactionItem.tsx:31`<br>`packages/client/ui-chat/src/client/chat/register-node-renderers.ts:52` |
| `chat.retry_failure` | 缩水/部分 / default | 重试倒计时、错误/配额/输出上限持久反馈 | `packages/client/ui-chat/src/client/chat/MessageItem.tsx:61`<br>`packages/client/ui-chat/src/client/chat/MessageItem.tsx:129`<br>`packages/client/ui-chat/src/client/chat/MessageItem.tsx:146`<br>`packages/client/ui-chat/src/client/chat/QuotaNoticeHost.tsx:1` |
| `chat.running_status` | 缩水/部分 / default | 运行尾部状态、计时及reduced motion | `packages/client/ui-chat/src/client/chat/RunningStatus.tsx:20`<br>`packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx:1` |
| `chat.session_activity_stats` | 缺失 / default | session turn/step、速度、LLM/tool/TTFT统计弹层 | `packages/client/ui-chat/src/client/chat/StatsPills.tsx:156`<br>`packages/client/ui-chat/src/client/chat/StatsPills.tsx:237`<br>`packages/bundle/web-app/cordis.patch.yml:102` |
| `chat.session_token_stats` | 缺失 / default | session tokens/cache hit弹层 | `packages/client/ui-chat/src/client/chat/StatsPills.tsx:282`<br>`packages/client/ui-chat/src/client/chat/StatsPills.tsx:311`<br>`packages/client/ui-chat/src/chat-settings.ts:41` |
| `chat.turn_token_usage` | 缺失 / default | 完成Turn消耗pill与routes/cache/input/output/reasoning详情 | `packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx:31`<br>`packages/client/ui-chat/src/client/chat/turn-assistant.ts:1`<br>`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:1` |
| `chat.session_header` | 缩水/部分 / default | title/breadcrumb层级与header插槽 | `packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx:12`<br>`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:58` |
| `chat.view_tabs` | 缺失 / default | 默认Chat/Trajectory切换及会话选择记忆 | `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:140`<br>`packages/client/ui-conversation/src/client/view-selection.ts:3`<br>`packages/bundle/web-app/cordis.patch.yml:445` |
| `trajectory.default_inspection` | 缺失 / default | 默认事件账本/请求/system/tools/code详情（父matrix有细项） | `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:223`<br>`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2938`<br>`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:3075`<br>`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:3222` |
| `composer.send.basic` | 已有 / default | 发送按钮、Enter发送、Shift+Enter换行 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:314`<br>`packages/client/ui-conversation/src/client/input/editor/keymap.ts:140` |
| `composer.keyboard.safety` | 缩水/部分 / default | IME尾键、重复Enter和修饰键仲裁 | `packages/client/ui-conversation/src/client/input/editor/keymap.ts:60`<br>`packages/client/ui-conversation/src/client/input/editor/keymap.ts:135` |
| `composer.primary.send_stop` | 缩水/部分 / default | 主操作随运行/草稿变为Send或Stop | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:294`<br>`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:460` |
| `composer.stop.double_escape` | 缺失 / default | 双Esc停止与区域隔离 | `packages/client/ui-conversation/src/client/stop-shortcut.ts:31`<br>`packages/client/ui-conversation/src/client/apply.ts:259` |
| `composer.busy_delivery` | 缺失 / default | 运行时Queue/Steer偏好与Ctrl/Cmd+Enter互补递送 | `packages/client/ui-conversation/src/client/input/submission-policy.ts:18`<br>`packages/client/ui-conversation/src/submission-settings.ts:17`<br>`packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.tsx:50` |
| `message.copy.assistant` | 缩水/部分 / default | Assistant复制的成功时限与防重复 | `packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:53`<br>`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:85` |
| `message.copy.user_clock` | 缺失 / default | User复制与消息时间 | `packages/client/ui-chat/src/client/chat/MessageItem.tsx:332`<br>`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:77`<br>`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:63` |
| `message.turn_fork` | 缺失 / default | 完成Turn末尾的消息分支 | `packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:63`<br>`packages/client/ui-chat/src/client/apply.ts:248` |
| `message.feedback.actions` | 缺失 / default | Like/Dislike与已记录判断撤回 | `packages/bundle/web-app/cordis.patch.yml:396`<br>`packages/client/ui-message-feedback/src/client/MessageFeedbackActions.tsx:50` |
| `chat.scroll.reading` | 缩水/部分 / default | 流式滚动尊重读者位置、回到底部和会话阅读记忆 | `packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:52`<br>`packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:127`<br>`packages/client/ui-chat/src/client/chat/ChatView.tsx:287` |
| `chat.turn_navigation` | 缺失 / default | Turn轨道导航、预览与未加载Turn跳转 | `packages/client/ui-chat/src/client/chat/ChatView.tsx:231`<br>`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:61`<br>`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:227` |
| `chat.history.load_earlier` | 缺失 / default | 显式加载更早历史 | `packages/client/ui-chat/src/client/chat/ChatView.tsx:249`<br>`packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:135` |
| `composer.command.plus_slash` | 缺失 / default | 加号与/命令候选、键盘仲裁 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:420`<br>`packages/client/ui-commands/src/client/service.ts:115`<br>`packages/client/ui-conversation/src/client/input/editor/keymap.ts:105`<br>`packages/client/ui-conversation/src/client/input/editor/keymap.ts:147` |
| `composer.reference.mention` | 缺失 / default | @文件/会话引用、目录下钻和引用chip | `packages/client/ui-reference/src/client/index.ts:54`<br>`packages/client/ui-reference/src/client/index.ts:112`<br>`packages/client/ui-input-trigger/src/client/MenuView.tsx:107` |
| `composer.file_intake` | 缺失 / default | 加号文件选择、粘贴文件与发送门控 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:434`<br>`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:80`<br>`packages/client/ui-conversation/src/client/input/editor/keymap.ts:159` |
| `composer.rich_controls.entries` | 缺失 / default | Permission/Plan/Model及activity插槽的composer入口 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:442` |
| `composer.queue.dock` | 缩水/部分 / default | Queue状态、折叠、编辑/删除/立即steer | `packages/client/ui-conversation/src/client/queue/QueueDock.tsx:104`<br>`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:175`<br>`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:163`<br>`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:267` |
| `composer.todo.dock` | 缺失 / default | Todo进度摘要与展开列表 | `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:65`<br>`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:115`<br>`packages/client/ui-conversation/src/client/apply.ts:551` |
| `conversation.content_width` | 缺失 / default | 对称宽度拖柄及持久化 | `packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:64`<br>`packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:154`<br>`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:247` |
| `composer.context_meter` | 缺失 / default | 上下文占用环、百分比与组成面板 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:499`<br>`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:57`<br>`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:111` |
| `shortcuts.reference_customization` | 缺失 / default | 快捷键目录、搜索、改键与恢复默认 | `packages/bundle/web-app/cordis.patch.yml:255`<br>`packages/client/ui-shortcuts/src/client/index.ts:42`<br>`packages/client/ui-shortcuts/src/client/Reference.tsx:110` |
| `shortcuts.new_sidebar` | 缺失 / default | 默认Web新建会话和侧栏快捷键 | `packages/client/ui-workspace/src/client/shortcuts.ts:78`<br>`packages/client/ui-layout/src/client/index.ts:191` |
| `responsive.sidebar` | 缩水/部分 / default | 窄屏自动收起与桌面偏好恢复 | `packages/client/ui-layout/src/client/columns.ts:13`<br>`packages/client/ui-layout/src/client/stores.ts:106` |
| `responsive.composer_controls` | 缩水/部分 / default | 窄composer容器下的工具间距和可用性 | `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:261`<br>`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:293`<br>`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:254` |

## 逐项差距、控制、复用和验收

### theme.vendor.base — 主题原样文件 base

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/base.css:1`。

当前证据：`apps/web/public/vendor/deepseek/base.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.vendor.design-platform — 主题原样文件 design-platform

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/design-platform.css:1`。

当前证据：`apps/web/public/vendor/deepseek/design-platform.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.vendor.scrollbar — 主题原样文件 scrollbar

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/scrollbar.css:1`。

当前证据：`apps/web/public/vendor/deepseek/scrollbar.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.vendor.focus — 主题原样文件 focus

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/focus.css:1`。

当前证据：`apps/web/public/vendor/deepseek/focus.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.vendor.corner-shape — 主题原样文件 corner-shape

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/corner-shape.css:1`。

当前证据：`apps/web/public/vendor/deepseek/corner-shape.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.vendor.gradient-shadow-text — 主题原样文件 gradient-shadow-text

状态：已有；范围：default。

上游行为：上游共享设计tokens/基础规则。

原件证据：`packages/client/ui-theme/src/styles/gradient-shadow-text.css:1`。

当前证据：`apps/web/public/vendor/deepseek/gradient-shadow-text.css`；`apps/web/public/vendor/deepseek/source-manifest.json:8`。清单声明verbatim；已存在原样源码。

按钮/交互：无独立按钮

建议：现有逐字CSS可直接保留；用sha256核对并保留vendor/deepseek/LICENSE和source-manifest.json。

可测验收：上游与vendor SHA256相同；light/dark使用相同token值。

### theme.preference — 主题选择与字体大小

状态：缩水/部分；范围：default。

上游行为：General提供light/dark/system及10–22px字体，Host持久化/系统实时跟随，presenter同步UA色系和theme-color。

原件证据：`packages/client/ui-theme/src/client/AppearanceRow.tsx:42`；`packages/client/ui-theme/src/client/FontSizeRow.tsx:35`；`packages/client/ui-theme/src/client/settings-store.ts:26`；`packages/client/ui-layout/src/client/theme-presenter.ts:15`。

当前证据：`apps/web/public/app.js:657`；`apps/web/public/style.css:8`。light/dark两态localStorage；初始system采样一次，无system选项/监听/font设置/theme-color；正文固定14px。

按钮/交互：Light；Dark；System；字体减/增/数值

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：选System后OS主题变化生效；改到10/22px影响消息与composer，重启后保留；theme-color与body一致。

### theme.prepaint — 首次渲染主题/字体bootstrap

状态：缺失；范围：default。

上游行为：Host注入head palette和body pre-plugin脚本，首次paint使用持久主题/字体。

原件证据：`packages/client/ui-theme/src/index.ts:30`；`packages/client/ui-theme/src/client/index.ts:39`。

当前证据：`apps/web/public/index.html:1`；`apps/web/public/app.js:666`。加载body/app.js后才setTheme；无上游Host bootstrap。

按钮/交互：无独立按钮

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：带dark持久配置冷启动，无先亮后暗；首paint正文尺寸正确。

### theme.onboarding-shiki — onboarding与语法主题样式

状态：缺失；范围：default。

上游行为：主题默认client还加载onboarding/shiki两张CSS。

原件证据：`packages/client/ui-theme/src/styles/onboarding.css:1`；`packages/client/ui-theme/src/styles/shiki.css:1`。

当前证据：`apps/web/public/vendor/deepseek/source-manifest.json:8`；`apps/web/public/index.html:8`。只移入六张sheet；onboarding.css/shiki.css缺失。

按钮/交互：无独立按钮

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：两文件在产物加载；onboarding颜色与代码token在双主题正确。

### theme.brand-font — 本地品牌字体与许可证

状态：缺失；范围：default。

上游行为：Web entry离线加载Montserrat Light/Regular/Medium，普通UI仍系统字体。

原件证据：`packages/client/ui-theme/src/styles/brand-font.css:1`；`packages/client/ui-theme/src/styles/Montserrat-OFL.txt:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：无独立按钮

建议：直接复制font CSS、三个WOFF2和Montserrat-OFL.txt，构建产物带OFL；Harness品牌文字由props替换。

可测验收：断网品牌字体加载成功；三个字体及OFL进入产物。

### boot.manifest — Web安装manifest/favicon

状态：缺失；范围：default。

上游行为：Web头部含manifest和随系统light/dark favicon。

原件证据：`apps/web/index.html:1`；`apps/web/public/manifest.webmanifest:1`。

当前证据：`apps/web/public/index.html:1`。无manifest/favicon link；public只app/styles/vendor。

按钮/交互：浏览器安装入口

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：manifest合法可读；明暗favicon可读。

### boot.document-title — 动态document title

状态：缩水/部分；范围：default。

上游行为：文档标题跟随可见panel与session及本地build元数据。

原件证据：`packages/client/ui-layout/src/client/DocumentTitle.tsx:17`。

当前证据：`apps/web/public/index.html:7`；`apps/web/public/app.js:79`。固定Harness Agent工作台标题；当前只更新h1会话title。

按钮/交互：无独立按钮

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切会话/全局面板后title同步。

### layout.columns — 三栏框架与可拖宽度

状态：缩水/部分；范围：default。

上游行为：普通Web左栏280px可拖264–420，折叠56px rail，1024px自动折叠；右栏300px起，中心优先400px。

原件证据：`packages/client/ui-layout/src/client/AppFrame.tsx:121`；`packages/client/ui-layout/src/client/columns.ts:11`；`packages/client/ui-layout/src/client/stores.ts:78`。

当前证据：`apps/web/public/style.css:17`；`apps/web/public/style.css:120`；`apps/web/public/app.js:651`。固定264px两栏，collapse完全隐藏，无rail/drag/rightcolumn；760px才overlay。

按钮/交互：左栏宽度divider拖动；右栏宽度divider拖动；左栏展开/折叠

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：1366px三栏可见且可拖；1023px auto rail；恢复桌面时保留宽度。

### layout.navigation-slots — 全局页面/区域装配

状态：缺失；范围：default。

上游行为：main/sidebar/rightbar/shell slots、主页面注册，global panel与conversation统一导航。

原件证据：`packages/client/ui-layout/src/client/index.ts:150`；`packages/client/ui-layout/src/client/service.ts:1`；`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:88`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Plugins入口；Automation tasks入口；Settings入口

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切全局页不发送/激活session；返回conversation保留draft/panels。

### sidebar.shell — 侧栏rail与导航细节

状态：缩水/部分；范围：default。

上游行为：collapse内容freeze+crossfade，rail品牌hover换展开icon，panel rows、底部settings/account action；pointer离开2秒隐藏scrollbar。

原件证据：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:88`；`packages/client/ui-sidebar/src/client/SidebarRoot.module.css:1`。

当前证据：`apps/web/public/index.html:21`；`apps/web/public/app.js:651`；`apps/web/public/style.css:17`。new/toggle已有；collapse无rail，footer是静态本地工作台，不含settings/account/全局页；无上游动画或scrollbar行为。

按钮/交互：New session；Expand/collapse；全局panel icons；底部settings/account

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：折叠rail仍可新建与开全局页；collapse过渡不换行；pointer离开后scrollbar隐藏。

### brand.slots — 品牌/空态可插入组件

状态：缩水/部分；范围：default。

上游行为：brand mark/name与intent hero由slot提供，hero有workspace/preset就位。

原件证据：`packages/client/ui-brand-official/src/client/index.ts:8`；`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx:22`。

当前证据：`apps/web/public/index.html:21`；`apps/web/public/index.html:41`。h字标与自定义固定hero为有意品牌替换，但workspace/mode插入位及行为均无。

按钮/交互：Hero选择workspace；Hero mode/preset；brand affordance

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：保留Harness品牌替换时，选择workspace/mode仍具上游行为。

### workspace.catalog — workspace与session分组树

状态：缩水/部分；范围：default。

上游行为：按Workspace/Workspace Tree/flat显示，canonical path独立；5 idle quota，running和当前blank额外，show more/less。

原件证据：`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`；`packages/client/ui-workspace/src/client/tree.ts:18`；`packages/client/ui-workspace/src/client/rows/Rows.tsx:219`。

当前证据：`apps/web/public/app.js:538`；`apps/web/public/index.html:26`。单一平面session-list；无workspace目录/树/分组/配额/展开。

按钮/交互：展开/折叠workspace；Show more；Show less

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：6+idle分批展示，running不占quota；tree父子indent/current祖先高亮。

### workspace.picker — 工作目录选择与创建

状态：缺失；范围：default。

上游行为：Add workspace或hero picker调auto native/browse carrier，注册目录并打开session，pending防重复。

原件证据：`packages/client/ui-workspace/src/client/WorkspacePicker.tsx:61`；`packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:273`；`packages/client/ui-directory-picker-native/src/client/flow.ts:25`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Add workspace；目录进入/返回；Choose；Cancel；Hero Workspace picker

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：选择真实目录后新session cwd对应；cancel保留当前；pending连续点击不会重复创建。

### workspace.manage — workspace管理

状态：缺失；范围：default。

上游行为：workspace rename、delete确认、siblings reorder；取消注册保留Sessions及子Workspace。

原件证据：`packages/client/ui-workspace/src/client/rows/Rows.tsx:219`；`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Rename workspace；Delete workspace；Confirm/cancel；workspace drag

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：取消Delete无变更；确认后session进入Ungrouped，子workspace留存；拖siblings跨reload保留。

### workspace.view-options — 导航视图/排序/归档过滤

状态：缺失；范围：default。

上游行为：WorkSpace/Workspace Tree/none；Last updated/Manual；Hide archived/All/Archived only；pinned partition。

原件证据：`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`；`packages/client/ui-workspace/src/client/stores.ts:14`；`packages/client/ui-workspace/src/client/pin-order.ts:26`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：View options；Group by；Sort；Archive filter；row drag

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切三种归档过滤正确；drag转Manual并保留隐藏archives；reload保留选择。

### workspace.search — 会话搜索

状态：缺失；范围：default。

上游行为：header展开搜索，title/workspace立即substring；250ms Host内容搜索只有启用index才补，20cap，取消旧请求，archived result可unarchive。

原件证据：`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx:836`；`packages/client/ui-workspace/src/client/rows/Rows.tsx:219`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Search展开；输入/clear/close；结果选择；Unarchive

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：metadata search默认可用；连续query不受旧响应污染；归档结果不直接open；内容索引disabled不记默认缺失。

### session.new-navigation — 新会话/恢复/导航正确性

状态：缩水/部分；范围：default。

上游行为：retain main reference立即呈现loading，restore blank、eligible blank reuse、initialize default workspace，late导航不覆新选择。

原件证据：`packages/client/ui-workspace/src/client/navigation.ts:1`；`packages/client/ui-workspace/src/client/index.ts:96`。

当前证据：`apps/web/public/app.js:85`；`apps/web/public/app.js:110`；`apps/web/public/app.js:666`。已有new/bootstrap、generation abort/selection restore及history/SSE；session id是web from，本地导航未提供workspace/blank/preset完整语义。

按钮/交互：New session；select session

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：快速A/B/new切换旧history不污染；拒绝new toast含Host原因；first-use workspace可恢复。

### session.rename — 会话重命名

状态：缺失；范围：default。

上游行为：row menu和title doubleclick打开预填rename；保存同title仍允许固定自动标题。

原件证据：`packages/client/ui-workspace/src/client/session-actions/RenameSession.tsx:19`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Rename；doubleclick title；Confirm；Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：rename在server catalog持久；相同title接受；Escape取消/返回focus。

### session.pin — 会话固定

状态：缺失；范围：default。

上游行为：pin/unpin修改完整序列并保留排序mode，分组和flat pinned在前。

原件证据：`packages/client/ui-workspace/src/client/session-actions/PinSession.tsx:30`；`packages/client/ui-workspace/src/client/pin-order.ts:26`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Pin；Unpin；hover pin action

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：跨reload固定；unpin不改变保存顺序；排序切换无丢row。

### session.fork — 会话分叉

状态：缺失；范围：default。

上游行为：从最后completed turn fork，继承title增号，不retain child或改变selection。

原件证据：`packages/client/ui-workspace/src/client/session-actions/ForkSession.tsx:11`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Fork session

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：source completed turn生成child且title递增；无completed明确失败；当前selection不跳转。

### session.archive — 会话归档/恢复

状态：缺失；范围：default。

上游行为：quiet archive无确认；running stop-and-archive列turn/subagent/jobs/reminders；Undo和filter archived；unarchive恢复但不恢复pin/运行。上游无session永久delete。

原件证据：`packages/client/ui-workspace/src/client/session-actions/ArchiveSession.tsx:31`；`packages/client/ui-workspace/src/client/session-actions/RowActionToast.tsx:25`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Archive；Stop and archive确认/取消；Undo；filter archived；Unarchive

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：quiet archive隐藏有undo；running取消仍跑，确认stop并archive；unarchive保留历史且不resume。

### session.row-details — 会话行状态与hover

状态：缩水/部分；范围：default。

上游行为：pending approval/plan/question warning dot优先，running child ongoing、未看done、relative time、path/title/created hover、title marquee reduced-motion。

原件证据：`packages/client/ui-workspace/src/client/rows/Rows.tsx:219`；`packages/client/ui-workspace/src/client/session-actions/derived.ts:12`。

当前证据：`apps/web/public/app.js:538`；`apps/web/public/style.css:36`。已有selected与ellipsis title；无runtime row dots/status/relative time/hover metadata/marquee/menu。

按钮/交互：hover card；ellipsis menu；row click

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：approval pending标题及时更新；long title hover可读；reduced-motion跳tail。

### rightbar.shell — 右侧栏开启/展示

状态：缺失；范围：default。

上游行为：session-scoped右栏normal push/fullscreen，同tree不remount；<768打开auto fullscreen，正常关闭不留rail。

原件证据：`packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx:161`；`packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx:34`；`packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx:33`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：header Expand right；Collapse；Fullscreen切换

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：宽屏push中心变窄；767px自动fullscreen；切模式terminal不remount；sessionless无rightbar。

### rightbar.docking — 右侧栏tabs/分屏/浮窗

状态：缺失；范围：default。

上游行为：tabs focus/close/add guide、drag reorder/split/float/dock/duplicate；最多两水平panes 20–80%，overflow chips，guide不能唯一close。

原件证据：`packages/client/ui-dockkit/src/components/DockSurface.tsx:300`；`packages/client/ui-dockkit/src/components/TabLayout.tsx:118`；`packages/client/ui-dockkit/src/components/TabMenu.tsx:55`；`packages/client/ui-dockkit/src/components/FloatLayer.tsx:74`；`packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:88`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Tab click/close；+guide；split；tab menu actions；float/dock；divider/tab/panel drag

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：两pane上限禁用解释；float回dock与close cleanup真实；刷新布局按session独立恢复。

### rightbar.state — 右侧栏恢复及资源导航

状态：缺失；范围：default。

上游行为：localStorage保存每session布局/tab选择/ratio/rect/fullscreen，resource URI dedup与line导航，invalid只清对应key。

原件证据：`packages/client/ui-sidebar-right/src/client/index.ts:83`；`packages/client/ui-sidebar-right/src/client/contract/seed.ts:26`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：file/resource link；tab reopen

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：same resource再次open聚焦同tab且line正确；reload/restored tab与session隔离；invalid key不破坏其他session。

### files.tree — workspace文件树

状态：缺失；范围：default。

上游行为：guide Files页，root/expanded directory直接watch更新，manual refresh，folder toggle/file preview。

原件证据：`packages/client/ui-sidebar-files/src/client/FilesBody.tsx:48`；`packages/client/ui-sidebar-files/src/client/FilesTitle.tsx:17`；`packages/client/ui-sidebar-files/src/client/definition.tsx:15`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Files guide；folder expand/collapse；file open；Reload

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实create/write文件使expanded树更新；file打开正确preview；目录listing错误有retry。

### terminal.interactive — 用户terminal

状态：缺失；范围：default。

上游行为：choose安装shell、interactive terminal/completion、rename、retained恢复；collapse继续运行、tab close终止并可cleanup retry。

原件证据：`packages/client/ui-sidebar-terminal/src/client/TerminalGuide.tsx:32`；`packages/client/ui-sidebar-terminal/src/client/terminal.tsx:24`；`packages/client/ui-sidebar-terminal/src/client/TerminalTitle.tsx:14`；`packages/client/ui-sidebar-terminal/src/client/TerminalRecovery.tsx:18`；`packages/client/ui-sidebar-terminal/src/client/TerminalCleanup.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：shell menu；Start terminal；terminal input；rename title；Close；Recover/retry

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：键入真实command得到output；collapse仍跑；reload重连retained；close进程终止；cleanup故障显示retry。

### preview.toolbar — 文件预览toolbar/状态

状态：缺失；范围：default。

上游行为：文件tab有status、renderer选择、wrap、auto/manual reload、bounded/page reads；line导航。

原件证据：`packages/client/ui-sidebar-documentpreview/src/client/TextTitle.tsx:16`；`packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx:56`；`packages/client/ui-sidebar-documentpreview/src/client/LoadingIndicator.tsx:11`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Renderer menu；Wrap；Auto reload；Reload；page controls

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切renderer不换tabidentity；打开line定位；编辑文件auto refresh；取消auto手动refresh正确。

### preview.text-code-md — Markdown/代码/纯文本预览

状态：缺失；范围：default。

上游行为：paged text、markdown frontmatter、syntax highlight、wrap、select/copy。

原件证据：`packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx:34`；`packages/client/ui-sidebar-documentpreview/src/client/code/CodeBody.tsx:14`；`packages/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx:9`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：selection/copy；wrap；paged loading

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：大文件bounded分页；markdown frontmatter与table/math正确；code theme/wrap正确。

### preview.html-image — HTML与图片预览

状态：缺失；范围：default。

上游行为：完整bytes预览HTML和common images，适用zoom控制、安全content容器。

原件证据：`packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx:76`；`packages/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx:44`；`packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.tsx:24`；`packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx:31`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Zoom in/out；Fit；pan

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：HTML隔离呈现；图片fit/zoom双主题/手机可用；Host read错误可见。

### preview.pdf-office-excel — PDF/Office/Excel预览

状态：缺失；范围：default。

上游行为：PDF完整bytes；Word/PPT本地转PDF；Excel浏览器多sheet，font notice/renderer recovery。

原件证据：`packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx:45`；`packages/client/ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx:44`；`packages/client/ui-sidebar-documentpreview/src/client/office/OfficeFontAction.tsx:16`；`packages/client/ui-sidebar-documentpreview/src/client/excel/excel.tsx:21`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：PDF page/zoom；spreadsheet tabs；font action；Reload

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：实际PDF/docx/pptx/xlsx各能读；转换失败可操作错误；switch sheet/zoom正确。

### open-in-app — 外部应用打开/文件位置

状态：缺失；范围：default。

上游行为：session header split button有resolved directory app才画；file associations menu/default/open/reveal，shared query/state、防并发launch。

原件证据：`packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx:33`；`packages/client/ui-open-in-app/src/client/OpenTargetButton.tsx:45`；`packages/client/ui-open-in-app/src/client/OpenPathAction.tsx:39`；`packages/client/ui-open-in-app/src/client/OpenPathEmptyAction.tsx:19`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Open；application dropdown；Show file location

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：有应用真实launch；query空仍reveal；重复click不双launch；无resolved app时正确不画而非fake button。

### settings.shell — Settings窗口/导航与focus

状态：缺失；范围：default。

上游行为：sidebar底部Settings打开800×800 bounded modal；sections导航滚动；Esc/topmodal/focus restore；逐个onboarding step。

原件证据：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:112`；`packages/client/ui-settings-general/src/client/GeneralSection.tsx:14`；`packages/client/ui-settings-general/src/client/chrome.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Settings；section tabs；Close/mask/Escape

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：所有标准section可到达；viewport24px margin；focus trap与return正确；上层modal不误关闭settings。

### settings.connection-recovery — 连接恢复反馈/重试

状态：缩水/部分；范围：default。

上游行为：断线yellow retry、reconnecting advancing dots ≥800ms、恢复green2秒，正常startup silent。

原件证据：`packages/client/ui-settings-general/src/client/chrome.tsx:22`；`packages/client/ui-primitives/src/ConnectionIndicator.tsx:29`。

当前证据：`apps/web/public/index.html:33`；`apps/web/public/app.js:208`；`apps/web/public/app.js:248`。有EventSource连接+retry及topbar连接文字dot；无用户recovery动作/上游状态展示/节奏。

按钮/交互：Disconnected retry；Reconnecting retry

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实断线点retry立即请求；reconnect minimum/show green后fade；healthy startup不闪。

### settings.general-coding — General开发工具与版本/配置文件

状态：缺失；范围：default。

上游行为：Coding Tools持久switch，write pending防重复；local config file action条件可用，release version metadata可选。

原件证据：`packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx:19`；`packages/client/ui-settings-general/src/client/CurrentVersionRow.tsx:10`；`packages/client/ui-settings-general/src/client/SettingsDocumentAction.tsx:29`；`packages/client/ui-settings/src/client/developer-tools.ts:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Coding Tools toggle；配置文件打开；version显示

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：toggle后preset/inspect控制跟随；失败恢复durable值/显示error；loopback配置文件action正确。

### settings.locale — 语言选择与locale所有权

状态：缺失；范围：default。

上游行为：General Language英文/中文持久，所有copy/dates/ARIA动态locale，document.lang同步。

原件证据：`packages/client/locale/src/client/LanguageRow.tsx:30`；`packages/client/locale/src/client/bootstrap.ts:24`；`packages/client/locale/src/client/settings-store.ts:35`。

当前证据：`apps/web/public/index.html:2`；`apps/web/public/app.js:666`。lang zh-CN和所有copy中文硬编码；无locale/t字典/语言控件。

按钮/交互：语言菜单English/中文

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切语言所有产品copy与ARIA更新；刷新保留；document.lang正确。

### settings.account — 账号与登录/登出

状态：缺失；范围：default。

上游行为：Account显示DeepSeek状态；browser sign-in/cancel、sidebar account menu Platform sign-out；no-response troubleshooting；desktop intro仅desktop。

原件证据：`packages/client/ui-settings-account/src/client/AccountSection.tsx:84`；`packages/client/ui-settings-account/src/client/SignInDialog.tsx:11`；`packages/client/ui-settings-account/src/client/SignOutDialog.tsx:8`；`packages/client/ui-settings-account/src/client/AccountMenu.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Sign in；Cancel；Retry；troubleshoot；account menu；Sign out确认

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：状态与Host同步；cancel终止等候；error分类对应copy；sign-out后saved model id留存、account catalog隐藏。

### settings.models-directory — Models provider页面

状态：缺失；范围：default。

上游行为：provider directory与settings/credentials一致snapshot，DeepSeek Account/DeepSeek优先，setup/error/edit/delete/close。

原件证据：`packages/client/ui-settings-models/src/client/ModelsSection.tsx:141`；`packages/client/ui-settings-models/src/client/ProviderEditor.tsx:121`；`packages/client/ui-settings-models/src/client/CustomProviderCard.tsx:95`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Add model provider；provider edit；Close editor；Delete provider；Apply/Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：providers真实载入；rejected apply保留draft/error；delete确认与catalog更新。

### settings.models-credentials — API key与endpoint/protocol设置

状态：缺失；范围：default。

上游行为：key空write-only/new-password，不泄露；customized endpoint/display/protocol；blank custom key允许provider native auth；Apply status。

原件证据：`packages/client/ui-settings-models/src/client/apiKey.ts:51`；`packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:42`；`packages/client/ui-settings-models/src/client/ProviderEditor.tsx:121`；`packages/client/ui-settings-models/src/client/EditorFooter.tsx:45`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：API key password input；Customized settings；baseURL；display name；API protocol；Apply

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：设置后requests使用新route；credentials response无literal；failed apply仍编辑；secret不进DOM历史。

### settings.models-catalog — 模型列表/能力编辑

状态：缺失；范围：default。

上游行为：id/name/contextWindow/maxTokens/text/image能力，at least1 input，preserve unrelated fields，restore default models。

原件证据：`packages/client/ui-settings-models/src/client/ModelListEditor.tsx:148`；`packages/client/ui-settings-models/src/client/ModelRow.tsx:44`；`packages/client/ui-settings-models/src/client/ModelInputTypes.tsx:32`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Add/remove model；Model options fold；Text/Image checks；Restore defaults；Apply

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：catalog改后model selection可读；至少一种input；unrelated字段不丢；restore移override。

### settings.onboarding-web — Web首次启动welcome与凭证

状态：缺失；范围：default。

上游行为：versioned preview notice然后条件DeepSeek credential step，一次挂一dialog，可由credentialOnboarding关闭；Desktop另属account。

原件证据：`packages/client/ui-settings-models/src/client/WelcomeNotice.tsx:34`；`packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx:58`；`packages/client/ui-settings-models/src/client/OnboardingModal.tsx:17`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：notice acknowledge；credential submit；skip/close（依组件）

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：未配置key首次dialog正确排序；完成跨reload不重复；配置关闭不画credential step。

### settings.session-log-upload — General session log上传开关

状态：缺失；范围：default。

上游行为：namespace有upload时显示official model API session-log上传toggle，acceptedHost值只读client不能写。

原件证据：`packages/client/ui-settings-session-log/src/client/UploadRow.tsx:26`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Upload Session Log toggle

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实setting immediate保存；pending防重复；readonly禁用/可读；不可用provider不画。

### settings.builtin-inventory — Built-in plugins只读inventory

状态：缺失；范围：default。

上游行为：preset展开/global折叠、search开两组、localizedcards entry id/source/runtime status/disabled/error、preset switcher、retry。

原件证据：`packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx:33`；`packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:252`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Search；preset switch；global fold；card disclosure；Retry

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实inventory含preset/global；search跨preset标匹配；failed read Retry；不会成为enable写面板。

### settings.plugin-shell — Shell官方配置页

状态：缺失；范围：default。

上游行为：Plugins Official Shell页timeout/output stream bytes staged save、overrides标记/reset default；namespace无则不画。

原件证据：`packages/client/ui-settings-shell/src/client/ShellCard.tsx:20`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：timeout/output fields；Reset；Save；Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：没有Save不改Host；Save后namespace值正确；Reset回部署default。

### settings.plugin-loop — Agent loop官方配置页

状态：缺失；范围：default。

上游行为：parallel-safe tool concurrency staged Save/reset default。

原件证据：`packages/client/ui-settings-agent-loop/src/client/AgentLoopCard.tsx:20`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：parallel field；Reset；Save；Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：save并发参数Host实际生效；invalid数值显错且不写。

### settings.plugin-subagent — Subagent官方配置页

状态：缺失；范围：default。

上游行为：depth/width limits与model-selection两个namespace同save。

原件证据：`packages/client/ui-settings-subagent/src/client/SubagentCard.tsx:22`；`packages/client/ui-settings-subagent/src/client/SubagentLimitsFields.tsx:18`；`packages/client/ui-settings-subagent/src/client/SubagentModelSelectionFields.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：depth/width fields；model options；Reset；Save；Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：可服务namespace准确显；保存两namespace有结果/error；failed保留draft。

### settings.plugin-websearch — Web search官方配置页

状态：缺失；范围：default。

上游行为：key通过credentials写，endpoint/max search request staged保存。

原件证据：`packages/client/ui-settings-web-search/src/client/WebSearchCard.tsx:24`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：key/endpoint/limit；Reset；Save；Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：key不回显或进settings响应；endpoint/limit真实保存；namespace无不留死按钮。

### plugins.catalog — Plugins全局页/详情/刷新

状态：缺失；范围：default。

上游行为：Official/Installed name sorted、Experimental badge、metadata/icons localization、skeleton/nohost unavailable、Refresh min400ms/Retry/cached failures。

原件证据：`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`；`packages/client/ui-plugin-manager/src/client/PluginRefreshToast.tsx:21`；`packages/client/ui-plugin-manager/src/client/presentation.ts:28`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Plugins navigation；Info tooltip/pin；Search；Refresh；Retry；open details；Back

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实bundles/cards/source图标；刷新失败cached内容仍留并toast；无profile显示unavailable。

### plugins.install — 插件添加/安装输出与取消

状态：缺失；范围：default。

上游行为：Add split menu、package/git/tarball/local dialog、registry source probe、Host检查spec后install、pnpm output、stop、enable newly added。

原件证据：`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`；`packages/client/ui-plugin-manager/src/client/manager-store.ts:124`；`packages/client/ui-plugin-manager/src/client/sanitize-install-input.ts:8`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Add plugin；dropdown；Install third-party；package field；registry select；Install；Cancel/Stop；Enable

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实Host inspect/install生命周期输出；cancel真实中止；关闭lateprobe不重开；失败retry清楚。

### plugins.switch-remove — bundle/entry enable disable remove

状态：缺失；范围：default。

上游行为：enable/disable bundle和row、composition details/config pages；official无uninstall，installed uninstall确认。

原件证据：`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:1337`；`packages/client/ui-plugin-manager/src/client/manager-store.ts:124`；`packages/client/ui-plugin-manager/src/client/config-ledger.ts:36`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：bundle switch；row switch；Uninstall；confirm/cancel；config page

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：每个switch修改对应Host row；拒绝回滚并error；取消uninstall不删；确认Host执行且UI收敛。

### presets.selection — Agent preset当前/未来选择

状态：缺失；范围：default。

上游行为：new-task seat与General default cards；Coding Tools off仅Standard/Creator/custom，on加PTC/Minimal；accepted default同步current blank。

原件证据：`packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx:81`；`packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx:64`；`packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx:43`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：mode seat；preset cards；default selection

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：切preset改变当前blank projection；未来default不改existing；unavailable失败toast；tools off模式过滤正确。

### presets.configuration-help — Preset配置/help/Creator入口

状态：缺失；范围：default。

上游行为：View configuration只读YAML含!!js，built-in guide tabs/examples，Creator流不自动send且保留draft，不改future default。

原件证据：`packages/client/ui-agent-preset/src/client/PresetGuideDialog.tsx:32`；`packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx:27`；`packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx:64`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：View configuration；help tabs；Creator card；Let agent create plugin

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：YAML late response不重开；help scrollposition保留；Creator进入cordis blank但无消息send。

### model.selection — 模型/推理强度composer与/model

状态：缺失；范围：default。

上游行为：provider grouped model search/fuzzy ranking、effort advertised names、>4composer search、slash总search；spinner/rejected menu保留、responsive icon。

原件证据：`packages/client/ui-model-selection/src/client/ModelSelect.tsx:64`；`packages/client/ui-model-selection/src/client/index.ts:107`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：model trigger；model search/clear；model rows；effort rows；back；Escape/Enter/Tab/arrow

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：选model/effort真实进入session.models；running step沿旧selection；removedsaved id留存；小屏icon仍accessible完整label。

### permission.selection — 权限preset composer/slash/settings

状态：缺失；范围：default。

上游行为：默认Read Only/Workspace Write/Full access，composer及/permission当前switch，General只future default；Full visible pick risk ack；auto仅exp。

原件证据：`packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:76`；`packages/client/ui-permission-presets/src/client/PermissionRow.tsx:41`；`packages/client/ui-primitives/src/RiskConfirmation.tsx:29`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：permission trigger；preset row；Full risk confirm/cancel；future default

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：当前switchHost projection确认且工具PermissionEngine实际遵循；General不改current；catalog失效关闭picker不吞draft。

### goal.bar — Goal strip/编辑和运行控制

状态：缺失；范围：default。

上游行为：Todo后Queue前goal elevation strip、pause/resume/edit multiline/clear、inlineerror；durable /goal command user bubble。

原件证据：`packages/client/ui-goal/src/client/GoalBar.tsx:42`；`packages/client/ui-goal/src/client/GoalCommandInputView.tsx:17`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Pause；Resume；Edit；Save/Cancel；Clear

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：每个action真实goal mutation；rejected保持strip/error；reload /goal bubble重建且无多余copy/branch。

### plan.mode — Plan模式入口/退出

状态：缺失；范围：default。

上游行为：+Plan或/plan开启、blue chip执行/plan off，placeholder随mode；Host confirms pending。

原件证据：`packages/client/ui-plan/src/client/PlanModeControl.tsx:19`；`packages/client/ui-plan/src/client/index.ts:52`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：+Plan；/plan；Plan chip off

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：进入/退出改变projection/下一requestmode；admissionfailure不假退出；placeholder变plan hint。

### plan.documents — plan卡片/完整文本和自动open

状态：缺失；范围：default。

上游行为：submitted plan出turn artifact card，pending首次自动open，distincttabs/history恢复，full plan link，只view不审批。

原件证据：`packages/client/ui-plan/src/client/PlanCard.tsx:43`；`packages/client/ui-plan/src/client/PlanPreview.tsx:18`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：plan card Open；View full plan；close preview

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：pending一次自动open且close后不重开；history cards click才open；refreshdurableplan恢复。

### questions.answer — agent questions回答交互

状态：缺失；范围：default。

上游行为：composer side card单/多选/custom、Recommended default仅draft、pager/Skip/submit；IME/Enter behavior；tool-keyedclose可row重开；settledreadonly。

原件证据：`packages/client/ui-user-questions/src/client/QuestionComposer.tsx:35`；`packages/client/ui-user-questions/src/client/QuestionReplyView.tsx:21`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：options；custom answer；pager；Skip；Submit batch；Close；tool row reopen

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：单/多选及custom真实answer payload；incomplete回first；close不是answer；aftersettled readonly显示recorded answer。

### questions.timed-recovery — question计时/迟答/草稿恢复

状态：缺失；范围：default。

上游行为：attachWait剩余countdown、focus pause/blur resume、edit/Take time indefinitely；timeout继续但可迟答；perrequest localdraft、reconnect。

原件证据：`packages/client/ui-user-questions/src/client/QuestionComposer.tsx:35`；`packages/client/ui-user-questions/src/client/index.ts:56`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Take time；late answer；reopen；draft edit

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：计时等待握手再开始；focus停/blur续；reloaddraft与remaining对应；lateanswer通过Host steer且duplicate reply报queued。

### plan.review — 计划审批composer card

状态：缺失；范围：default。

上游行为：Plan review warningstrip/title/两行summary/fullplan；Request changes拒绝wait返回composer，Approve选approval label；ongoing settling。

原件证据：`packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx:29`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：View full plan；Request changes；Approve

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：approve真实Hostanswer后可实施；requestchanges ASK_CANCELLED且无批准；pendingspinner/不可重复。

### jobs.roster — background jobs列表/输出/停止

状态：缺失；范围：default。

上游行为：session header控制roster，live durations/progress、settledfold/clear、本行2-press3秒kill，output按需stream/collapse关。

原件证据：`packages/client/ui-jobs/src/client/JobListAction.tsx:325`；`packages/client/ui-jobs/src/client/index.ts:27`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Jobs header；output expand/collapse；Stop arm/confirm；settled fold；Clear；Copy command

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实job.list/observe/kill；collapse终止观察非job；kill日志通知agent；gap/interruptednotice可见。

### schedule.catalog — Automation tasks全局页/header/row标记

状态：缺失；范围：default。

上游行为：globalpage无需activateSession、search/filterAllEnabledInactive/New开session、headeractive clock/taskdetail、idle rowclock与hover list。

原件证据：`packages/client/ui-schedule/src/client/TaskManagerPage.tsx:41`；`packages/client/ui-schedule/src/client/ScheduleCatalogAction.tsx:35`；`packages/client/ui-schedule/src/client/SessionScheduleMark.tsx:40`；`packages/client/ui-schedule/src/client/SessionScheduleHover.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Automation tasks；Search；filters；New；task row；header clock

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：任务真实schedule catalog；全局browse不activate；New仅开新session无formcreate；tasktitle及frequency/next可见。

### schedule.rules — 任务Rules/时间与时区编辑

状态：缺失；范围：default。

上游行为：Rules/Records tabs、active staged name/instruction/repeat/weekdays/date/time/cron/zone；ICUzones/recent5、inactive readonly；save/cancel/error。

原件证据：`packages/client/ui-schedule/src/client/TaskDetail.tsx:250`；`packages/client/ui-schedule/src/client/DatePicker.tsx:118`；`packages/client/ui-schedule/src/client/ClockPicker.tsx:100`；`packages/client/ui-schedule/src/client/TaskMenu.tsx:123`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Rules；Records；name/instruction；Repeat；Weekdays；date calendar nav；clock columns；timezone search；Save/Cancel

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实schedule.update后title/rule/runtimezone正确；invalidcron/interval blockSave；inactive不能edit；untouchedmillis保留。

### schedule.history-delete — 任务记录/linked session/delete/transcript

状态：缺失；范围：default。

上游行为：Records deliveryhistory、linked session元数据checks、moredeleteconfirm、deletetoast；schedule_create/turn transcriptcards及right tasktab。

原件证据：`packages/client/ui-schedule/src/client/DeliveryHistory.tsx:70`；`packages/client/ui-schedule/src/client/TaskDetail.tsx:250`；`packages/client/ui-schedule/src/client/ScheduleCreateCard.tsx:46`；`packages/client/ui-schedule/src/client/ScheduleTurnCard.tsx:103`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Records paging；Linked session；More delete；confirm/cancel；transcriptcard open

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：linked archived disabled explanation且不unarchive；confirmeddelete真实schedule.remove；cancel保留task；creationcard opens正确task。

### workflow.run — workflow run/phases/members

状态：缺失；范围：default。

上游行为：durable独立Chatnode，running/failed/cancelled/interrupted默认open，completeclosed，currentlocalrunningmember可openchild；身份/status而非logs。

原件证据：`packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx:347`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Run disclosure；Phase disclosure；Member child open

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：reload重建nestedstatus；默认fold随state；不availablemember无死导航。

### deliverables.cards — 交付物/changed files/inlinefile links

状态：缺失；范围：default。

上游行为：turntail changedfiles actualHost counts、explicitdeliveredfile cards、finalinlinecode用成功mutation/deliveryset变filelink，不从prose猜。

原件证据：`packages/client/ui-deliverables/src/client/Deliverables.tsx:45`；`packages/client/ui-deliverables/src/client/ChangedFiles.tsx:37`；`packages/client/ui-deliverables/src/client/PresentedFileCard.tsx:22`；`packages/client/ui-deliverables/src/client/PresentRow.tsx:31`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Changed file row；delivery Open；fileinlinecode link

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：实际editturn显示files/counts；点击打开对应reviewtab/file；无记录prose不造可点击文件。

### deliverables.review-diff — 文件review比较/diff

状态：缺失；范围：default。

上游行为：turnreviewtab文件list/selection、comparison/diffcontexts、textwrapped syntax/gutter markers。

原件证据：`packages/client/ui-deliverables/src/client/ReviewTab.tsx:68`；`packages/client/ui-deliverables/src/client/FileDiff.tsx:14`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：file select menu；unified/side-by-side toggle；wrap/nowrap；open file；external file actions；retry

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：before/after真实对应turn记录；切文件与context无混淆；binary/unavailable有明确状态。

### trajectory.default — Trajectory标准事件账本

状态：缺失；范围：default。

上游行为：默认viewring Trajectory，virtualturn/step/UserAssistantToolSubtoolcompaction ledger、tail首定位/olderpage/onstream follow、selection/inspector。

原件证据：`packages/client/ui-trajectory/src/client/TrajectoryView.tsx:132`；`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2069`；`packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx:38`；`packages/client/ui-trajectory/src/client/TrajectoryTurnHeader.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Trajectory tab；older page；turn/group fold；row select；toolbar/search

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：长history分页不重复/丢；scrollup不自动抢tail；rowinspector呈Input/Output/Timing/usage/imagefile。

### trajectory.timeline — Trajectory timing overview

状态：缺失；范围：default。

上游行为：真实start/duration overview、assistantTTFT/decoding、hover500ms、drag interval selection、wheelzoom、rightclickclear/rightdragpan。

原件证据：`packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx:241`；`packages/client/ui-trajectory/src/client/TrajectoryTurn.tsx:22`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：timeline drag；wheel；right click；right drag；hover

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：选inclusive时间区间ledger对应；streamtail/scrollup暂停follow；无starttoken不编TTFT。

### primitive.controls — 菜单/modal/tooltip/toast/forms/焦点

状态：缩水/部分；范围：default。

上游行为：统一portal/anchoring、roving focus、modal layering/focus、pointermodalityring、toast/reducedmotion、structuredconfig validation。

原件证据：`packages/client/ui-primitives/src/Menu.tsx:84`；`packages/client/ui-primitives/src/Modal.tsx:48`；`packages/client/ui-primitives/src/Tooltip.tsx:20`；`packages/client/ui-primitives/src/Toast.tsx:46`；`packages/client/ui-primitives/src/input-modality.ts:9`；`packages/client/ui-primitives/src/focus.ts:12`；`packages/client/ui-primitives/src/settings-form/SettingsForm.tsx:50`。

当前证据：`apps/web/public/style.css:11`；`apps/web/public/app.js:674`；`apps/web/public/index.html:18`。有基础aria-label和focus-visible，只有mobileEscape/backdrop；没有上游menu/modal/tooltip/toast体系。

按钮/交互：menu arrow/Enter/Tab/Escape；modalClose；formSave/Reset

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：keyboard操作无focus丢失；Esc只toplayer；focusreturn；手机overlay不溢出；invalidfield不写。

### modules.live-extensions — 模块装配/HMR/插件UI扩展

状态：缺失；范围：default。

上游行为：bootmodulegraph/typedslots、plugin-ownedUI contributions、dynamicenable/disable/HMR卸载清理/extensionfactories。

原件证据：`packages/client/modules/src/client/index.ts:39`；`packages/client/ui-renderer/src/client/index.ts:52`；`packages/client/ui-slots/src/index.ts:865`；`packages/client/hmr/src/client/index.ts:9`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：插件enable导致UI呈现；dev HMR

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：启用真实clientplugin后出现contributedslot；disable卸载listener/style；HMR不漏旧controls。

### resources.unified — 资源模型/授权读取与共享

状态：缺失；范围：default。

上游行为：useResource由protocolproviders供应，以sessionauthorization/sharedcache给chat/preview/inspect，no content进入layout存储。

原件证据：`packages/client/resources/src/client/index.ts:23`；`packages/client/ui-session/src/client/index.ts:664`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：resource/document/image links

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：同attachment共享授权read；切session不读别会话；storage布局不含filebytes。

### optional.browser — Web opt-in sandbox browser tab

状态：可选未移植；范围：optional-web-disabled。

上游行为：ui-sidebar-browser disabled unless desktop; Web需显式overlay启用。

原件证据：`packages/client/ui-sidebar-browser/src/client/index.ts:40`；`packages/client/ui-sidebar-browser/README.md:10`；`packages/bundle/web-app/cordis.patch.yml:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Browser guide；URL/nav/reload

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：默认Web不出Browser不算标准缺；显式启用后真实隔离浏览器导航。

### optional.voice — Experimental voice input

状态：可选未移植；范围：experimental。

上游行为：独立experimental voice bundle；不在标准web-app roster。

原件证据：`packages/experimental/client-ui-voice-input/src/client/VoiceInput.tsx:56`；`packages/experimental/client-ui-voice-input/src/client/VoiceSetupDialog.tsx:16`；`packages/experimental/voice-input-bundle/cordis.patch.yml:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Mic；setup/download；stop recording

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：默认关闭；开plugin后真实permission/transcription及setupdownload。

### optional.agent-team — Experimental Agent Team

状态：可选未移植；范围：experimental。

上游行为：独立experimental team profile/tool/UI，不在standard roster。

原件证据：`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:179`；`packages/experimental/agent-team-profile/cordis.patch.yml:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Team action；member/task controls

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：默认关闭；开启后真实teamprojection渲染。

### optional.inspector — Experimental shared/session inspector

状态：可选未移植；范围：experimental。

上游行为：experimental inspector不同于默认Trajectory和requestdetail。

原件证据：`packages/experimental/session-inspector/src/client/views/View.tsx:47`；`packages/experimental/inspector/src/client/bottom/page.tsx:58`；`packages/experimental/inspector-profile/cordis.patch.yml:1`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：inspector table/details/filter；bottomresize

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：默认关闭；不把缺experimental当缺标准Trajectory。

### optional.auto-review — Experimental Auto permission integration

状态：可选未移植；范围：experimental。

上游行为：Auto review须显式实验integration，当前sessionpicker EXP+risk confirmation；defaultsettingsenum不含auto。

原件证据：`packages/experimental/auto-review/cordis.patch.yml:1`；`packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:76`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：Auto review；risk acknowledge/cancel

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：default只有三preset；开实验plugin后auto有EXP与risk确认。

### optional.claude-mods — Experimental Claude Code mods

状态：可选未移植；范围：experimental。

上游行为：experimental clientUI addon不在标准web-app。

原件证据：`packages/experimental/client-ui-claude-code-mods/src/client/Band.tsx:104`；`packages/experimental/client-ui-claude-code-mods/src/client/index.ts:16`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：addon band controls

建议：此项不属于默认Web必须界面。记录其插件/条件边界，若显式开启则复用原件并接实际服务；保持默认关闭，不将它冒充标准UI缺口。

可测验收：默认关闭；开启真实plugin后才渲染。

### approval.composer — 审批composer占位/工具详情与键盘

状态：缩水/部分；范围：default。

上游行为：pending approval接管composer，可render相关tool details，Enter批准/Escape拒绝、focus input/IME保持nativekeys，withdraw/replace lock安全。

原件证据：`packages/client/ui-approval/src/client/ApprovalPanel.tsx:12`；`packages/client/ui-approval/src/client/index.ts:25`。

当前证据：`apps/web/public/app.js:385`；`apps/web/public/app.js:414`；`apps/web/public/style.css:99`。已有真实allow/deny卡片和owner/session/generation guard、expiry/result；卡片置transcript无composer接管/相关toolview/EnterEscape语义。

按钮/交互：Approve once；Reject；detail disclosure；Enter/Escape

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实decision归owner且pending防重复；withdraw/replaced不能答；focus Reject Enter仍拒绝；IME不决策。

### subagent.navigation — Subagent目录/lineage/右栏聊天

状态：缺失；范围：default。

上游行为：header descendant catalog lazy tree/read retry、breadcrumb导航、usage/duration、每childmain或righttab address exact，普通sidebar排除child。

原件证据：`packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx:744`；`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:18`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：descendant count hover/click；tree arrows；expand/collapse；child row main open；trailing rightbar arrow；breadcrumb；Retry

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：真实nestedchild列表/状态/usage；用exact parent/child/mode打开；righttab关闭release；leaf只readyempty确认。

### subagent.continuation — 子agent继续/只读/独立停止

状态：缺失；范围：default。

上游行为：one-shot永只读；continuable live parent FIFO followup/running仍可send；parent unavailable inputdisabled、running仍可Stop interruptByParent。

原件证据：`packages/client/ui-subagent/src/client/SubagentReadOnlyComposer.tsx:19`；`packages/client/ui-subagent/src/client/index.ts:34`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：child Followup Send；child Stop；parent breadcrumb

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：FIFO followups真实入child；one-shot不接受prompt；parentoffline运行child可Stop，不能send；错误recovery说明可见。

### skill.invoke-preview-card — Skill slash invoke/预览/历史卡

状态：缺失；范围：default。

上游行为：skills/list用户可invoke source/user-only标记、literal /name；known tokenclick打开provider SKILL.md；skilltool exactInstructions durablecard/Inspect。

原件证据：`packages/client/ui-skill/src/client/index.ts:73`；`packages/client/ui-skill/src/client/SkillRow.tsx:102`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：skill suggestion pick；/name token preview；Instructions disclosure；Inspect

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：选择/手输/name等价；command同名优先；已记录Instructionscatalog变更后仍稳定；tokenlatefetch保持clickedSession。

### cordis.historical-panel — Cordis历史卡与process-local定义控制

状态：缺失；范围：default。

上游行为：默认挂载历史generatedplugin card+globalfooterpanel，Host running与page loaded独立、allSessiondefs，approvalfirstwins/liveinventoryread、cardreplay不重建定义。

原件证据：`packages/extensions/ui-cordis/src/client/CordisPanel.tsx:118`；`packages/extensions/ui-cordis/src/client/CordisDefineRow.tsx:39`；`packages/extensions/ui-cordis/src/client/CordisRunRow.tsx:36`；`packages/extensions/ui-cordis/src/client/CordisActionRow.tsx:16`。

当前证据：`apps/web/public/index.html:18`；`apps/web/public/app.js:666`。当前静态HTML只挂会话导航、主题、消息、发送/停止；app.js init只有这些控制的监听器，未挂本组件/控制。

按钮/交互：footer badge；Approve once；Approve plugin；Decline；Run/load；Stop；Remove；Retry；Rollback；card disclosure

建议：保留MIT来源，直接复用上述纯展示组件及配套CSS Modules；将derived props/hooks/store actions接到Harness HTTP/RPC/SSE视图适配层，UI状态留在前端。必要协议缺口单列适配实现，不能据此删掉本条。

可测验收：historicalcard重启仍可读不重建defs；实际registereddefinition控制Host/page状态；跨Sessionpending可到达；失败retry/rollback实际接线。

### render.message_content — 按content类型保留正文、推理、图片、工具及未知block

状态：缩水/部分；范围：default。

上游行为：按content类型保留正文、推理、图片、工具及未知block

原件证据：`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:79`；`packages/client/ui-chat/src/client/chat/MessageItem.tsx:19`。

当前证据：`apps/web/public/app.js:293`；`apps/web/public/app.js:363`；`apps/web/public/app.js:518`。user接受字符串；assistant强制String；history仅role分支

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：在浏览器建立纯展示用MessageView/BlockView适配层，沿用现有messageId去重，持久化记录与live事件统一投影；不改Runtime。

可测验收：混合text/image/reasoning/tool/unknown消息按原顺序显示；live、history、重连投影相同且无重复。。

### render.user_text — 用户安全纯文本气泡及语义引用

状态：缩水/部分；范围：default。

上游行为：用户安全纯文本气泡及语义引用

原件证据：`packages/client/ui-chat/src/client/chat/MessageItem.tsx:221`；`packages/client/ui-chat/src/client/chat/MessageItem.tsx:195`。

当前证据：`apps/web/public/app.js:305`；`apps/web/public/style.css:72`。右对齐user textContent气泡；user bubble geometry

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：保留当前文本节点气泡；增加引用/skill词汇投影和附件外置stack。

可测验收：文字、换行和HTML字面量原样显示；被确认的引用可激活，普通文本不自动变成未经授权文件链接。。

### render.markdown_gfm — 完整GFM正文：标题/列表/引用/强调/删除线/任务/表格/脚注

状态：缺失；范围：default。

上游行为：完整GFM正文：标题/列表/引用/强调/删除线/任务/表格/脚注

原件证据：`packages/client/ui-primitives/src/markdown/parse.ts:27`；`packages/client/ui-primitives/src/markdown/render.tsx:275`；`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:29`。

当前证据：`apps/web/public/app.js:326`；`apps/web/public/app.js:344`。明确只有fenced code格式化；其余文本为text node

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：抽取/适配上游纯mdast grammar与DOM语义映射（需要react桥接则使用独立渲染island）；复用tokens和MarkdownText CSS语义，不移植Cordis。

可测验收：固定GFM/CJK/脚注/嵌套引用/任务列表样本与上游fixture输出一致；宽表可横向滚动且正文不溢出。。

### render.markdown_math — 完成回复中的TeX与兼容分隔符

状态：缺失；范围：default。

上游行为：完成回复中的TeX与兼容分隔符

原件证据：`packages/client/ui-primitives/src/markdown/parse.ts:40`；`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:149`；`packages/client/ui-primitives/src/markdown/katex.tsx:1`。

当前证据：`apps/web/public/app.js:344`。TeX按普通文本

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：使用上游mathCompatibility grammar及KaTeX受限渲染；流式禁用数学解析，完成后切settled。

可测验收：$/$ $和兼容TeX样本正确；不完整流式公式不闪错误；危险TeX不获得trusted执行。。

### render.markdown_links — 普通URL、行号文件链接、inline-code URL/文件引用

状态：缺失；范围：default。

上游行为：普通URL、行号文件链接、inline-code URL/文件引用

原件证据：`packages/client/ui-primitives/src/markdown/render.tsx:301`；`packages/client/ui-primitives/src/markdown/render.tsx:553`；`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:164`；`packages/client/ui-chat/src/client/apply.ts:216`。

当前证据：`apps/web/public/app.js:344`。链接是普通文本

按钮/交互：HTTP(S)链接；文件行号链接；inline-code中的文件/URL

建议：复用sanitizeUrl/parseFileLink规则；新tab使用noopener；只从确认文件词汇调用既有资源导航。默认Web未启用built-in Browser时HTTP链接新tab。

可测验收：HTTP/mailto允许、javascript拒绝；#L24-L30文件链接定位首行；修饰键保持浏览器行为。。

### render.untrusted_html_literal — 模型HTML不执行且输出安全

状态：已有；范围：default。

上游行为：模型HTML不执行且输出安全

原件证据：`packages/client/ui-primitives/src/markdown/render.tsx:333`；`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:170`。

当前证据：`apps/web/public/app.js:47`；`apps/web/public/app.js:333`；`apps/web/public/app.js:339`。el仅使用textContent；非code文本使用createTextNode；code使用textContent

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：Markdown补齐后继续使用语义元素与协议allowlist；只允许可信highlighter生成的静态span HTML。

可测验收：<script>与事件属性字面显示/不可执行；危险href不产生可点击执行目标。。

### render.markdown_streaming — 流式Markdown增量冻结与稳定DOM

状态：缺失；范围：default。

上游行为：流式Markdown增量冻结与稳定DOM

原件证据：`packages/client/ui-primitives/src/markdown/MarkdownText.tsx:66`；`packages/client/ui-primitives/src/markdown/incremental.ts:1`。

当前证据：`apps/web/public/app.js:485`；`apps/web/public/app.js:328`。text_delta累计后全量textContent；final renderAssistantContent replaceChildren

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：适配IncrementalMarkdownParser的source offset keys与tail缓存；streaming/settled状态由消息生命周期明确传入，final self-heal references。

可测验收：长回复增量不会重建既有代码选择/披露状态；流式未闭合fence可显示；完成输出与一次性settled一致。。

### render.code_fence — 代码围栏、语言名、横向滚动与复制

状态：缩水/部分；范围：default。

上游行为：代码围栏、语言名、横向滚动与复制

原件证据：`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:71`；`packages/client/ui-primitives/src/markdown/render.tsx:385`。

当前证据：`apps/web/public/app.js:330`；`apps/web/public/app.js:337`；`apps/web/public/style.css:83`。仅完整```fence regex；语言+复制；pre横向滚动

按钮/交互：复制代码

建议：通过GFM节点替换完整三反引号regex；保留已实现copyButton与pre呈现，支持tilde fence/缩进代码/未闭合流式fence。

可测验收：三/四反引号、tilde与未闭合流式代码正确；代码复制仅原文不含语言/行号。。

### render.code_toolbar — 代码卡片换行切换/复制确认/粘性header

状态：缩水/部分；范围：default。

上游行为：代码卡片换行切换/复制确认/粘性header

原件证据：`packages/client/ui-primitives/src/CodeToolbar.tsx:38`；`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:156`；`packages/client/ui-primitives/src/markdown/CodeBlock.module.css:1`。

当前证据：`apps/web/public/app.js:337`；`apps/web/public/app.js:311`；`apps/web/public/style.css:82`。语言和复制按钮；复制没有超时复位；普通banner无sticky/wrap

按钮/交互：开启/关闭代码换行；复制/已复制

建议：复用CodeToolbar行为与labels，vanilla状态保存在stable fence key；默认wrap遵循上游，选择不重置。

可测验收：切换wrap保留代码全文；复制确认约1s后复位；无Clipboard时明确失败；键盘可达且sticky banner正确。。

### render.code_highlight — 语言grammar懒加载、流式增量语法高亮

状态：缺失；范围：default。

上游行为：语言grammar懒加载、流式增量语法高亮

原件证据：`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:77`；`packages/client/ui-primitives/src/markdown/CodeBlock.tsx:120`；`packages/client/ui-primitives/src/markdown/highlight.ts:1`。

当前证据：`apps/web/public/app.js:339`。plain code text，无syntax spans

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：使用上游Shiki/highlight utility或同等受维护依赖；未知语言plain fallback，视口外延迟加载，streaming按append处理。

可测验收：支持语言高亮；未知language保留全文；长流式代码不丢行；深浅主题token正确。。

### render.markdown_images — Markdown远程/本地图片、安全alt fallback与预览

状态：缺失；范围：default。

上游行为：Markdown远程/本地图片、安全alt fallback与预览

原件证据：`packages/client/ui-primitives/src/markdown/render.tsx:70`；`packages/client/ui-primitives/src/markdown/render.tsx:639`；`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:23`。

当前证据：`apps/web/public/app.js:344`。![]语法字面输出

按钮/交互：Markdown图片预览

建议：复用remoteImageUrl及pathImages vocab；本地路径必须通过当前file-resource loader确认，远程图片失败保留alt。

可测验收：HTTP(S)图显示，data/javascript作者URL拒绝；已授权本地文件图可显示；失败仍可读alt。。

### render.message_images — 用户/助手/工具图集、单图尺寸与失败重试

状态：缺失；范围：default。

上游行为：用户/助手/工具图集、单图尺寸与失败重试

原件证据：`packages/client/ui-attachment/src/MessageImage.tsx:45`；`packages/client/ui-attachment/src/MessageImage.tsx:85`；`packages/client/ui-attachment/src/MessageImage.tsx:169`；`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:104`。

当前证据：`apps/web/public/app.js:520`；`apps/web/public/app.js:525`。content直接传给字符串user/assistant；tool转String

按钮/交互：打开原图；加载失败重试

建议：统一ImageGallery view，加载使用已有session授权API；cache URL按附件id稳定，异步结果受当前view generation保护。

可测验收：1图不超自然尺寸；多图64px tile并换行；loading与重试可达；切换会话不显示旧URL。。

### render.image_lightbox — 原图modal、Esc/遮罩/关闭与焦点恢复

状态：缺失；范围：default。

上游行为：原图modal、Esc/遮罩/关闭与焦点恢复

原件证据：`packages/client/ui-primitives/src/ImageLightbox.tsx:27`；`packages/client/ui-primitives/src/ImageLightbox.tsx:36`。

当前证据：`apps/web/public/index.html:39`。消息区没有image dialog

按钮/交互：原图关闭；遮罩关闭；Escape

建议：复用body级overlay/aria-modal/focus逻辑；图片渲染与modal独立，避免transformed祖先影响遮罩。

可测验收：点击缩略图开原图；Esc、遮罩、close均关闭；Tab保持modal；关闭回到原按钮。。

### render.file_attachments — 历史用户文件卡片：名称/类型/大小/顺序

状态：缺失；范围：default。

上游行为：历史用户文件卡片：名称/类型/大小/顺序

原件证据：`packages/client/ui-chat/src/client/chat/MessageItem.tsx:208`。

当前证据：`apps/web/public/app.js:306`；`apps/web/public/index.html:47`。user只有text bubble；composer只有textarea

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：保留content block附件顺序，使用file icon/size utilities；附件在气泡外stack，无文本消息也显示附件。

可测验收：图/文件交错顺序保留；长名称ellipsis且title可读；类型及bytes准确。。

### render.composer_attachments — 草稿图片/文件rail、拖放、上传进度/删除/失败重试

状态：缺失；范围：default。

上游行为：草稿图片/文件rail、拖放、上传进度/删除/失败重试

原件证据：`packages/client/ui-attachment/src/client/ComposerAttachments.tsx:21`；`packages/client/ui-attachment/src/client/ComposerAttachments.tsx:59`；`packages/client/ui-attachment/src/FileCard.tsx:21`；`packages/client/ui-attachment/src/client/index.ts:16`。

当前证据：`apps/web/public/index.html:43`；`apps/web/public/index.html:48`。composer无attachment rail；仅stop/send

按钮/交互：删除附件；重试上传；草稿原图预览

建议：增加draft attachment展示模块和session-scoped上传队列，onAddFiles/onRemove/onRetry复用UI行为；提交payload依现有Gateway合同适配。

可测验收：拖放显示overlay；图片可预览/删除；file显示上传进度、失败重试；切session草稿不串；上传未ready不可误提交。。

### render.unknown_block — 未知/额外消息block的受限JSON披露

状态：缺失；范围：default。

上游行为：未知/额外消息block的受限JSON披露

原件证据：`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:131`；`packages/client/ui-chat/src/client/chat/MessageItem.tsx:223`；`packages/client/ui-primitives/src/markdown/JsonBlock.tsx:8`。

当前证据：`apps/web/public/app.js:329`；`apps/web/public/app.js:512`。unknown结构强制String；unknown event ignored

按钮/交互：展开/收起JSON

建议：在适配器保留未知content原值并提供懒序列化JSON disclosure；仅event unknown不应全部呈现成用户消息。

可测验收：未知content不会消失或[object Object]；展开后可读JSON，超20k有明确截断提示。。

### render.reasoning — 推理独立disclosure与流式摘要

状态：缺失；范围：default。

上游行为：推理独立disclosure与流式摘要

原件证据：`packages/client/ui-chat/src/client/chat/ReasoningRow.tsx:47`；`packages/client/ui-chat/src/client/chat/ReasoningRow.tsx:56`；`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:92`。

当前证据：`apps/web/public/app.js:481`；`apps/web/public/app.js:482`。仅'正在思考'状态；model.delta只处理tool_call

按钮/交互：展开/收起思考

建议：按真实reasoning block建立独立stable disclosure；复用firstLine/latestCompletedParagraph规则与compact Markdown，不从正文猜测推理。

可测验收：真实推理默认折叠；流式摘要逐段推进；展开全文与body Markdown能力一致；完成/模式切换不丢展开状态。。

### render.process_display — work details四模式、步骤组与completed turn整体折叠

状态：缺失；范围：default。

上游行为：work details四模式、步骤组与completed turn整体折叠

原件证据：`packages/client/ui-chat/src/chat-settings.ts:32`；`packages/client/ui-chat/src/client/presentation-policy.ts:24`；`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx:36`；`packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx:1`。

当前证据：`apps/web/public/app.js:474`；`apps/web/public/style.css:59`。扁平event switch；message-list单column gap

按钮/交互：整个Turn展开/收起；步骤组展开/收起

建议：按turn/step构建展示索引；整个turn process与每条reason/tool分别拥有disclosure state；保留final answer。默认detailed策略。

可测验收：四模式呈现符合policy；completed turn折叠不隐藏最终回答；running turn正确分组；错误/取消始终可见。。

### render.tool_row — 工具准备/运行/完成/失败/停止生命周期与独立披露

状态：缩水/部分；范围：default。

上游行为：工具准备/运行/完成/失败/停止生命周期与独立披露

原件证据：`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:120`；`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:169`；`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:1`。

当前证据：`apps/web/public/app.js:482`；`apps/web/public/app.js:492`；`apps/web/public/app.js:497`；`apps/web/public/app.js:291`。准备工具状态；tool requested；tool start/completed/failed；flat tool-line

按钮/交互：工具展开/收起

建议：以callId聚合tool events为一个可更新卡片，沿用现有approval UI；状态由真实events驱动，惰性格式化args/output。

可测验收：一个call始终一个row；preparing不可展开空body；completion/failure不丢stdout/stderr；history/live呈现同一。。

### render.tool_cards — 默认专业工具卡：terminal/read/image/diff/search/web/todo/details/question

状态：缺失；范围：default。

上游行为：默认专业工具卡：terminal/read/image/diff/search/web/todo/details/question

原件证据：`packages/client/ui-tool/src/client/apply.ts:44`；`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:169`；`packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx:33`。

当前证据：`apps/web/public/app.js:498`；`apps/web/public/app.js:525`。stdout/stderr flat；history tool String

按钮/交互：卡片披露；代码/终端复制及换行；文件/来源链接

建议：可复用tool/models纯解析器，映射Harness工具名与结果metadata；unknown/malformed必须回generic卡，随后适配TerminalBlock/ReadBlock/DiffBlock/SearchBlock/WebBlock。

可测验收：bash exit!=0可见失败；read有line范围，diff有增删合计，search分文件，web可点击来源，todo/ask/details不丢记录；未知工具显示generic。。

### render.tool_subcalls — 工具/PTC子调用树

状态：缺失；范围：default。

上游行为：工具/PTC子调用树

原件证据：`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:61`；`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:82`。

当前证据：`apps/web/public/app.js:492`；`apps/web/public/app.js:498`。flat lifecycle statuses；flat stdout

按钮/交互：各层工具展开

建议：聚合parentCallId/subcall refs并用相同atomic card递归渲染；stable callId keys，未知工具保留generic。

可测验收：父子层级、状态及输出独立；live准备到result身份稳定；重连后结构不重复。。

### render.tool_navigation — 工具文件/URL链接和Inspect跳转

状态：缺失；范围：default。

上游行为：工具文件/URL链接和Inspect跳转

原件证据：`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:189`；`packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:197`；`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:38`。

当前证据：`apps/web/public/app.js:291`。tool文本不可交互

按钮/交互：打开工具关联文件；打开URL；Inspect

建议：复用toolRowModel的路径/URL识别，文件路径接资源路由，Inspect接默认trajectory的callId选择；未有能力时不显示无效按钮。

可测验收：点击路径不折叠row；Enter/Space激活目标；Inspect定位同call；error/stopped不误显示可操作链接。。

### chat.system_prompt — 完整系统提示词及历史更新披露

状态：缺失；范围：default。

上游行为：完整系统提示词及历史更新披露

原件证据：`packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx:25`；`packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts:92`。

当前证据：`apps/web/public/app.js:518`；`apps/web/public/app.js:512`。history只处理user/assistant/tool；default event ignored

按钮/交互：展开/收起系统提示词

建议：增加system/message/request header的前端投影与bounded opaque展示，保持同step去重和历史位置；不修改model-visible记录。

可测验收：首系统prompt、replacement、request-series新prompt正确；完整文本保持原换行；不重复同step提示词。。

### chat.context_injection — 注入/召回/工具增减上下文及producer/form详情

状态：缺失；范围：default。

上游行为：注入/召回/工具增减上下文及producer/form详情

原件证据：`packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx:31`；`packages/client/ui-chat/src/client/chat/ContextBody.tsx:551`。

当前证据：`apps/web/public/app.js:472`；`apps/web/public/app.js:518`。仅system plain line；无context role

按钮/交互：展开/收起上下文；工具变更列表展开

建议：复用纯form renderer思路，保留source fields与模型文本；读取失败全量fallback OpaqueBody，unknown blocks JsonBlock。

可测验收：所有默认forms有可读详情；缺失/畸形source回opaque；tool-add/remove单项不显示无意义展开，召回来源可辨。。

### chat.turn_trigger — 非人工回合触发归因、时间与内容披露

状态：缺失；范围：default。

上游行为：非人工回合触发归因、时间与内容披露

原件证据：`packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.tsx:29`；`packages/client/ui-chat/src/client/chat/turn-trigger.ts:1`。

当前证据：`apps/web/public/app.js:477`。turn.started仅运行状态

按钮/交互：展开/收起回合触发

建议：纯展示读取turn trigger source，按类型显示真实来源；不要把agent-team prototype列默认需求。

可测验收：schedule/job/subagent/webhook等真实来源与时间可见；展开显示原内容；来源未知有fallback。。

### chat.compaction — 自动/手动压缩标记、token/item数量与summary

状态：缺失；范围：default。

上游行为：自动/手动压缩标记、token/item数量与summary

原件证据：`packages/client/ui-chat/src/client/chat/CompactionItem.tsx:31`；`packages/client/ui-chat/src/client/chat/register-node-renderers.ts:52`。

当前证据：`apps/web/public/app.js:512`。无compaction event handling

按钮/交互：展开/收起压缩摘要

建议：从真实压缩记录投影标记，summary不可用时禁用展开；历史shadowed transcript保留。

可测验收：压缩数量/摘要正确；无summary不出现假按钮；完成后历史消息仍可导航。。

### chat.retry_failure — 重试倒计时、错误/配额/输出上限持久反馈

状态：缩水/部分；范围：default。

上游行为：重试倒计时、错误/配额/输出上限持久反馈

原件证据：`packages/client/ui-chat/src/client/chat/MessageItem.tsx:61`；`packages/client/ui-chat/src/client/chat/MessageItem.tsx:129`；`packages/client/ui-chat/src/client/chat/MessageItem.tsx:146`；`packages/client/ui-chat/src/client/chat/QuotaNoticeHost.tsx:1`。

当前证据：`apps/web/public/app.js:480`；`apps/web/public/app.js:484`；`apps/web/public/app.js:511`。turn failed errorLine；model failed；generic run.limit

按钮/交互：重试详情展开

建议：以turn/retry事件建立持久node；仅active retry运行clock，真实配额新失败显示notice，paging不重复toast。

可测验收：重试剩余秒/attempt/max可展开；error/cancel/max tokens可辨；history恢复不触发旧quota toast。。

### chat.running_status — 运行尾部状态、计时及reduced motion

状态：缩水/部分；范围：default。

上游行为：运行尾部状态、计时及reduced motion

原件证据：`packages/client/ui-chat/src/client/chat/RunningStatus.tsx:20`；`packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx:1`。

当前证据：`apps/web/public/app.js:281`；`apps/web/public/app.js:477`；`apps/web/public/style.css:86`；`apps/web/public/style.css:143`。一条全局status-line；turn started status；pulse；reduced motion

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：将current status置于正确turn尾部并从turn start真实时间计算elapsed；复用已有semantic tokens和reduced-motion分支。

可测验收：计时准确且ticks不反复aria-live播报；取消/完成停止计时；reduced-motion没有持续动画。。

### chat.session_activity_stats — session turn/step、速度、LLM/tool/TTFT统计弹层

状态：缺失；范围：default。

上游行为：session turn/step、速度、LLM/tool/TTFT统计弹层

原件证据：`packages/client/ui-chat/src/client/chat/StatsPills.tsx:156`；`packages/client/ui-chat/src/client/chat/StatsPills.tsx:237`；`packages/bundle/web-app/cordis.patch.yml:102`。

当前证据：`apps/web/public/app.js:517`；`apps/web/public/index.html:44`。session-meta只有sessionId；activity-bar只有status/sessionId

按钮/交互：Activity统计pill

建议：复用stats computation/格式；优先whole-log projection；无准确timing时普通pill不显示空dialog，compact仅speed。

可测验收：paging/压缩不改变整session统计；点击pill显示可用时间/速度；Esc/外点关闭，缺数据不编造。。

### chat.session_token_stats — session tokens/cache hit弹层

状态：缺失；范围：default。

上游行为：session tokens/cache hit弹层

原件证据：`packages/client/ui-chat/src/client/chat/StatsPills.tsx:282`；`packages/client/ui-chat/src/client/chat/StatsPills.tsx:311`；`packages/client/ui-chat/src/chat-settings.ts:41`。

当前证据：`apps/web/public/index.html:44`。无usage pill

按钮/交互：Usage统计pill

建议：保持uncached/cache-read/cache-write/output互斥加总；有真实billing才显示，缺cache字段不推算错误值。

可测验收：tokens/cache hit与真实accounting一致；无billing不显示；弹层只展示可用bucket；compact只cache hit。。

### chat.turn_token_usage — 完成Turn消耗pill与routes/cache/input/output/reasoning详情

状态：缺失；范围：default。

上游行为：完成Turn消耗pill与routes/cache/input/output/reasoning详情

原件证据：`packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx:31`；`packages/client/ui-chat/src/client/chat/turn-assistant.ts:1`；`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:1`。

当前证据：`apps/web/public/app.js:358`。assistant footer仅复制

按钮/交互：Turn消耗pill

建议：仅在完整turn start和每个attempt精确安全accounting可用时显示；复用footer与statDialog交互。

可测验收：一个turn多个attempt加总正确；routes/reasoning可选；不完整或矛盾数据整个pill隐藏。。

### chat.session_header — title/breadcrumb层级与header插槽

状态：缩水/部分；范围：default。

上游行为：title/breadcrumb层级与header插槽

原件证据：`packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx:12`；`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:58`。

当前证据：`apps/web/public/index.html:30`；`apps/web/public/index.html:32`。topbar title/nav/connection/theme；单层标题

按钮/交互：父会话breadcrumb

建议：保留现有topbar，用session parent/origin投影breadcrumbs；header actions由各域拥有，不把无后端动作伪装成可用。

可测验收：当前标题稳定；subagent父层级点击可返回正确session；blank/sessionless保持全局导航。。

### chat.view_tabs — 默认Chat/Trajectory切换及会话选择记忆

状态：缺失；范围：default。

上游行为：默认Chat/Trajectory切换及会话选择记忆

原件证据：`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:140`；`packages/client/ui-conversation/src/client/view-selection.ts:3`；`packages/bundle/web-app/cordis.patch.yml:445`。

当前证据：`apps/web/public/index.html:39`。只有messages section

按钮/交互：Chat tab；Trajectory tab

建议：session-scopedview偏好，Chat fallback；trajectory切换复用同数据适配源与draft，不复制session runtime。

可测验收：默认Chat；两tab可达，切换保留draft/session/scroll；缺失view时回Chat。。

### trajectory.default_inspection — 默认事件账本/请求/system/tools/code详情（父matrix有细项）

状态：缺失；范围：default。

上游行为：默认事件账本/请求/system/tools/code详情（父matrix有细项）

原件证据：`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:223`；`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:2938`；`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:3075`；`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:3222`。

当前证据：`apps/web/public/index.html:39`。只有transcript无ledger

按钮/交互：Request边界选择；详情tabs；Close；Resize；parent/result跳转

建议：沿用纯事件投影与独立viewer；复用JsonTree/Markdown/CodeBlock；父matrix可合并此overview与更细rows。

可测验收：Request选择对应overview/options/usage/timing；system提示/工具目录/diff正确；details close/resize键盘可用。。

### composer.send.basic — 发送按钮、Enter发送、Shift+Enter换行

状态：已有；范围：default。

上游行为：普通空闲输入可通过主按钮或Enter提交；Shift+Enter保留换行。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:314`；`packages/client/ui-conversation/src/client/input/editor/keymap.ts:140`。

当前证据：`apps/web/public/index.html:47`；`apps/web/public/app.js:601`；`apps/web/public/app.js:682`。textarea、send-btn与提示；发送到/api/messages；Enter处理

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：保留现有发送HTTP接线，把提示及aria接入统一本地化字典。

可测验收：点击/Enter各只发一个请求；空输入不能发送；Shift+Enter只插入换行；切换会话后请求仍归原generation。。

### composer.keyboard.safety — IME尾键、重复Enter和修饰键仲裁

状态：缩水/部分；范围：default。

上游行为：IME候选确认及紧随compositionend的Safari Enter不能提交；长按Enter不能重复发；Alt/AltGraph及混合修饰键不触发提交。

原件证据：`packages/client/ui-conversation/src/client/input/editor/keymap.ts:60`；`packages/client/ui-conversation/src/client/input/editor/keymap.ts:135`。

当前证据：`apps/web/public/app.js:679`。有composition/isComposing/keyCode229；compositionend立即清除，无repeat/Alt保护

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：在原textarea按键路由加入短尾键保护、event.repeat和明确修饰键矩阵，不改消息传输。

可测验收：中文/日文候选Enter与compositionend紧邻Enter均零请求；独立Enter一请求；repeat、Alt+Enter、Ctrl+Meta+Enter不误发。。

### composer.primary.send_stop — 主操作随运行/草稿变为Send或Stop

状态：缩水/部分；范围：default。

上游行为：普通运行会话空草稿主按钮显示Stop，有草稿显示当前递送方式的Send；停止经会话作用域取消。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:294`；`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:460`。

当前证据：`apps/web/public/index.html:48`；`apps/web/public/app.js:260`；`apps/web/public/app.js:639`。始终分别显示停止与发送；现有running/cancelPending控制；实际cancel命令

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：复用已有cancel()，按running/empty切换主按钮图标与aria；保留当前会话和pending防重机制。

可测验收：运行且空草稿只显示可执行Stop；有草稿可继续发消息；停止只取消当前会话当前回合；失败解除pending并可重试。。

### composer.stop.double_escape — 双Esc停止与区域隔离

状态：缺失；范围：default。

上游行为：两次未消费Escape在同一会话同一Turn作用域内才停止；审批、模态框、终端和组合输入不触发。

原件证据：`packages/client/ui-conversation/src/client/stop-shortcut.ts:31`；`packages/client/ui-conversation/src/client/apply.ts:259`。

当前证据：`apps/web/public/app.js:674`；`apps/web/public/app.js:639`。唯一全局Escape仅关闭移动侧栏；cancel()可复用

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：新增可重置的双Esc序列，路由至已有cancel()；导航、运行回合变更及overlay消费事件时重置。

可测验收：单Esc不取消；双Esc取消一次；切换会话/回合、IME、审批卡或弹窗中的Esc不取消；repeat无效。。

### composer.busy_delivery — 运行时Queue/Steer偏好与Ctrl/Cmd+Enter互补递送

状态：缺失；范围：default。

上游行为：默认运行时Enter入Queue；Ctrl/Cmd+Enter选择相反的Steer；偏好可改，主按钮与Enter一致。

原件证据：`packages/client/ui-conversation/src/client/input/submission-policy.ts:18`；`packages/client/ui-conversation/src/submission-settings.ts:17`；`packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.tsx:50`。

当前证据：`apps/web/public/app.js:683`；`apps/web/public/app.js:616`。Ctrl/Cmd+Enter与普通Enter都直接调用sendMessage；请求仅from/text，无delivery mode

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：先由Gateway确认queue/steer现有权限与时窗语义，再新增递送模式与偏好入口；前端不得把普通send伪装成steer。

可测验收：Queue模式Enter排队、Ctrl/Cmd+Enter尝试steer；Steer偏好反转；关闭steering时窗按真实后端规则落队列；空闲均普通发送。。

### message.copy.assistant — Assistant复制的成功时限与防重复

状态：缩水/部分；范围：default。

上游行为：复制全文，成功短暂切换勾选图标和aria；pending/已成功窗口内不重复写。

原件证据：`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:53`；`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:85`。

当前证据：`apps/web/public/app.js:311`；`apps/web/public/app.js:356`。已有复制，成功文案永久更换；每个assistant气泡复制按钮

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：移植复制成功状态时限与pending防重，复用现有messageId作用域和安全纯文本内容。

可测验收：复制内容与原回复逐字相同；连点一次写入；约1秒恢复；复制失败保留可重试操作；旧generation不更新新视图。。

### message.copy.user_clock — User复制与消息时间

状态：缺失；范围：default。

上游行为：User正文也可复制；durable消息有日期感知时间，瞬态消息不编造时间。

原件证据：`packages/client/ui-chat/src/client/chat/MessageItem.tsx:332`；`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:77`；`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:63`。

当前证据：`apps/web/public/app.js:305`；`apps/web/public/app.js:350`。user只渲染气泡；assistant heading/body/copy，无clock

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：为user气泡增加复制动作；消费history/live的真实时间字段，缺时间时隐藏时钟。

可测验收：user与assistant均可复制；历史显示真实时间；瞬态/缺字段无伪时间；跨日时钟正确刷新。。

### message.turn_fork — 完成Turn末尾的消息分支

状态：缺失；范围：default。

上游行为：完成Turn末尾有Branch操作，发送确切turn/end seq；不可分支时仍显示焦点可达按钮和原因。

原件证据：`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:63`；`packages/client/ui-chat/src/client/apply.ts:248`。

当前证据：`apps/web/public/app.js:356`。assistant动作只有copy

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：将分支请求接入现有Session/Gateway的fork能力并传真实边界标识；确认权限与分支能力后添加动作。

可测验收：完成回合分支得到边界一致的历史并打开子会话；运行/非终尾不可点击且有原因；失败源会话保持不变。。

### message.feedback.actions — Like/Dislike与已记录判断撤回

状态：缺失；范围：default。

上游行为：冷按钮点击先读已有评分；未记录评分打开对话框，重复相同评分撤回；pending禁用并公布失败。

原件证据：`packages/bundle/web-app/cordis.patch.yml:396`；`packages/client/ui-message-feedback/src/client/MessageFeedbackActions.tsx:50`。

当前证据：`apps/web/public/app.js:356`。assistant动作仅复制

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：按messageId增加评分动作，通过既有HTTP/RPC反馈能力持久化；细分反馈对话框由另一清单负责。

可测验收：评分刷新可读；重复相同评分撤回；并发失败不误显示成功；只有真实durable messageId有按钮。。

### chat.scroll.reading — 流式滚动尊重读者位置、回到底部和会话阅读记忆

状态：缩水/部分；范围：default。

上游行为：读者上滚时流式回复不抢读位；回底按钮恢复跟随；每会话保留语义阅读位置。

原件证据：`packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:52`；`packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:127`；`packages/client/ui-chat/src/client/chat/ChatView.tsx:287`。

当前证据：`apps/web/public/app.js:270`；`apps/web/public/app.js:374`；`apps/web/public/app.js:488`。每次append强制scrollHeight；assistant完成强制底部；每次delta强制底部

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：为#messages跟踪followingTail与会话scroll memory，底部更新条件化，新增回到底部按钮。

可测验收：流式过程中上滚后位置保持；底部时继续跟随；点击回底恢复跟随；切换回来还原读位；发送自己的消息回底。。

### chat.turn_navigation — Turn轨道导航、预览与未加载Turn跳转

状态：缺失；范围：default。

上游行为：所有Turn通过outline保留导航；点击未加载Turn需要分页历史；独立轨道滚动且支持keyboard focus。

原件证据：`packages/client/ui-chat/src/client/chat/ChatView.tsx:231`；`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:61`；`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx:227`。

当前证据：`apps/web/public/index.html:39`。聊天容器只含empty-state/message-list

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：通过Gateway已有turn outline/分页能力形成稳定Turn索引；原生DOM移植轨道和预览，保留messageId与generation归属。

可测验收：两回合出现轨道，单回合隐藏；点击精确定位；未加载历史先加载再定位；焦点预览和busy aria正确；reduced-motion无平滑动画。。

### chat.history.load_earlier — 显式加载更早历史

状态：缺失；范围：default。

上游行为：历史可分页，有明确加载状态且加载旧消息不改变当前读位。

原件证据：`packages/client/ui-chat/src/client/chat/ChatView.tsx:249`；`packages/client/ui-chat/src/client/chat/use-chat-scroll.ts:135`。

当前证据：`apps/web/public/app.js:183`。history加载，无hasMore或loadEarlier控制

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：确认当前history分页接口后加入Load earlier按钮与锚点补偿；现有全量历史不能冒充分页。

可测验收：长会话每次只加载一页；按seq/messageId正确合并；读位不跳；失败可重试；旧generation结果不落入新会话。。

### composer.command.plus_slash — 加号与/命令候选、键盘仲裁

状态：缺失；范围：default。

上游行为：+与键入/打开同一命令菜单；Enter/Tab接受高亮，↑↓移动，Escape/Shift+Tab回composer；命令目录随会话能力刷新。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:420`；`packages/client/ui-commands/src/client/service.ts:115`；`packages/client/ui-conversation/src/client/input/editor/keymap.ts:105`；`packages/client/ui-conversation/src/client/input/editor/keymap.ts:147`。

当前证据：`apps/web/public/index.html:45`；`apps/web/public/app.js:682`。只有textarea/send/stop；Enter只有send，未做命令仲裁

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：为现有textarea建立可取消session-keyed命令目录和候选路由，菜单先消费键盘再提交；命令需走现有Gateway权限路径。

可测验收：点击+与/得到相同菜单；↑↓/Enter/Tab选择；Esc不发送；菜单保持输入焦点；会话切换与能力变更不会复用旧候选。。

### composer.reference.mention — @文件/会话引用、目录下钻和引用chip

状态：缺失；范围：default。

上游行为：@候选合并文件与会话；目录行可Tab/chevron下钻；选择插入原子引用chip，复制和序列化使用真实引用。

原件证据：`packages/client/ui-reference/src/client/index.ts:54`；`packages/client/ui-reference/src/client/index.ts:112`；`packages/client/ui-input-trigger/src/client/MenuView.tsx:107`。

当前证据：`apps/web/public/index.html:47`；`apps/web/public/app.js:616`。普通textarea无chip；只有文本传输

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：消费Gateway真实文件/会话候选并取消陈旧请求，增加文本区引用标识适配或受控editor；引用序列化不得只发送显示标签。

可测验收：@列出授权文件/会话；目录下钻和面包屑正确；Esc退回；chip复制/发送恢复真实引用；切换会话无旧候选或越权结果。。

### composer.file_intake — 加号文件选择、粘贴文件与发送门控

状态：缺失；范围：default。

上游行为：文件选择和粘贴进入同一附件rail；上传中或失败附件阻止发送，可重试或移除，不静默丢失。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:434`；`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:80`；`packages/client/ui-conversation/src/client/input/editor/keymap.ts:159`。

当前证据：`apps/web/public/index.html:45`；`apps/web/public/app.js:616`。composer无文件入口；/api/messages仅text

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：在已授权附件上传Gateway接口上增加选择/粘贴、预览、进度/失败与send门控；不要直接把本地path当成上传成功。

可测验收：文件/图片多选与粘贴可见；上传未ready不能send；失败可重试/移除；消息提交含真实附件引用；导航撤销本地预览资源。。

### composer.rich_controls.entries — Permission/Plan/Model及activity插槽的composer入口

状态：缺失；范围：default。

上游行为：默认InputBar持有权限、计划、模型以及活动入口，锁定状态依真实会话和输入状态决定。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:442`。

当前证据：`apps/web/public/index.html:48`。composer actions只有hint、stop、send

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：用现有Gateway可用能力装配入口与锁定状态；model/permission/preset的选择细项交由其专门清单，不重复实现。

可测验收：仅能力可用时出现入口；输入冻结/会话失效时锁定；触发不会意外提交当前draft；手机宽度不重叠。。

### composer.queue.dock — Queue状态、折叠、编辑/删除/立即steer

状态：缩水/部分；范围：default。

上游行为：Queue由Host inbox投影，pending项禁用操作；多项可折叠；纯文本可编辑、项目可删、运行时可steer。

原件证据：`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:104`；`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:175`；`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:163`；`packages/client/ui-conversation/src/client/queue/QueueDock.tsx:267`。

当前证据：`apps/web/public/app.js:471`；`apps/web/public/app.js:616`。仅[queued]提示一行；继续输入可发送，但无可操作队列

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：通过Gateway真实inbox与queue update接口加dock；依durable itemId合并pending，操作成功后更新投影，保留错误与作用域。

可测验收：单项直显/多项折叠；编辑save/cancel；删除只删目标；运行时steer、不运行解释禁用；pending无重复项；断线重连恢复队列。。

### composer.todo.dock — Todo进度摘要与展开列表

状态：缺失；范围：default。

上游行为：从todos投影显示只读计划进度；空列表无UI，展开逐条pending/in_progress/completed。

原件证据：`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:65`；`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:115`；`packages/client/ui-conversation/src/client/apply.ts:551`。

当前证据：`apps/web/public/index.html:43`。composer无todo dock

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：消费既有任务投影，在composer dock呈现折叠摘要与列表，保持工具执行为唯一写入来源。

可测验收：空投影隐藏；三种状态和计数准确；Enter/Space展开收起；流式todo更新不丢展开状态；手机列表可读。。

### conversation.content_width — 对称宽度拖柄及持久化

状态：缺失；范围：default。

上游行为：左右拖柄对称改会话正文宽度；存储用户偏好；窄列缩夹/隐藏命中区，取消不持久化。

原件证据：`packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:64`；`packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:154`；`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:247`。

当前证据：`apps/web/public/style.css:16`；`apps/web/public/style.css:58`。固定748px宽度；message-list max-width固定

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：移植纯DOM pointer-capture控制及CSS宽度变量；宽度同时影响transcript/composer布局；无需后端。

可测验收：两侧拖动同样宽度；刷新恢复；窗口缩窄暂时clamp后放宽恢复偏好；pointercancel还原；窄手机无漂浮命中条。。

### composer.context_meter — 上下文占用环、百分比与组成面板

状态：缺失；范围：default。

上游行为：真实contextPressure/capacity驱动占用；点击显示系统/工具/消息heuristic breakdown，Escape或外点关闭，capacity移除时自动关闭。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:499`；`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:57`；`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:111`。

当前证据：`apps/web/public/index.html:44`；`apps/web/public/app.js:260`。activity/status/meta而无context meter；只维护send/stop

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：只消费现有计量投影；缺provider/capacity时隐藏，禁止把字符数包装成真实context percent。

可测验收：投影到达才显示；ring/percent/capacity一致；面板组成值明确近似；Esc/外点关闭；模型切换容量消失立即关闭。。

### shortcuts.reference_customization — 快捷键目录、搜索、改键与恢复默认

状态：缺失；范围：default。

上游行为：Ctrl/Cmd+/打开可搜索快捷键目录，展示有效绑定、固定输入和应用命令；用户可录制/改键/恢复，冲突和持久化失败显式。

原件证据：`packages/bundle/web-app/cordis.patch.yml:255`；`packages/client/ui-shortcuts/src/client/index.ts:42`；`packages/client/ui-shortcuts/src/client/Reference.tsx:110`。

当前证据：`apps/web/public/index.html:24`；`apps/web/public/app.js:674`。新会话按钮仅装饰+，非shortcut；键盘监听只有移动Esc与Enter

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：先提供共享命令注册与平台键描述，再移植目录；改键持久化需遵守现有设置能力，固定输入不能误当可编辑应用快捷键。

可测验收：Ctrl/Cmd+/切换目录；搜索按名称/键生效；改键执行新动作；冲突不保存；恢复默认有确认且失败显式；刷新有效绑定保持。。

### shortcuts.new_sidebar — 默认Web新建会话和侧栏快捷键

状态：缺失；范围：default。

上游行为：Web平台特定组合键通过同一命令操作，editable区域也可触发，modal阻断。

原件证据：`packages/client/ui-workspace/src/client/shortcuts.ts:78`；`packages/client/ui-layout/src/client/index.ts:191`。

当前证据：`apps/web/public/app.js:670`。仅点击侧栏和新建，没有这些keyboard绑定

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：先将现有newSession()/setSidebar()注册成命令，绑定Web platform defaults，统一默认阻断和IME处理；搜索能力由工作区清单负责。

可测验收：正确平台组合键等价按钮；不会输入字符或重复触发；modal/IME场景阻断；工具提示与aria-keyshortcuts显示有效绑定。。

### responsive.sidebar — 窄屏自动收起与桌面偏好恢复

状态：缩水/部分；范围：default。

上游行为：上游默认在1024收起为56px rail，窄屏manual override不覆盖宽屏偏好；当前760 drawer是本地适配而非exact parity。

原件证据：`packages/client/ui-layout/src/client/columns.ts:13`；`packages/client/ui-layout/src/client/stores.ts:106`。

当前证据：`apps/web/public/style.css:125`；`apps/web/public/app.js:651`；`apps/web/public/app.js:668`。760断点、264全遮罩drawer；桌面持久化；手机初始收起、响应resize/Esc

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：明确选择保留现有手机drawer作为适配，或移植上游rail/1024逻辑；恢复桌面偏好、缩放和侧栏内导航需一致。

可测验收：390/760/1024/1440宽度无横向溢出；窄屏开关/遮罩/Esc和选择会话关闭；回宽屏恢复原偏好；阅读区和composer可操作。。

### responsive.composer_controls — 窄composer容器下的工具间距和可用性

状态：缩水/部分；范围：default。

上游行为：上游控件适配按实际composer容器宽度；工具与trailing可换行，chip/model缩文字，保持固定操作可达。

原件证据：`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:261`；`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:293`；`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:254`。

当前证据：`apps/web/public/style.css:125`；`apps/web/public/style.css:115`。手机调整padding/字体/隐藏hint、安全区；单行controls无richer group wrap

按钮/交互：本项不含单独按钮，使用所属组件交互。

建议：保留当前dvh/safe-area/16px输入防缩放，补实际容器查询与flex-wrap；新增richer controls后按560等容器尺寸验证。

可测验收：390手机、窄桌面分栏和虚拟键盘下输入/Stop/Send都可见；tooltip/菜单不越界；工具控件不重叠；safe-area不遮按钮。。

## 核验边界

已读取相关 AGENTS 与当前 task 文件；所有 source path 存在、source line 在范围内、stable id 唯一、JSON 必填字段完整；六张逐字 CSS 和 MIT LICENSE 的 SHA256 已与上游及清单三方比对。未修改 tracked 源码、plan，未 commit/push，未调用 GitHub connector。按父任务授权只将此审查报告与 JSON 复制到新隔离树 docs。
