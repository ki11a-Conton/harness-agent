# 第二轮全面审查与修复验收 — 2026-10-07（Asia/Shanghai）

本轮确认的 **15 类缺陷已修复**，逐项触发条件、影响、修复和回归见 [BUGS.md](BUGS.md)。
验收源码为 `3ca4795d665b2c9e426c1debad3815aa77c85b70`，工程验收 **PASS**。
本文与原始证据的后续归档提交只增加文档，不把尚未测试的新产品代码归入已通过结果。

审查覆盖 Runtime 状态/取消/终态、ToolOrchestrator 权限和沙箱、原生进程与文件路径、provider 请求与 SSE、CLI/Web、存储恢复、记忆/MCP、评测计量、安全事实、历史归档及发布门禁。未发现确定性反例的模块通过原有全仓回归核对，没有凭模型失败重写 Runtime。
原工作区 `5340bbcf196f54b283ad4351ef057189a07aca0b` 的未提交 plan.md 与 N8 文件保留；在独立工作区完成原生 Git/HTTP 推送，未调用 GitHub 连接器或启动子智能体。

## 修复和反例

- 费用：补实际输入上界、最终 usage、累计快照覆盖、无 usage 的明确 UNKNOWN、完成事件前落盘、费用与归属原子结算、结算故障持久冻结，以及坏状态/数组预留表/可变返回引用的拒绝。
- 安全：拒绝的写入不再冒充真实逃逸；按真实成功事件追踪副作用；baseline/candidate、rep/attempt、真实 toolCallId 与规则关联必须一致，缺失和错配不能作为 CONTAINED。
- provider：实际 HTTP 请求携带 temperature/max_tokens，保留零温度；非法参数在发送前拒绝。
- 归档：修实际 CLI 语法错误，支持原始证据完整移交与历史 SHA 隔离重建；拒绝秘密、篡改、坏压缩、路径逃逸和身份漂移；没有原件不能补造。
- 发布：取回真实 Windows 原失败 artifact 定位 N2 清理 hook；异步有界清理并传播错误；release attestation 等待 formal/dual 验收。

最初基线四文件28项反例为 **18 failed / 10 passed**，失败均是实际断言；另实际 CLI 的 `node --check` 复现语法错误。
基线仅是定向源码反例，依赖与预构建依赖包复用工作区；它不是基线全仓发布验收。[原测试源码](raw/round2-baseline-test-corpus.tar.gz)与[环境说明](raw/round2-baseline-provenance.json)保留。
补充数组预留表反例在 `1360479` 为 **9 passed / 1 failed**，不混算成最初基线失败数。
本轮第一次固定源码全量为 **9064 passed / 5 failed / 13 skipped**：结算改动使既有耗时变异锚点失效，CI 同样明确拒绝。
更新唯一锚点后 **111 项相关回归全部通过**；实际将耗时结算改成零，原检测断言真实失败，变异被抓住且工作树恢复。没有删用例、放宽门禁或将 red 改成 skip。

## 固定源码验收

| 范围 | 结果 | 原件 |
| --- | --- | --- |
| Linux 全仓，启用 N2 真正离线 release 链 | **9070 passed / 0 failed / 13 skipped**，500文件，exit 0 | [完整 JSON](raw/round2-final-full-suite.json.gz)、[日志](raw/round2-final-full-suite.log.gz)、[SHA/退出码回执](raw/subreaper-run-receipt.json) |
| 真实 Windows，13文件 | **179 passed / 0 failed / 1 POSIX skip**；12项指定原生用例全部执行通过 | [runner 回执](raw/round2-final-windows-receipt.json)、[全部逐项结果](raw/round2-final-windows-case-records.json)、[公开 packet](raw/round2-final-windows-annotations.json) |
| 正式双平台 CI | **10 / 10 jobs SUCCESS** | [run](raw/round2-final-ci-run.json)、[每个 job/step](raw/round2-final-ci-jobs.json) |
| 真实 Chromium + 生产后端/HTTP/SSE | **27场景 / 77断言 / 0浏览器错误** | [结果与身份](browser/browser-result.json)、[请求](browser/browser-requests.json)、[响应](browser/browser-responses.json)、截图与实际 runtime 数据 |
| 生产 HTTP Host/Origin 与重启会话恢复 | **2 / 2 PASS** | [实际结果](raw/web-acceptance-results.json) |
| 安全回归专项 | **2135 passed / 0 failed**，19文件 | [JSON](raw/round2-security.json.gz) |
| 协议专项 | **52 passed / 0 failed** | [JSON](raw/round2-protocol.json.gz) |
| 耗时变异实际执行 | **1 / 1 CAUGHT**，applied/restored/failedTestNamed 均 true | [实际变异报告](raw/round2-duration-mutation.json) |
| pnpm typecheck / docs:verify | **PASS / ALL CHECKS PASS** | [类型检查](raw/round2-final-typecheck.log.gz)、[文档检查](raw/round2-final-docs-verify.log.gz) |
| 全部206个受版本管理 .mjs 语法 | **0失败** | [逐次结果汇总](raw/round2-final-script-syntax.json) |
| 全依赖漏洞检查（含 dev） | **0 vulnerabilities** | [原始 audit JSON](raw/round2-all-dependencies.json) |

