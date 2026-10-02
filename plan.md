# Harness Agent 上下文压缩优化计划

日期：2026-10-02。本轮优化长任务的上下文压缩、受保护信息保留和预算计量。先复现问题，再实施修改，以离线配对基准与完整回归验收。按 AGENTS.md 的 Runtime Freeze 要求，本轮属于有确定复现的正确性维护；不调整智能体策略或推广实验结果。

## 基线与范围

- origin/main 已同步，仍为 `991576901e6ac718dc30246e5b11c84771f42dce`。实现基于上一轮完成快照 `b747502c8cbcfd6dbb996c0dd744069468b17abd`，保留已有工具安全与工作区知识优化。
- 上一轮计划归档为 `plan(20261002-workspace-knowledge).md`；更早的审查计划继续保留。
- 开发与完整测试使用 `/workspace/harness-agent-context-optimization`；验收后将明确范围的文件同步回 `/workspace/harness-agent`。
- 修改范围：`packages/context/src/compaction.ts`、`pipeline.ts`、`rehydration.ts`、相关回归测试、基准脚本、证据与计划。不改变 Core 架构、工具权限或 sandbox / Verification 边界，不新增依赖。
- 已读取 AGENTS.md、HANDOVER.md、CTX-002 / CTX-003 及 ContextBlock、TokenEstimator、熔断器契约。保留现有多阶段压缩顺序与 host 提供摘要的要求。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| C1 有界、安全的压缩 | 修复超长首行逃过字节限制、全量 split 分配、不可压缩信息被早期阶段改写/删除、证据去重丢失顺序与不同原文 | 仅扫描有限预览前缀，按完整 Unicode 码点计 UTF-8 字节，优先保留完整行；标记额外字节计入 token；保护 system/user/project/local/skill、受保护类别、instructional 和 compressible:false；以原始证据内容及来源身份去重，保留最后出现位置，跨来源和已有预览保守保留 | 测试超长 JSON/单行、中文/emoji、完整行边界、原文不可变、保护块全部字段保留、相同预览不同尾部、来源身份、A→B→A 的最后出现顺序；1 MiB 单行证据输出字节下降至少 99%，正文不超过 previewMaxBytes；大量换行输入的全量 split 处理字节下降至少 99% |
| C2 一致的预算计量 | 修复摘要、复水、隔离包裹和消息历史使用不同 token 估算方式，避免中文内容预算低报 | 所有生成内容通过现有 TokenEstimator seam；默认使用 UTF-8 bytes/4；支持注入的估算器；保持默认接口兼容 | 覆盖 Default/MultiStage 摘要、预览与标记、中文复水、隔离内容、消息历史、注入估算器；实际报告 tokens 与所用估算器一致，复水总额不超过限制；仅统计启发式预算，不冒充模型真实 tokenizer |
| C3 可靠的压缩反馈 | 防止阶段报告跨 build 累积导致熔断误判；压缩失败可计入熔断，报告剩余预算应与最终内容一致 | 每次压缩隔离阶段记录，基于本次输入与复水后的输出记录收益；为注入 compactor 提供实际输入/输出兜底统计；失败调用 recordFailure；记录实际耗时并重算 available | 首次有效后连续无效压缩按设定阈值打开熔断；失败会计入，打开后不再调用 compactor；并发默认 build 不混淆计数；report.used/available 与最终块相符；protected overflow 如实为负 |
| C4 证据与交付 | 完整执行计划，验证兼容性与量化收益 | 新测试在原实现上先取得 RED；同一脚本/配置/环境运行基线与候选配对基准，保存样本、源码和脚本摘要，加入基线自比较负向检查；执行类型/构建、上下文与 Harness 集成、安全和干净快照全量测试 | 基准正确性检查与两项 99% 门槛均通过；相关测试、`corepack pnpm typecheck`、`build`、`test:security`、`test` 退出 0；`git diff --check` 通过；同步后字节核对、目标目录构建通过，计划填入实际结果 |

## 执行步骤

