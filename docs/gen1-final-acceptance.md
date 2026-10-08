# v1.9.0 第一代个人 coding agent 工程验收

测试源码：`c5bbe61fef101a8c9eb10edab673be8b2e0935e3`，Git tree：`603f7cc88a3ac8b3897c296b70eef4df1133132b`。本文件及最终证据随 main 的文档归档子提交交付，release/tag/独立资产绑定上述已测试源码；文档子提交不宣称另一次全量测试。原始用户工作区未提交内容保留。

本轮比较 Codex、pi、Hermes、OpenCode、DeepSeek 有许可源码，源码文件和许可证记录见[使用及来源说明](first-generation.md)与六路比较清单。49条初审记录和验收补修见[审查索引](gen1-audit-index.md)；不声称已证明不存在任何bug。第一代提供持续chat/恢复、正确模型请求/恢复、分页读文件/完整版本hash、有界搜索/取消、原生编辑/exec/审批/验证、持久会话fork/SDK、Web侧栏与双SSE、本机持久目录所有权、SQLite/审批/ask迁移和预算完整性。

| 验收 | 实际结果与原件 |
| --- | --- |
| 最终本地全量 | 525文件、9298项：9284 PASS / 0 FAIL / 14 pending，847.243秒；真实exit0，HEAD与工作树前后clean。[命令与摘要](evidence/gen1-final-20261008/local/full/result.json)，[原始日志](evidence/gen1-final-20261008/local/full/run.log)，[完整Vitest JSON](evidence/gen1-final-20261008/local/full/vitest.json.gz) |
| 安全 / 协议 | 2143 / 52 PASS，分别20 / 7文件，0FAIL/0pending。[安全](evidence/gen1-final-20261008/local/security/result.json)、[协议](evidence/gen1-final-20261008/local/protocol/result.json) |
| portable / bounded exporter | Node30 PASS，0FAIL/0skip。[退出码与摘要](evidence/gen1-final-20261008/local/node/result.json)、[原始TAP](evidence/gen1-final-20261008/local/node/run.tap) |
| 文档与历史归档 | ALL CHECKS PASS；90原始回归证据验证，Git blobs独立恢复92文件通过。[文档](evidence/gen1-final-20261008/local/docs/result.json)、[归档](evidence/gen1-final-20261008/local/evidence/result.json)、[仅Git交付复核](evidence/gen1-final-20261008/local/root-git-evidence/result.json) |
| 实际 CLI/Web | Linux24断言、13真实loopback HTTP；逐次审批、编辑与真实验证、重启恢复、策略漂移拒绝、双SSE/取消；paid0。[结果](evidence/gen1-final-20261008/local/interaction/result.json)、[实际命令收据](evidence/gen1-final-20261008/local/product-commands.json) |
| 实际 Chromium | 29cases/82断言PASS，0浏览器错误；含78场景断言及4全局断言，包括受控传输case和真实后端case。[原始结果](evidence/gen1-final-20261008/local/browser/browser-result.json)、[截图与记录索引](evidence/gen1-final-20261008/local/browser/artifact-index.json) |
| 本机持久宿主 | 3真实双进程case PASS；占用写前拒绝、SIGKILL释放、失败启动清理。[结果](evidence/gen1-final-20261008/local/host-lease/result.json) |
| 原生Windows | [genuine Windows acceptance run37740745991](https://github.com/ki11a-Conton/harness-agent/actions/runs/37740745991) SUCCESS；安装49断言/18HTTP PASS。[API原件](evidence/gen1-final-20261008/ci/native-windows-run.json)、[job/step终态](evidence/gen1-final-20261008/ci/native-windows-jobs.json)；不把Linux平台SKIP当Windows证据 |
| 同一分发包 | [安装CI run37740743372](https://github.com/ki11a-Conton/harness-agent/actions/runs/37740743372) 三个产品腿通过；Ubuntu50断言/19HTTP，原生Windows49/18；同tar哈希、source/tree，0workspace links、doctor0、tamper两层拒绝。[Ubuntu](evidence/gen1-final-20261008/ci-data/ubuntu/installed/result.json)、[同包Windows消费](evidence/gen1-final-20261008/ci-data/same-archive-windows/result.json)、[独立复核](evidence/gen1-final-20261008/reviews/gen1-ci-final-c5bbe61-independent-review.json) |
| 再次独立消费 | 从draft下载的实际CI Ubuntu tar再于本地不重建运行：50/19 PASS；原件source与正式字节一致。[结果](evidence/gen1-final-20261008/local/distributed/result.json) |
| 最终完整CI | [run37740692345](https://github.com/ki11a-Conton/harness-agent/actions/runs/37740692345)，attempt1，completed SUCCESS；10jobs全部SUCCESS，包含coverage、sameSHA双平台与P38-12 attestation。[run原件](evidence/gen1-final-20261008/ci/main-run.json)、[job/step原件](evidence/gen1-final-20261008/ci/main-jobs.json) |

正式资产：`harness-agent-1.9.0-portable.tar.gz`，2176092 bytes；SHA256 `f7006e6c22655d35576bbb800870bda792cfb0df4834fc9405dd55f30e9a278b`；1621个文件/26个workspace包/10份许可与notice。选择Ubuntu构建、已在Windows实际消费的同一archive，Windows自行构建的另一hash不用于发布。需要Node>=22.19.0，消费者不需pnpm/npm/Git或重建；自己的项目开发依赖另行安装。7项移植许可文件与固定Git blobs逐字节一致。

原件中保存首轮full 3FAIL、typedoverflow漏码、RPC/CRLF fixture旧合同、workspace闭包、Windows短路径、SSE验收同步及20原日志未提交的真实失败。历史RED不改写；三个产品安装腿首次通过后，私有draft导出因旧同名资产拒绝两次，备份并清理自己的旧候选后只重跑导出，最终exportattempt3通过；不把这类传输准备当新的产品/模型实验，也不抹去失败。

模型编码质量、成本和与参考agent成功率对比仍NOT_PROVEN，paidModelCalls=0。没有晋升champion、改写冻结N7或声称已达到这些agent的模型能力。OpenAI兼容Chat Completions为当前接入；Anthropic原生/Responses/OAuth、多模态、完整TUI/PTY/LSP、跨机器同目录写入等未交付，见能力差距与使用文档。

## 归档复验与发布阶段

最终证据位于 [固定源码档案](evidence/gen1-final-20261008/README.md)，214个登记文件的来源、长度及SHA256见 [manifest](evidence/gen1-final-20261008/manifest.json)。对该交付目录和正式候选tar执行只读验证器已真实exit0/PASS；独立复审的1个正向及23个负向控制全部符合预期，包含重绑外层hash后仍拒绝错误源码、未完成/失败CI、缺失job、跳过必要归并步骤及篡改包。[独立审查原件](evidence/gen1-final-20261008/reviews/final-evidence-independent-review.json)。历史开发回归另保留于 [原始90件归档](evidence/gen1-20261008/README.md)，其 `fixedSource: null` 不改成最终源码。

在仓库根目录，只用Node内建模块复验；第二个参数可传独立下载的候选包，以核对它与原始CI bundle中的Ubuntu字节一致：

```sh
node docs/evidence/gen1-final-20261008/verify.mjs
node docs/evidence/gen1-final-20261008/verify.mjs docs/evidence/gen1-final-20261008 /path/to/harness-agent-1.9.0-portable.tar.gz
```

档案 `ACCEPTED_NOT_RELEASED` 记录采集时的真实阶段；后续公开发布应另记录实际release链接，不把这个原始字段或收据改成伪造的历史发布状态。验证器校验原件与平台/源码/退出码/终态关系，不重新运行归档实验，不联网，也不提供GitHub API的远程数字签名。文档归档子提交与已测试产品源码分开绑定，不能把归档提交当作新的全量测试结果。

发布状态：必要工程门全部通过后已推送main并公开发布 [v1.9.0 正式发布](https://github.com/ki11a-Conton/harness-agent/releases/tag/v1.9.0)（原始公开时间 `2026-10-08T10:37:34Z`）。annotated tag及产品包均绑定上述c5源码；无认证公开API及产品/证据下载hash均通过。发布完成原件见[公开交付记录](evidence/gen1-release-20261008/README.md)。最终验收manifest的 `ACCEPTED_NOT_RELEASED` 保留采集先于公开的原始状态，不改写归档字节。[实施计划](../plan(20261008-024527).md)记录G1–G11，真实模型质量仍为 `NOT_PROVEN`。
