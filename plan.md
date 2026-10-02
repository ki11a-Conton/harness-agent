# Harness Agent 工作区知识优化计划

日期：2026-10-02。目标：让智能体可靠地读取当前工作区，并减少并发调用 repo_map / symbol_search 时的重复文件系统操作。本轮按仓库 AGENTS.md 的 Runtime maintenance 规则处理可复现的缓存、检索正确性问题，不改动智能体策略或 Runtime 架构。

## 基线与范围

- 远端 origin/main：`991576901e6ac718dc30246e5b11c84771f42dce`；本轮实现基于已验证的本地修复快照 `9cf89a95fbec2d902d56558d0b8bdfc989874a84`，保留上一轮权限、取消、读取路径和搜索错误修复。
- 上一份已完成计划归档为 `plan(20261001-code-review).md`。在独立工作树 `/workspace/harness-agent-optimization` 实现和验收，最终同步回 `/workspace/harness-agent`。
- 修改范围：`packages/tools/src/repo-map.ts`、`symbol-index.ts`、`tools/repo-map-tool.ts`、相关回归测试、离线基准脚本、证据和计划。保留 ToolOrchestrator / PermissionEngine / SandboxManager / Verification 边界，维持工具 schema 与元数据。
- 验收平台为当前 Linux / Node 24 环境；不宣称 Windows CI、真实模型任务成功率或 token 消耗收益。

## 做什么、怎么做、怎么验收

| 项目 | 做什么 | 怎么做 | 怎么验收 |
| --- | --- | --- | --- |
| O1 仓库地图缓存 | 消除并发热缓存的重复扫描、重建的第二次扫描，以及构建期间丢失失效通知 | 将验证和构建合并为按失效代次共享的 Promise；一次扫描同时提供指纹和构建输入；失效代次变化后丢弃旧结果；递归遍历传播停止信号，文件上限加一个探测项判断 complete | 定向测试覆盖冷/热并发、重建、扫描/构建期间 noteChange 与 invalidate、精确上限和截断；16 并发热查询 stat 次数较基线下降至少 90%，修改后单次重建下降至少 45%，限制扫描的 readdir 次数下降至少 75% |
| O2 工作区隔离 | 同一进程的不同工作区、不同 maxFiles 使用各自的缓存，防止返回其他仓库地图 | 以规范化绝对工作区路径与有效 maxFiles 为键，最多保留 8 个缓存，按最近使用淘汰；refresh 只影响对应键 | 测试 A→B→A、不同文件预算、路径别名、局部 refresh 与容量；通过真实工具调用确认输出 root / files 属于调用工作区 |
| O3 符号检索 | 修复默认路径漏检、目录前缀越界、嵌套文件修改后仍返回旧符号；减少并发冷启动和重读 | 每个规范化根目录合并在途查询；检查源文件集合、mtimeMs 和 size，仅重读变化文件，60 秒后强制内容刷新；最多保留 64 个根；将 . / ./ 视为根目录，并按目录边界限定路径 | 测试默认工具调用、目录/文件范围、嵌套修改/新增/删除、未变化内容复用、TTL、冷/热并发、根目录隔离；16 并发冷查询 readFile 次数下降至少 90%，单文件变更只重读该文件 |
| O4 可复现证据 | 避免仅凭耗时或主观感受评价优化 | 编写不调用模型、不联网的基准脚本；用同一固定文件布局、样本数和并发度，对原实现与候选实现统计真实 stat / readdir / readFile 次数、输出正确性和耗时中位数；保存原始结果与比较 | 基线和候选使用相同脚本与配置；脚本比较模式校验正确性和操作次数门槛；耗时仅作为观测，不用波动的计时作为硬门槛 |
| O5 回归交付 | 确认本轮及上一轮修复未破坏已有能力与安全边界 | 先运行新测试取得 RED 复现，再实现 GREEN；运行类型检查、构建、工具/集成测试和安全测试；冻结干净本地快照后跑全量测试，使用 Linux subreaper 处理本容器 PID 1 不回收孤儿进程的环境差异 | `corepack pnpm typecheck`、`build`、相关单元/集成、安全和 `test` 均退出 0；`git diff --check` 通过；计划填入实际数字、失败处理和日志路径；最终修改同步回用户工作区 |

