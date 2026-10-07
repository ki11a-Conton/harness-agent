# 2026-10-07 源码审查问题修复与验收

审查基线为 `7203a01bf83e8ebe25e0971bb65a7bdeac6d9311`。原[审查报告](../../reviews/source-audit-20261007/README.md)和 46 项哈希清单保持原字节；本轮修复 B01–B21、两项依赖公告 B22/B23、文档问题 D01/D02，并补齐验收工具的兼容修正。没有重写 plan.md，没有修改候选策略文本、冻结用例或质量门限。

全仓验收源码：`e40ba599293076c123132a8635b65ae9fa29ba8a`，启动时工作区干净。后续 `503b706` 只修正可选测试入口、浏览器夹具和说明，Runtime、Agent、Web 产品源码及依赖字节均保持一致，见[源码比较回执](evidence/delivery-source-comparison.json)。全量结果属于 e40ba59；后续工具入口另行重跑，未把旧结果重新标成新 SHA。

## 修复对应表

| 问题 | 实现与通过的验收 |
| --- | --- |
| B01 | scoped context 按实际条目扣减预算，跨分组不超额；20 条上限反例转绿。 |
| B02 | goal/constraints 完整保留且不可压缩；预算不足显式 RESOURCE_LIMIT，不截断或静默遗漏。 |
| B03 | 新文件携带“基线不存在”信息，检测父方新增冲突并以独占创建封住新增写入竞争。 |
| B04 | UTF-8 无损或 base64 字节传输；写入前校验编码、字节预算和内容 SHA256；二进制往返、篡改不落盘通过。 |
| B05 | 复制/补丁保留普通权限位，检测 chmod-only 修改及父方模式冲突；POSIX 实测通过。 |
| B06 | 仅成功 child 合并物理补丁，文件元数据只采用实际 applied 列表；冲突/跳过不能伪造 filesChanged。 |
| B07 | MemSessionStore 落实 parentId/status 查询过滤。 |
| B08 | scheduler 完成所有维度的准入后才扣预留；拒绝路径不漏工具额度。 |
| B09 | child 绑定、工作区准入、context seed、started 发射共用初始化清理；注入 seed 失败后无槽位、工作区或准入泄漏。 |
| B10 | testsRun 采用对应 toolCallId 的真实成功/失败事件和引用；失败 npm test 不再报 passed，未观测结果为未通过。 |
| B11 | MCP 参数按 required 集合设置 optional；省略可选字段合法，缺必填字段拒绝。 |
| B12 | MCP integer、有限数值、上下界、独占边界及 multipleOf 校验生效。 |
| B13 | N7 每个完成 arm 后写 checkpoint；重启验证身份、日志及现有账本后封存 abandoned attempt，开启新 attempt 续跑。真实 SIGKILL 测试证明不重置预算；unknown 不退款/重发，篡改先拒绝。 |
| B14 | Web 校验 Host、Origin、Sec-Fetch-Site 及 application/json；非可信 Host/跨站返回 403，错误媒体类型返回 415。可信代理须显式配置。 |
| B15 | 原子保存 Web sender→session 绑定；启动验证后恢复 Gateway 的 sender 归属、审批和取消入口。生产进程重启后的历史和后续消息保持同一 session，跨发送者审批仍拒绝。 |
| B16 | Runtime 验证命令经过注册 exec、ToolOrchestrator、冻结工具策略、PermissionEngine、SandboxManager、intent、工具预算与期限；argv 不经 shell；exec-deny、只读、强隔离、额度、期限分别拒绝，无越界文件。 |
| B17 | 审批先 fsync/原子落盘，再发布决定/释放等待者；真实落盘失败保留 pending 且不释放 allow，重试成功有持久记录。 |
| B18 | JSONL/SQLite 按可信仓库/工作区 identity 分目录；不同仓库隔离、同 origin 的 checkout 复用、显式 global 共享均通过。 |
| B19 | VerificationContext 传递同一 signal，ProcessExecutor 启动前及运行中响应取消；真实进程被回收，无取消后写入、无 verification.completed，单一 cancelled 终态。 |
| B20 | execution digest 只绑定实际激活机制；OFF 候选不移动 baseline。legacyDigest 校验原有 v1 冻结输入，新 N7 execution facts 标明 active-mechanisms-v2，旧身份/结果不回写。 |
| B21 | 内存 store 保存并 clone 冻结快照；child 仅允许 read_file 时 exec dispatch 为 0，外部修改快照不改变策略。 |
| B22 | Vitest/coverage/mocker 对齐 4.1.11；GHSA-82fw-gwwq-j7x9 不再命中。 |
| B23 | pnpm 11 workspace override 固定 source-map-js 1.2.2；GHSA-68fv-2mgg-jv7q 不再命中。 |
| D01 | 修正 P 入口的 ../plan 链接；6 个已移除的历史计划改指实际 Git blob。26 个本地任务链接均存在，6 个历史目标已用 git cat-file 验证。 |
| D02 | 三项 whole-file unchanged 更正为 false，附 baseline hash/范围和更正回执；更正前完整验收包原样归档，历史测试不归因到新源码，包内清单重新校验。 |
| 额外验收入口 | test:perf/test:soak 使用 Vitest 可识别的文件过滤；旧命令实际选中 0 项的失败结果保留。浏览器宿主显式授权固定 Node 验证程序及自有回连代理，文件审批仍由真实 UI 决定。 |