本地 Node `v24.19.0`、pnpm `11.19.0`；CI 为 Node `v22.23.3`、pnpm `11.21.0`。
安全/协议专项在 `1360479` 执行；随后仅增加坏预算状态拒绝与变异锚点修复，它们也由最终 `3ca4795` 的完整套件执行。
本地13个 skip 为12个 Windows 专用用例（已由真实 Windows 全部补验）和一个历史对象缺失的 N5 自证分支；[逐项清单](raw/final-skipped-tests.json)保留，skip不算通过。
普通 `pnpm test` 的原有 perf/soak、取证与专用故意 red 范围排除保持不变；本轮没有声称它们都通过。

浏览器覆盖多轮消息/去重、审批允许/拒绝、沙箱拒绝、取消、SSE断线重连、会话隔离、真实验证 exit 7 不得完成、主题与390×844移动端。
生产场景使用真实 Harness/Gateway/WebServer/权限/沙箱/TaskVerifier 和 scripted provider；受控协议竞态单独标记。真实模型质量未执行，付费请求为0。
最终源码整个验收期间保持干净，浏览器 source/dist/static 指纹不变、服务正常退出；Linux child subreaper只补容器 PID 1 缺少的正常孤儿回收，不修改进程杀停或存活断言。

主 [CI 37630733777](https://github.com/ki11a-Conton/harness-agent/actions/runs/37630733777) 的 Ubuntu/Windows verify、两个 formal、两个 R97/R98、cold-start、coverage、dual-platform acceptance、release attestation 全部成功。
真实 Windows [专项 37630733658](https://github.com/ki11a-Conton/harness-agent/actions/runs/37630733658) 为 Windows_NT 10.0.26100 / x64，源码与 workflow SHA 相同，全部指定真实子/孙进程、shim、cwd、CJK路径与非法字符用例没有跳过。

## Windows 原始失败与证据复查

原 run `37615393968` / Windows formal job `112772385624` 的原 artifact 由官方 download-artifact 在 GitHub runner 上取回；forensics run `37626033845` 成功。
原命令 pair/arms/typecheck 为0，test为1；原唯一失败是 `n2-release-cli-forward.test.ts:86` 的 afterEach **Hook timed out in 10000ms**。
[原命令与失败片段](raw/round2-original-formal-failure.json)、[公开压缩 packet](raw/round2-forensics-annotations.json)和[job元数据](raw/round2-forensics-jobs.json)保存。
原 test.log 的320114 bytes与SHA由取证runner记录；这里只取得实际失败片段并核对摘要，未宣称下载了整份旧日志或ZIP。
首次 `1360479` 的 formal因变异锚点失败时，发布证明正确 skipped；[那次run](raw/round2-product-run-final.json)及[Windows失败断言](raw/round2-product-formal-windows-annotations.json)保留。

所有实际本地归档文件的 bytes/SHA256 在 [RAW-MANIFEST.json](RAW-MANIFEST.json)，[acceptance-summary.json](acceptance-summary.json)附各模块真实测试数量。
无需网络或token，从仓库根目录复核：

```bash
python3 docs/evidence/source-audit-round2-20261007/raw/verify-evidence.py
```

校验器核对文件摘要、完整Linux终态/SHA/退出码、浏览器身份、Windows公开packet无损解码与12项实际状态、所有CI job同源码成功，以及原失败片段与变异报告。
实际正例 PASS；[三个反例](raw/verifier-controls.json)（改动原内容、缺公开packet、错源码）全部拒绝，后两项在同时更新归档索引后仍拒绝。
本地代理拒绝 Azure blob 直接下载：原生Windows Vitest JSON和artifact ZIP摘要只作为runner/GitHub元数据，不声称独立比对了下载原件；公开全部逐项packet已真实取得并核对原内容SHA。

## N7 原件、结论与后续使用

冻结的 N7 execution/main 文件、原 plan.md、门限和 champion 未改；[原件保持校验](raw/round2-frozen-input-preservation.json)与[代码diff](raw/source-repairs.patch.gz)可复查。
N7说明错误以[N7-ERRATA-20261007.md](../agent-next7-20261006/N7-ERRATA-20261007.md)和机器汇总勘误：255定案为143→145，完整256为143→146；9171 committed、9169 journal记录，两条异常不能视为同一终态。原账本不重写。

旧付费归档约460MB、9701份raw tape/journal没有发布到当前仓库，历史严格复算仍需这些原件与记录SHA匹配的构建。新增完整移交与历史检出正例是合成工程验收，不能替代旧付费证据。
当前源码复现了32k计量故障类别，不将其单独当成旧请求的完整因果解释；用户原 **NOT_PROVEN**、未holdout、未promotion结论不变。
后续新实验应按新源码重新绑定身份，采用覆盖实际64k输入/32k输出（合计96k）的价格声明；旧64k声明会在发送前被拒绝，累计授权上限没有提高。
本轮工程通过不代表模型能力达到Codex/Claude Code，也不能证明不存在未知bug。
