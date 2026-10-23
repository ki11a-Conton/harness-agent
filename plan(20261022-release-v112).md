# v1.12.0：收尾、发布与后续工作

合同：[RELEASE-V112-20261022](tasks/RELEASE-V112-20261022.md)。前序研究与长任务实现：[长任务计划](plan(20261020-161914).md)。证据保存在工作树外，历史失败和未推送候选不覆盖。

## 做什么

1. 完成 coding 长任务修复和 Web bootstrap 验收收尾，明确历史 CI 未证原因，不用推测修生产。
2. 将发布用 Web 构建/双平台实际安装及受限 exporter 绑定到新版本1.12.0；保留旧 gen1 历史工作流的版本与全部历史发布。
3. 修复 exporter 在多资产上传之间只检查一次 draft 的完整性窗口。
4. 以最终精确 SHA 完成工程及同字节 Ubuntu/Windows Web/CLI 门禁，再创建/填充该 SHA 的新草稿并正式发布 v1.12.0。
5. 发布后再选择下一轮 coding harness 缺口，写新计划并实施，不能靠本次发布宣称全部能力完成。

## 怎么做

- ef5a54cd 的已通过本地结果作为独立候选保留；最终版本变化后重新 clean 全量、构建和实际安装验收。
- 仅修改发布 workflow/exporter/version fixtures 与必要文档，不修改原始上游 UI 包、Core 架构或放宽工具权限。发布工作流构建一个1.12.0归档，让 Ubuntu/Windows Web 与 CLI 消费同一字节。
- exporter 仍只接受 main、同源码成功安装工作流、精确 tree/manifest/hash 和四份消费收据；只向已存在、同 SHA、tag=v1.12.0 的 draft 导出固定四资产。每次检查资产及 POST 前 fresh GET；中途发布、改绑或冲突立即拒绝，不删除、不覆盖、不自动发布。
- 正常快进 main 前先确认旧四组 CI 全部终态；新源码的主 CI、Windows 专项、第一代安装、Web 安装到终态。未匹配 push.paths 的专项只在无活跃冲突、main 精确 SHA 已核对时原生 dispatch，保存真实 run/job 结果。
- 本地 Actions artifact 下载被代理拒绝时，不绕过限制；复用 GitHub runner 的受限 exporter 下载已验收 artifacts 并上传新 draft。发布前重新核对版本、tag/source、资产大小/服务器 digest、源码收据及实际下载/安装结果。
- 最终发布者等待 exporter 工作流终态成功并核对所有合格收据后，再把新 draft 正式发布；随后复核公共 release、tag、下载资产和哈希，保持旧 v1.11.0 及其它历史版本不变。GitHub GET 与 POST 不具备原子 CAS，逐资产检查只保证拒绝已观察到的状态变化，不宣称防御外部 actor 恰在检查和上传之间改状态。
- 后续优化在发布后另立计划，以真实反例或成对评测决定范围；策略假设不作为绕过 Runtime 冻结的理由。

## 怎么验收

- 类型、文档、相关发布/安全/浏览器检查通过，最终 clean 全量0失败，实际跳过逐条归档。
- exporter 首次上传后 draft=false、target改变、同名资产冲突的对照由红到绿；原同源、hash、固定资产、旧版本和已发布拒绝规则保持。
- 精确 SHA 四组 CI 全部 success，主 CI 十个 job 全通过；仅 main 上不适用的 export-existing-draft 可跳过。
- CLI 完整适用项按平台验收：Linux 至少50项断言/19次请求，Windows 至少49项/18次；POSIX SIGINT 原用例保留，Windows 原生取消必须由同源码 Windows 专项通过。计数差异及实际收据见 [平台门禁修复](docs/evidence/release-v112-platform-20261023/README.md)。
- 同一1.12.0归档的 Ubuntu/Windows Web 和 CLI 收据全部通过，实际包大小/sha256与 BUILD-RECEIPT、PORTABLE-MANIFEST、SOURCE-ACCEPTANCE 一致；本地同包完整 Web/CLI 复验及篡改拒绝通过。
- 新 release 非 draft、tag精确指向最终源码，公开资产下载与记录哈希一致，旧 release/tag/assets 保持。发布前 ACCEPTED_NOT_PUBLISHED 原收据不被改写成已经发布。
- 真实付费模型任务成功率、摘要质量及未覆盖 UI 能力仍不由脚本模型门禁代证。发布后下一轮计划及实施证据单独记录。

