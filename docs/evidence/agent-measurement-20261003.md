# 实测驱动的技能上下文与评测身份优化（2026-10-03）

当前状态：实施中。新计划 [plan.md](../../plan.md)，制定快照 [plan(20261003-000000).md](../../plan(20261003-000000).md)。基线 `c31e4a8046f1e22b0da29c9310f5c131c5d9a38f`；真实模型配置仍缺失，真实模型质量和 promotion 均 NOT_RUN，付费调用 0。

## 已完成的基线实测

真实 createHarness、文件系统、ToolOrchestrator、JSONL 和原独立 TaskVerifier；scripted provider 只控制调用，不能证明真实模型质量。

| 工程观察 | 基线 | 固定英文 selector 对照 |
| --- | --- | --- |
| 100技能 AB/BA 平均 system bytes | 241065.5 | 3330.5（减少98.62%） |
| 100技能平均完整 request bytes | 253068.5 | 11373.5（减少95.51%） |
| 8k / 21技能相关正文 | 0/9 请求 | 9/9 请求 |
| 8k每turn系统字节（3请求） | 56277 | 15720（减少72.07%） |
| 8k 原独立内容验证 | 3/3 | 3/3 |

上述对照使用旧 selector/固定 host goal，尚不是本轮新候选成绩。21技能基线 ledger 将63次加载提前算注入，实际模型只收到12次正文；相关正文0/3而 injected=3/tokens=3030/completed=1。100技能16k实际34次正文却记200次注入。英文/中文显式命名在长描述下被旧Jaccard筛掉。

原始反例、逐请求统计、完整工具事件、负例、原脚本和原索引保存在 [基线索引](agent-measurement-20261003/baseline-artifact-index.json)。收集范围是两组原目录全部顶层报告、JSON、日志、原脚本；生成fixture/session子目录未复制，原索引指向原外部目录，外层索引核验本交付实际保留文件。原始字节没有重写。

验证保留证据：

```bash
node scripts/research/agent-measurement-20261003/verify-artifacts.mjs docs/evidence/agent-measurement-20261003/baseline-artifact-index.json
```

## 实施与验收

M1、M2、M3 正在实施；待补实际受测SHA、独立审查、候选工程AB/BA、全仓检查与原生Git发布记录。M4真实模型pilot因无provider/key/费用配置保持BLOCKED，不能用全仓测试通过代替模型质量结论。
