# 发布前最终工程审查

基线：5058d536d44acd61369d822cea4e160b553dff4b。用户要求全面审查、列出并修复剩余 bug。初始发布暂停要求已由后续明确授权更新：去除 Preview Notice，完成验收后发布第一代可用版本 v1.10.0；旧证据的“未发布”采集状态不改写。

## 做什么

审查 CLI/Web/SDK → Harness/Runtime → 模型/上下文 → 工具/权限/沙箱 → 持久化/恢复/验证 → 独立安装包的完整 coding 链路。重点查未被旧测试覆盖的取消/失败/重连/重启/路径/并发/配置变化/长输出及 UI DTO 边界。已声明的不支持能力与可复现缺陷分别列出，不能声称所有潜在 bug 已消除。

## 怎么做

独立 worktree，保留原工作区、旧 evidence、冻结实验与发布资产；先复现、记录触发条件和严重程度，再做最小修复和回归测试。遵守 Runtime freeze，仅修实证正确性、安全、发布完整性缺陷；副作用沿 ToolOrchestrator、PermissionEngine、SandboxManager、Verification。禁止启动子 agent。原生 Git/HTTP，禁止 GitHub 连接器。品牌保持 Harness Agent，原始版权/许可证保留。

## 怎么验收

全仓 typecheck/unit/integration，相关安全/协议、发布脚本/静态资产完整性；必要缺陷先 RED 后 GREEN。固定 clean 源码构建独立包，CLI/Web loopback 编程闭环、审批允许/拒绝、取消、恢复与中英文三视口品牌回归。能取得的原生 Windows/CI 证据绑定实际 SHA；未执行项如实记录。归档审查范围、所有确认 bug、修法、测试与剩余能力限制，commit 并推送 main，给用户本地测试步骤，并按新增要求完成发布。

新增发布验收：全新状态目录及刷新/重启均不出现中英文 Preview Notice；编程入口、模型设置和工具审批仍通过。源码与发布资产绑定同一 clean SHA，实际 Ubuntu/Windows 安装包和必要 CI 门全部通过后，创建 v1.10.0 tag/release，上传独立包、校验和与证据，并复核公开下载字节。继续区分工程可用性与未证明的付费模型质量，不自动晋升实验。

状态：已完成。最终产品源码 b65801e4 全量 9,521 PASS / 15 SKIP，完整第三轮 CI 10/10 SUCCESS，原生 Windows 专项 393 PASS / 2 POSIX SKIP，同一包两平台 CLI/Web 安装验收全部通过。Preview Notice 和首页 Preview 标记已移除；v1.10.0 已正式发布，4 项公开资产的无需登录下载均与验收字节一致。详细清单、原始失败和能力边界见 docs/final-audit-20261014.md，使用及最终发布绑定见 docs/release-v1.10.0.md。
