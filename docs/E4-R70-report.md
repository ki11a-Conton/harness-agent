# E4-R70 报告：按资源所有权验证清理，并使验证失败可见

## 1. 问题（K70-A / K70-B，P2；无依赖）

`apps/cli/src/e4-r55-failure-wiring.test.ts` 的真实父验证末尾（修复前约 1143–1147 行）：

```ts
const leftover = await readdir(RUNS_ROOT).catch((err) => {
  reportDegraded("e4-r55 runs-root listing", err);
  return [] as string[];
});
expect(leftover, "each run must clean only its own directory ...").toEqual([]);
```

**K70-A**：`RUNS_ROOT` 是**多个运行共享的父目录**。其他进程的活跃目录与历史残留**不属于本次运行**，
即使本次 normal/mutated 都已清理，全局 `readdir` 仍非空。该断言把
"不能删除他人的目录"与"所有人的目录都必须不存在"**同时**作为要求。
（R69 报告记录：历史 `run-YtCeW3` 引起同一实现版本的全套验收失败。）

**K70-B**：`readdir` 抛 EACCES/EIO 时 catch 返回 `[]`，断言**通过**。
输出一行 degraded 日志并没有改变"通过"这个错误语义——**不可确认清理状态时被认证为清理成功**。

## 2. 修复前复现（实测）

### 2.1 提取检查块的探针（与计划 §1 同法）

| 条件 | 旧实现结果 |
|---|---|
| 根下只有 `run-foreign`，无本次资源 | 断言失败：`["run-foreign"]` ≠ `[]` |
| `readdir` 注入 EACCES | **断言通过**（catch 返回 `[]`） |

### 2.2 本轮真实观测到的更严重后果：`afterAll` 会删掉整个共享根

在**完整套件**里预置 `apps/cli/test-infra/e4-r55-runs/run-YtCeW3/`（含标记文件）后运行：

```
BEFORE : RUNS_ROOT=true  listing=["run-YtCeW3"]        ← 根非空，外来目录在内
rmdir  : returned WITHOUT throwing                     ← 没有抛 ENOTEMPTY
AFTER  : RUNS_ROOT=false                               ← 整个根连同外来目录一起没了
```

修复前，同样的预置在外来目录上得到 `foreign=GONE root=gone`：
**`afterAll` 的 `rmdir(RUNS_ROOT)` 删除了其他运行拥有的目录。**

**机制未完全定因（如实记录）**：同一个 `rmdir(non-empty dir)` 调用在
**最小 vitest 探针**与**纯 node** 中都正确返回 `ENOTEMPTY`（两种守卫设置下均如此），
只在大型套件的 `afterAll` 里"成功"。因此**本修复不依赖该机制的结论**：
计划 §2 明确要求"**不直接删除整个 RUNS_ROOT**"，而 `rmdir(RUNS_ROOT)` 本身就是一次
**全局、无视所有权**的删除尝试——它瞄准的是别人拥有的目录，本就不该由本套件执行。

## 3. 修改文件

| 文件 | 性质 |
| --- | --- |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | 修改（+368/−14，再 +22/−12）：新增所有权记录与探测/验证辅助；`runChild` 记录精确的 `runDir`；主用例末尾改为按所有权验证并把两类失败一起断言；`afterAll` **不再删除共享根**，改为非阻塞诊断 |

### 3.1 资源集合（计划 §3.A）

读了 `runChild` / `prepareChainModule` / `conclude` / 每次运行的 `cleanup` / `afterAll` 后：

- **唯一由本进程分配、且位于共享根下**的资源是 `runChild` 的 `mkdtemp(join(RUNS_ROOT, "run-"))`。
  `diagDir` / `reportDir` 在 `tmpdir()` 下，由 `afterAll` 的 `tempDirs` 负责。
- **所有权在分配时刻记录**（`allocateOwnedRunDir()`：先 `mkdir`+`mkdtemp`，**立刻** push 精确路径），
  因此"分配成功但后续初始化失败"的目录**同样被纳入**验证（计划 §3.A.4）。
  计划 §3.A.2 明确禁止"从 `run-*` 文件名或全局目录差集猜所有权"——这里用的是 `mkdtemp` 的返回值。
- 复用了既有信息（`ChildRun` 新增 `runDir` 字段），**没有**另建状态机。

### 3.2 验证范围（计划 §3.B）

```ts
type PathState = "absent" | "present" | "unknown";
async function probePathState(path, lstatImpl = lstat): Promise<PathProbeResult>
async function verifyOwnedCleanup(owned: string[], lstatImpl = lstat): Promise<string[]>
```

