# Coding agent 研究：证据与复跑

执行日期 2026-10-15。Harness 基线 `2a141309f01acae3707060faf1fab8aa247ed31d`；研究工件在独立研究分支，本轮没有产品代码修改、真实模型调用或 release 操作。

## 实际结果

| 项目 | 结果 | 原件 |
| --- | --- | --- |
| 固定来源复核 | 5 个 Git 仓库、71 个文件，工作字节/固定 Git 对象/哈希一致 | [sources.json](sources.json)、[sources.md](sources.md)、[source-verification.json](source-verification.json) |
| 生产 provider loopback 观察 | 4 场景完成；命中 128、DeepSeek 命中/未命中、明确 0 三种明细被丢弃；无明细控制通过 | [probe.json](probe.json)、[probe.log](probe.log) |
| 生产 SDK 策略组合 | legacy/v1 各实际运行一 turn、读取真实请求；共 12 原生工具 + ask_user，无默认 test-profile memory store | 同上 |
| 基线构建 | `pnpm typecheck` 通过 | [baseline-build.log](baseline-build.log) |
| 相关既有回归 | 6 文件、89 PASS、0 FAIL、0 SKIP | [摘要](baseline-tests-summary.json)、[Vitest 原件](baseline-tests.json)、[日志](baseline-tests.log) |
| 文档门 | 14 checks 全部 truthful，ok=true；真实 CLI 返回 0 | [JSON](docs-verify.json)、[CLI 输出](docs-verify.log) |
| 研究脚本与链接复核 | JS 语法检查、来源复核、研究文档本地链接和引用一致 | [review.json](review.json) |

探针的 `execution=PASS` 只表示观察执行完成；其中 `OBSERVED_GAP` 是待修复缺口，不能解释为功能通过。缓存值 `null` 在该研究 JSON 中表示未观察到字段，不是 0。正例及负例都是预先提供的合成 usage，不能推导真实缓存比例、时延或费用。

没有进行 paid eval、真实 DeepSeek/其他模型测试、Windows、此次全仓回归或 IDE 验收；它们不能被既有 89 项测试替代。没有基于本轮研究宣布“生产级”或“达到 Codex/Claude Code 水平”。后续项目状态见 [计划](../../../plan(20261015-104912).md)。

## 复跑

需要 Node 24、Python 3、Git、pnpm 及固定参考检出。`verify-sources.py` 支持重复 `--root ID=/path`，五个 ID 为 harness、collection、deepseek、zcode、aider；默认目录见 sources.json。此命令不访问网络。

```sh
python scripts/research/coding-agent-research-20261015/verify-sources.py
node --check scripts/research/coding-agent-research-20261015/probe.mjs
```

生产模块使用另一个**干净且 HEAD 恰为基线 SHA**的构建 worktree，防止误测已变化的代码。本次使用 `/workspace/harness-agent-pr-review-20261014`，重新执行构建返回 0；关键代码与研究 worktree 逐字节比对。移到其他机器时替换路径。

```sh
git worktree add --detach /tmp/harness-coding-research-baseline 2a141309f01acae3707060faf1fab8aa247ed31d
cd /tmp/harness-coding-research-baseline
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run packages/agents/src/coding-prompt.test.ts packages/harness/src/coding-prompt-policy.test.ts packages/harness/src/memory-search-production.regressions.test.ts packages/context/src/compaction.test.ts packages/context/src/rehydration-headroom.regressions.test.ts packages/model/src/openai-stream-footer.regressions.test.ts
```

回到研究分支的仓库根目录，运行：

```sh
node scripts/research/coding-agent-research-20261015/probe.mjs --runtime-root /tmp/harness-coding-research-baseline --out /tmp/coding-agent-research-probe.json
node /tmp/harness-coding-research-baseline/apps/cli/dist/main.js docs:verify
```

探针绑定基线 SHA，有意拒绝任意更新后的工作树；后续 C1 修复应把场景转成正式回归，不能修改本轮记录来伪装旧源码已通过。baseline-tests 原件中的绝对目录为本次实际执行位置。JSON 中时间戳属于原始输出，不参与跨次字节相等判断。

本轮最初的两个研究调用有纠正：SDK 探针最初假设工具总数为 12，实际 Runtime 还注入 ask_user；文档检查的自写包装最初误读取 truthful 而不是结果层 ok。已修正研究调用并以真实 CLI 复核；没有对应生产代码缺陷，也未放宽产品测试。
