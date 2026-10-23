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
