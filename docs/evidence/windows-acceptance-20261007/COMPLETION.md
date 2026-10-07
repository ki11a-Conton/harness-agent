# 真实 Windows 验收 — 2026-10-07

真实 Windows 执行与功能回归验收 **PASS**。代码验收提交为
`0cf4549f4f040b8abc983cafc4fcac4805041dab`；本目录归档的是该提交的执行证据。
后续文档和证据归档提交与此提交分开，不将尚未测试的新源码归入已通过结果。

该版本可以配置真实模型后作为编程 agent 使用：读取和修改代码、执行命令、
任务验证、权限审批、取消、会话恢复及 Web 多轮消息都有生产路径验收。
连续交互建议使用 Web；CLI `run <cwd> <text>` 执行单个任务，`resume` 显示会话状态。
本次修正了两个 README 的 CLI 示例，以及 Web 持久化恢复的过时说明。

这些工程验收不证明模型编码质量达到 Codex / Claude Code 的水平。
用户另行归档的 N7 付费主实验结论为 `NOT_PROVEN`，holdout 未执行，候选未 promotion；
原件和用户新增提交已保留，未改冻结输入、结果或判定门限，也未启动付费请求。

| 验收范围 | 结果 | 证据 |
| --- | --- | --- |
| 真正 Windows 专项，13 文件 | **179 passed / 0 failed / 1 skipped** | [逐项结果](raw/final-native-receipt.json)、[公开检查原件](raw/final-native-annotations.json) |
| 原有 Windows 专属进程用例 | **10 / 10 执行并通过** | receipt 的 `required` 与逐项记录 |
| 新增真实父进程与孙进程取消／超时完成用例 | **2 / 2 执行并通过** | `windows-cancellation.regressions.test.ts`，真实 PID 与禁止越界标记写入 |
| Windows 标准 frozen install / typecheck / 全量 unit+integration / build / strict usage audit | **PASS**，同一源码 SHA | 主 CI `37611869402` 的 Windows job `112761081708`，原始 steps 元数据 |
| 本地 Linux 全仓 | **9,032 passed / 0 failed / 14 skipped**，495 文件 | [完整 JSON](raw/final-local-full-tests.json.gz)、[日志](raw/final-local-full-tests.log.gz)、[源 SHA 与真实退出码](raw/final-local-full-subreaper-receipt.json) |
| 本地安全回归 | **2,135 passed / 0 failed**，19 文件 | [JSON](raw/final-security.json.gz)、[日志](raw/final-security.log.gz) |
| Web durable outcome 修复专项 | **6 passed / 0 failed** | [JSON](raw/local-terminal-barrier.json.gz) |
| 进程生命周期宿主复核 | **89 passed / 0 failed** | [JSON](raw/local-process-lifecycle-subreaper.json.gz)、[宿主回执](raw/local-process-lifecycle-subreaper-receipt.json) |
| 验收报告解析器 | **4 / 4 PASS**，Windows workflow 内执行 | [workflow job 原件](raw/final-native-jobs.json) |
| 公开证据独立校验器 | 正例通过，6 个篡改／缺失反例拒绝 | [回执](raw/receipt-verification.json)、[反例结果](raw/receipt-verifier-controls.json) |
| 文档真实性检查 | **ALL CHECKS PASS** | [日志](raw/final-docs-verify.log.gz) |

## Windows 实测及修复

最初主 CI `37597081529` 在 `b94ded5424bc1b7b32550ff07f2df3714de23f20`
上真实复现了四项失败，原始 [检查注释](raw/windows-failure-annotations.json) 与
[job 元数据](raw/initial-ci-jobs.json) 已归档。

1. **进程树停止后过早返回。** Windows 的 `taskkill /t /f` 原先启动即返回，
   verification 已报告取消时，孙进程仍可能写文件。现在 executor 等待真实 taskkill
   结束，抑制终止期间的 close/error 抢先完成；终止失败或超时明确报错。
   取消和超时分别检查真实 parent/child PID 在返回边界已不存在，随后释放写入标记，
   确认没有存活后代继续写入。shell、argv、PowerShell 和 sandbox 路径共用此处理。
