# Coding 工具改进验收记录

本地基线为干净的 `7a596f058d4f7df28cbc39bc1740b725916e00d5`。候选是在该版本之上的未提交工作树；[candidate-source.json](candidate-source.json) 保存实际产品、测试、脚本和 CI 文件的字节哈希，不把基线 SHA 冒充新代码的提交。远端提交后的 CI 使用精确 head SHA，结果以 Actions 记录为准。

## 可复查原件

- [参考源码清单](sources.json)：固定快照、文件、许可证和应用范围。
- [旧版反例](baseline-probe.json)：批量接口不支持且未写入；根代码图到达 500 文件上限而漏掉目标。
- [真实 CLI/Web A/B 回执](http-paired/result.json)：四组独立项目/状态目录、同一脚本 HTTP provider 和验证命令；工具调用 8→4，编辑调用 3→1，同一最终文件和独立测试通过。
- [运行详情](http-paired/runs.json)：真实工具参数、审批计数、CLI 输出、独立测试和 Git diff。原始 provider 请求与 Web 事件使用同目录下的 `.json.gz` 保存，解压后为原始 JSON。
- [各组本地测试的原始计数](local-checks.json)；完整 Vitest JSON、全量日志在 [raw](raw) 下，以 gzip 压缩保存。该计数只描述对应报告，不将重叠的测试组加总为不同用例。
- [最终聚焦回归](final-focused.json)：43 项新增回归通过，包含真实 Runtime 失败恢复；[类型检查](logs/typecheck-final.log)、[安全测试](logs/security.log)、[旧接口/策略兼容](logs/compatibility.log)、[既有30查询回归所在测试组](logs/tool-regressions.log)、[Windows 回执解析器](logs/windows-parser.log)。
- [文件清单及 SHA-256](inventory.json)：覆盖证据文件；本清单不包含自身。

最终本地全量在干净提交 `86cde6ff5c26c956b49dd3835eae0a5120c2fa24` 上通过：10018通过、0失败、16平台条件跳过。起止HEAD相同，起止工作树均干净。归档提交只补充文档和证据，14份产品/测试/脚本文件的哈希与该已测提交一致。

本地完整命令为 `pnpm test --maxWorkers=2 --reporter=default --reporter=json --outputFile=<工作区缓存>/full.json`，未额外删减 package.json 定义的测试范围；限制并发用于当前 8 GiB 环境。干净提交后的最终执行起止状态与退出码见 [full-execution.json](full-execution.json)，完整结果以 `local-checks.json` 中的 `full` 及对应原件为准。

## 保留的开发失败

1. `development-failures/http-fixture-prefix`：第一版验收夹具错误地假定成功工具输出带 `[success]`，真实 Runtime 输出是裸 JSON。实际 HTTP 请求暴露了错误；修正夹具后重跑四组，不改 Runtime 输出语义。
2. [path-space-before.log](logs/path-space-before.log)：新增 `queryPath` 的 schema 原先 trim 路径，`" target"` 被错误变为 `"target"`。负例先失败，修复后包含在最终 43 项回归中。
3. `development-failures/interrupted-full`：发现上项问题后主动停止修正前的全量运行，退出码 130。保留原始记录；它不是最终全量通过证据。

4. `development-failures/dirty-full`：首次完整全量10011通过、7失败、16跳过。生产评测要求干净提交；未提交工作树及运行期间归档变化使这些前置条件不满足。保留全部报告、退出码和失败断言，不删减门禁。先固定本地提交，再在不改任何文件的工作树中重跑。

最终四组 A/B 在路径修正并重新构建后运行。付费模型调用为 0；`realModelQuality: NOT_PROVEN`。这里证明脚本选定行动的实际接口、执行、验证和调用效率，不证明真实模型能自主选择同样的行动。

## 重跑

```sh
pnpm install --frozen-lockfile
pnpm typecheck
node scripts/research/coding-tools-20261019/acceptance.mjs .ci/coding-tools /path/to/clean-built-baseline
```

第三个位置参数为可选的已构建基线 checkout；省略时仅验证当前版本真实 CLI/Web 的新 schema 和执行链，CI 使用此方式。运行目录必须有足够的临时空间；可通过 `TMPDIR` 指向工作区内目录。脚本本地启动 HTTP provider，不需要真实模型密钥。

## Windows CI后续修复

第一次远端主CI未通过：连续模型切换的后续派生owner端口冲突。完整记录、测试专用准备修复和新增6项回归见[Windows跟进](windows-fixture-followup/README.md)。前三类专项当次通过；最终交付以修复提交的完整CI为准。

后续106c9e64的Windows formal完整测试又暴露公共初始子owner同类冲突；统一准备修复、额外真实回归和原断言保留审查见[初始owner跟进](windows-initial-fixture-followup/README.md)。最终新SHA结果以交付报告为准，两次远端失败均保留。
