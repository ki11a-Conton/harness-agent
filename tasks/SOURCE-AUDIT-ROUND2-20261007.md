# 全面审查与确定性缺陷修复（2026-10-07，Asia/Shanghai）

基线：`21fa7436b1abdcbc0dcd4f8a300f171b1a35f8e0`。用户要求审查、列出 bug、修复并验收。

## 做什么

重新检查 Runtime、权限/沙箱、工具进程、provider、存储恢复、CLI/Web、计量与评测、研究归档和发布链。
先复现已发现的费用漏记、拒绝写入误报、arm 身份错误和归档入口错误；定位真实 Windows formal 失败。
只修有反例或明确合同证明的缺陷。保留付费实验原件、门限、champion 和旧验收身份；不修改 plan.md。

## 怎么做

按模块检查输入边界、状态转移、取消、终态、持久化、来源身份和发布门禁。
每个确认问题记录触发条件、影响、源码位置、反例、修复和回归结果。
先补失败回归，再修实现；Windows 通过原生 GitHub Actions 运行，诊断不得改变退出码或放宽门禁。
原生 Git/HTTP 访问 GitHub，禁止 GitHub 连接器；不启动子智能体，不调用付费模型。
隔离工作区完成，不碰原工作区未提交文件；以非强制方式提交并推送。

## 怎么验收

运行针对性单元/集成/安全反例、pnpm typecheck、完整 pnpm test、相关发布门禁。
涉及 Web 行为则运行实际浏览器；Windows 进程/路径及 formal/双平台门禁由真实 Windows runner 验收。
费用 request/ledger/cost journal/metrics 对账；拒绝与真实副作用分别验证；baseline/candidate 标签逐条一致。
实际执行归档 CLI，覆盖完整原件、缺失、篡改、历史 SHA、路径逃逸和损坏压缩包反例。
在 docs/evidence/source-audit-round2-20261007/ 中保存问题清单和可核验结果。
源码和工作树身份在全量测试期间固定；缺失历史原件或不可下载的日志明确记录，不能伪造通过。
