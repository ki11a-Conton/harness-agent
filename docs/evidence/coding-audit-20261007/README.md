# Coding 全面审查完成报告（2026-10-07）

本轮修复 7 类影响编程任务的产品问题，以及 1 类浏览器验收基础设施问题；逐项触发条件、影响、修法、验收见 [BUGS.md](BUGS.md)。CLI 和 Web 已实测完成读取代码、审批编辑、运行测试、收到失败诊断、继续修复、独立测试通过的完整链路。所有工具副作用继续经过 Orchestrator、权限、沙箱和验证。

产品和验收脚本的固定源码为 `a19fcabf7bd2ef186574227cf7676f26275aed08`，审查基线为 `33eb6438130956be51706bb523071f7550ba83ab`。后续提交只加入报告和证据；验收结果属于记录的源码 SHA，不能把另一源码的结果冒充本次验收。执行计划见 [tasks/CODING-AUDIT-20261007.md](../../../tasks/CODING-AUDIT-20261007.md)。原工作区未提交的 plan.md 和 NEXT8 文件保持原样。

## 验收结果

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| 基线反例（独立 checkout、重新安装构建） | 36 passed / 10 failed；失败用例在修复源码全量报告中逐一通过 | raw/baseline-red.json.gz、baseline-build.log |
| 固定最终源码全仓 unit/integration，开启 N2 真实 release CLI | 502 个测试文件；9081 passed / 0 failed / 13 skipped | raw/full-suite.json.gz、full-suite.log、subreaper-run-receipt.json |
| 安全与协议独立门禁 | 安全 2135 passed；协议 52 passed；均 0 failed | raw/security.json.gz、protocol.json.gz |
| 实际 CLI + 生产 Web HTTP/SSE 编程闭环 | Linux 50 条断言；真实文件、进程、Git diff、审批、失败修复、取消、重启与后续回合 | coding/result.json、requests.json、runs.json、web-frames.json、episode/ |
| 真实 Chromium UI 验收 | 27 场景、77 断言通过；0 浏览器错误；正常退出、源码未变 | browser/browser-result.json、HTTP 原件、截图、runtime-snapshot.json |
| 原生 Windows | 16 文件、226 passed / 0 failed / 1 POSIX skip；12 条必须原生执行的 Windows 用例全通过；实际 CLI/Web 49 条断言通过 | raw/windows-receipt.json、windows-case-records.json、windows-coding.json、windows-annotations.json |
| 207 个 tracked mjs 语法检查 | 0 errors | raw/script-syntax.json |
| 冻结锁文件依赖审计 | 0 已知漏洞 | raw/history/dependencies.json |
| docs:verify、构建/类型检查 | 通过；全量 pnpm test 先执行 tsc -b | raw/docs-verify.log、full-suite.log |
| 最终源码发布 CI | 10 个 job 全部 success；包含双系统 verify、coverage、formal、闭环、双平台汇总及发布 attestation | raw/source-ci-run.json、source-ci-jobs.json |

原生 Windows：[Actions 37656880356](https://github.com/ki11a-Conton/harness-agent/actions/runs/37656880356)。最终源码完整 CI：[Actions 37656880282](https://github.com/ki11a-Conton/harness-agent/actions/runs/37656880282)。Windows receipt 与全部 case records 从该 job 的官方 Checks annotations 无损解压，包 SHA 与 receipt 核对；保留 run/job/annotation 原件，不把 POSIX 参数化测试称为真实 Windows。

Linux 的 13 条 skip 为 12 条仅能在真实 Windows 执行的用例（上述 Windows run 均通过），以及 1 条需要缺失历史 Git 对象的旧 baseline 字节复现。Windows 的 1 条 skip 是 POSIX shell 用例；编程验收另明确跳过 POSIX SIGINT 实验，Windows 的实际子进程树取消/超时另有原生通过证据。perf、soak、历史刻意失败的 forensic/研究入口遵循原仓现有默认测试范围，不将它们计作本轮通过。

## 原件与离线复核

`RAW-MANIFEST.json` 列出包内每个文件的字节数与 SHA-256。JSON.gz 为原 JSON 的无损压缩；full suite 保留框架最终状态，不能用中途 stdout 的 passed 累加代替。`raw/product-source-files.json` 记录产品、测试、脚本和 CI 的 canonical Git blob 摘要，不受 Windows 换行转换影响。包内 .gitattributes 保持所有原件字节；另对暂存内容执行 core.autocrlf=true 的 Git checkout 字节对照。

在仓库根执行：

```sh
python3 docs/evidence/coding-audit-20261007/raw/verify-evidence.py docs/evidence/coding-audit-20261007 --repo .
```

复核字节清单、基线失败全部转绿、完整测试状态、固定源码、Windows 必须用例及包一致性、实际编程验收、浏览器和 10-job CI。`raw/evidence-negative-controls.json` 记录三种篡改均被拒绝：文件字节改变、重新计算摘要后仍带失败的测试报告、伪造 Windows 源码身份。复核不联网、不调用模型。

`raw/history/` 保留失败原件：最初 fixture 类型接口不匹配（后修正再跑实际基线）、文件变更清单和模型身份失败、thinking 历史缺字段、首次修复引入的两条安全日志回归、主动中止的初次全量运行，以及旧的三条“诊断应不可见”断言。产品修复源码 a53 的先前全量通过报告也单独保存，不替代最终 a19 的重跑。三条断言按本轮可诊断修复目标更新，仍检查输出不变、脱敏、注入边界、完整工具协议和独立验证；没有改写冻结实验、champion 或门限。中止运行 exit 130 明确保留，不计作完成。浏览器空 ready.json 的失败原件及草稿修复结果也保留；草稿 dirty/75 断言不能替代最终 clean/77 断言。

## 如何使用

配置真实 OpenAI-compatible provider 的 `OPENAI_API_KEY`、`OPENAI_MODEL` 和需要时的 `OPENAI_BASE_URL`，安装并构建后：

```sh
node apps/cli/dist/main.js run "/项目目录" "修复失败测试" --verify "npm test" --data-dir "/会话数据目录"
```

每项待审批操作输入 `allow` 或 `deny`；EOF 拒绝写入，Ctrl-C 取消回合。成功验收才显示 `grade: verified_complete`；不配置验证时显示 unverified。Web 在项目目录启动，并配置 `HARNESS_VERIFY_COMMAND`（例如 `npm test`）、`HARNESS_DATA_DIR` 和上述模型设置；审批按钮使用现有后端协议。

编程闭环使用明确标记的 scripted 本地 HTTP provider；文件修改、权限、沙箱、进程、测试、Web 重启和 UI 操作是真实执行，付费模型调用为 0。这证明工程链可运行，不能证明任意模型能解决任意 coding 任务或已经达到 Codex/Claude Code 的模型质量。付费模型效果实验由用户本地运行；冻结 N7 的 NOT_PROVEN 结论和缺失旧原件的边界保持原记录。本次审查列出全部已确认问题，不承诺任何未来输入都不存在 bug。