## 2026-10-23 收尾修正

b1c4c982 已通过四组 CI，导出工作流随后失败。实际 Checks 收据证实新增发布门禁把 Linux 的50/19误用于 Windows 的完整49/18。按平台修正计数合同，保留原始失败和收据，不修改生产编码验收或凑断言。旧源码验收作为历史证据；修复后重新固定 SHA，完整执行上述门禁再发布。

本轮空草稿的受控恢复：新源码全部门禁通过后，fresh确认本次自己创建的 draft421052090 仍为 `draft=true`、tag=v1.12.0、target=b1c4c982、assets为空，旧export39830447189已终态失败且没有活跃导出，v1.12.0 tag尚不存在；仅将该空草稿的 target_commitish 更新为最终新SHA，保存前后观测。不得删除/替换资产、改历史版本或正在上传的草稿。随后仍须由新版 exporter 对新源码实际资产验收并导出成功，才可正式发布。

## 2026-10-23 持久化恢复测试的固定 lease 准入

**做什么：** 补强 `composition.integration.test.ts` 的 restored child owners 准备流程。e1c07385 主 CI 的 [coverage job120222545067](https://github.com/ki11a-Conton/harness-agent/actions/runs/39894775938/job/120222545067) 在固定 `127.0.0.1:59802` 收到真实 EADDRINUSE；临时目录唯一不保证其派生 TCP 端口可用。历史端口占用者和失败发生于初建还是重开仍为 NOT_PROVEN。

**怎么做：** 复用现有 `allocateAvailableLeaseFixture`，只把完整真实准备纳入准入：初建、创建持久会话、读取初始工具注册布尔值、实际关闭、用相同 config/dataDir 重开、取得原 session 的 restored owner。各次独立临时 attempt 内数据根和 session 始终保持；只有真实 busy lease 能在业务断言前重新分配完整准备，资源清理失败及其它异常继续失败。四项原始业务断言留在准入外，仅运行一次；不改生产关闭、lease 协议、固定端口、测试时限或覆盖阈值。

**怎么验收：** 受控真实 listener 分别占住初建前和真实关闭后重开前的 child 固定端口，均能触发真实 lease 拒绝；完整准备重新分配后四项恢复检查通过，原 blocker 和成功 owner 继续持锁。生产生命周期独立 probe 证明 close 等待 lease OS 回调，同根同端口可立即重获，连续真实恢复通过；不把该对照当历史 CI 的占用者证据。运行该恢复用例、composition 整文件、lease fixture 回归及 web 类型检查；最终新 SHA 仍须完整全量、同包安装和四组 CI 成功后才允许空草稿改绑与发布。原始对照与哈希记录在工作树外的 `coverage-e1-fixture-collision`、`coverage-e1-lease-audit`，由最终工程归档保留。

### 同轮 Windows PR15 普通请求的完成验收

- **做什么：** 修正该条测试将队列准入、文件内容和 turn 完成混为同一信号的问题。[独立记录](docs/evidence/release-v112-windows-pr15-20261023/README.md)的真实受控反例证明：原默认1秒 poll 可在合法工作仍进行时过早失败；文件已有十字节时 turn/inbox 也可能尚未完成。历史 Windows 的确切失败阶段或读取错误仍为 NOT_PROVEN。
- **怎么做：** 在真实请求准入前订阅原 owner 的 `markConsumed`，委托原持久化方法成功后才确认消费；错误拒绝等待并继续传播。使用报告实际阶段的有限 hang guard，在 `finally` 恢复原方法。生产 inbox/turn、权限、文件写入和原字节要求保持。
- **怎么验收：** 联合核对唯一 consumed inbox、对应的唯一 completed turn、accepted 普通请求 metadata、无 goal、两次模型调用及真实十字节 `real bytes`。真实提前失败/提前成功控制、focused 用例及新源码真实 Windows CI 必须通过；不将本地控制当成历史根因或新 Windows 成功结果。