## 执行顺序

1. [x] 同步 origin/main，读取 AGENTS.md、相关任务和架构约束；保留并归档上一轮成果；安装锁定依赖并通过基线类型检查。
2. [x] 在实施前写下本计划和验收门槛。
3. [x] 创建离线基准和定向回归测试，记录基线操作次数与 RED 复现。
4. [x] 完成 O1 / O2 / O3；通过定向测试和基准门槛。
5. [ ] 完成类型、构建、工具集成、安全与干净快照全量验收。
6. [ ] 补全证据、实际结果和适用限制；同步最终代码与计划到用户工作区。

## 结果与证据

已完成 O1–O4，O5 的全量验收待执行。

- RED：同一批 29 项新回归测试在基线上 24 失败 / 5 通过；候选 29 项全部通过。原有相关测试与新增测试合计 56 项通过。
- 工具与 Harness：57 个测试文件，610 通过 / 10 跳过 / 0 失败。
- 安全：19 个测试文件，2,135 通过 / 0 失败。
- `corepack pnpm typecheck`、`corepack pnpm build` 和 `git diff --check` 通过。
- 基准：7 个样本，同一 Node 24.19.0 / Linux / x64 环境；每个工作区 192 个源码文件 + 1 个 manifest，16 并发。所有正确性检查和操作次数门槛通过。原始样本、环境、基线提交、工作区源码差异、源码与脚本 SHA-256 保存在 `docs/evidence/workspace-knowledge-optimization.json`。

| 场景与指标 | 基线 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 16 并发热地图 stat | 3,088 | 193 | 减少 93.75% |
| 修改后地图重建 stat | 386 | 193 | 减少 50% |
| 最多 8 个文件的扫描 readdir | 26 | 3 | 减少 88.46% |
| 16 并发冷符号查询 readFile | 3,072 | 192 | 减少 93.75% |
| 16 并发热符号查询 stat / readFile | 16 / 0 | 192 / 0 | 增加文件级状态检查，内容仍复用 |
| 嵌套单文件修改后的符号查询 readFile | 0，漏检修改 | 1，正确检出 | 只重读变化文件 |

适用限制：这些收益来自离线固定夹具，不代表所有仓库或真实模型任务的提升。符号热查询为保证嵌套修改的可见性，每次会扫描源码文件集合和 stat，比旧实现只检查根目录更贵；16 并发热查询中位耗时约从 0.2 ms 增至 5–6 ms，详细观测见证据。mtime 与 size 相同的外部改写最迟由 60 秒完整内容刷新检出；`noteChange` / `refresh` 可强制地图更新。仓库地图的文件扫描有上限，显式 monorepo 的 workspace 成员解析仍可能遍历目录，以保留现有 glob 与空目录语义。未运行 Windows CI 或真实模型基准。

## 复现方法

先在候选和基线工作树分别执行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm build`；基线使用 `9cf89a95fbec2d902d56558d0b8bdfc989874a84`。从候选工作树执行以下命令（脚本支持任意工作树路径）：

```bash
node scripts/benchmark/workspace-knowledge.mjs --repo-root /workspace/harness-agent-optimization-baseline --label baseline --out /tmp/workspace-baseline.json
node scripts/benchmark/workspace-knowledge.mjs --repo-root /workspace/harness-agent-optimization --label candidate --out /tmp/workspace-candidate.json
node scripts/benchmark/workspace-knowledge.mjs --compare --baseline /tmp/workspace-baseline.json --candidate /tmp/workspace-candidate.json
corepack pnpm exec vitest run packages/tools/src/workspace-knowledge-regressions.test.ts
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:security
corepack pnpm test
```

本容器 PID 1 不回收孤儿进程。进程子树测试和全量测试通过 `.ci/optimization/run-with-subreaper.py` 启动，让 Linux 在测试进程树内回收孤儿进程；未修改测试或产品进程执行逻辑。详细日志保存在用户工作区 `.ci/optimization/`。