1. `cleanup` 完成后，逐个检查**本次拥有的精确路径**是否已不存在。
2. **只有能确认不存在才算成功**：`present` → 失败并指出该目录；`unknown` → 失败并给出探测操作/错误码/路径。
   返回的是**原因列表**，不是一个会被吞掉错误的布尔值。
3. **`lstat`（不跟随链接）**：悬空链接仍算路径残留。
4. **ENOENT 的父目录约束被显式确认**：先看错误码，**只有 ENOENT** 才进入"不存在"分支；
   然后**再探测父目录**——父目录存在但不是目录时返回 `unknown`
   （实测：**Windows 没有 ENOTDIR**，父组件是文件时同样报 ENOENT，只靠 ENOENT 会误判为"已清理"）。
   父目录也不存在（ENOENT）才确认 `absent`。
5. **外来目录只做非阻塞诊断**（`listForeignEntries`），**不构成**本次清理失败，
   **也不构成**清理授权。

### 3.3 不删除他人资源（计划 §3.C）

`afterAll` 的 `rmdir(RUNS_ROOT)` **整体移除**，替换为"若共享根仍非空则打印一行"的只读诊断。
这是本轮**唯一**一处删除行为的变更，方向是**减少**删除。

### 3.4 失败诊断（计划 §3.D）

主用例末尾改为：

```ts
const cleanupReasons = await verifyOwnedCleanup(ownedRunDirs);
const foreign = await listForeignEntries(RUNS_ROOT, ownedRunDirs);   // 诊断，不参与失败判定
expect([...chainReasons, ...cleanupReasons], "the real chain verdict and this run's own cleanup").toEqual([]);
```

两类失败**一起**断言，所以**清理失败不会遮盖原始链路失败，反之亦然**（计划 §3.D.3）。
归档路径与完整性沿用 R67 的协议，**未**新增通用归档层。

## 4. 修复后命令、退出码和关键断言

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `tsc -b` | **0** | 类型检查通过 |
| `vitest run … -t "E4-R70 cleanup verification is ownership-based"` | **0** | **7 passed**（1 例 E 因本机无法建链接而显式 skip） |
| `vitest run apps/cli/src/e4-r55-failure-wiring.test.ts`（完整，干净树，**预置外来目录**） | **0** | **63 passed \| 2 skipped (65)**，111.49 s |

逐条对应计划 §3「怎么验收」矩阵：

| 场景 | 用例与断言 | 结果 |
|---|---|---|
| 本次目录都已删除，根下无其他目录 | A：`verifyOwnedCleanup === []`、`listForeignEntries === []` | ✅ |
| 本次目录已删除，**foreign 历史目录存在** | B：验证通过；`listForeignEntries === ["run-YtCeW3"]`；标记文件 **sha256 与事前一致**；`existsSync(foreign) === true` | ✅ |
| 本次目录已删除，另一个运行 **active** 目录存在 | C：验证通过；active 目录**跨本次清理始终存在**（用 `open()` 持有句柄使其真正在用）；内容未被改动 | ✅ |
| 本次 normal/mutated 目录仍存在 | D：`reasons` 恰为 1 条，**含泄漏目录的完整路径**且含 `NOT cleaned up`；且**不**被报成 foreign | ✅ |
| 目标路径是**悬空链接** | E：`probePathState` 返回 `present`（`lstat` 不跟随），验证失败 | ⏳ **本机显式 skip**（无符号链接能力），待 CI |
| 验证探测 **EACCES/EIO** | F：`probePathState` → `unknown`；`verifyOwnedCleanup` 返回 1 条含错误码的原因；**不能 PASS** | ✅ |
| 初始化中途失败但**已分配**目录 | G：分配后抛错 → 该路径**仍在** `ownedRunDirs` 中，且清理后验证通过 | ✅ |
| 原始业务失败**且** cleanup 失败 | H：`[...chainReasons, ...cleanupReasons]` 两项都在 | ✅ |

**附加要求**：

| 要求 | 结果 |
|---|---|
| 至少一次完整 R55 父验证在**受控预置 foreign 目录**存在的情况下成功，foreign 保留 | ✅ 见 §5 |
| 正常/变异真实链仍被执行；精确子测试身份、退出码、decision 缺失反例等断言不削弱 | ✅ 主用例未改动判定逻辑（`judgeRealRun`/`judgeMutatedRun` 原样），完整运行 63 passed |
| 使用局部 seam 或隔离进程制造故障，不修改主仓 fs 全局行为 | ✅ 只用**参数注入**（`lstatImpl`、`copyFile`/`readdir` seam），未改任何全局 fs 行为 |
| 测试清理仅清理自身夹具（含自建 foreign 模拟），不清理真实历史残留 | ✅ 矩阵用例的根都在 `tmpdir()` 下；集成用的 `run-YtCeW3` 是**我自建的模拟**，验收后已删除；真实残留不在本机 |