1. [x] 同步远端，检查工作区、历史优化与相关契约，确定可复现目标。
2. [x] 在修改实现前写下本计划、方法和验收门槛。
3. [x] 写离线基准与回归测试，保存原实现的 RED 与量化基线。
4. [x] 完成 C1–C3；通过定向回归和配对基准。
5. [x] 完成类型、构建、集成、安全与干净快照全量验收。
6. [x] 记录实际结果与限制，同步最终代码和计划回用户工作区。

## 验收结果

C1–C4 全部完成，优化代码与计划已同步至 `/workspace/harness-agent`，前两轮的 12 个交付文件保持一致。

- 同一批 39 项新增回归：基线 35 失败 / 4 通过，候选全部通过。上下文包合计 149 项、9 个文件全部通过。
- Harness 集成与单元：213 项、29 个文件全部通过；Runtime 真实 loop 集成与消息协议：31 项、2 个文件全部通过。
- 安全：2,135 项、19 个文件全部通过。
- 全量 `corepack pnpm test`：419 个文件通过 / 1 个文件跳过，7,773 项通过 / 12 项按仓库原配置跳过 / 0 项失败，退出 0，耗时 604.07 秒。使用干净冻结快照 `cc8096e2b25969daf8be6fc198228db11fda787a`，验收后仅补充本计划。
- `corepack pnpm typecheck`、`corepack pnpm build` 与 `git diff --check` 通过。
- 配对基准：7 个样本，Node 24.19.0 / Linux / x64，预览正文上限 4,096 bytes；全部正确性检查和 99% 门槛通过。基线与自身比较被拒绝，退出 1。

| 场景 | 基线 | 候选 | 结果 |
| --- | ---: | ---: | --- |
| 1 MiB ASCII 单行的最终预览 UTF-8 bytes | 1,048,637 | 4,157 | 减少 99.6036% |
| 1.25 MiB 中文/emoji 单行的最终预览 UTF-8 bytes | 1,310,781 | 4,157 | 减少 99.6829% |
| 密集换行输入交给全量 split 的 bytes | 1,048,576 | 0 | 避免全量 split 分配 |
| ASCII 单行预览的预算估算 / 实际按同一估算器计量 | 1,024 / 262,160 | 1,040 / 1,040 | 预算与实际预览内容一致 |

7 个样本、环境、工作区源码差异及源码/脚本 SHA-256 固化于 `docs/evidence/context-compaction-optimization.json`。日志保存在 `.ci/context-optimization/`。计时受 split 插桩开销影响，仅作观测；验收门槛基于实际输出字节与 split 处理字节，不使用不稳定耗时。

## 复现方式

先在候选和基线工作树分别执行 `corepack pnpm install --frozen-lockfile` 与 `corepack pnpm build`；基线快照为 `b747502c8cbcfd6dbb996c0dd744069468b17abd`。从候选工作树使用同一脚本：

```bash
node scripts/benchmark/context-compaction.mjs --repo-root /workspace/harness-agent-context-baseline --label baseline --out /tmp/context-baseline.json
node scripts/benchmark/context-compaction.mjs --repo-root /workspace/harness-agent-context-optimization --label candidate --out /tmp/context-candidate.json
node scripts/benchmark/context-compaction.mjs --compare --baseline /tmp/context-baseline.json --candidate /tmp/context-candidate.json
corepack pnpm exec vitest run packages/context packages/harness packages/core/src/runtime/loop-integration.test.ts packages/core/src/runtime/turn-helpers.protocol.test.ts
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:security
corepack pnpm test
```

本轮只在当前 Linux / Node 24 环境验收，不宣称 Windows CI、真实模型成功率或模型 token 消耗提升。预览不能代替原始证据；完整内容仍应由现有 artifact/transcript 路径保留。previewMaxBytes 限制正文，显式预览标记在此上增加少量字节；预算统计包含标记。受保护信息不会为硬凑预算而被删改，仍可能如实报告超限。本容器使用已有 Linux subreaper 启动进程测试，处理 PID 1 不回收孤儿进程的环境差异。
