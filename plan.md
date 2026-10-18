# Harness Agent 当前执行计划入口

当前任务：第一代 v1.11.0 更新与 Web 交互复验。详细规格：[plan(20261018-184000).md](plan(20261018-184000).md)。

用户授权：拉取最新 main，重新测试 Web 各种按键交互，修复实际问题；通过后以最新源码更新第一代 release。执行合同：[RELEASE-REFRESH-20261018](tasks/RELEASE-REFRESH-20261018.md)。此前 PR 修复计划保留在 [历史入口](plan(20261018-before-release-refresh).md)。

## 做什么

1. 以最新 main 为基线，在独立工作区构建，复验日常 Web 按钮和真实 coding 闭环。
2. 准备 v1.11.0 的固定源码安装包；保留 v1.10.0 等历史版本及 tag。
3. 通过同源码工程门及同字节 Ubuntu/Windows 安装验收后，发布新版本并校验公开下载。

## 怎么做

- 实际 Chromium 操作工作区/文件、模型/设置、发送/停止/队列、审批/问答、会话/分支/归档、反馈/附件、快捷键/语言、Chat/Trajectory 和连接恢复，覆盖桌面、390px 和 320px。
- 采用生产 HTTP/WebSocket、Runtime、工具和 JSONL，脚本模型只运行在 loopback；不拦截或伪造后端响应，不调用付费模型。
- 发布工作流和受限 draft exporter 的版本一起更新到 1.11.0；原校验、必跑用例、权限和源码/资产哈希契约不放宽。
- 无新产品缺陷时，不修改产品行为。若有缺陷，先保留失败与独立反例，再做最小修复及相邻回归。
- 等原 main 四工作流结束后正常快进推送；新 main 的四工作流独立验证，仅未被路径触发的流程在新 SHA 首次 dispatch。
- 创建绑定精确 SHA 的新 draft，只导出已验收的同一包；本地再次运行实际下载包，然后发布并检查无认证下载。

## 怎么验收

- 浏览器日常交互 42 场景/117 检查和基础 coding UI 30 场景，以及中英文真实断线恢复全部通过；失败保留，不把未实现能力算作通过。
- 类型、相关发布回归、安全及同一 clean SHA 的完整 suite 成功；主 CI 十项和原生 Windows、两类安装流程全部成功，核对 SHA、分支和 attempt。
- 最终发布 tar.gz 在 Ubuntu/Windows 上经过 Web/CLI 验收，所有收据的 sourceSha/sourceTree/version/archiveSha256 完全一致。
- 正式 release 与 tag 指向已验证源码；公开资产大小、SHA-256 与已验证字节一致；旧 release 不改写。完整证据附 release，付费模型质量仍单独报告。