## 5. 集成验收：预置外来目录下的完整父验证

```
[e4-r55] 1 entry/entries under the shared runs root are NOT owned by this run (run-YtCeW3)
         — left untouched, and NOT a cleanup failure of this run
[e4-r55] the shared runs root still holds 1 entr(y|ies) after this suite (run-YtCeW3)
         — left untouched, not this suite's to remove
Test Files  1 passed (1)
     Tests  63 passed | 2 skipped (65)
```

| 项 | 修复前 | 修复后 |
|---|---|---|
| 完整套件结果（预置外来目录） | 通过，但**外来目录被删** | **通过** |
| 共享根 | `gone` | `present` |
| `run-YtCeW3` | **GONE** | **present** |
| 标记文件 sha256（前 16 位） | — | 事前 `8f3e4f1148a269bb` → 事后 **`8f3e4f1148a269bb`（一致）** |
| 内容 | — | `{"historical":true}` 未变 |

## 6. 判别力（恢复旧实现后反例失败）

把 `verifyOwnedCleanup` 改回"共享根必须为空 + 吞掉探测错误"，并让 `probePathState` 把任何错误都当作 `absent`：

```
× B: a FOREIGN historical leftover does not fail this run, and its bytes are untouched
× C: another run's ACTIVE directory is neither a failure nor cleaned
× D: a LEAKED owned directory fails the acceptance and is named
× F: an unreadable probe is UNKNOWN — never certified as a successful cleanup
× H: a cleanup failure and the ORIGINAL chain failure are both preserved
     Tests  5 failed | 2 passed | 58 skipped (65)
```

A 与 G 仍通过是**预期**的：A 的根**确实为空**（旧规则下也成立），G 断言的是"分配即记录所有权"，
与旧规则无关。用例 B 内还带一条**显式反证**：同一夹具下 `readdir(root) !== []`，
即旧规则**必然**在此失败。用例 F 内亦带一条显式反证：把错误吞成 `absent` 的旧写法会通过，
而新实现返回 1 条失败原因。随后已从备份恢复：`7 passed`、`tsc -b` 退出码 0。

## 7. testedSourceSha

- 基线提交（R70 开始时 HEAD）：`2d6d9f8615191b601a83e7c5c9a66a4f4e2381fa`（计划 §0 的 reviewedSourceSha）
- 被测文件内容标识（`git hash-object`，提交前实测）：

| 文件 | blob（工作树） |
| --- | --- |
| `apps/cli/src/e4-r55-failure-wiring.test.ts` | `383987a88390c8e50eebc97e616ea4b25c2e3598` |

- 实现提交：`b5ceec1`（按所有权验证）、`c714433`（不再删除共享根）
- 环境：Node `v22.22.2`、pnpm `11.21.0`、vitest `4.1.10`、Windows (win32)，**符号链接不可用**

## 8. NOT_RUN

- **用例 E（悬空链接）未在本机执行**（显式 skip，无符号链接能力）——待 CI。
- 未在真实 CI 上验证（留给 R71）。
- 未做付费模型调用、未发布 release、未强推。

## 9. 残余限制

1. **`rmdir` 在大型套件 `afterAll` 中"成功删除非空目录"的机制未定因**（§2.2）。
   本修复**不依赖**该结论——按计划要求，共享根根本不再被删除。
   但**真实 CI 上是否也存在该行为未被验证**，故 R71 需在 CI 上复核"外来目录保留"。
2. **用例 E 的悬空链接分支只能由 CI 覆盖**（本机 `fs.symlink` 不可用，且实测存在"静默 no-op"）。
3. **`ownedRunDirs` 只覆盖 `runChild` 分配的资源**。R59 并发用例自建的 `dirA`/`dirB` 由该用例
   自己的 `finally` 清理，不在本验证范围内（其泄漏会由该用例自身的断言发现）。
4. **外来目录的诊断不区分"历史残留"与"活跃运行"**——两者都只打印、都不删除，这是刻意的。
5. 本任务未触碰 Runtime、权限、沙箱或业务决策逻辑；未新增通用垃圾回收/租约/锁框架（计划 §3）。
