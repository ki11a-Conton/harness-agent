# E4-R46 报告：保证诊断包跨进程与重复采集不覆盖

## 1. 做了什么

修复 `apps/cli/src/e4-09-diagnostics.ts` 中诊断包目录分配依赖**模块内计数器**的问题，
并新增跨进程回归测试 + CI 上传命名调整。

R40 时代的目录名由 `ATTEMPT_SEQ`（模块内变量，每个进程从 1 起）推导。CI 的 `verify`
矩阵跑多个测试文件，各自在独立进程里共享同一个 `E4_09_DIAG_DIR`（`.ci/diagnostics`）
和同一个 `E2E_OBSERVATION_RUN_ID`（`e4-r24-<os>-<run_id>`）；两个失败且 label 相同的
进程都会算出 `…__attempt-1`，`mkdir recursive` + `writeFile` 会让第二个**覆盖第一个**。

改动：

1. **目录分配改为原子 `mkdtemp`**：`captureFailure` 用 `mkdtemp(prefix)` 创建唯一目录，
   不再用 `attempt-<n>`（它只保留在 prefix/注释里作可读后缀，**不承担唯一性**）。
   `attempt` 字段更名为 `captureOrdinal`（进程内序号，仅可读），并新增
   `captureIdentity`（`<pid>-<ts>-<ordinal>`，跨进程唯一，写入 bundle）。
2. **bundle 增加身份字段**：`captureOrdinal`、`captureIdentity`、`ciRunAttempt`
   （`process.env.GITHUB_RUN_ATTEMPT ?? null`）。
3. **`e4-r40-forensics.test.ts`** 断言从 `.attempt` 改为 `.captureIdentity` 判异；
4. **CI 上传 artifact 名加 `-attempt-${{ github.run_attempt }}`**
   （`.github/workflows/ci.yml`），使 GitHub Actions 内同一 run 的重试不会用同名
   artifact 覆盖上一次的诊断证据。
5. **新增 `e4-r46-diagnostics-noclobber.test.ts`**（3 例）+ 专用 fixture config
   `apps/cli/test-infra/diagnostic-vitest.config.ts` + fixture 目录
   `apps/cli/test-infra/diagnostic-fixtures/`（在根 vitest `include` 与 `tsc` 之外）。

## 2. 为什么需要改

计划 §5「做什么」第 1 条：`ATTEMPT_SEQ` 是模块内变量，不同进程用相同
`E2E_OBSERVATION_RUN_ID` 和 label 都会生成 `attempt-1`，最终写入**同一目录**。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-09-diagnostics.ts` | 修改：目录原子分配（`mkdtemp`）+ `captureIdentity`/`ciRunAttempt` 字段 |
| `apps/cli/src/e4-r40-forensics.test.ts` | 修改：断言改 `captureIdentity` 判异 |
| `apps/cli/src/e4-r46-diagnostics-noclobber.test.ts` | 新增：跨进程/重复采集不覆盖回归测试（3 例） |
| `apps/cli/test-infra/diagnostic-vitest.config.ts` | 新增：fixture 专用 config |
| `apps/cli/test-infra/diagnostic-fixtures/` | 新增：fixture 目录（含 `.gitkeep`） |
| `.github/workflows/ci.yml` | 修改：artifact 名加 `run_attempt` |

## 4. 复现方法与修复前结果

**修复前**（推理 + 实测）：两个独立进程，相同 root + runId + label，各写不同内容 →
`mkdir(join(...attempt-1))` 递归 + `writeFile` 覆盖 → **只有一个目录，内容为后写者**。

**决定性判别实验**：把修复临时**改回** `join(root, '...__attempt-1')`，R46 跨进程测试
**必然失败**（期望 2 个目录，实得 1 个）：

```text
AssertionError: expected 1 to be 2
❯ apps/cli/src/e4-r46-diagnostics-noclobber.test.ts:149 expect(dirs.length).toBe(2)
```

这证明「固定目录名」正是缺陷，且新回归测试能捕获它（计划 §5 验收：断言或配置验证）。

**修复后**：`mkdtemp` 原子建目录，两个进程各得一个唯一目录，互不覆盖。恢复正确实现后
R46 3/3 通过。

## 5. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | tsc -b 全绿 |
| `pnpm vitest run apps/cli/src/e4-r46-diagnostics-noclobber.test.ts` | 0 | **3 passed** |
| `pnpm vitest run apps/cli/src/e4-r45-diagnostics-order.test.ts` | 0 | 4 passed（无回归） |
| `pnpm test:forensics` | 非零（按设计） | 1 failed / 1 passed（取证路径仍 work） |

R46 三例覆盖：

- **跨进程**：两个独立子进程，相同 root+runId+label，写不同决策 →
  父进程断言共享 root 下有 **2 个不同目录**，两份 bundle 各带自己的内容与不同的
  `captureIdentity`，`summary["decision-artifact"].decision` 分别含 `ACCEPT` 和
  `REJECT`（两者都存活），且**逐字节稳定**（再读 = 首读）。
- **重复采集**：同一 recorder 两次 `captureFailure` → 两个独立目录（幂等-by-new-dir），
  第一份在第二次之后逐字节不变。
- **`ciRunAttempt`**：设 `GITHUB_RUN_ATTEMPT=3` → bundle.`ciRunAttempt` = "3"。

## 6. testedSourceSha 与未提交改动

- `reviewedSourceSha` / `testedSourceSha`：`d201da5e8071e2780a745ffb86ddb31d3cdf547d`
  （计划审查基线）。
- 本任务实现提交后工作树干净（R46 改动 + 报告一并提交）。

## 7. 未执行项与残余限制

- **CI 上传命名**：已加 `run_attempt`，但仅在 CI 真实失败时才能观察到；本地不伪造失败
  去触发上传（不造数据）。CI 侧验收在 R50 远端核实 job 状态或 R46 CI run 时记录。
- **性能**：跨进程测试通过 spawn 真实 vitest 子进程，耗时约 2 秒，属正常 E2E 范畴；
  不依赖 sleep 保证时间戳不同（唯一性来自 `mkdtemp`，与时间戳无关）。
- 诊断模块其余字节限制/摘要语义问题属于 **R47**，未在本任务处理。
