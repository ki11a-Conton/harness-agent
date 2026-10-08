# 内部 coding 提示词审查与改进（2026-10-08）

旧默认提示词只有能力/审批介绍，不足以据此判断生产 coding 质量。本轮参考当前工作区有许可证的 pi、Codex、OpenCode、Hermes 源码与 DeepSeek Harness 的模块化设计，实现 `coding-v1` Agent challenger，并修复提示词导出/实际请求不一致、未评估组合沿用冠军证明的问题。

固定验收源码：`6814ead2906f719a3a8e591d2ef73d8d37d529c2`；最初基线为 `663b6552db0e7006e7e47c70b5ab68fb6212786b`。源码提交 `64a174d` 增加提示词策略，`6814ead` 隔离冠军证明。后续提交添加说明/原件，验收属于记录的源码 SHA。

## 实施结果

| 项目 | 实现/验收 |
| --- | --- |
| P01 编码闭环 | 定位→保护已有工作→最小修改→真实检查→诊断修复→按证据报告；实际 CLI/Web 请求加载精确正文 |
| P02 默认导出漂移 | CLI 复用实际 Harness 默认常量；基线 1 条 RED 在最终全量中 GREEN |
| P03 角色与能力 | 主角色/readonly worker/write worker 按原生工具生成；工具/权限/委派开关/限额保持原契约 |
| P04 开源移植 | pi 的工具过滤与去重直接改编，Codex/OpenCode/Hermes 的工作准则适配；不引入不存在的工具或重复 ContextPipeline |
| P05 会话冻结 | 实际三角色正文进入配置指纹；同版本正文改变拒绝恢复；legacy 可恢复旧会话 |
| P06 效果边界 | 显式启用；默认 legacy、冻结 N7 与原实验保持原策略；真实模型效果 `NOT_PROVEN` |
| P07 证明污染 | 显式新策略独立运行，不自动叠加旧冠军或生成 AppliedProof；CLI/Web 两条 RED→GREEN，切回 legacy 正常应用原冠军 |

完整计划：[plan(20261008-coding-prompts).md](../../../plan(20261008-coding-prompts).md)。来源、许可证、实际工具适配、启用/回退和线下比较见 [coding-prompts.md](../../coding-prompts.md)。改编许可证/NOTICE 在 `third_party/coding-prompts/`，参考文件精确摘要见 `raw/reference-source-manifest.json`。Claude 目录自述为泄露源码且没有找到开源许可证，本轮未使用其实现或提示词。

## 工程验收

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 固定最终源码 typecheck / full unit + integration | 505 文件；9099 passed、0 failed、13 skipped；开启 N2 真实 release CLI | `raw/full-suite.json.gz`、日志与 subreaper receipt |
| 安全 / 协议独立门禁 | 2135 / 52 passed，0 failed | `raw/security.json.gz`、`protocol.json.gz` |
| 提示词/冠军/配置针对性回归 | 48 passed | `raw/targeted.json.gz` |
| CLI/Web 新策略真实 HTTP 编程通路 | Linux 50 条既有 coding 断言 + 8 条新策略断言；19 个实际请求 | `coding-v1/`：正文、摘要、请求、审批/SSE、diff、episode、独立测试 |
| legacy 回归 | Linux 50 条 coding + 6 条加载/启动断言；19 个实际请求 | `legacy/` |
| 原生 Windows | 20 文件、253 passed、0 failed、1 POSIX skip；12 条必须原生执行的 Windows 用例全通过 | `raw/windows-receipt.json`、全部 case records 与官方 annotations |
| Windows 新策略 HTTP | 49 条 coding + 8 条新策略断言；正文 SHA256 与 Linux 完全一致 | `raw/windows-prompt-coding.json` |
| 最终源码完整发布 CI | 10 个 job 全部 success，包括双系统 verify/coverage/formal/闭环/双平台汇总/release attestation | `raw/source-ci-run.json`、`source-ci-jobs.json` |

主提示词 4403 字节/1101 个估算 token；readonly 2358/590；write worker 4450/1113，均小于现有 system 预留 1500，不提高预算。实际 provider tokenizer 与完整上下文另计。模型请求、角色正文和 SHA256 在 receipt 中绑定。

原生 Windows：[Actions 37711057472](https://github.com/ki11a-Conton/harness-agent/actions/runs/37711057472)。最终源码 CI：[Actions 37711057912](https://github.com/ki11a-Conton/harness-agent/actions/runs/37711057912)。所有副作用继续经过现有 Orchestrator、权限、沙箱与 Verification。

Linux 13 条 skip 是 12 条真正 Windows 才能执行的测试和 1 条缺失历史 Git 对象的旧字节复现；Windows 1 条 skip 为 POSIX 用例。HTTP 验收在 Windows 跳过 POSIX SIGINT 实验，另有真实 Windows 子进程树取消/超时通过证据。默认排除的 perf/soak/历史故意失败研究入口不计本轮已通过。

脚本 HTTP provider 的动作预先确定；文件、进程、审批、失败诊断/修复、验证与会话恢复实际执行。该结果证明工程链和策略安装，不证明真实模型会服从这些准则、解题率提高或达到 Codex/Claude Code 水平；付费调用为 0，真实模型质量保持 `NOT_PROVEN`。

## 失败原件与离线复核

`raw/history/` 保留首次全量失败：两个已终止的后代被容器 PID 1 留为 Z 状态，PID 探测仍判为存活。诊断同时记录了 Z/ppid=1，回收器复核的两文件 89 条断言通过。最终完整测试由 Linux child subreaper 回收该次调用的孤儿后代，保留实际 framework 最终状态，不改断言来制造成功。

另外保留 `64a174d` 的中间通过报告、组合证明的 2 条 RED 和中间 receipt；它们不替代最终 `6814ead` 的验收。中间 CI 在最终修复推送后被 supersede/cancel，不能标为完整通过。历史 `663b655` 的离线闭环曾出现 claim-lock 并发反例失败；当前单条复核与完整闭环通过，本轮未修改预算锁，也未把该历史失败宣称为已修复。

`RAW-MANIFEST.json` 覆盖所有原件的大小与 SHA256；JSON.gz 为无损压缩。`.gitattributes` 保留归档字节。`raw/product-source-files.json` 绑定记录源码的 canonical Git blobs，不用工作区换行冒充源码漂移。

在仓库根运行：

```sh
python3 docs/evidence/coding-prompts-20261008/raw/verify-evidence.py docs/evidence/coding-prompts-20261008 --repo .
```

复核 manifest、逐例最终状态、源码身份、实际 HTTP 正文、Windows 必须用例、跨系统正文、完整 CI 与 `NOT_PROVEN` 边界。负控制记录见 `raw/evidence-negative-controls.json`：篡改文件、重算 manifest 后带失败测试、伪造 Windows 源码身份均需拒绝。