2. **作用域测试只识别 `/`。** 并发作用域的真实文件读取断言同时识别 Windows 的
   `\`，仍检查实际访问与缓存隔离；没有放宽产品作用域边界。
3. **NTFS 打开目录的 rename 行为不同。** 父目录替换测试原先在失败的 rename
   之前就标记替换成功。现在只接受真实 Windows 的特定原生错误，并检查失败捕获
   被丢弃、原文件保持完整和后续真实重新发现；POSIX 的真实替换断言保持有效。
4. **Web 停止验收读取了中间持久化状态。** 只看到 `Turn.status=cancelled`
   时，terminal event 和持久化 fence 尚可能未完成。Windows 后续诊断专项
   `37611380915` 的 178 passed / 1 failed 原件已保留。现在通过真实 HTTP 停止后
   等待该 actor 的 `activeTurn.outcome`，再检查持久化状态、唯一终止事件、发送者
   隔离及 inbox 消费。保留有界超时和失败诊断，不改 Runtime 取消策略。

代码修复提交：`3ddccafa7319abb4ccd68dfae1dcc9b06e58058c`、
`c01818f21826b897492dd376200577fc8a7fb5b5`、
`0cf4549f4f040b8abc983cafc4fcac4805041dab`。
[限定路径修复 diff](raw/windows-repairs.patch.gz) 可与 Git 历史复核。
合并提交 `1db2b71e08a6e8325267c235b30c57e265b980c5` 保留了用户期间新增的 N7 归档。

## 原生 runner 与证据复查

专项 [GitHub run 37611869373](https://github.com/ki11a-Conton/harness-agent/actions/runs/37611869373)
的 [job 112760760987](https://github.com/ki11a-Conton/harness-agent/actions/runs/37611869373/job/112760760987)
使用 GitHub-hosted `windows-latest`，实际宿主为 `Windows_NT 10.0.26100` / x64，
Node `v22.23.3`，不是 Wine、模拟 `process.platform` 或 Linux 结果。
receipt 的 source/workflow SHA 一致，源码工作树干净，run attempt 为 1。
唯一 skip 是 POSIX `chmod` 权限位用例；全部 12 项指定原生用例均为 passed。

公开 annotation 中的 4 个 `gzip+base64` packet 保留全部 13 文件、180 项最终状态。
本地独立解码校验后的 `caseRecordsSha256` 为
`a957f1322fec362b88412bf5987112442c61c8ac3f8a67b808f89b15060bfa7b`。
归档的 `final-native-receipt.json` 与公开 packet 完全一致。

从仓库根目录可离线复核，无需 token：

```bash
python3 docs/evidence/windows-acceptance-20261007/raw/verify-receipt.py
```

校验器检查 packet 完整性、原始内容 SHA-256、runner/run/source 身份、通过／失败／
跳过计数、12 项原生用例实际状态，以及归档副本一致性。缺块、重复块、外来 SHA、
错计数、要求用例跳过和改动归档副本均会返回非零。

GitHub artifact `11477458848` 的元数据摘要为
`sha256:a524d78b828fe2f380cfdda9efdb5f964ff7dcea5e64027be37d2cd705cda763`。
原始 Vitest JSON 的 runner 记录摘要为
`0831a057d509296ae55a50fdbb674da9ce74c576040e1ff3582773d523cde774`，65,804 bytes。
当前工作区代理拒绝 Azure blob 的直接下载，因此未下载该 ZIP 和云端原始文本日志，
这两个原件摘要仅是 GitHub／runner 元数据记录，**不声明独立比对过下载原件**。
完整逐项最终状态的公开 packet 则已实际取得、无损解码并验证摘要。
本目录 `RAW-MANIFEST.json` 校验的是实际归档的本地文件 bytes，和云端 ZIP 摘要分开。

## 全量 CI、宿主条件与模型结论

主 [CI 37611869402](https://github.com/ki11a-Conton/harness-agent/actions/runs/37611869402)
同样绑定 `0cf4549f4f040b8abc983cafc4fcac4805041dab`，最终 **10 / 10 jobs SUCCESS**。
Ubuntu / Windows 主 verify（包括重复执行的真实 release gates）、Ubuntu / Windows
formal 离线链、Ubuntu / Windows R97/R98 闭环、Ubuntu cold-start、coverage、
dual-platform acceptance 和 release attestation 均通过。
最终 [run 元数据](raw/final-ci-run.json)、[逐 job / step 元数据](raw/final-ci-jobs.json)
和 [artifact 元数据](raw/final-ci-artifacts.json) 已归档。
这里的 attestation 是工程发布证据校验通过，不代表付费模型实验或策略 promotion。

本地 14 个 skip：12 个 Windows 专属用例由上述 Windows 专项实际补验，另两个为
N2 离线内容路径迁移用例与历史对象不在当前 checkout 的 N5 自证，详见
[逐项 skip 清单](raw/final-local-skipped-tests.json)。不将 skip 算作通过。

本地容器的 PID 1 未回收孤儿进程：两个生命周期测试看到已退出的 `Z (zombie)`
进程，因 `process.kill(pid, 0)` 仍成功而误判存活。
[宿主诊断](raw/linux-zombie-diagnosis.json) 记录了 `State=Z`、`PPid=1`。
使用真实 Linux child subreaper 提供正常 init 回收后，相同 89 项检查全部通过，
全仓验收也以 9,032 passed / 0 failed / 14 skipped 退出成功。
未修改测试、产品杀进程逻辑或模拟存活探测。
[宿主启动脚本](raw/run-with-subreaper.py) 保留真实子进程退出码，并检查整个测试期间
HEAD 未变。此设置只说明 Linux 宿主条件，不能作为 Windows 证据。

`local-full-tests.*.gz` 是较早一次无效验收的诊断原件：运行期间 HEAD 曾改变，
source 绑定检查正确拒绝，且当时尚未补上容器正常回收。它不是最终 PASS 证据。
最终验收文件名均以 `final-local-full-tests` 开头；整个最终运行 source 不变，exit 0。

实际模型任务需配置有效 `OPENAI_API_KEY`、对应 `OPENAI_BASE_URL` / `OPENAI_MODEL`；
未配置模型时页面可打开，但不能完成真实编码任务。Windows 执行可用不代表 Windows
已提供 OS 级进程隔离，也不代表模型策略合格或 release/promotion 自动成立。
付费实验结论以用户归档的 [N7 真实结果](../agent-next7-20261006/N7-RESULT-20261007.md)
为准；本轮工程验收不覆盖它的基础设施与模型质量问题。
