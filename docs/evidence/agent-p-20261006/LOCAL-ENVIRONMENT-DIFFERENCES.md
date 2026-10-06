# 本机已知环境差异清单（Windows 工作机）

目的：把**本机环境导致、与候选策略无关**的测试失败集中记录，便于 CI/他机复核时一眼区分"环境差异"与"产品缺陷"。本清单不修改任何产品代码，也不放宽任何测试。

- 采集基线：`HEAD = e6fc818c`（P 轮重新冻结之后），工作树 clean。
- 采集方式（两次独立运行 + 一次基线对比）：
  1. 并行全仓 `pnpm test`：8990 用例 → **8948 PASS / 32 FAIL / 10 skip**，13 个文件失败。
  2. 串行复跑这 13 个文件（`--no-file-parallelism`）：450 用例 → **415 PASS / 30 FAIL / 5 skip**，11 个文件失败。
  3. 基线对比：其中 11 个文件在**拉取前的提交**（`e99cb3f1`，未含本轮改动）上以同样方式失败；`apps/cli/src/benchmark-command.test.ts > E4-R41` 在本机隔离复跑同样失败。
- **没有一项与 N7 语料/预注册或 P 轮新候选相关**：`apps/cli/src/n7-execution-chain.regressions.test.ts` 在重新冻结后 **55/55 PASS**（此前因 `ARM_DIGEST_DRIFT` fail-closed）；P 轮新增的 7 + 4 + 12 项测试全部通过。

| # | 文件 | 失败数 | 现象/类别 | 串行是否仍失败 | 建议运行环境 |
| --- | --- | --- | --- | --- | --- |
| 1 | `packages/context/src/path-scoped-discovery.test.ts` | 2 | symlink 发现边界（"every symlink component"、symlinked instruction file） | 是 | Linux/macOS，或有符号链接权限的 Windows（开发者模式/管理员） |
| 2 | `packages/context/src/scoped-instruction-read.regressions.test.ts` | 1 | 读取后父目录被替换的边界 | 是 | 同上 |
| 3 | `packages/tools/src/read-file-resource.regressions.test.ts` | 1 | "reads an authorized symlink alias" | 是 | 同上 |
| 4 | `packages/harness/src/skill-revision-regressions.test.ts` | 1 | 缓存的元数据路径被 symlink 替换须拒绝 | 是 | 同上 |
| 5 | `packages/core/src/runtime/encoded-tool-output-security.regressions.test.ts` | 1 | 拒绝预先存在的 artifact symlink | 是 | 同上 |
| 6 | `packages/tools/src/symbol-scope.regressions.test.ts` | 1 | 并发不同 scope 之间不得共享 flight/缓存文件集 | 是 | 资源充裕的 CI；本机并发下不稳定 |
| 7 | `packages/evaluation/src/r97-arm-worker-contract.test.ts` | 9 | worker 终止/预算退还协议（含"hanging arm 必须被终止"与若干 PROTOCOL FIXTURE） | 是 | Linux CI；对进程终止计时与子进程语义敏感 |
| 8 | `packages/evaluation/src/e4-r77-baseline-oracle.test.ts` | 7 | "platform-consistent" / "direct argv execution" 的 oracle 判别（标注为**每个平台都应通过**） | 是 | **最值得维护者复核的一项**：Linux CI 复跑，确认是否为平台条件期望 |
| 9 | `apps/cli/src/e4-09-production-e2e.test.ts` | 4 | 重链路 E2E（benchmark → V3 → evaluator → promote → createHarness） | 是（并行时也失败；个别轮次曾通过） | Linux CI，充裕超时 |
| 10 | `apps/cli/src/e4-r55-failure-wiring.test.ts` | 1 | 父验证器对隔离子进程的失败证据判定 | 是 | Linux CI，充裕超时 |
| 11 | `apps/cli/src/benchmark-command.test.ts` | 2 | `E4-R41` host-probe fail-closed（UNVERIFIED 状态必须拒绝）；另一项为跨用例工作区隔离 | 是 | Linux CI；`E4-R41` 与本机 host-probe 能力相关（已单独复跑确认） |
| 12 | `apps/cli/src/cli.test.ts` | 0（并行时 1） | 写文件审批流（并发下超时） | **否（单独/串行通过）** | 视为**负载波动**，无需处理 |
| 13 | `apps/web/src/harness.integration.test.ts` | 0（并行时 1） | HTTP 会话/队列跟进（并发下超时） | **否（单独/串行通过）** | 视为**负载波动**，无需处理 |

## 复核方法（他机/CI）

```bash
# 1) 全仓基线（记录失败集合）
pnpm test

# 2) 只跑本清单的 13 个文件，串行，用于区分"稳定失败"与"并发波动"
npx vitest run \
  packages/context/src/path-scoped-discovery.test.ts \
  packages/context/src/scoped-instruction-read.regressions.test.ts \
  packages/tools/src/read-file-resource.regressions.test.ts \
  packages/harness/src/skill-revision-regressions.test.ts \
  packages/core/src/runtime/encoded-tool-output-security.regressions.test.ts \
  packages/tools/src/symbol-scope.regressions.test.ts \
  packages/evaluation/src/r97-arm-worker-contract.test.ts \
  packages/evaluation/src/e4-r77-baseline-oracle.test.ts \
  apps/cli/src/e4-09-production-e2e.test.ts \
  apps/cli/src/e4-r55-failure-wiring.test.ts \
  apps/cli/src/benchmark-command.test.ts \
  apps/cli/src/cli.test.ts \
  apps/web/src/harness.integration.test.ts \
  --no-file-parallelism
```

判定标准：**在 Linux CI 上全部通过** → 本清单即为"本机环境差异"，无产品含义；若某项在 Linux CI 上仍失败（尤其第 8 项），则升级为真实缺陷并单独开轮处理。