## 验收结果与证据

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 21 个安全行为反例，旧版独立构建 | 21 项失败，符合红色对照；B13 新 checkpoint 模块不存在，另有原审查对旧 verifyIndex 拒绝恢复的实测 | [red](evidence/red/) |
| 同样的反例，修复后 Runtime/文件/生产 Web | 21/21 PASS，含真实 Web 双进程重启 | [acceptance](evidence/final-acceptance/) |
| 全仓标准测试 | 494 文件；9,030 PASS / 0 FAIL / 12 SKIP；新增 40 项回归全部通过 | [原始 JSON](evidence/final-full-tests.json.gz) |
| typecheck 与 frozen-lock install | PASS | [typecheck](evidence/delivery-typecheck.log)、[install](evidence/delivery-frozen-install.log) |
| R97，真实历史 arm 各自构建 | 77/77 PASS，未将缺 arm 当作通过 | [R97](evidence/final-r97-tests.json) |
| N2 可选发布入口，显式启用 | 1/1 PASS，20 次真实离线 arm；正向使用原冻结 CSV oracle | [N2](evidence/final-n2-tests.json) |
| SIGKILL 恢复/unknown/篡改 | 3/3 PASS；0 模型调用、0 付费，账本操作和 journal 标明离线故障注入 | [recovery](evidence/final-acceptance/recovery-acceptance-results.json) |
| Chromium，官方浏览器入口 | 27/27 场景、77 断言；0 browser errors，含实际审批、取消、重连、桌面/手机；控制协议场景单独标注 | [结果](evidence/official-browser/browser-result.json)、[截图](evidence/official-browser/desktop-chat.png) |
| 可选性能/压力入口，修正后实际执行 | 5/5 PASS；50,000 次事件追加 1/1 PASS | [perf](evidence/repaired-perf-tests.json)、[soak](evidence/repaired-soak-tests.json) |
| 依赖 audit | 0 vulnerabilities | [audit](evidence/final-dependency-audit.json) |
| coverage 初始化 smoke | 32/32 PASS；针对 TaskVerifier 的 v8 coverage 正常初始化；不是全仓 coverage 门限验收 | [coverage](evidence/delivery-coverage-tests.json) |
| docs:verify、N7/P 四份冻结规格 | PASS，未重新冻结输入 | [docs](evidence/delivery-docs-verify.log)、[N7 main](evidence/final-n7-main-freeze.log) |
| N7 主/holdout dry wiring | 512 arms/256 pairs；192 arms/96 pairs；0 付费，效果/晋升 NOT_RUN | [主](evidence/final-n7-main-dry/dry-run.json)、[holdout](evidence/final-n7-holdout-dry/dry-run.json) |

12 个标准跳过包括 10 个真实 Windows 进程场景、1 个 N2 opt-in（上表已单独通过）、1 个“历史对象不存在”条件分支（对象实际存在，正向字节证明通过）。本环境未运行真实 Windows，也未运行付费模型质量实验。

## 兼容行为与边界

- 独立调用 TaskVerifier 的宿主须显式提供可信 executor；Runtime 始终优先使用受授权的 executeCommand。原 primitive oracle 测试据此更新，Runtime 拒绝测试保持生效。
- 旧离线 HTTP oracle 使用 loopback 仍属于 network intent；禁网策略下现在明确失败。原用例字节保持不变并有拒绝回归；内置离线脚本升级为 offline-scripted-task-v2，以既有 CSV 用例证明正向发布链路，没有放宽网络规则或质量阈值。
- 新记忆位于 `<dataDir 或 memory.dbPath>/memory-scopes/repository-<id>`、`workspace-<id>` 或显式 `global`。旧根目录未标明归属的记忆文件保持原样，不自动注入任何仓库。历史迁移必须先确认文件所有权，再按目标 identity 导入；同一 origin URL 的 checkout 可复用新目录。
- N7 崩溃恢复适用于本版本写出的 checkpoint，且必须保持绑定源码/策略/日志/预算身份。无 checkpoint 的旧未封存包、checkpoint 后未经确认的 dispatch、unknown 账目或真正身份漂移继续拒绝，不自动补证、重置额度或冒用旧结果。
- Web 代理使用 HARNESS_WEB_ALLOWED_HOSTS（准确 host:port）及必要的 HARNESS_WEB_ALLOWED_ORIGINS 显式配置。损坏或引用不存在 session 的绑定不会启动成“新空会话”。
- 历史审查、首次未提交源码验收失败、最初 HTTP 正向 fixture 失败、测试入口 0 项及浏览器权限规则冲突均保留在 diagnostics，最终通过结果另存，未覆盖旧观察。

## 提交与复跑

模块提交：6286be3（审查与历史更正）、402da57（agent/工作区）、9ea3b55（验证/审批）、6fe34b2（Web/MCP/记忆）、b39cb1c（实验身份/恢复）、3b4b701（依赖）、e40ba59（回归）、503b706（验收入口）。交付证据随后以 docs commit 附加，不改变已验收的产品代码。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
N2_RUN_RELEASE_E2E=1 corepack pnpm exec vitest run apps/cli/src/n2-release-cli-forward.test.ts
corepack pnpm test:perf
corepack pnpm test:soak
python3 scripts/research/web-dsh-20261004/browser.py --mode candidate --require-clean --out .ci/browser-repeat
```

R97 额外验收需先按原仓库脚本分别准备冻结 arm 构建，再设置 R97_ARM_BASELINE_DIR/R97_ARM_CANDIDATE_DIR，不能以缺条件跳过代替通过。所有结果由 [manifest.json](manifest.json) 的 SHA256 清单绑定；全仓验收的精确源码清单为 [validated-source.json](evidence/validated-source.json)。
